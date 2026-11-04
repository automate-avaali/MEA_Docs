// Structure-aware chunking for bilingual (Arabic/English) business documents.
//
// Strategy (why each rule exists):
//  • Page-aware: every chunk keeps the page it starts on → exact citations ("[3] Contract · p.2").
//  • Section-aware: lines like "Article (3) …", "المادة (3) …", "ANNEX (2) …", Markdown headings and
//    numbered clauses ("3.2 …") start a new section; the section title travels with each chunk and is
//    prepended to the embedding text, so a clause about "prices" still knows it belongs to "Article 3".
//  • Tables stay whole. A table larger than the limit is split by rows and EVERY part repeats the header
//    row, so "SSPET 250ml | 0-500 | 0.87" is never separated from "Volume | Off-Invoice".
//  • Size ~1,400 chars (~350–450 bge-m3 tokens for Arabic), hard max 2,200: big enough for a full clause,
//    small enough that the reranker and the LLM get focused evidence.
//  • Recursive splitting: text that is still too long is split on the largest natural boundary that works —
//    paragraph → line → sentence (. ! ? ؟ ۔) → clause (; ؛ ، ,) → words — so a chunk never cuts a word and
//    rarely cuts a sentence, even when OCR returns one giant unpunctuated line.
//  • Overlap: the tail of the previous chunk (its last sentence, or the last ~240 chars cut at a word
//    boundary) is carried into the next one, so a definition split at a boundary is still whole in one chunk.
//    Never overlaps across sections or tables.
//  • Page starts: each new page starts a new chunk, so the top of a page (letterhead, contract/reference
//    numbers, dates) is always the beginning of a chunk — "what is the ID at the top of page 1" finds it.

export type PageText = { page: number; text: string };
export type Chunk = { page: number; pageEnd: number; section: string; content: string; isTable: boolean };

const TARGET = 1400;
const MAX = 2200;
const OVERLAP = 240;

