import "server-only";
import crypto from "node:crypto";

// BAAI/bge-m3 (1024-dim, 8K tokens, MIT). ONE model only — never fall back to a different embedding model,
// because vectors from another model live in a different space and silently break retrieval. What CAN change
// is who serves it: every provider below runs the same bge-m3 weights (checked: a self-hosted TEI server gives
// cosine 1.00000 against the vectors stored from the Hugging Face API), so they are interchangeable.
//
// Providers, tried in this order (only the ones configured):
//   1. EMBED_URL            — your own Text-Embeddings-Inference server / HF Inference Endpoint (".../embed")
//   2. CF_ACCOUNT_ID + CF_API_TOKEN — Cloudflare Workers AI @cf/baai/bge-m3 (free daily allowance)
//   3. DEEPINFRA_API_KEY    — DeepInfra BAAI/bge-m3 (pay-as-you-go, very cheap)
//   4. HF_TOKEN             — Hugging Face Inference Providers (needs credits / PRO)
// A provider that answers 401/402/403 (bad key, out of credits) is skipped for 10 minutes and the next one is
// used, so one exhausted account never takes embeddings down.

export const EMBED_MODEL = "BAAI/bge-m3";
export const EMBED_DIMS = 1024;
const BATCH = 16;
const CONCURRENCY = 4;
const MAX_CHARS = 8000;
const DEAD_FOR_MS = 10 * 60_000;

type Provider = { name: string; call: (texts: string[], signal: AbortSignal) => Promise<Response>; parse: (j: unknown) => unknown };

function providers(): Provider[] {
  const list: Provider[] = [];
  const own = process.env.EMBED_URL?.trim();
  if (own) {
    list.push({
      name: "tei",
      call: (texts, signal) =>
        fetch(own, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(process.env.EMBED_TOKEN ? { Authorization: `Bearer ${process.env.EMBED_TOKEN}` } : {}) },
          body: JSON.stringify({ inputs: texts, truncate: true }),
          signal,
        }),
      parse: (j) => j,
    });
  }
  const cfAccount = process.env.CF_ACCOUNT_ID?.trim(), cfToken = process.env.CF_API_TOKEN?.trim();
  if (cfAccount && cfToken) {
    list.push({
      name: "cloudflare",
      call: (texts, signal) =>
        fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/ai/run/@cf/baai/bge-m3`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: texts }),
          signal,
        }),
      parse: (j) => (j as { result?: { data?: number[][] } }).result?.data,
    });
  }
  const deepinfra = process.env.DEEPINFRA_API_KEY?.trim();
  if (deepinfra) {
    list.push({
      name: "deepinfra",
      call: (texts, signal) =>
        fetch("https://api.deepinfra.com/v1/openai/embeddings", {
          method: "POST",
          headers: { Authorization: `Bearer ${deepinfra}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: EMBED_MODEL, input: texts, encoding_format: "float" }),
          signal,
        }),
      parse: (j) => (j as { data?: { embedding: number[] }[] }).data?.map((d) => d.embedding),
    });
  }
  const hf = process.env.HF_TOKEN?.trim();
  if (hf) {
    list.push({
      name: "huggingface",
      call: (texts, signal) =>
        fetch("https://router.huggingface.co/hf-inference/models/BAAI/bge-m3/pipeline/feature-extraction", {
          method: "POST",
          headers: { Authorization: `Bearer ${hf}`, "Content-Type": "application/json", "x-wait-for-model": "true" },
          body: JSON.stringify({ inputs: texts }),
          signal,
        }),
      parse: (j) => j,
    });
  }
  return list;
}

const g = globalThis as unknown as { _embedDead?: Map<string, number>; _qcache?: Map<string, number[]> };
const dead = (g._embedDead ??= new Map());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalizeVec(v: number[]) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** Status of the embedding setup, for logs / health checks. */
export function embeddingProviders() {
  return providers().map((p) => ({ name: p.name, skippedUntil: dead.get(p.name) ?? null }));
}

