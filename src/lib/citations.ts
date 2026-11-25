// Citations in chat answers, Copilot-style: the model sees up to 20 numbered sources and cites them as [n];
// the UI renumbers the cited ones 1, 2, 3… in order of first appearance, merges citations that point at the
// same page of the same document, and lists the top 3 under the answer (the rest behind "+N more").
// Shared by the chat view and the source viewer (browser-only, no server imports).

import { searchNormalize } from "./text/arabic";
import { namesNotPresent } from "./text/signatures";

export type Source = {
  n: number;
  documentId: string;
  chunkId?: string;
  title: string;
  page: number;
  pageEnd?: number;
  section: string;
  snippet: string;
  score: number;
};

/** One entry of the reference list: a page of a document, cited through one or more sources. */
export type Reference = {
  k: number; // number shown to the user
  documentId: string;
  title: string;
  page: number;
  pageEnd: number;
  section: string;
  snippet: string;
  sources: Source[];
};

const CITE = /\[(\d{1,2})\]/g;

/**
 * References in the order the answer first cites them. `display` maps the model's source number → shown number.
 * An answer with no citations at all falls back to the 3 best-ranked sources (no inline markers to map).
 */
export function buildReferences(answer: string, sources: Source[] | undefined, opts: { fallback: boolean }) {
  const display = new Map<number, number>();
  const refs: Reference[] = [];
  if (!sources?.length) return { refs, display };
  const byN = new Map(sources.map((s) => [s.n, s]));
  const keyOf = (s: Source) => `${s.documentId}:${s.page}`;
  const byKey = new Map<string, Reference>();

  const add = (s: Source) => {
    let ref = byKey.get(keyOf(s));
    if (!ref) {
      ref = { k: refs.length + 1, documentId: s.documentId, title: s.title, page: s.page, pageEnd: s.pageEnd ?? s.page, section: s.section, snippet: s.snippet, sources: [] };
      byKey.set(keyOf(s), ref);
      refs.push(ref);
    }
    if (!ref.sources.includes(s)) {
      ref.sources.push(s);
      ref.pageEnd = Math.max(ref.pageEnd, s.pageEnd ?? s.page);
    }
    display.set(s.n, ref.k);
  };

  for (const m of answer.matchAll(CITE)) {
    const s = byN.get(Number(m[1]));
    if (s && !display.has(s.n)) add(s);
  }
  if (!refs.length && opts.fallback) [...sources].sort((a, b) => a.n - b.n).slice(0, 3).forEach(add);
  return { refs, display };
}

const CITE_RUN = /(?:\[\d{1,2}\])+/g;

/** Rewrites each run of markers like [4][5]: shown numbers, a number only once per run (merged pages). */
function mapRuns(answer: string, display: Map<number, number>, fmt: (k: number, n: number) => string) {
  return answer.replace(CITE_RUN, (run) => {
    const seen = new Set<number>();
    let out = "";
    for (const m of run.matchAll(CITE)) {
      const n = Number(m[1]);
      const k = display.get(n);
      if (!k) out += m[0]; // unknown number: left as text
      else if (!seen.has(k)) {
        seen.add(k);
        out += fmt(k, n);
      }
    }
    return out;
  });
}

/** Answer Markdown with [n] → [k](#src-n) links (k = shown number); unknown numbers are left as text. */
export function linkCitations(answer: string, display: Map<number, number>) {
  return mapRuns(answer, display, (k, n) => `[${k}](#src-${n})`);
}

/** Plain-text copy of the answer with the shown numbers. */
export function renumberPlain(answer: string, display: Map<number, number>) {
  return mapRuns(answer, display, (k) => `[${k}]`);
}

/** Passage text for display: Markdown tables → readable "cell · cell" rows, no separator lines or tags; unreadable names → "not present". */
export const cleanSnippet = (s: string) =>
  namesNotPresent(s)
    .split("\n")
    .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))
    .map((l) => (/^\s*\|/.test(l) ? l.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" · ") : l))
    .join("\n")
    .replace(/<br\s*\/?>/gi, " / ")
    .replace(/\*\*/g, "")
    .trim();

// ── Highlighting ────────────────────────────────────────────────────────────────────────────────────────
const STOP = new Set(
  (
    "by of in on to is as at an or it be if no so do we us he my " +
    "the and for with this that from are was were has have had which who whom whose what when where been being into onto upon over under " +
    "than then also such each other their there these those its his her our your not but all any can may shall will would should " +
    "page document documents source sources " +
    "في من على الى عن مع هذا هذه ذلك تلك التي الذي الذين وفي او ان كان كانت تم بين عند كل غير قد لا ما هو هي هم وهو وهي ولا " +
    "میں سے کے کی کو اور یہ وہ ہے ہیں تھا تھی پر"
  )
    .split(" ")
    .map((w) => searchNormalize(w)),
);

