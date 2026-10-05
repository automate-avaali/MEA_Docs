import "server-only";

// Scanned pages → text with Gemini (benchmarked on the MenaBev contracts: 13/13 key terms on text,
// tables and dates at 5 pages per request; ~3–5 s per page). Free tier: 15 RPM / 500 RPD.

export class OcrQuotaError extends Error {
  constructor(public retryAfterSec?: number) {
    super("ocr_quota");
  }
}

const MODEL = () => process.env.GEMINI_OCR_MODEL || "gemini-3.5-flash-lite";

const PROMPT = `You are an OCR engine. This PDF contains scanned pages of a business document (Arabic and/or English).
Transcribe EVERY page completely, in order. Before each page write a line exactly like: === Page N ===  (N = 1 for the first page in this PDF).
For each page:
- Transcribe ALL text, every column (English and Arabic). Never summarise, skip, translate or correct.
- Keep every number, date, slash and backslash exactly as printed (for example [1\\01\\2026.]).
- Write Arabic in logical reading order. Render tables as Markdown tables with a header row.
- Use "## " for document titles and article/annex headings.
- Write handwritten text as you read it; if illegible write [illegible]. For an empty page write [blank page].`;

/** Splits "=== Page N ===" output by page NUMBER (tolerates duplicated or missing markers). */
export function splitPages(text: string, count: number): string[] {
  const pages = new Map<number, string>();
  let cur: number | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*=+\s*Page\s+(\d+)\s*=+\s*$/i);
    if (m) {
      cur = Number(m[1]);
      if (!pages.has(cur)) pages.set(cur, "");
      continue;
    }
    if (cur != null) pages.set(cur, pages.get(cur) + line + "\n");
  }
  if (pages.size === 0 && count === 1) return [text];
  return Array.from({ length: count }, (_, i) => (pages.get(i + 1) ?? "").replace(/\[blank page\]/gi, "").trim());
}

/** OCR a small PDF (1–N pages). Returns one string per page. Throws OcrQuotaError on 429. */
export async function ocrPdf(pdf: Uint8Array, pageCount: number): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new OcrQuotaError();
  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [{ inline_data: { mime_type: "application/pdf", data: Buffer.from(pdf).toString("base64") } }, { text: PROMPT }],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: Math.min(65536, 4000 * pageCount + 1000),
      thinkingConfig: /^gemini-2\./.test(MODEL()) ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" },
    },
  });

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(110_000),
    });
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after")) || undefined;
      throw new OcrQuotaError(ra);
    }
    if ((res.status === 503 || res.status === 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * attempt)); // Gemini "high demand" spikes are short
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`gemini_ocr_${res.status}: ${j?.error?.message ?? ""}`.slice(0, 300));
    const text: string = j.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    return splitPages(text, pageCount);
  }
}
