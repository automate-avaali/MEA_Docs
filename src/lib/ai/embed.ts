import "server-only";
import crypto from "node:crypto";

// BAAI/bge-m3 (1024-dim, 8K tokens, MIT). Benchmarked: 380 ms per query; batching + parallel requests
// ≈ 53 ms per chunk. ONE model only — never fall back to a different embedding model, because vectors
// from another model live in a different space and silently break retrieval.

export const EMBED_MODEL = "BAAI/bge-m3";
export const EMBED_DIMS = 1024;
const HF_URL = "https://router.huggingface.co/hf-inference/models/BAAI/bge-m3/pipeline/feature-extraction";
const BATCH = 16;
const CONCURRENCY = 4;
const MAX_CHARS = 8000;

const url = () => process.env.EMBED_URL?.trim() || HF_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalizeVec(v: number[]) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

async function embedBatch(texts: string[], deadline: number): Promise<number[][]> {
  for (let attempt = 1; ; attempt++) {
    let status = 0;
    let retryAfter = 0;
    try {
      const res = await fetch(url(), {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, "Content-Type": "application/json", "x-wait-for-model": "true" },
        body: JSON.stringify({ inputs: texts.map((t) => t.slice(0, MAX_CHARS)) }),
        signal: AbortSignal.timeout(Math.max(5_000, deadline - Date.now())),
      });
      status = res.status;
      retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
      if (res.ok) {
        let data = await res.json();
        if (texts.length === 1 && typeof data?.[0] === "number") data = [data];
        if (!Array.isArray(data) || data.length !== texts.length || data[0]?.length !== EMBED_DIMS) {
          throw new Error("embedding response has the wrong shape");
        }
        return (data as number[][]).map(normalizeVec);
      }
    } catch (e) {
      if (Date.now() >= deadline) throw e;
    }
    const transient = status === 0 || status === 429 || status >= 500;
    const wait = retryAfter || Math.min(15_000, 800 * 2 ** attempt);
    if (!transient || Date.now() + wait >= deadline) throw new Error(`embedding_failed_${status}`);
    await sleep(wait);
  }
}

/** Embeds many texts: batches of 16, 4 requests in flight (rolling pool), retries with backoff. */
export async function embedMany(texts: string[], budgetMs = 40_000): Promise<number[][]> {
  const deadline = Date.now() + budgetMs;
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) batches.push(texts.slice(i, i + BATCH));
  const out: number[][][] = new Array(batches.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
      while (next < batches.length) {
        const i = next++;
        out[i] = await embedBatch(batches[i], deadline);
      }
    }),
  );
  return out.flat();
}

// Query embeddings are cached in memory: repeated / similar follow-up questions skip the network call.
const g = globalThis as unknown as { _qcache?: Map<string, number[]> };
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
