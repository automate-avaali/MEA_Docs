import "server-only";
import { PDFDocument } from "pdf-lib";
import type { Types } from "mongoose";
import { collection } from "../db";
import { CHUNKS, DocumentModel, type DocumentDoc } from "../models";
import { OcrQuotaError, ocrPdf } from "../ai/gemini-ocr";
import { embedManyPartial } from "../ai/embed";
import { cleanText, detectContentLang, searchNormalize } from "../text/arabic";
import { normalizeTables } from "../text/tables";
import { extractDates, invalidIbans } from "../text/verify";
import { SIGNATURE_SEARCH_TERMS, signatureStats, stripMarkers } from "../text/signatures";
import { chunkPages, embeddingText, type PageText } from "./chunk";
import { replacePageChunks, toVector, type ChunkRow } from "./store";

export type IncomingPage = { page: number; text: string; source: "text" | "tesseract" | "docx" | "plain" };

const tokens = (s: string) => new Set(searchNormalize(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2));
/**
 * Share of the smaller token set found in the other — two independent OCR engines on the same page.
 * Gemini's signature/stamp marker words are left out: Tesseract never writes them.
 */
export function agreement(a: string, b: string) {
  const A = tokens(stripMarkers(a)), B = tokens(b);
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
  const texts: (PageText & { source: string })[] = (opts.pages ?? []).map((p) => ({ page: p.page, text: normalizeTables(cleanText(p.text)), source: p.source }));
  const flagged: number[] = [];

  if (opts.pdf && opts.pdfPages?.length) {
    const ocr = await ocrPdf(opts.pdf, opts.pdfPages.length);
    // Pages the reply skipped entirely (Gemini sometimes stops after page 1) are re-read one at a time — a
    // skipped signature page would otherwise be stored empty. A quota error here sends the whole batch to the
    // browser's Tesseract, like any other quota error.
    for (const n of ocr.missing ?? []) {
      const [again] = await ocrPdf(await singlePage(opts.pdf, n - 1), 1).catch((e) => {
        if (e instanceof OcrQuotaError) throw e;
        console.warn(`[ingest] re-reading skipped page ${opts.pdfPages![n - 1]} failed:`, (e as Error).message);
        return [""];
      });
      ocr[n - 1] = again ?? "";
    }
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
      texts.push({ page, text: normalizeTables(text), source: "gemini" });
    }
  }
  const tOcr = Date.now();

  texts.sort((a, b) => a.page - b.page);
  const chunks = chunkPages(texts.filter((t) => t.text));
  const rows: ChunkRow[] = chunks.map((c) => {
    // Signature blocks: flagged for signature questions (retrieval puts them first) and given extra search words
    // in Arabic / Urdu / English, so "من وقع؟" or "کس نے دستخط کیے؟" finds them by keyword too.
    const sig = signatureStats(c.content);
    const signatureBlock = sig.signatures + sig.unsigned + sig.stamps > 0;
    return {
      userId: doc.userId as Types.ObjectId,
      documentId: doc._id,
      docTitle: doc.title,
      page: c.page,
      pageEnd: c.pageEnd,
      section: c.section,
      content: c.content,
      searchText: searchNormalize(`${c.section}\n${c.content}${signatureBlock ? `\n${SIGNATURE_SEARCH_TERMS}` : ""}`),
      isTable: c.isTable,
      lang: detectContentLang(c.content),
      dates: extractDates(c.content),
      ...(signatureBlock ? sig : {}),
      createdAt: new Date(),
    };
  });

  // Embed. If the embedding service is down, chunks are still stored (keyword search works) and
  // marked pending; /api/documents/[id]/embed fills them in later with the SAME model.
  // Batches that succeed keep their vectors even if another batch fails (never all-or-nothing). The budget
  // is whatever is left of the route's 120 s after OCR.
  let pending = 0;
  if (rows.length) {
    const { vectors, error } = await embedManyPartial(
      chunks.map((c) => embeddingText(doc.title, c)),
      { budgetMs: Math.max(20_000, 100_000 - (Date.now() - t0)) },
    );
    rows.forEach((r, i) => {
      const v = vectors[i];
      if (v) r.embedding = toVector(v);
      else pending++;
    });
    if (pending) console.warn(`[ingest] ${pending}/${rows.length} chunks of ${doc._id} stored without embeddings (${error}) — they are filled in later`);
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

/**
 * Embeds chunks stored without a vector (embedding service was down during upload). Small steps (48 chunks),
 * and every finished batch is written immediately — a slow or failing provider still makes progress.
 */
export async function backfillEmbeddings(documentId: Types.ObjectId, opts: { limit?: number; budgetMs?: number } = {}) {
  const col = await collection(CHUNKS);
  const missing = await col
    .find({ documentId, embedding: { $exists: false } }, { projection: { docTitle: 1, page: 1, pageEnd: 1, section: 1, content: 1 } })
    .limit(opts.limit ?? 48)
    .toArray();
  if (!missing.length) {
    await DocumentModel.updateOne({ _id: documentId }, { $set: { pendingEmbeddings: 0 } });
    return { done: 0, remaining: 0, error: null };
  }
  let done = 0;
  const { error } = await embedManyPartial(
    missing.map((c) => embeddingText(c.docTitle, { page: c.page, pageEnd: c.pageEnd, section: c.section, content: c.content, isTable: false })),
    {
      budgetMs: opts.budgetMs ?? 45_000,
      onBatch: async (start, vecs) => {
        await col.bulkWrite(vecs.map((v, k) => ({ updateOne: { filter: { _id: missing[start + k]._id }, update: { $set: { embedding: toVector(v) } } } })));
        done += vecs.length;
      },
    },
  );
  const remaining = await col.countDocuments({ documentId, embedding: { $exists: false } });
  await DocumentModel.updateOne({ _id: documentId }, { $set: { pendingEmbeddings: remaining } });
  if (error) console.warn(`[backfill] ${documentId}: ${done} embedded, ${remaining} remaining (${error})`);
  return { done, remaining, error };
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
