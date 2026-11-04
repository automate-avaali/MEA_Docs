import "server-only";
import type { Types } from "mongoose";
import { collection } from "../db";
import { CHUNKS, DocumentModel, type DocumentDoc } from "../models";
import { completeChat } from "../ai/fanar";
import { annotateDigits, searchNormalize } from "../text/arabic";

// Starter questions for the chat welcome screen, written from the document itself so every suggestion is
// something it can actually answer. Generated once per document and UI language, then stored on the document.

export type Locale = "en" | "ar" | "ur";
const LANG: Record<Locale, string> = { en: "English", ar: "Arabic (العربية)", ur: "Urdu (اردو)" };

/** A compact outline of the document: page 1, the section headings, and the start of each table. */
async function outline(documentId: Types.ObjectId) {
  const col = await collection(CHUNKS);
  const chunks = await col
    .find({ documentId }, { projection: { page: 1, section: 1, content: 1, isTable: 1 } })
    .sort({ page: 1, _id: 1 })
    .limit(400)
    .toArray();
  const sections = [...new Set(chunks.map((c) => String(c.section ?? "").trim()).filter(Boolean))].slice(0, 40);
  const first = chunks.filter((c) => c.page === chunks[0]?.page).map((c) => String(c.content)).join("\n").slice(0, 1800);
  const tables = chunks
    .filter((c) => c.isTable)
    .slice(0, 4)
    .map((c) => `(p.${c.page}${c.section ? ` · ${c.section}` : ""})\n${String(c.content).split("\n").slice(0, 5).join("\n")}`);
  return annotateDigits(`FIRST PAGE:\n${first}\n\nSECTIONS:\n${sections.join("\n")}\n\nTABLES:\n${tables.join("\n\n") || "(none)"}`);
}

function parseList(text: string): string[] {
  const body = text.replace(/^```(?:json)?|```$/gm, "").trim();
  const s = body.indexOf("["), e = body.lastIndexOf("]");
  if (s >= 0 && e > s) {
    try {
      const arr = JSON.parse(body.slice(s, e + 1));
      if (Array.isArray(arr)) return arr.filter((q): q is string => typeof q === "string");
    } catch {}
  }
  return body.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter((l) => l.endsWith("?") || l.endsWith("؟"));
}

/** Generates (or returns the stored) starter questions for one document in one language. */
export async function documentSuggestions(doc: Pick<DocumentDoc, "_id" | "title" | "suggestions">, locale: Locale): Promise<string[]> {
  const stored = doc.suggestions?.[locale];
  if (stored?.length) return stored;
  const { text } = await completeChat(
    [
      {
        role: "system",
        content: `You write starter questions for a chat that answers questions about ONE uploaded business document. Write exactly 4 short, specific questions (max 12 words each) that a business user would ask and that the outline below can answer: e.g. parties, term/duration, key amounts or tables (prices, discount slabs), obligations, termination or payment conditions, IDs/reference numbers. Mix them — not all about the same section. Use the document's own terms (product names, article titles). Write them in ${LANG[locale]}. Return ONLY a JSON array of 4 strings.`,
      },
      { role: "user", content: `Document: ${doc.title}\n\n${await outline(doc._id)}` },
    ],
    { maxTokens: 300, signal: AbortSignal.timeout(15_000) },
  );
  const questions = [...new Set(parseList(text).map((q) => q.trim()).filter((q) => q.length >= 8 && q.length <= 140))].slice(0, 4);
  if (questions.length >= 2) await DocumentModel.updateOne({ _id: doc._id }, { $set: { [`suggestions.${locale}`]: questions } });
  return questions;
}

/**
 * Up to 4 questions for the welcome screen: from the selected documents (or the 3 most recent ready ones),
 * interleaved so each document is represented. Missing ones are generated in parallel.
 */
export async function suggestionsFor(opts: { userId: Types.ObjectId; documentIds: Types.ObjectId[]; locale: Locale }) {
  const filter: Record<string, unknown> = { userId: opts.userId, status: "ready", chunkCount: { $gt: 0 } };
  if (opts.documentIds.length) filter._id = { $in: opts.documentIds };
  const docs = await DocumentModel.find(filter, { title: 1, suggestions: 1 }).sort({ createdAt: -1 }).limit(3).lean<DocumentDoc[]>();
  const lists = await Promise.all(
    docs.map((d) =>
      documentSuggestions(d, opts.locale)
        .then((qs) => qs.map((q) => ({ question: q, documentId: String(d._id), title: d.title })))
        .catch((e) => (console.warn("[suggest]", (e as Error).message), [])),
    ),
  );
  // Interleave (q1 of doc A, q1 of doc B, …, q2 of doc A, …), skipping near-duplicates: same-template contracts
  // produce the same questions, and four copies of "who are the parties?" helps nobody.
  const words = (q: string) => new Set(searchNormalize(q).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const similar = (a: string, b: string) => {
    const A = words(a), B = words(b);
    let n = 0;
    for (const w of A) if (B.has(w)) n++;
    return n / Math.max(1, Math.min(A.size, B.size)) >= 0.6;
  };
  const out: { question: string; documentId: string; title: string }[] = [];
  for (let i = 0; out.length < 4 && i < 4; i++)
    for (const l of lists) if (l[i] && out.length < 4 && !out.some((o) => similar(o.question, l[i].question))) out.push(l[i]);
  // Not enough distinct ones → top up with whatever is left.
  for (const q of lists.flat()) if (out.length < 4 && !out.some((o) => o.question === q.question)) out.push(q);
  return out;
}
