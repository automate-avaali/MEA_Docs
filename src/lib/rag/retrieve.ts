import "server-only";
import { Types } from "mongoose";
import { collection } from "../db";
import { CHUNKS } from "../models";
import { embedQuery } from "../ai/embed";
import { rerank } from "../ai/rerank";
import { annotateDigits, searchNormalize } from "../text/arabic";
import { SIGNATURE_LINE, signatureTier } from "../text/signatures";
import { TEXT_INDEX, VECTOR_INDEX } from "./store";

// Hybrid retrieval (per question):
//   for every query (standalone question + bilingual keyword queries from rewrite.ts):
//     Sparse — BM25 via Atlas Search (Arabic + English analyzers)  → top 30
//     Dense  — bge-m3 via $vectorSearch                           → top 30      all in parallel
//   + Page list — chunks of the pages the user pointed at ("top of the first page" → page 1), in reading order
//   → Reciprocal Rank Fusion (k = 60): score = Σ weight / (60 + rank) — rank-based, so BM25 and cosine scores
//     never need to be calibrated against each other
//   → top 40 fused candidates → Jina cross-encoder reranker (scored against the standalone question) → top 20
//   Signature questions ("who signed?", "من وقع؟", "کس نے دستخط کیے؟"): the signature blocks of the documents in scope
//   are added as one more list, always reach the reranker, and go FIRST in the final 20 — handwritten-signature
//   blocks, then stamps, then plain signature lines (documents read before signatures were marked).
// Why hybrid: contracts are full of exact tokens (CR numbers, IBANs, product codes like "SSPET 250ml")
// that keyword search nails and vectors blur; vectors catch paraphrases ("how long is the contract" ↔
// "مدة العقد") that keywords miss. Sparse here = BM25 with Lucene's Arabic analyzer: learned sparse models
// (SPLADE) are English-only and non-commercially licensed, so they don't fit these bilingual contracts.

export type Hit = {
  _id: Types.ObjectId;
  documentId: Types.ObjectId;
  docTitle: string;
  page: number;
  pageEnd: number;
  section: string;
  content: string;
  isTable: boolean;
  signatures?: number;
  unsigned?: number;
  stamps?: number;
  score: number;
};

export const SPARSE_K = 30;
export const DENSE_K = 30;
export const FUSE_TOP = 40;
export const TOP_K = 20;
const SIGNATURE_K = 30; // signature blocks fetched for a signature question
const SIGNATURE_FIRST = 12; // at most this many of them are moved ahead of the other sources
const RRF_K = 60;
const PROJECT = { docTitle: 1, documentId: 1, page: 1, pageEnd: 1, section: 1, content: 1, isTable: 1, signatures: 1, unsigned: 1, stamps: 1 };

async function bm25(query: string, userId: Types.ObjectId, docIds: Types.ObjectId[]) {
  const q = searchNormalize(query);
  const col = await collection(CHUNKS);
  const filter = [{ equals: { path: "userId", value: userId } }, ...(docIds.length ? [{ in: { path: "documentId", value: docIds } }] : [])];
  return col
    .aggregate<Hit>([
      {
        $search: {
          index: TEXT_INDEX,
          compound: {
            filter,
            should: [
              { text: { query: q, path: "searchText" } },
              { text: { query: q, path: { value: "searchText", multi: "en" } } },
              { text: { query: q, path: "section", score: { boost: { value: 1.5 } } } },
            ],
            minimumShouldMatch: 1,
          },
        },
      },
      { $limit: SPARSE_K },
      { $project: { ...PROJECT, score: { $meta: "searchScore" } } },
    ])
    .toArray();
}

async function vector(query: string, userId: Types.ObjectId, docIds: Types.ObjectId[]) {
  const v = await embedQuery(query);
  const col = await collection(CHUNKS);
  const filter: Record<string, unknown> = { userId };
  if (docIds.length) filter.documentId = { $in: docIds };
  return col
    .aggregate<Hit>([
      { $vectorSearch: { index: VECTOR_INDEX, path: "embedding", queryVector: v, numCandidates: 400, limit: DENSE_K, filter } },
      { $project: { ...PROJECT, score: { $meta: "vectorSearchScore" } } },
    ])
    .toArray();
}

/** Chunks of the pages the user explicitly referred to, in reading order (top of the page first). */
async function pageChunks(pages: number[], userId: Types.ObjectId, docIds: Types.ObjectId[]) {
  if (!pages.length) return [];
  const col = await collection(CHUNKS);
  const filter: Record<string, unknown> = { userId, page: { $in: pages } };
  if (docIds.length) filter.documentId = { $in: docIds };
  return col.find<Hit>(filter, { projection: PROJECT }).sort({ documentId: 1, page: 1, _id: 1 }).limit(30).toArray();
}

/**
 * Signature blocks of the documents in scope: chunks where OCR marked a handwritten signature, an empty signature
 * place or a stamp — and, for documents read before those markers existed, chunks with a signature line.
 */
async function signatureChunks(userId: Types.ObjectId, docIds: Types.ObjectId[]) {
  const col = await collection(CHUNKS);
  const filter: Record<string, unknown> = {
    userId,
    $or: [{ signatures: { $gt: 0 } }, { unsigned: { $gt: 0 } }, { stamps: { $gt: 0 } }, { content: { $regex: SIGNATURE_LINE.source, $options: "i" } }],
  };
  if (docIds.length) filter.documentId = { $in: docIds };
  return col.find<Hit>(filter, { projection: PROJECT }).sort({ signatures: -1, stamps: -1, documentId: 1, page: 1 }).limit(SIGNATURE_K).toArray();
}

