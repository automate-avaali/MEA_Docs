import "server-only";
import { Types } from "mongoose";
import { collection } from "../db";
import { CHUNKS } from "../models";
import { embedQuery } from "../ai/embed";
import { rerank } from "../ai/rerank";
import { annotateDigits, searchNormalize } from "../text/arabic";
import { TEXT_INDEX, VECTOR_INDEX } from "./store";

// Hybrid retrieval (per question):
//   for every query (standalone question + bilingual keyword queries from rewrite.ts):
//     Sparse — BM25 via Atlas Search (Arabic + English analyzers)  → top 30
//     Dense  — bge-m3 via $vectorSearch                           → top 30      all in parallel
//   + Page list — chunks of the pages the user pointed at ("top of the first page" → page 1), in reading order
//   → Reciprocal Rank Fusion (k = 60): score = Σ weight / (60 + rank) — rank-based, so BM25 and cosine scores
//     never need to be calibrated against each other
//   → top 40 fused candidates → Jina cross-encoder reranker (scored against the standalone question) → top 20
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
  score: number;
};

export const SPARSE_K = 30;
export const DENSE_K = 30;
export const FUSE_TOP = 40;
export const TOP_K = 20;
const RRF_K = 60;
const PROJECT = { docTitle: 1, documentId: 1, page: 1, pageEnd: 1, section: 1, content: 1, isTable: 1 };

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

type List = { hits: Hit[]; kind: "sparse" | "dense" | "page"; weight: number };

/** Runs sparse + dense for each query (and the page list) in parallel. */
export async function gatherLists(opts: { queries: string[]; pages?: number[]; userId: Types.ObjectId; documentIds: Types.ObjectId[]; timings?: Record<string, number> }) {
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
  return Promise.all(jobs);
}

export type RetrievalResult = { hits: Hit[]; timings: Record<string, number>; mode: string; candidates: number };

/** RRF over all lists → top 40 → cross-encoder → top 20. */
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
  const candidates = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, FUSE_TOP).map((f) => ({ ...f.hit, score: f.score }));
  const has = (k: List["kind"]) => opts.lists.some((l) => l.kind === k && l.hits.length);
  if (!candidates.length) return { hits: [], timings, mode: "none", candidates: 0 };

  const ranked = await rerank(
    opts.rerankQuery,
    candidates.map((c) => `${c.docTitle} · p.${c.page}${c.section ? ` · ${c.section}` : ""}\n${annotateDigits(c.content)}`),
    topK,
  );
  timings.rerank = Date.now() - t0;
  const hits = ranked ? ranked.map((r) => ({ ...candidates[r.index], score: r.score })) : candidates.slice(0, topK);
  const mode = [has("sparse") && "sparse", has("dense") && "dense", has("page") && "page"].filter(Boolean).join("+") + (ranked ? "+rerank" : "+rrf");
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
