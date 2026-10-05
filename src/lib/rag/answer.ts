import "server-only";
import { streamChat, type ChatMsg, type StreamState } from "../ai/fanar";
import { normalizeTables } from "../text/tables";
import { detectLang, type Lang } from "../text/arabic";
import { verifyAnswer } from "../text/verify";
import type { Hit } from "./retrieve";

const LANG_NAME: Record<Lang, string> = { ar: "Arabic (العربية)", en: "English", ur: "Urdu (اردو)" };

export const NOT_FOUND: Record<Lang, string> = {
  en: "I couldn't find this in your documents.",
  ar: "لم أجد هذه المعلومة في مستنداتك.",
  ur: "مجھے یہ معلومات آپ کی دستاویزات میں نہیں ملی۔",
};

function systemPrompt(lang: Lang) {
  return `You are mea.docs, an assistant that answers questions about the user's own uploaded documents (contracts, invoices, agreements — often bilingual Arabic/English).
Rules:
1. Use ONLY the numbered sources provided. If they do not contain the answer, reply exactly: "${NOT_FOUND[lang]}"
2. Write the whole answer in ${LANG_NAME[lang]}, even if the sources are in another language.
3. Copy names, numbers, amounts, dates, IDs and product codes EXACTLY as they appear in the sources. Never invent or convert dates.
4. Put the source number in square brackets after each fact, like [1] or [2][3]. Cite at most 3 sources per fact — the most relevant ones. Only use numbers of sources that exist.
   Several sources may come from different documents with the same template; when they agree, say so once instead of listing each.
5. Lead with the direct answer, then short supporting details. Use a bullet list or a Markdown table when comparing several items.
6. Markdown tables: one header row, then a separator row (| --- | --- |), then EACH data row on its own line. Every row must have the same number of columns as the header. Keep each value in its own column (for example Volume and Off-Invoice are separate columns). When comparing several documents, add a "Document" column instead of writing a new table per document.
7. Never stop early or summarise with "etc." — when asked for a full list or table, include every row from the sources.`;
}

export function formatSources(hits: Hit[]) {
  return hits
    .map((h, i) => {
      const pages = h.pageEnd && h.pageEnd !== h.page ? `pages ${h.page}-${h.pageEnd}` : `page ${h.page}`;
      return `[${i + 1}] ${h.docTitle} — ${pages}${h.section ? ` — ${h.section}` : ""}\n${normalizeTables(h.content)}`;
    })
    .join("\n\n");
}

// Follow-up markers: pronouns / "and what about…" in English, Arabic and Urdu. Length alone is NOT a signal —
// "معاہدے کی مدت کیا ہے؟" is short but self-contained (merging it with the previous question broke retrieval).
const FOLLOW_UP =
  /^(and|also|what about|how about|same for)\b|\b(it|its|that one|this one|they|them|those|these)\b|^(و|وماذا|ماذا عن|وكذلك|وهل|اور|اس کا|اس کی|ان کا)|(ذلك|هذا|هذه|تلك|ها)\s*[؟?]?$/i;

/**
 * Queries to retrieve with. Standalone questions → [question]. Follow-ups ("and the second party?",
 * "وماذا عن السعر؟") → [question, previous question + question]; both are searched and fused.
 */
export function retrievalQueries(question: string, history: { role: string; content: string }[]) {
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content;
  return lastUser && FOLLOW_UP.test(question.trim()) ? [question, `${lastUser}\n${question}`] : [question];
}

export type AnswerEvent =
  | { t: "delta"; d: string }
  | { t: "verify"; issues: string[] }
  | { t: "done"; text: string; firstTokenMs: number; llmMs: number; retried: boolean };

/**
 * Streams the answer. The first ~80 characters are held back and language-checked: if the model drifted
 * into another language (seen with Fanar-S answering Arabic questions in English) the request is aborted
 * and retried once with a firmer instruction, before the user sees anything.
 */
export async function* answer(opts: { question: string; lang: Lang; hits: Hit[]; history: ChatMsg[] }): AsyncGenerator<AnswerEvent> {
  const t0 = Date.now();
  const context = formatSources(opts.hits);
  const base: ChatMsg[] = [
    { role: "system", content: systemPrompt(opts.lang) },
    ...opts.history.map((m) => ({ ...m, content: m.content.slice(0, 700) })),
    { role: "user", content: `Sources:\n${context}\n\nQuestion: ${opts.question}` },
  ];

  let text = "";
  let firstTokenMs = 0;
  let retried = false;
  const state: StreamState = { finishReason: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const messages =
      attempt === 0
        ? base
        : [...base.slice(0, -1), { role: "user" as const, content: `${base[base.length - 1].content}\n\nRespond ONLY in ${LANG_NAME[opts.lang]}.` }];
    const stream = await streamChat(messages, { state, signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(240_000)]) });
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
    if (!released && held) yield { t: "delta", d: held };
    break;
  }

  // Never truncate: if the model stopped at the token limit, ask it to carry on from the exact point.
  for (let more = 0; more < 2 && state.finishReason === "length"; more++) {
    state.finishReason = null;
    const cont = await streamChat(
      [...base, { role: "assistant", content: text }, { role: "user", content: "Continue exactly where you stopped. Do not repeat anything already written. If you stopped inside a table, continue with the next table row (no new header)." }],
      { state, signal: AbortSignal.timeout(240_000) },
    );
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
  yield { t: "done", text, firstTokenMs, llmMs: Date.now() - t0, retried };
}
