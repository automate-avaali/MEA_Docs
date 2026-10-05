import "server-only";
import mongoose, { Types } from "mongoose";
import { collection, connectDB } from "../db";
import { CHUNKS } from "../models";
import { EMBED_DIMS } from "../ai/embed";

// Chunk documents:
// { _id, userId, documentId, docTitle, page, pageEnd, section, content, searchText, isTable,
//   lang, dates: [ISO], embedding: BinData(float32 vector) | missing, createdAt }

export const VECTOR_INDEX = "chunk_vector";
export const TEXT_INDEX = "chunk_text";

/** float32 BSON vector: 4 KB per chunk instead of ~9 KB as a number array. */
export const toVector = (v: number[]) => mongoose.mongo.Binary.fromFloat32Array(new Float32Array(v));

export type ChunkRow = {
  userId: Types.ObjectId;
  documentId: Types.ObjectId;
  docTitle: string;
  page: number;
  pageEnd: number;
  section: string;
  content: string;
  searchText: string;
  isTable: boolean;
  lang: string;
  dates: string[];
  embedding?: ReturnType<typeof toVector>;
  createdAt: Date;
};

/** Idempotent page write: re-processing a batch replaces its chunks instead of duplicating them. */
export async function replacePageChunks(documentId: Types.ObjectId, pages: number[], rows: ChunkRow[]) {
  const col = await collection(CHUNKS);
  await col.deleteMany({ documentId, page: { $in: pages } });
  if (rows.length) await col.insertMany(rows, { ordered: false });
}

export const SEARCH_INDEX_DEFS = [
  {
    name: VECTOR_INDEX,
    type: "vectorSearch",
    definition: {
      fields: [
        { type: "vector", path: "embedding", numDimensions: EMBED_DIMS, similarity: "cosine" },
        { type: "filter", path: "userId" },
        { type: "filter", path: "documentId" },
      ],
    },
  },
  {
    name: TEXT_INDEX,
    type: "search",
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          userId: { type: "objectId" },
          documentId: { type: "objectId" },
          // lucene.arabic: Arabic normalisation + light stemming; the "en" sub-field stems English words.
          searchText: { type: "string", analyzer: "lucene.arabic", multi: { en: { type: "string", analyzer: "lucene.english" } } },
          section: { type: "string", analyzer: "lucene.arabic" },
        },
      },
    },
  },
] as const;

/** Creates the Atlas Search + Vector Search indexes if missing (safe to call repeatedly). */
export async function ensureSearchIndexes() {
  const db = (await connectDB()).connection.db!;
  // Search indexes can only be created on an existing collection.
  if (!(await db.listCollections({ name: CHUNKS }).hasNext())) await db.createCollection(CHUNKS);
  const col = db.collection(CHUNKS);
  const existing = await col.listSearchIndexes().toArray();
  const names = new Set(existing.map((i) => i.name as string));
  const created: string[] = [];
  for (const def of SEARCH_INDEX_DEFS) {
    if (names.has(def.name)) continue;
    await col.createSearchIndex(def as unknown as Parameters<typeof col.createSearchIndex>[0]);
    created.push(def.name);
  }
  return { db: db.databaseName, existing: [...names], created };
}

export async function ensureRegularIndexes() {
  const col = await collection(CHUNKS);
  await col.createIndex({ documentId: 1, page: 1 });
  await col.createIndex({ userId: 1, documentId: 1 });
}