const HEADING_RE = [
  /^#{1,4}\s+\S/, // markdown heading
  /^\*\*[^*]{3,120}\*\*$/, // bold-only line
  /^(article|clause|section|annex|appendix|schedule|part)\s*[(\[]?\s*[\dIVX]+/i,
  /^(المادة|مادة|البند|الفصل|الملحق|ملحق|الباب|القسم)\s*[(\[]?\s*[\d٠-٩]+/,
  /^(ANNEX|ARTICLE)\b/,
];
const isHeading = (l: string) => l.length <= 140 && HEADING_RE.some((r) => r.test(l));
const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const clean = (l: string) => l.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();

type Block = { page: number; kind: "heading" | "table" | "text"; lines: string[] };

function toBlocks(pages: PageText[]): Block[] {
  const blocks: Block[] = [];
  for (const { page, text } of pages) {
    const lines = text.split("\n");
    let cur: Block | null = null;
    const flush = () => {
      if (cur && cur.lines.some((l) => l.trim())) blocks.push(cur);
      cur = null;
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (isTableLine(line)) {
        if (cur?.kind !== "table") {
          flush();
          cur = { page, kind: "table", lines: [] };
        }
        cur!.lines.push(line.trim());
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      if (isHeading(line.trim())) {
        flush();
        blocks.push({ page, kind: "heading", lines: [clean(line)] });
        continue;
      }
      if (cur?.kind !== "text") {
        flush();
        cur = { page, kind: "text", lines: [] };
      }
      cur!.lines.push(line.trim());
    }
    flush();
  }
  return blocks;
}

/** Splits a long Markdown table into parts that each repeat the header (+ separator) rows. */
function splitTable(lines: string[]): string[] {
  const text = lines.join("\n");
  if (text.length <= MAX) return [text];
  const sepIdx = lines.findIndex(isSeparator);
  const headerEnd = sepIdx >= 0 ? sepIdx + 1 : 1;
  // Keep extra header rows (e.g. "| | | Volume | Off-Invoice |") that come right after the separator.
  let h = headerEnd;
  while (h < lines.length && h < headerEnd + 2 && !/\d/.test(lines[h].replace(/\|/g, ""))) h++;
  const header = lines.slice(0, h);
  const rows = lines.slice(h);
  const parts: string[] = [];
  let buf: string[] = [];
  const size = (b: string[]) => [...header, ...b].join("\n").length;
  for (const r of rows) {
    if (buf.length && size([...buf, r]) > TARGET + 400) {
      parts.push([...header, ...buf].join("\n"));
      buf = [];
    }
    buf.push(r);
  }
  if (buf.length) parts.push([...header, ...buf].join("\n"));
  return parts;
}

/** Splits an over-long paragraph on sentence boundaries (Arabic ؟ ، ۔ and Latin . ! ?). */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?؟۔])\s+|\n/).filter((s) => s.trim());
}

// Recursive splitter: largest boundary first, falling back to smaller ones only for pieces still too long.
const SPLITTERS: RegExp[] = [/\n{2,}/, /\n/, /(?<=[.!?؟۔])\s+/, /(?<=[;؛،,])\s+/, /\s+/];
export function splitRecursive(text: string, max = TARGET, level = 0): string[] {
  if (text.length <= max || level >= SPLITTERS.length) {
    // Last resort for a single "word" far longer than max (e.g. a run of OCR noise): hard cut.
    if (text.length <= max * 1.6) return [text];
    const out: string[] = [];
    for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
    return out;
  }
  const parts = text.split(SPLITTERS[level]).filter((p) => p.trim());
  if (parts.length === 1) return splitRecursive(text, max, level + 1);
  // Re-pack the parts greedily so pieces are as close to `max` as possible without exceeding it.
  const joiner = level <= 1 ? "\n" : " ";
  const out: string[] = [];
  let cur = "";
  for (const part of parts) {
    if (part.length > max) {
      if (cur) out.push(cur);
      cur = "";
      out.push(...splitRecursive(part, max, level + 1));
      continue;
    }
    if (cur && cur.length + joiner.length + part.length > max) {
      out.push(cur);
      cur = part;
    } else cur = cur ? cur + joiner + part : part;
  }
  if (cur) out.push(cur);
  return out;
}

/** Overlap carried into the next chunk: the last sentence if short, else the last ~240 chars from a word start. */
const overlapTail = (s: string) => {
  const sents = splitSentences(s);
  const last = sents[sents.length - 1] ?? "";
  if (last.length <= OVERLAP) return last;
  const tail = s.slice(-OVERLAP);
  const cut = tail.search(/\s/);
  return cut >= 0 ? tail.slice(cut + 1) : "";
};

export function chunkPages(pages: PageText[]): Chunk[] {
  const chunks: Chunk[] = [];
  let section = "";
  let buf: string[] = [];
  let bufPage = pages[0]?.page ?? 1;
  let lastPage = bufPage;

  // Very short text (a lone "No. 138097" or date line before a heading/table) is never dropped: it is kept and
  // glued to the start of the next chunk, so header IDs stay searchable.
  const emit = (keepOverlap: boolean, final = false) => {
    const content = buf.join("\n").trim();
    if (!content) return void (buf = []);
    if (content.length < 30 && !final) return void (buf = [content]);
    chunks.push({ page: bufPage, pageEnd: lastPage, section, content, isTable: false });
    const carry = keepOverlap ? overlapTail(content) : "";
    buf = carry ? [carry] : [];
  };

  for (const b of toBlocks(pages)) {
    if (b.kind === "heading") {
      if (buf.length) emit(false);
      section = b.lines[0].slice(0, 140);
      if (!buf.length) bufPage = b.page;
      lastPage = b.page;
      continue;
    }
    if (b.kind === "table") {
      if (buf.length) emit(false);
      const lead = buf.join("\n").trim(); // short text right before the table (e.g. its caption)
      buf = [];
      splitTable(b.lines).forEach((part, i) =>
        chunks.push({ page: i === 0 && lead ? bufPage : b.page, pageEnd: b.page, section, content: i === 0 && lead ? `${lead}\n${part}` : part, isTable: true }),
      );
      bufPage = lastPage = b.page;
      continue;
    }
    // New page → new chunk (overlap kept), so every page's top starts a chunk.
    if (b.page !== lastPage && buf.join("\n").trim().length >= 30) emit(true);
    // Text block: pack paragraphs; split long ones recursively.
    const paragraph = b.lines.join("\n");
    const pieces = paragraph.length > TARGET ? splitRecursive(paragraph) : [paragraph];
    for (const piece of pieces) {
      const current = buf.join("\n");
      if (buf.length && current.length + piece.length > TARGET) emit(true);
      if (!buf.length || (buf.length === 1 && buf[0].length <= OVERLAP)) bufPage = b.page;
      buf.push(piece);
      lastPage = b.page;
    }
  }
  if (buf.length) emit(false, true);
  return chunks;
}

/** Text that gets embedded: document + section context line, then the chunk (contextual chunk header). */
export function embeddingText(docTitle: string, c: Chunk) {
  return `${docTitle} · p.${c.page}${c.section ? ` · ${c.section}` : ""}\n${c.content}`;
}
