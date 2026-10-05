import "server-only";

// Jina reranker (v3.5: listwise, multilingual incl. Arabic, 131K context). Benchmarked 0.5–0.8 s for 30
// passages and it put the right clause first for Arabic and English questions. Free key: 100 RPM.
// On any failure/timeout the caller keeps the RRF order, so reranking can never make retrieval worse.

const PASSAGE_CHARS = 1200; // ~300 tokens each → ~9K tokens per question (stretches the free token grant)

export async function rerank(query: string, docs: string[], topN: number): Promise<{ index: number; score: number }[] | null> {
  const key = process.env.JINA_API_KEY;
  if (!key || docs.length === 0) return null;
  try {
    const res = await fetch("https://api.jina.ai/v1/rerank", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.JINA_RERANK_MODEL || "jina-reranker-v3.5",
        query,
        documents: docs.map((d) => d.slice(0, PASSAGE_CHARS)),
        top_n: Math.min(topN, docs.length),
        return_documents: false,
      }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.results ?? []).map((r: { index: number; relevance_score: number }) => ({ index: r.index, score: r.relevance_score }));
  } catch {
    return null;
  }
}