type List = { hits: Hit[]; kind: "sparse" | "dense" | "page" | "signature"; weight: number };

/** Runs sparse + dense for each query (and the page / signature lists) in parallel. */
export async function gatherLists(opts: {
  queries: string[];
  pages?: number[];
  /** The question is about signing → also fetch the signature blocks. */
  signatures?: boolean;
  userId: Types.ObjectId;
  documentIds: Types.ObjectId[];
  timings?: Record<string, number>;
}) {
  const t0 = Date.now();
  const timings = opts.timings ?? {};
  const jobs: Promise<List>[] = opts.queries.flatMap((q) => [
    bm25(q, opts.userId, opts.documentIds)
      .catch((e) => (console.warn("[retrieve] bm25 failed:", e.message), [] as Hit[]))
      .then((hits) => ((timings.sparse = Date.now() - t0), { hits, kind: "sparse" as const, weight: 1 })),
    vector(q, opts.userId, opts.documentIds)
      .catch((e) => (console.warn("[retrieve] vector failed:", e.message), [] as Hit[]))
      .then((hits) => ((timings.dense = Date.now() - t0), { hits, kind: "dense" as const, weight: 1 })),
  ]);
  if (opts.pages?.length) {
    // Weighted like two lists: the user named the page, so those chunks must reach the reranker.
    jobs.push(pageChunks(opts.pages, opts.userId, opts.documentIds).then((hits) => ({ hits, kind: "page" as const, weight: 2 })));
  }
  if (opts.signatures) {
    jobs.push(
      signatureChunks(opts.userId, opts.documentIds)
        .catch((e) => (console.warn("[retrieve] signature blocks failed:", e.message), [] as Hit[]))
        .then((hits) => ({ hits, kind: "signature" as const, weight: 2 })),
    );
  }
  return Promise.all(jobs);
}

/** Signature blocks first (marker → stamp → signature line, each in reranker order), at most SIGNATURE_FIRST of them. */
export function signaturesFirst(hits: Hit[]) {
  const first = hits
    .map((h, i) => ({ h, i, tier: signatureTier(h) }))
    .filter((x) => x.tier < 3)
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .slice(0, SIGNATURE_FIRST)
    .map((x) => x.h);
  const moved = new Set(first);
  return [...first, ...hits.filter((h) => !moved.has(h))];
}

export type RetrievalResult = { hits: Hit[]; timings: Record<string, number>; mode: string; candidates: number };

/** RRF over all lists → top 40 → cross-encoder → top 20 (signature blocks first for a signature question). */
export async function fuseAndRerank(opts: { lists: List[]; rerankQuery: string; topK?: number; timings?: Record<string, number> }): Promise<RetrievalResult> {
  const topK = opts.topK ?? TOP_K;
  const timings = opts.timings ?? {};
  const t0 = Date.now();
  const fused = new Map<string, { hit: Hit; score: number }>();
  for (const list of opts.lists) {
    list.hits.forEach((h, rank) => {
      const id = String(h._id);
      const cur = fused.get(id) ?? { hit: h, score: 0 };
      cur.score += list.weight / (RRF_K + rank + 1);
      fused.set(id, cur);
    });
  }
  const sorted = [...fused.values()].sort((a, b) => b.score - a.score);
  const signatureList = opts.lists.find((l) => l.kind === "signature" && l.hits.length);
  // Signature question: every signature block reaches the reranker, even ones that fused below the top 40.
  const keep = signatureList ? new Set(signatureList.hits.map((h) => String(h._id))) : null;
  const candidates = sorted.filter((f, i) => i < FUSE_TOP || keep?.has(String(f.hit._id))).map((f) => ({ ...f.hit, score: f.score }));
  const has = (k: List["kind"]) => opts.lists.some((l) => l.kind === k && l.hits.length);
  if (!candidates.length) return { hits: [], timings, mode: "none", candidates: 0 };

  const ranked = await rerank(
    opts.rerankQuery,
    candidates.map((c) => `${c.docTitle} · p.${c.page}${c.section ? ` · ${c.section}` : ""}\n${annotateDigits(c.content)}`),
    // Signature question: rank them all, so a signature block the reranker scores low is moved up, not cut.
    signatureList ? candidates.length : topK,
  );
  timings.rerank = Date.now() - t0;
  let hits = ranked ? ranked.map((r) => ({ ...candidates[r.index], score: r.score })) : candidates;
  if (signatureList) hits = signaturesFirst(hits);
  hits = hits.slice(0, topK);
  const mode =
    [has("sparse") && "sparse", has("dense") && "dense", has("page") && "page", has("signature") && "signature"].filter(Boolean).join("+") + (ranked ? "+rerank" : "+rrf");
  return { hits, timings, mode, candidates: candidates.length };
}

/** Convenience: gather + fuse + rerank in one call (scripts, tests). */
export async function retrieve(opts: { queries: string[]; pages?: number[]; rerankQuery?: string; userId: Types.ObjectId; documentIds: Types.ObjectId[]; topK?: number }) {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const lists = await gatherLists({ ...opts, timings });
  const r = await fuseAndRerank({ lists, rerankQuery: opts.rerankQuery ?? opts.queries[0], topK: opts.topK, timings });
  timings.total = Date.now() - t0;
  return r;
}
