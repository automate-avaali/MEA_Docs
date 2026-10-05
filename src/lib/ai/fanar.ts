import "server-only";

// Fanar-C-2-27B (QCRI, Qatar) through its OpenAI-compatible API. Set FANAR_BASE_URL to your own vLLM
// server running QCRI/Fanar-2-27B-Instruct (Apache 2.0) to self-host — nothing else changes.
// Benchmarked: ~2.1 s fixed server overhead + prompt time → first token ≈ 3.5–4 s for ~550 prompt tokens,
// so the app keeps prompts small (top-8 chunks) and streams.

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

const base = () => (process.env.FANAR_BASE_URL || "https://api.fanar.qa/v1").replace(/\/$/, "");

export async function streamChat(messages: ChatMsg[], opts: { maxTokens?: number; signal?: AbortSignal } = {}) {
  const res = await fetch(`${base()}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.FANAR_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.FANAR_MODEL || "Fanar-C-2-27B",
      messages,
      stream: true,
      temperature: 0.1,
      max_tokens: opts.maxTokens ?? 900,
    }),
    signal: opts.signal ?? AbortSignal.timeout(90_000),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`llm_${res.status}: ${t.slice(0, 200)}`);
  }
  return (async function* () {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const j = JSON.parse(payload);
          if (j.error) throw new Error(j.error.message ?? "llm stream error");
          const d = j.choices?.[0]?.delta?.content;
          if (d) yield d as string;
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  })();
}
