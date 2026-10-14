# MongoDB Atlas indexes for Avagama MiddleEast Docs

Create both on **Database `mea_arabic_chatbot` → Collection `chunks`**.
Atlas → your cluster → **Atlas Search** tab → **Create Search Index** → choose the type → **JSON Editor** → paste → Next → Create.
(The `chunks` collection must exist first — it is created on the first upload, or create it empty in Data Explorer.)

## 1. Vector index — `chunk_vector`

Type: **Atlas Vector Search** · Index name: **`chunk_vector`**

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" },
    { "type": "filter", "path": "userId" },
    { "type": "filter", "path": "documentId" }
  ]
}
```

- `numDimensions: 1024` — BAAI/bge-m3 output size (same as your `evaluations.vector_index`).
- `cosine` — the app normalises vectors, so cosine is correct.
- The two **filter** fields are required: every query filters by `userId` (a user only searches their own
  documents) and optionally `documentId` (when the user picks specific documents). Without them,
  `$vectorSearch` with a filter fails.

## 2. Keyword (BM25) index — `chunk_text`

Type: **Atlas Search** · Index name: **`chunk_text`**

```json
{
  "mappings": {
    "dynamic": false,
    "fields": {
      "userId": { "type": "objectId" },
      "documentId": { "type": "objectId" },
      "searchText": {
        "type": "string",
        "analyzer": "lucene.arabic",
        "multi": { "en": { "type": "string", "analyzer": "lucene.english" } }
      },
      "section": { "type": "string", "analyzer": "lucene.arabic" }
    }
  }
}
```

- `lucene.arabic` normalises Arabic letters and strips prefixes/suffixes (ال، و، ـها…); the `en` sub-field
  stems English words. Search queries use both, so bilingual contracts match in either language.
- Names must be exactly `chunk_vector` and `chunk_text` — the app queries them by name.

## Check

Both should show **READY** and **Queryable** in the Atlas Search list, Type `vectorSearch` and `search`.
The free M0 tier allows up to 3 search indexes per cluster; this app uses 2.

To have the app create them automatically instead, set `ATLAS_AUTO_INDEXES=true` in `.env.local`
or run `npm run db:setup`. `npm run db:setup -- --print` prints the JSON above.
