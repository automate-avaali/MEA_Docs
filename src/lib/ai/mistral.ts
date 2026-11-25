import "server-only";
import type { ChatMsg, Completion, LlmProvider, StreamState } from "./provider";

// Mistral (La Plateforme), mistral-small-latest by default. Used first when MISTRAL_ENABLED=true (see ./llm.ts).
// Same request/stream shape as OpenAI's (and Fanar's): POST /chat/completions, then SSE lines
// `data: {"choices":[{"delta":{"content":"…"}}]}` ending with `data: [DONE]`. Differences handled here:
//   • `content` can be an array of parts on reasoning models — only the "text" parts are the answer
//   • finish reason "model_length" (context window full) is reported as "length", like a max_tokens stop
// Measured with mistral-small-latest (= mistral-small-2603, 262K context): ~0.5 s to the first token.

const base = () => (process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1").replace(/\/$/, "");
const model = () => process.env.MISTRAL_MODEL || "mistral-small-latest";
const headers = () => ({ Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`, "Content-Type": "application/json" });

function partText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
  return "";
}

async function fail(res: Response): Promise<never> {
  const t = await res.text().catch(() => "");
  throw new Error(`llm_${res.status}: ${t.slice(0, 200)}`);
}

export async function streamChat(messages: ChatMsg[], opts: { maxTokens?: number; signal?: AbortSignal; state?: StreamState } = {}) {
  const state = opts.state ?? { finishReason: null };
  const res = await fetch(`${base()}/chat/completions`, {
    method: "POST",
    headers: { ...headers(), Accept: "text/event-stream" },
    body: JSON.stringify({ model: model(), messages, stream: true, temperature: 0.1, max_tokens: opts.maxTokens ?? 4000 }),
    signal: opts.signal ?? AbortSignal.timeout(240_000),
  });
  if (!res.ok || !res.body) await fail(res);
  const reader = res.body!.getReader();
  return (async function* () {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue; // blank separators, ": keep-alive" comments
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          let j;
          try {
            j = JSON.parse(payload);
          } catch {
            continue;
          }
          if (j.error || j.object === "error") throw new Error(`llm_stream: ${j.error?.message ?? j.message ?? "mistral stream error"}`);
          const choice = j.choices?.[0];
          if (choice?.finish_reason) state.finishReason = choice.finish_reason === "model_length" ? "length" : choice.finish_reason;
          const d = partText(choice?.delta?.content);
          if (d) yield d;
        }
      }
    } finally {
      reader.cancel().catch(() => {}); // stopped early (language retry, error) → close the connection
    }
  })();
}

export async function completeChat(messages: ChatMsg[], opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<Completion> {
  const res = await fetch(`${base()}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: model(), messages, temperature: 0, max_tokens: opts.maxTokens ?? 400 }),
    signal: opts.signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) await fail(res);
  const j = await res.json();
  return { text: partText(j.choices?.[0]?.message?.content), usage: j.usage };
}

export const mistral: LlmProvider = {
  name: "mistral",
  model,
  // Only matters when Mistral runs without Fanar: with Fanar as the fallback, prompts are sized for Fanar's
  // 16K window so a fallback never overflows (see ./llm.ts). Kept well under the key's 100K tokens/minute.
  contextTokens: () => Number(process.env.MISTRAL_CONTEXT_TOKENS) || 32_000,
  configured: () => Boolean(process.env.MISTRAL_API_KEY),
  streamChat,
  completeChat,
};
