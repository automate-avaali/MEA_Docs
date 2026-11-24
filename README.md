# Avagama MiddleEast Docs — Arabic / English document RAG

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
| `BLOB_READ_WRITE_TOKEN` (optional) | Keeps the original uploaded files in a **private** Vercel Blob store. When connecting the Blob store to the project, tick **Add a read-write token env var to this connection** (browser uploads need it; keep the prefix `BLOB`). For local dev, put a read-write token in `.env.local`. Unset → files are indexed but not kept | Hobby plan allowance |

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
6. In parallel, the original file goes **straight from the browser to Vercel Blob** (private;
   `docs/<userId>/<documentId>/…`) with a token from `POST /api/documents/[id]/file`, and is linked to the
   document with `PUT` on the same route. `GET` checks ownership and redirects to a 5-minute signed URL (view); `GET ?download=1` streams it as an attachment under its original name.
   Deleting a document or the account deletes its files (`src/lib/storage.ts`).

**Chunking** (`src/lib/rag/chunk.ts`): structure-aware + recursive with overlap. Page-aware (citations; every
page starts a new chunk, so the top of a page — IDs, letterheads — begins a chunk), section-aware (`Article (3)`,
`المادة (3)`, `ANNEX`, headings start sections; the section title travels with each chunk), tables never split
from their header row, ~1,400 chars, recursive splitting paragraph → line → sentence → clause → words, ~240-char
overlap, very short lines (a lone "ID: ١٠٤١٩٠") never dropped, contextual header (`document · page · section`)
embedded.

**Query understanding** (`src/lib/rag/rewrite.ts`): every message is first rewritten by Fanar with the thread
(last 10 Q&A pairs): connected follow-ups become self-contained questions, bilingual (English + Arabic)
keyword queries are generated, page references ("top right of the first page") become a page filter, small talk
("my name is Suhas") is answered from the conversation, and unclear fragments ("ID #") get one clarifying
question. Falls back to the raw question + a fixed EN↔AR contract-term expansion if the rewrite fails.

**Retrieval** (`src/lib/rag/retrieve.ts`): for each query, sparse BM25 (Atlas Search, `lucene.arabic` + English,
Arabic normalisation, Arabic-Indic digits → 0-9) **top 30** and dense bge-m3 (`$vectorSearch`) **top 30** in
parallel (+ the chunks of any page the user pointed at) → **Reciprocal Rank Fusion** → **top 40** → **Jina
cross-encoder** → **top 20**, packed into Fanar's 16K-token window best-first next to the thread.

**Answering** (`src/lib/rag/answer.ts`, `/api/chat`): streams NDJSON — sources appear first, then the answer.
The question's language is detected (`detectLang`: script ratio + Urdu letters, 13/13 in tests); the first
characters of the answer are language-checked and the request retried if Fanar drifts into another language.
After the answer, dates (Gregorian + Hijri), numbers and `[n]` citations are verified against the sources and
shown as "please verify" notes if they don't match.

## Measured on the sample contracts (`../Docs`, 4 scanned bilingual PDFs, 35 pages)

- Ingestion: 2.5–3 s per scanned page end-to-end (OCR + chunk + embed), 8-page contract in ~20 s.
- Answers: sources in ~1 s, first words in ~3.5–5.5 s (Fanar has ~2 s fixed latency), all test questions
  correct in Arabic, English and Urdu, including values read from scanned tables.

## Accounts & limits

Sign-up is open, except in a browser where a limited account has signed in: that browser gets a one-year cookie,
`/signup` redirects to `/login`, the sign-up links are hidden and the API returns `signup_disabled`.
`SIGNUP_ENABLED=false` closes sign-up for everyone. Accounts can also be created by the administrator, optionally with limits:

```bash
USER_PASSWORD='…' npm run user:set -- --email client@company.com --name "Client"   --max-docs 15 --max-pages 50 --max-mb 25 --questions 60
npm run user:set -- --email client@company.com --questions 100   # change one limit
npm run user:set -- --email client@company.com --no-limits        # remove limits
```

Limits are enforced on the server (`src/lib/limits.ts`); days reset at midnight Riyadh time. Every question counts,
and starting a new chat also counts as a chat. Questions that fail before an answer is produced are not counted.

## Scripts

- `npm run db:setup` — create indexes (or `-- --print` to print the JSON for the Atlas UI)
- `node scripts/e2e-test.mjs` — full API test against a running server using `../Docs`
