import "server-only";
import { Types } from "mongoose";
import { collection } from "../db";
import { CHUNKS } from "../models";
import { embedQuery } from "../ai/embed";
import { rerank } from "../ai/rerank";
import { searchNormalize } from "../text/arabic";
import { TEXT_INDEX, VECTOR_INDEX } from "./store";

// Hybrid retrieval:
//   BM25 (Atlas Search, Arabic + English analyzers)  ┐  run in parallel
//   Vector (bge-m3, $vectorSearch)                    ┘
//   → Reciprocal Rank Fusion (k = 60): score = Σ 1/(60 + rank) — rank-based, so the two very different
//     score scales never need tuning
//   → Jina reranker on the fused top 30 → top K
// Why hybrid: contracts are full of exact tokens (CR numbers, IBANs, product codes like "SSPET 250ml")
// that keyword search nails and vectors blur; vectors catch paraphrases ("how long is the contract" ↔
// "مدة العقد") that keywords miss.

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

const CANDIDATES = 40;
const FUSE_TOP = 30;
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
      { $limit: CANDIDATES },
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
      { $vectorSearch: { index: VECTOR_INDEX, path: "embedding", queryVector: v, numCandidates: 300, limit: CANDIDATES, filter } },
      { $project: { ...PROJECT, score: { $meta: "vectorSearchScore" } } },
    ])
    .toArray();
}

export type RetrievalResult = { hits: Hit[]; timings: Record<string, number>; mode: string };

export async function retrieve(opts: { queries: string[]; userId: Types.ObjectId; documentIds: Types.ObjectId[]; topK?: number }): Promise<RetrievalResult> {
  const topK = opts.topK ?? 8;
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  // Every query × {BM25, vector} runs in parallel; all ranked lists go into one RRF.
  const lists = await Promise.all(
    opts.queries.flatMap((q) => [
      bm25(q, opts.userId, opts.documentIds)
        .catch((e) => (console.warn("[retrieve] bm25 failed:", e.message), [] as Hit[]))
        .finally(() => (timings.bm25 = Date.now() - t0)),
      vector(q, opts.userId, opts.documentIds)
        .catch((e) => (console.warn("[retrieve] vector failed:", e.message), [] as Hit[]))
        .finally(() => (timings.vector = Date.now() - t0)),
    ]),
  );
  const kw = lists.filter((_, i) => i % 2 === 0).flat();
  const vec = lists.filter((_, i) => i % 2 === 1).flat();

  // Reciprocal Rank Fusion
  const fused = new Map<string, { hit: Hit; score: number }>();
  for (const list of lists) {
    list.forEach((h, rank) => {
      const id = String(h._id);
      const cur = fused.get(id) ?? { hit: h, score: 0 };
      cur.score += 1 / (RRF_K + rank + 1);
      fused.set(id, cur);
    });
  }
  const candidates = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, FUSE_TOP).map((f) => ({ ...f.hit, score: f.score }));
  timings.fusion = Date.now() - t0;
  if (!candidates.length) return { hits: [], timings, mode: "none" };

  const t1 = Date.now();
  // Rerank against the most context-rich query (for follow-ups: previous question + this one).
  const ranked = await rerank(
    opts.queries[opts.queries.length - 1],
    candidates.map((c) => `${c.docTitle}${c.section ? ` · ${c.section}` : ""}\n${c.content}`),
    topK,
  );
  timings.rerank = Date.now() - t1;
  const hits = ranked ? ranked.map((r) => ({ ...candidates[r.index], score: r.score })) : candidates.slice(0, topK);
  timings.total = Date.now() - t0;
  return { hits, timings, mode: `${kw.length ? "bm25" : ""}${vec.length ? "+vector" : ""}${ranked ? "+rerank" : "+rrf"}` };
}
