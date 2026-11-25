import "server-only";
import { contextTokens, streamChat, type ChatMsg, type StreamState } from "../ai/llm";
import { normalizeTables } from "../text/tables";
import { annotateDigits, detectLang, type Lang } from "../text/arabic";
import { verifyAnswer } from "../text/verify";
import { namesNotPresent, signatureSummary } from "../text/signatures";
import type { Hit } from "./retrieve";

const LANG_NAME: Record<Lang, string> = { ar: "Arabic (العربية)", en: "English", ur: "Urdu (اردو)" };

export const NOT_FOUND: Record<Lang, string> = {
  en: "I couldn't find this in your documents.",
  ar: "لم أجد هذه المعلومة في مستنداتك.",
  ur: "مجھے یہ معلومات آپ کی دستاویزات میں نہیں ملی۔",
};

/** How to say a missing / unreadable name, per answer language. */
const NAME_NOT_PRESENT: Record<Lang, string> = { en: "name not present", ar: "الاسم غير موجود", ur: "نام موجود نہیں" };

/** Signature table header and yes / no, per answer language. */
const SIGNATURE_TABLE: Record<Lang, { header: string; yes: string; no: string }> = {
  en: { header: "Document | Party | Signed by hand | Signer | Stamp", yes: "Yes", no: "No" },
  ar: { header: "المستند | الطرف | موقّع بخط اليد | الموقّع | الختم", yes: "نعم", no: "لا" },
  ur: { header: "دستاویز | فریق | ہاتھ سے دستخط | دستخط کنندہ | مہر", yes: "ہاں", no: "نہیں" },
};

/** Extra rules for questions about signing — handwritten signatures come first (see ../text/signatures.ts). */
function signatureRules(lang: Lang) {
  const table = SIGNATURE_TABLE[lang];
  return `
10. This question is about SIGNATURES. When a "Signature summary" follows the sources, base the answer on it: it was built from the marks below with each party's Arabic and English columns already merged — keep its "signed by hand" / "NOT signed" status, signer and stamp for every line, and cite its source numbers.
   The scanned pages were read with these marks:
   [Handwritten signature — <party> — name: …] = that party signed by hand — "Signed by hand: Yes", ALSO when it says "name: not present" (then only the name is missing: write "${NAME_NOT_PRESENT[lang]}" as the signer). [No signature — <party>] = the signature place is empty (not signed). [Stamp: …] = company stamp/seal. [Handwritten: …] = other handwriting. Older readings may show "[Signature]" or "Signature: [illegible]" — both mean a handwritten signature is there; "[Stamp of …]" is a stamp.
   Answer from the signature-block sources FIRST, for each document and each party (First Party / الطرف الأول, Second Party / الطرف الثاني): signed by hand or not, the signer's name (from the mark or the "Represented by / ويمثلها السيد" line), the stamp, and any handwritten date. For several documents or parties use a table with exactly this header: "${table.header}", writing "${table.yes}" / "${table.no}" in the signed column.
   A party counts as signed when ANY of its sources — the Arabic or the English column — shows a handwritten signature; an empty label in the other language column does not mean it is unsigned.
   Clauses such as "signed by both parties" or "executed in two counterparts" are contract terms, not proof of signing. If a document has no signature-block source, say its signature page was not found in the sources.`;
}

