# mea.docs — Arabic / English document RAG

Upload scanned or digital contracts and invoices of any size (Arabic, English, bilingual), then ask
questions in Arabic, English or Urdu and get answers with page citations. Next.js 16 (frontend + API on
Vercel), MongoDB Atlas (data + vector + keyword search). Same design system as vitals.diary.

## Run it

```bash
npm install            # also copies the pdf.js worker into /public
cp .env.example .env.local   # fill in the keys (see below)
npm run dev            # http://localhost:3000
```

Atlas indexes: create them once in the Atlas UI with the JSON in [docs/atlas-indexes.md](docs/atlas-indexes.md)
(or `npm run db:setup`). They must be named `chunk_vector` and `chunk_text` on `mea_arabic_chatbot.chunks`.

| Variable | What for | Free tier |
|---|---|---|
| `MONGODB_URI`, `MONGODB_DB` | Database + Atlas Search/Vector Search | M0 (512 MB) |
| `JWT_SECRET` | Session cookies (64 hex chars) | — |
| `GEMINI_API_KEY`, `GEMINI_OCR_MODEL` | OCR of scanned pages | 15 req/min, 500 req/day (×5 pages each) |
| `HF_TOKEN` (fine-grained, *Inference*) | `BAAI/bge-m3` embeddings | small monthly credit |
| `EMBED_URL` (optional) | Your own TEI endpoint for bulk ingestion (same model) | — |
| `JINA_API_KEY` | `jina-reranker-v3.5` | 10M tokens (one-time) |
| `FANAR_API_KEY`, `FANAR_BASE_URL`, `FANAR_MODEL` | Answers (`Fanar-C-2-27B`) — point `FANAR_BASE_URL` at your own vLLM to self-host | 50 req/min |
| `SMTP_*` (optional) | Password-reset emails. Unset → link shown on screen in dev | — |
| `ATLAS_AUTO_INDEXES` | `false` = indexes managed manually in Atlas | — |

## How it works

**Ingestion (browser → API, any file size).** The file never leaves the browser in one piece:
1. SHA-256 of the file → `POST /api/documents` registers it (or resumes: pages already done are skipped).
2. pdf.js reads each page. Digital pages → text layer, repaired for Arabic (visual-order presentation forms
   → logical text). Scanned pages → grouped 5 at a time into a small PDF (pdf-lib) → `POST /batch` →
   **Gemini** OCR (Markdown, tables kept, both columns).
3. Gemini quota hit (HTTP 429) → the browser OCRs the remaining pages itself with **Tesseract.js** (Arabic +
   English) and sends text. Ingestion never stops.
4. Every 4th scanned batch, one page is also read by Tesseract; the server compares the two readings and
   re-reads / flags pages where they disagree. Invalid IBAN checksums also flag a page.
5. Server: clean → **structure-aware chunking** → **bge-m3** embeddings (batched, parallel, retry, single
   model) → idempotent write to `chunks` (float32 BSON vectors).

**Chunking** (`src/lib/rag/chunk.ts`): page-aware (citations), section-aware (`Article (3)`, `المادة (3)`,
`ANNEX`, headings start sections; the section title is carried with each chunk), tables never split from
their header row, ~1,400 chars with sentence overlap, contextual header (`document · section`) embedded.

**Retrieval** (`src/lib/rag/retrieve.ts`): BM25 (Atlas Search, `lucene.arabic` + English analyzer, Arabic
normalisation) and vector search (`$vectorSearch`) run in parallel → **Reciprocal Rank Fusion** → **Jina**
rerank of the top 30 → top 8. Follow-up questions are also searched together with the previous question.

**Answering** (`src/lib/rag/answer.ts`, `/api/chat`): streams NDJSON — sources appear first, then the answer.
The question's language is detected (`detectLang`: script ratio + Urdu letters, 13/13 in tests); the first
characters of the answer are language-checked and the request retried if Fanar drifts into another language.
After the answer, dates (Gregorian + Hijri), numbers and `[n]` citations are verified against the sources and
shown as "please verify" notes if they don't match.

## Measured on the sample contracts (`../Docs`, 4 scanned bilingual PDFs, 35 pages)

- Ingestion: 2.5–3 s per scanned page end-to-end (OCR + chunk + embed), 8-page contract in ~20 s.
- Answers: sources in ~1 s, first words in ~3.5–5.5 s (Fanar has ~2 s fixed latency), all test questions
  correct in Arabic, English and Urdu, including values read from scanned tables.

## Scripts

- `npm run db:setup` — create indexes (or `-- --print` to print the JSON for the Atlas UI)
- `node scripts/e2e-test.mjs` — full API test against a running server using `../Docs`