/** Normalised search tokens (Arabic letter variants folded, Arabic-Indic digits → 0-9), stop words dropped. */
export function tokens(s: string): string[] {
  return searchNormalize(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Words worth highlighting for a reference: tokens of the answer lines that cite it (names, numbers, dates —
 * what the answer actually took from the page) that also occur in the cited passage.
 */
export function factTokens(answer: string, ref: Reference, passage: string): Set<string> {
  const ns = new Set(ref.sources.map((s) => s.n));
  const inPassage = new Set(tokens(passage));
  const out = new Set<string>();
  for (const line of answer.split(/\n|(?<=[.!?؟。])\s+/)) {
    const cited = [...line.matchAll(CITE)].some((m) => ns.has(Number(m[1])));
    if (!cited) continue;
    for (const t of tokens(line.replace(CITE, " "))) if (inPassage.has(t)) out.add(t);
  }
  return out;
}

// ── Highlight boxes on a rendered PDF page (from pdf.js text content) ──
export type PageTextItem = { str: string; transform: number[]; width: number; height: number };
export type HighlightBox = { x: number; y: number; w: number; h: number; fact: boolean };
const PRES = /[ﭐ-﷿ﹰ-﻿]/; // Arabic presentation forms: stored in visual order → also try the reversed string

function itemTokens(str: string) {
  const out = new Set(tokens(str.normalize("NFKC")));
  if (PRES.test(str)) for (const t of tokens([...str].reverse().join("").normalize("NFKC"))) out.add(t);
  return [...out];
}

/**
 * Where the cited passage sits on the page: the densest run of text items (in reading order) whose words come
 * from the passage → light boxes; items carrying the answer's facts (names, numbers, dates) → strong boxes.
 * Coordinates are in viewport pixels. Scanned pages have no text items → no boxes.
 */
export function highlightBoxes(
  items: PageTextItem[],
  viewport: { transform: number[]; scale: number },
  transform: (a: number[], b: number[]) => number[],
  passage: Set<string>,
  facts: Set<string>,
): HighlightBox[] {
  const toks = items.map((it) => itemTokens(it.str));
  const hits = toks.map((ts) => ts.filter((t) => passage.has(t)).length);
  const inPassage = toks.map((ts, i) => ts.length > 0 && hits[i] / ts.length >= 0.5);

  // Densest run of matching items (≤ 2 non-matching items in a row inside it).
  let best = { start: -1, end: -1, score: 0 };
  let cur = { start: -1, end: -1, score: 0, gap: 0 };
  toks.forEach((ts, i) => {
    if (!ts.length) return;
    if (inPassage[i]) {
      if (cur.start < 0) cur = { start: i, end: i, score: 0, gap: 0 };
      cur.end = i;
      cur.score += hits[i];
      cur.gap = 0;
      if (cur.score > best.score) best = { start: cur.start, end: cur.end, score: cur.score };
    } else if (cur.start >= 0 && ++cur.gap > 2) cur = { start: -1, end: -1, score: 0, gap: 0 };
  });
  const runOk = best.score >= Math.min(4, passage.size);

  const isFact = (i: number) => toks[i].some((t) => facts.has(t));
  const inRun = (i: number) => runOk && i >= best.start && i <= best.end;
  let factIdx = items.map((_, i) => i).filter((i) => inRun(i) && isFact(i));
  if (!factIdx.length) factIdx = items.map((_, i) => i).filter(isFact).slice(0, 12); // facts may sit outside the run

  const box = (i: number, fact: boolean): HighlightBox => {
    const it = items[i];
    const tx = transform(viewport.transform, it.transform);
    const h = Math.hypot(tx[2], tx[3]) || it.height * viewport.scale;
    return { x: tx[4] - 2, y: tx[5] - h - 1, w: it.width * viewport.scale + 4, h: h + 3, fact };
  };
  const out: HighlightBox[] = [];
  if (runOk) for (let i = best.start; i <= best.end; i++) if (inPassage[i]) out.push(box(i, false));
  for (const i of factIdx) out.push(box(i, true));
  return out;
}

/** Splits text into [text, highlighted?] parts, marking whole words whose tokens are in `words`. */
export function markWords(text: string, words: Set<string>): [string, boolean][] {
  if (!words.size) return [[text, false]];
  const parts: [string, boolean][] = [];
  for (const piece of text.split(/([\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*)/u)) {
    if (!piece) continue;
    const hit = /[\p{L}\p{N}]/u.test(piece) && tokens(piece).some((t) => words.has(t));
    const last = parts[parts.length - 1];
    if (last && last[1] === hit) last[0] += piece;
    else parts.push([piece, hit]);
  }
  return parts;
}