function systemPrompt(lang: Lang, signatures = false) {
  return `You are Avagama MiddleEast Docs, an assistant that answers questions about the user's own uploaded documents (contracts, invoices, agreements — often bilingual Arabic/English).
Rules:
1. Use ONLY the numbered sources provided. Answer with everything the sources do contain, even if it only partly answers the question, and say in one short sentence what is not covered. Reply exactly "${NOT_FOUND[lang]}" ONLY when none of the sources is relevant to the question.
2. Write the whole answer in ${LANG_NAME[lang]}, even if the sources are in another language.
3. Copy names, numbers, amounts, dates, IDs and product codes EXACTLY as they appear in the sources. Never invent or convert dates.
   A person's name shown as [illegible], "illegible" or "not present" in the sources: write "${NAME_NOT_PRESENT[lang]}" — never "illegible", and never guess a name.
4. Put the source number in square brackets after each fact, like [1] or [2][3]. Cite at most 3 sources per fact — the most relevant ones. Only use numbers of sources that exist.
   Several sources may come from different documents with the same template; only when their values are identical, say so once instead of listing each.
   Values that each document has its own version of (ID / contract number, customer, names, dates, amounts): when the sources come from several documents, give the value for EACH document, e.g. a table "Document | Value". Never claim documents share a value unless every one of those sources shows exactly that value.
   Group by DOCUMENT, not by source: refer to a document by its name (the title before " — page"), never as "Document [3]" or "Source [3]"; one line/row per document, even when several sources come from it. Never repeat the same statement for each source — say it once and cite up to 3 sources.
5. Lead with the direct answer, then short supporting details. Use a bullet list or a Markdown table when comparing several items.
6. When you take values from a table in the sources, keep every value with its own row label (e.g. the product/pack) and its own column header (e.g. "Slab A Volume"). Never turn columns into rows or mix values from different rows. When the answer comes from a table (slabs, prices, rates, quantities), answer with a Markdown table that uses the same row labels and column headers as the source table.
   Markdown tables: one header row, then a separator row (| --- | --- |), then EACH data row on its own line. Every row must have the same number of columns as the header. Keep each value in its own column (for example Volume and Off-Invoice are separate columns). When comparing several documents, add a "Document" column instead of writing a new table per document.
7. Never stop early or summarise with "etc." — when asked for a full list or table, include every row from the sources.
8. Each source is labelled with its document and page. The text at the start of the first source of a page is the top of that page (letterhead, contract/reference numbers, dates). When the sources come from several documents, keep facts with their document and name it.
9. The user may refer to earlier turns of the conversation ("this", "it", "the same for…"); the question line shows how it was understood. Use the conversation only to understand the question — facts must come from the sources.${signatures ? signatureRules(lang) : ""}`;
}

export function formatSources(hits: Hit[]) {
  return hits
    .map((h, i) => {
      const pages = h.pageEnd && h.pageEnd !== h.page ? `pages ${h.page}-${h.pageEnd}` : `page ${h.page}`;
      return `[${i + 1}] ${h.docTitle} — ${pages}${h.section ? ` — ${h.section}` : ""}\n${annotateDigits(normalizeTables(namesNotPresent(h.content)))}`;
    })
    .join("\n\n");
}

// ── Token budget ────────────────────────────────────────────────────────────────────────────────────────
// The budget is the LLM chain's smallest window (../ai/llm.ts): Fanar-C-2-27B's 16,000 tokens in total (prompt +
// answer) whenever Fanar is in the chain, so a Mistral request that falls back to Fanar still fits. The prompt
// gets the rules, up to the last 10 Q&A pairs of the thread, and as many of the 20 reranked sources as fit (best
// first); the answer keeps at least 3,000 tokens (longer answers continue automatically). Chars-per-token
// calibrated against Fanar's own token counts on the OCR'd contracts (scripts/eval-chat.mjs prints the check).
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
const AR_CHARS_PER_TOKEN = 2.6;
const OTHER_CHARS_PER_TOKEN = 3.4;
const ANSWER_RESERVE = 3000;
const SAFETY = 400;
const HISTORY_BUDGET = 2500;
const MAX_PAIRS = 10;
const SIGNATURE_SUMMARY_RESERVE = 700; // one line per document and party (signature questions)

export function estimateTokens(s: string) {
  const ar = s.match(ARABIC)?.length ?? 0;
  return Math.ceil(ar / AR_CHARS_PER_TOKEN + (s.length - ar) / OTHER_CHARS_PER_TOKEN) + 4;
}

/** Thread memory: the last 10 Q&A pairs; the oldest are dropped first when the budget is tight. */
export function trimHistory(history: ChatMsg[]) {
  const recent = history.slice(-MAX_PAIRS * 2).map((m) => ({ ...m, content: m.role === "assistant" ? m.content.slice(0, 1200) : m.content.slice(0, 600) }));
  const out: ChatMsg[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = estimateTokens(recent[i].content) + 4;
    if (used + t > HISTORY_BUDGET) break;
    used += t;
    out.unshift(recent[i]);
  }
  while (out.length && out[0].role !== "user") out.shift(); // start on a question
  return out;
}

/** Keeps the best-ranked sources that fit in the prompt next to the rules, thread and question. */
export function fitSources(hits: Hit[], opts: { lang: Lang; history: ChatMsg[]; question: string; signatures?: boolean }) {
  const fixed = (opts.signatures ? SIGNATURE_SUMMARY_RESERVE : 0) + estimateTokens(systemPrompt(opts.lang, opts.signatures)) + opts.history.reduce((n, m) => n + estimateTokens(m.content) + 4, 0) + estimateTokens(opts.question) * 2 + 60;
  let room = contextTokens() - ANSWER_RESERVE - SAFETY - fixed;
  const kept: Hit[] = [];
  for (const h of hits) {
    const t = estimateTokens(normalizeTables(h.content)) + 30;
    if (t > room) continue; // a smaller, lower-ranked source may still fit
    room -= t;
    kept.push(h);
  }
  return kept;
}

