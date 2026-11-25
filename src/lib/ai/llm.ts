import "server-only";
import { fanar } from "./fanar";
import { mistral } from "./mistral";
import type { ChatMsg, Completion, LlmProvider, StreamState } from "./provider";

// Every LLM call in the app goes through here (answers, question rewriting, starter questions).
//
//   MISTRAL_ENABLED=true  → Mistral first; if it fails, the same request goes to Fanar.
//   otherwise             → Fanar only (as before).
//
// A provider that fails (down, timed out, bad key) is skipped for 60 s, so while Mistral is down each question
// doesn't wait for it first. Rate limits (429) and request errors (400/422) only fall back for that one call.
// A stream falls back only if it fails before its first word — after that the user is already reading it.

export type { ChatMsg, StreamState };

const ON = /^(1|true|yes|on)$/i;
const COOLDOWN_MS = 60_000;
/** A primary that hasn't sent its first word by then is given up on, and the fallback gets the question. */
const FIRST_TOKEN_TIMEOUT_MS = 20_000;

const downUntil = new Map<string, number>();
let warned = false;

/** Providers in the order they are tried. */
export function llmChain(): LlmProvider[] {
  const chain: LlmProvider[] = [];
  if (ON.test(process.env.MISTRAL_ENABLED?.trim() ?? "")) {
    if (mistral.configured()) chain.push(mistral);
    else if (!warned) {
      warned = true;
      console.warn("[llm] MISTRAL_ENABLED is true but MISTRAL_API_KEY is empty — using Fanar only");
    }
  }
  if (fanar.configured() || !chain.length) chain.push(fanar);
  return chain;
}

/**
 * Prompt + answer budget: the smallest window in the chain, so a request built for Mistral still fits Fanar
 * when it has to fall back (16K with Fanar in the chain).
 */
export function contextTokens() {
  return Math.min(...llmChain().map((p) => p.contextTokens()));
}

const label = (p: LlmProvider) => `${p.name}/${p.model()}`;

/** Providers to try now: the chain minus ones cooling down after a failure (the last one is always kept). */
function attempts() {
  const chain = llmChain();
  const now = Date.now();
  const up = chain.filter((p) => (downUntil.get(p.name) ?? 0) <= now);
  return up.length ? up : chain.slice(-1);
}

function noteFailure(p: LlmProvider, e: unknown, next: LlmProvider) {
  const msg = e instanceof Error ? e.message : String(e);
  const status = Number(/^llm_(\d{3})/.exec(msg)?.[1]);
  const transient = status === 429 || status === 400 || status === 422;
  if (!transient) downUntil.set(p.name, Date.now() + COOLDOWN_MS);
  console.warn(`[llm] ${label(p)} failed (${msg.slice(0, 160)}) → ${label(next)}${transient ? "" : `; skipping ${p.name} for ${COOLDOWN_MS / 1000}s`}`);
}

const signals = (...s: (AbortSignal | undefined)[]) => AbortSignal.any(s.filter((x): x is AbortSignal => Boolean(x)));

/**
 * Streams the answer from the first provider that starts answering. `signal` cancels it (no fallback then);
 * `timeoutMs` is the time each provider gets for the whole stream.
 */
export async function streamChat(
  messages: ChatMsg[],
  opts: { maxTokens?: number; signal?: AbortSignal; state?: StreamState; timeoutMs?: number } = {},
): Promise<AsyncGenerator<string, void, unknown>> {
  const state = opts.state ?? { finishReason: null };
  const list = attempts();
  for (let i = 0; ; i++) {
    const p = list[i];
    const last = i === list.length - 1;
    const firstToken = new AbortController();
    const timer = last ? undefined : setTimeout(() => firstToken.abort(new Error(`no answer within ${FIRST_TOKEN_TIMEOUT_MS / 1000}s`)), FIRST_TOKEN_TIMEOUT_MS);
    try {
      state.finishReason = null;
      const stream = await p.streamChat(messages, {
        maxTokens: opts.maxTokens,
        state,
        signal: signals(opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 240_000), firstToken.signal),
      });
      // Wait for the first piece here, so a provider that fails before saying anything still falls back.
      const first = await stream.next();
      clearTimeout(timer);
      if (first.done && !last) throw new Error("llm_empty: the stream ended without any text");
      state.provider = label(p);
      return (async function* () {
        if (!first.done) yield first.value;
        yield* stream;
      })();
    } catch (e) {
      clearTimeout(timer);
      if (last || opts.signal?.aborted) throw firstToken.signal.aborted ? firstToken.signal.reason : e;
      noteFailure(p, firstToken.signal.aborted ? firstToken.signal.reason : e, list[i + 1]);
    }
  }
}

/** One-shot completion from the first provider that answers. `timeoutMs` is the time each provider gets. */
export async function completeChat(
  messages: ChatMsg[],
  opts: { maxTokens?: number; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Completion & { provider: string }> {
  const list = attempts();
  for (let i = 0; ; i++) {
    const p = list[i];
    try {
      const r = await p.completeChat(messages, { maxTokens: opts.maxTokens, signal: signals(opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 15_000)) });
      return { ...r, provider: label(p) };
    } catch (e) {
      if (i === list.length - 1 || opts.signal?.aborted) throw e;
      noteFailure(p, e, list[i + 1]);
    }
  }
}