async function embedBatch(texts: string[], deadline: number): Promise<number[][]> {
  const inputs = texts.map((t) => t.slice(0, MAX_CHARS));
  const all = providers();
  if (!all.length) throw new Error("embedding_failed_no_provider");
  let lastError = "embedding_failed_0";
  for (let attempt = 1; ; attempt++) {
    const live = all.filter((p) => (dead.get(p.name) ?? 0) < Date.now());
    // Every provider is out of credits / unauthorised → fail fast with the reason (no pointless retries).
    if (!live.length) throw new Error(lastError);
    for (const p of live) {
      let status = 0;
      let retryAfter = 0;
      try {
        const res = await p.call(inputs, AbortSignal.timeout(Math.max(5_000, Math.min(60_000, deadline - Date.now()))));
        status = res.status;
        retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
        if (res.ok) {
          let data = p.parse(await res.json()) as number[][] | number[];
          if (inputs.length === 1 && typeof (data as number[])?.[0] === "number") data = [data as number[]];
          const vecs = data as number[][];
          if (!Array.isArray(vecs) || vecs.length !== inputs.length || vecs[0]?.length !== EMBED_DIMS) throw new Error(`embedding response from ${p.name} has the wrong shape`);
          return vecs.map(normalizeVec);
        }
        const body = (await res.text().catch(() => "")).slice(0, 160);
        lastError = `embedding_failed_${status}`;
        if (status === 401 || status === 402 || status === 403) {
          dead.set(p.name, Date.now() + DEAD_FOR_MS);
          console.error(`[embed] ${p.name} unavailable (${status}${status === 402 ? " — out of credits" : ""}): ${body} → trying the next provider`);
          continue;
        }
        console.warn(`[embed] ${p.name} ${status}: ${body}`);
      } catch (e) {
        lastError = (e as Error).name === "TimeoutError" ? "embedding_failed_timeout" : `embedding_failed_${status}`;
        console.warn(`[embed] ${p.name} error: ${(e as Error).message}`);
      }
      if (retryAfter && Date.now() + retryAfter < deadline) await sleep(retryAfter);
    }
    const wait = Math.min(8_000, 800 * 2 ** attempt);
    if (Date.now() + wait >= deadline) throw new Error(lastError);
    await sleep(wait);
  }
}

/**
 * Embeds many texts: batches of 16, 4 requests in flight. Never all-or-nothing — returns one vector per text,
 * or null where its batch failed, and reports each finished batch through `onBatch` so callers can save it
 * immediately.
 */
export async function embedManyPartial(
  texts: string[],
  opts: { budgetMs?: number; onBatch?: (start: number, vectors: number[][]) => Promise<void> | void } = {},
): Promise<{ vectors: (number[] | null)[]; error: string | null }> {
  const deadline = Date.now() + (opts.budgetMs ?? 40_000);
  const out: (number[] | null)[] = new Array(texts.length).fill(null);
  const starts: number[] = [];
  for (let i = 0; i < texts.length; i += BATCH) starts.push(i);
  let next = 0;
  let error: string | null = null;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, starts.length) }, async () => {
      while (next < starts.length && !error?.match(/40[123]|no_provider/)) {
        const start = starts[next++];
        if (Date.now() >= deadline) {
          error ??= "embedding_failed_timeout";
          return;
        }
        try {
          const vecs = await embedBatch(texts.slice(start, start + BATCH), deadline);
          vecs.forEach((v, k) => (out[start + k] = v));
          await opts.onBatch?.(start, vecs);
        } catch (e) {
          error ??= (e as Error).message;
        }
      }
    }),
  );
  return { vectors: out, error };
}

/** All-or-nothing variant (queries, scripts). */
export async function embedMany(texts: string[], budgetMs = 40_000): Promise<number[][]> {
  const { vectors, error } = await embedManyPartial(texts, { budgetMs });
  if (vectors.some((v) => !v)) throw new Error(error ?? "embedding_failed_0");
  return vectors as number[][];
}

// Query embeddings are cached in memory: repeated / similar follow-up questions skip the network call.
const qcache = (g._qcache ??= new Map());

export async function embedQuery(text: string): Promise<number[]> {
  const key = crypto.createHash("sha1").update(text.trim().toLowerCase()).digest("hex");
  const hit = qcache.get(key);
  if (hit) return hit;
  const [v] = await embedMany([text], 10_000);
  qcache.set(key, v);
  if (qcache.size > 2000) qcache.delete(qcache.keys().next().value!);
  return v;
}
