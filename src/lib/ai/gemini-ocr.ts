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
- Start each page with what is at its very top — logos, boxed fields, stamps, reference/ID numbers in the corners (for example a box "ID: ١٠٤١٩٠" at the top right) — then the body, then footers ("Page 1 of 9", version lines). Never leave out boxes, stamps, seals, margin or corner text.
- Numbers written in Arabic-Indic digits: keep them as written and add the Western digits in parentheses, e.g. ID: ١٠٤١٩٠ (104190).
- SIGNATURES — check every place where a party signs ("Signature", "Signed by", "Represented by", "التوقيع", "الإمضاء", "ويمثلها السيد", "(الإسم)", "دستخط", and the space under each party's name — on the main signature page AND in annexes) in BOTH language columns. Bilingual contracts are often signed by hand only on the Arabic side, or only on the English side. A handwritten signature is an ink scribble or stroke, often in Arabic or Urdu script; it may cross the printed line or overlap a stamp. Treat the two language columns of the same party as ONE block, and give every signature place on the page exactly one of these two lines, right after its label:
  [Handwritten signature — <party as printed, e.g. First Party / الطرف الأول> — name: <the signer's name written by hand or printed beside it, or not present>]
  [No signature — <party as printed>]   ← the place is empty in every column (blank line "_____", empty brackets)
- Names of signers and representatives ("Represented By: Mr. …", "ويمثلها السيد/ …"): write the name only if you can read it. If it is empty or unreadable, leave the line as printed and put "name: not present" in the signature line — never write "illegible" for a name, and never write "not present" (or "غير موجود") as if it were handwriting.
- Other handwriting anywhere (company names, dates, amounts, filled-in blanks, notes): [Handwritten: <exactly what is written, Arabic/Urdu in logical order>]. Write [illegible] only for words (not names) you really cannot read.
- Stamps and seals: [Stamp: <every word and number in it — company name, city, CR number>]
- For an empty page write [blank page].`;

/** Page numbers (1-based) of a batch for which the reply had no "=== Page N ===" marker at all. */
export function missingPages(text: string, count: number): number[] {
  if (count === 1) return [];
  const seen = new Set([...text.matchAll(/^\s*=+\s*Page\s+(\d+)\s*=+\s*$/gim)].map((m) => Number(m[1])));
  return Array.from({ length: count }, (_, i) => i + 1).filter((n) => !seen.has(n));
}

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

/**
 * OCR a small PDF (1–N pages). Returns one string per page, and the pages the reply skipped entirely (Gemini now
 * and then stops after page 1 of a batch — those are re-read one by one, see ../rag/ingest.ts).
 * Throws OcrQuotaError on 429.
 */
export async function ocrPdf(pdf: Uint8Array, pageCount: number): Promise<string[] & { missing?: number[] }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new OcrQuotaError();
  const count = pageCount > 1 ? `\nThis PDF has ${pageCount} pages: transcribe all ${pageCount}, from === Page 1 === to === Page ${pageCount} ===.` : "";
  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [{ inline_data: { mime_type: "application/pdf", data: Buffer.from(pdf).toString("base64") } }, { text: PROMPT + count }],
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
    // 401/403: key revoked or the project lost its free tier → same as quota: the browser OCRs these pages
    // itself (Tesseract) instead of the whole upload failing.
    if (res.status === 401 || res.status === 403) {
      console.warn(`[ocr] gemini ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      throw new OcrQuotaError(3600);
    }
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
    return Object.assign(splitPages(text, pageCount), { missing: missingPages(text, pageCount) });
  }
}
