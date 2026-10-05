import "server-only";
import { PDFDocument } from "pdf-lib";
import type { Types } from "mongoose";
import { collection } from "../db";
import { CHUNKS, DocumentModel, type DocumentDoc } from "../models";
import { ocrPdf } from "../ai/gemini-ocr";
import { embedMany } from "../ai/embed";
import { cleanText, detectContentLang, searchNormalize } from "../text/arabic";
import { extractDates, invalidIbans } from "../text/verify";
import { chunkPages, embeddingText, type PageText } from "./chunk";
import { replacePageChunks, toVector, type ChunkRow } from "./store";

export type IncomingPage = { page: number; text: string; source: "text" | "tesseract" | "docx" | "plain" };

const tokens = (s: string) => new Set(searchNormalize(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2));
/** Share of the smaller token set found in the other — two independent OCR engines on the same page. */
export function agreement(a: string, b: string) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size);
}

async function singlePage(pdf: Uint8Array, index: number) {
  const src = await PDFDocument.load(pdf);
  const out = await PDFDocument.create();
  const [p] = await out.copyPages(src, [index]);
  out.addPage(p);
  return out.save();
}

/**
 * Processes one batch of pages for a document and stores its chunks.
 *  - `pdf` + `pdfPages`: a small PDF of scanned pages → Gemini OCR (throws OcrQuotaError on 429).
 *  - `pages`: text already extracted in the browser (text layer, Tesseract fallback, DOCX, plain text).
 *  - `checks`: Tesseract text for one sampled scanned page → cross-engine agreement check.
 */
export async function processBatch(opts: {
  doc: DocumentDoc;
  pages?: IncomingPage[];
  pdf?: Uint8Array;
  pdfPages?: number[];
  checks?: { page: number; text: string }[];
}) {
  const { doc } = opts;
  const t0 = Date.now();
  const texts: (PageText & { source: string })[] = (opts.pages ?? []).map((p) => ({ page: p.page, text: cleanText(p.text), source: p.source }));
  const flagged: number[] = [];

  if (opts.pdf && opts.pdfPages?.length) {
    const ocr = await ocrPdf(opts.pdf, opts.pdfPages.length);
    for (let i = 0; i < opts.pdfPages.length; i++) {
      const page = opts.pdfPages[i];
      let text = cleanText(ocr[i] ?? "");
      const check = opts.checks?.find((c) => c.page === page);
      if (check && check.text.trim().length > 80) {
        let score = agreement(text, check.text);
        if (score < 0.35) {
          // Low agreement with Tesseract → re-read this page alone (batching can drift on dense pages).
          const [retry] = await ocrPdf(await singlePage(opts.pdf, i), 1).catch(() => [""]);
          const retryText = cleanText(retry ?? "");
          const retryScore = agreement(retryText, check.text);
          if (retryScore > score) {
            text = retryText;
            score = retryScore;
          }
          if (score < 0.35) flagged.push(page);
        }
      }
      if (!text) flagged.push(page);
      if (invalidIbans(text).length) flagged.push(page);
      texts.push({ page, text, source: "gemini" });
    }
  }
  const tOcr = Date.now();

  texts.sort((a, b) => a.page - b.page);
  const chunks = chunkPages(texts.filter((t) => t.text));
  const rows: ChunkRow[] = chunks.map((c) => ({
    userId: doc.userId as Types.ObjectId,
    documentId: doc._id,
    docTitle: doc.title,
    page: c.page,
    pageEnd: c.pageEnd,
    section: c.section,
    content: c.content,
    searchText: searchNormalize(`${c.section}\n${c.content}`),
    isTable: c.isTable,
    lang: detectContentLang(c.content),
    dates: extractDates(c.content),
    createdAt: new Date(),
  }));

  // Embed. If the embedding service is down, chunks are still stored (keyword search works) and
  // marked pending; /api/documents/[id]/embed fills them in later with the SAME model.
  let pending = 0;
  if (rows.length) {
    try {
      const vectors = await embedMany(chunks.map((c) => embeddingText(doc.title, c)));
      rows.forEach((r, i) => (r.embedding = toVector(vectors[i])));
    } catch (e) {
      console.warn(`[ingest] embedding failed for ${doc._id}: ${(e as Error).message}`);
      pending = rows.length;
    }
  }
  const tEmbed = Date.now();

  const pageNums = texts.map((t) => t.page);
  await replacePageChunks(doc._id, pageNums, rows);

  const count = (src: string) => texts.filter((t) => t.source === src).length;
  await DocumentModel.updateOne(
    { _id: doc._id },
    {
      $addToSet: { pagesDone: { $each: pageNums }, "ocr.flagged": { $each: [...new Set(flagged)] } },
      $inc: {
        "ocr.gemini": count("gemini"),
        "ocr.tesseract": count("tesseract"),
        "ocr.textLayer": count("text") + count("docx") + count("plain"),
        pendingEmbeddings: pending,
      },
    },
  );

  return {
    pages: pageNums.length,
    chunks: rows.length,
    flagged: [...new Set(flagged)],
    pendingEmbeddings: pending,
    timings: { ocr: tOcr - t0, embed: tEmbed - tOcr, total: Date.now() - t0 },
  };
}

/** Embeds chunks stored without a vector (embedding service was down during upload). */
export async function backfillEmbeddings(documentId: Types.ObjectId, limit = 96) {
  const col = await collection(CHUNKS);
  const missing = await col
    .find({ documentId, embedding: { $exists: false } }, { projection: { docTitle: 1, section: 1, content: 1 } })
    .limit(limit)
    .toArray();
  if (!missing.length) return { done: 0, remaining: 0 };
  const vectors = await embedMany(missing.map((c) => `${c.docTitle}${c.section ? ` · ${c.section}` : ""}\n${c.content}`));
  await col.bulkWrite(missing.map((c, i) => ({ updateOne: { filter: { _id: c._id }, update: { $set: { embedding: toVector(vectors[i]) } } } })));
  const remaining = await col.countDocuments({ documentId, embedding: { $exists: false } });
  await DocumentModel.updateOne({ _id: documentId }, { $set: { pendingEmbeddings: remaining } });
  return { done: missing.length, remaining };
}

/** Final bookkeeping once the browser has sent every page. */
export async function finalizeDocument(documentId: Types.ObjectId) {
  const col = await collection(CHUNKS);
  const [chunkCount, langs] = await Promise.all([
    col.countDocuments({ documentId }),
    col.aggregate<{ _id: string; n: number }>([{ $match: { documentId } }, { $group: { _id: "$lang", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
  ]);
  const total = langs.reduce((s, l) => s + l.n, 0) || 1;
  const share = (l: string) => (langs.find((x) => x._id === l)?.n ?? 0) / total;
  // Bilingual when mixed chunks are common, or when Arabic-script and English chunks both carry weight.
  const language =
    share("mixed") > 0.25 || (share("en") > 0.2 && share("ar") + share("ur") > 0.2) ? "mixed" : (langs.find((l) => l._id !== "mixed")?._id ?? langs[0]?._id ?? "en");
  await DocumentModel.updateOne({ _id: documentId }, { $set: { status: "ready", chunkCount, language } });
  return { chunkCount, language };
}
