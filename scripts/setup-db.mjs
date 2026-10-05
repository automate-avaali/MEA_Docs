// Creates the MongoDB Atlas indexes the app needs (safe to run repeatedly):
//   chunks.chunk_vector  — Atlas Vector Search (bge-m3, 1024-dim, cosine) + userId/documentId filters
//   chunks.chunk_text    — Atlas Search (BM25) with Arabic + English analyzers
//   + regular B-tree indexes.
// Usage: npm run db:setup            (create + wait until READY)
//        npm run db:setup -- --print (only print the JSON to paste into the Atlas UI)
import { config } from "dotenv";
import { MongoClient } from "mongodb";

config({ path: ".env.local" });

export const VECTOR_INDEX = {
  name: "chunk_vector",
  type: "vectorSearch",
  definition: {
    fields: [
      { type: "vector", path: "embedding", numDimensions: 1024, similarity: "cosine" },
      { type: "filter", path: "userId" },
      { type: "filter", path: "documentId" },
    ],
  },
};

export const TEXT_INDEX = {
  name: "chunk_text",
  type: "search",
  definition: {
    mappings: {
      dynamic: false,
      fields: {
        userId: { type: "objectId" },
        documentId: { type: "objectId" },
        searchText: { type: "string", analyzer: "lucene.arabic", multi: { en: { type: "string", analyzer: "lucene.english" } } },
        section: { type: "string", analyzer: "lucene.arabic" },
      },
    },
  },
};

const dbName = process.env.MONGODB_DB || "mea_arabic_chatbot";

if (process.argv.includes("--print")) {
  console.log(`Database: ${dbName}   Collection: chunks\n`);
  for (const ix of [VECTOR_INDEX, TEXT_INDEX]) {
    console.log(`── ${ix.name}  (${ix.type === "vectorSearch" ? "Atlas Vector Search → JSON Editor" : "Atlas Search → JSON Editor"})`);
    console.log(JSON.stringify(ix.definition, null, 2) + "\n");
  }
  process.exit(0);
}

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(dbName);
if (!(await db.listCollections({ name: "chunks" }).hasNext())) await db.createCollection("chunks");
const chunks = db.collection("chunks");

await Promise.all([
  chunks.createIndex({ documentId: 1, page: 1 }),
  chunks.createIndex({ userId: 1, documentId: 1 }),
  db.collection("documents").createIndex({ userId: 1, hash: 1 }),
  db.collection("messages").createIndex({ conversationId: 1, createdAt: 1 }),
  db.collection("conversations").createIndex({ userId: 1, updatedAt: -1 }),
]);
console.log("✓ regular indexes");

const existing = new Map((await chunks.listSearchIndexes().toArray()).map((i) => [i.name, i]));
for (const ix of [VECTOR_INDEX, TEXT_INDEX]) {
  if (existing.has(ix.name)) {
    console.log(`• ${ix.name} already exists (${existing.get(ix.name).status})`);
    continue;
  }
  await chunks.createSearchIndex(ix);
  console.log(`+ created ${ix.name}`);
}

// Wait until both are queryable (Atlas builds them in the background, usually < 1 min on an empty collection).
const started = Date.now();
for (;;) {
  const list = await chunks.listSearchIndexes().toArray();
  const status = list.map((i) => `${i.name}: ${i.status}${i.queryable ? " (queryable)" : ""}`).join(" | ");
  if (list.length >= 2 && list.every((i) => i.queryable)) {
    console.log(`✓ ${status}`);
    break;
  }
  if (Date.now() - started > 180_000) {
    console.log(`… still building: ${status} — check Atlas → Search & Vector Search`);
    break;
  }
  process.stdout.write(`  waiting… ${status}\r`);
  await new Promise((r) => setTimeout(r, 4000));
}
await client.close();