const maxTokensFor = (messages: ChatMsg[]) => Math.min(4000, contextTokens() - SAFETY - messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0));

export type AnswerEvent =
  | { t: "delta"; d: string }
  | { t: "verify"; issues: string[] }
  /** `llm`: who wrote the answer, e.g. "mistral/mistral-small-latest" ("a + b" if a continuation fell back). */
  | { t: "done"; text: string; firstTokenMs: number; llmMs: number; retried: boolean; llm: string };

/**
 * Streams the answer. The first ~80 characters are held back and language-checked: if the model drifted
 * into another language (seen with Fanar-S answering Arabic questions in English) the request is aborted
 * and retried once with a firmer instruction, before the user sees anything.
 */
export async function* answer(opts: { question: string; standalone?: string; lang: Lang; hits: Hit[]; history: ChatMsg[]; signatures?: boolean }): AsyncGenerator<AnswerEvent> {
  const t0 = Date.now();
  const context = formatSources(opts.hits);
  const understood = opts.standalone && opts.standalone.trim() !== opts.question.trim() ? `\n(Understood as: ${opts.standalone})` : "";
  const summary = opts.signatures ? signatureSummary(opts.hits) : "";
  const signatureBlock = summary ? `Signature summary (from the signature marks in the sources above):\n${summary}\n\n` : "";
  const base: ChatMsg[] = [
    { role: "system", content: systemPrompt(opts.lang, opts.signatures) },
    ...opts.history,
    { role: "user", content: `Sources:\n${context}\n\n${signatureBlock}Question: ${opts.question}${understood}` },
  ];

  let text = "";
  let firstTokenMs = 0;
  let retried = false;
  const state: StreamState = { finishReason: null };
  const used = new Set<string>();
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const messages =
      attempt === 0
        ? base
        : [...base.slice(0, -1), { role: "user" as const, content: `${base[base.length - 1].content}\n\nRespond ONLY in ${LANG_NAME[opts.lang]}.` }];
    const stream = await streamChat(messages, { state, maxTokens: maxTokensFor(messages), signal: ctrl.signal, timeoutMs: 240_000 });
    let held = "";
    let released = false;
    let wrongLanguage = false;
    text = "";
    for await (const d of stream) {
      if (!firstTokenMs) firstTokenMs = Date.now() - t0;
      text += d;
      if (released) {
        yield { t: "delta", d };
        continue;
      }
      held += d;
      const probe = held.replace(/\[\d+\]/g, "").replace(/[\d\s.,:;()\-|*#]/g, "");
      if (probe.length >= 40 || held.length >= 120) {
        if (attempt === 0 && detectLang(held, opts.lang) !== opts.lang) {
          wrongLanguage = true;
          ctrl.abort();
          break;
        }
        released = true;
        yield { t: "delta", d: held };
      }
    }
    if (wrongLanguage) {
      retried = true;
      continue;
    }
    if (state.provider) used.add(state.provider);
    if (!released && held) yield { t: "delta", d: held };
    break;
  }

  // Never truncate: if the model stopped at the token limit, ask it to carry on from the exact point.
  for (let more = 0; more < 2 && state.finishReason === "length"; more++) {
    state.finishReason = null;
    const contMessages: ChatMsg[] = [
      ...base,
      { role: "assistant", content: text },
      { role: "user", content: "Continue exactly where you stopped. Do not repeat anything already written. If you stopped inside a table, continue with the next table row (no new header)." },
    ];
    const room = maxTokensFor(contMessages);
    if (room < 400) break; // the context window is full
    const cont = await streamChat(contMessages, { state, maxTokens: room, timeoutMs: 240_000 });
    if (state.provider) used.add(state.provider);
    const glue = text.endsWith("\n") ? "" : "\n";
    let first = true;
    for await (const d of cont) {
      const piece = first ? glue + d.replace(/^\s+/, "") : d;
      first = false;
      text += piece;
      yield { t: "delta", d: piece };
    }
  }

  const { issues } = verifyAnswer({ question: opts.question, answer: text, context, sourceCount: opts.hits.length, expectedLang: opts.lang });
  if (issues.length) yield { t: "verify", issues };
  yield { t: "done", text, firstTokenMs, llmMs: Date.now() - t0, retried, llm: [...used].join(" + ") };
}
