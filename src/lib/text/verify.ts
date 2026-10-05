import "server-only";
import moment from "moment-hijri";
import { isValidIBAN } from "ibantools";
import { detectLang, westernDigits } from "./arabic";

// ── Dates → ISO (Gregorian + Hijri, Western/Arabic-Indic digits, Arabic/English month names) ──
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  يناير: 1, فبراير: 2, مارس: 3, أبريل: 4, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, أغسطس: 8, اغسطس: 8, سبتمبر: 9, أكتوبر: 10, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
  جنوری: 1, فروری: 2, مارچ: 3, اپریل: 4, مئی: 5, جون: 6, جولائی: 7, اگست: 8, ستمبر: 9, اکتوبر: 10, نومبر: 11, دسمبر: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const iso = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;

export function extractDates(raw: string): string[] {
  const text = westernDigits(raw);
  const out = new Set<string>();
  for (const m of text.matchAll(/(\d{1,4})\s*[\\/.-]\s*(\d{1,2})\s*[\\/.-]\s*(\d{1,4})/g)) {
    const [a, b, c] = [m[1], m[2], m[3]].map(Number);
    const [y, mo, d] = a > 31 ? [a, b, c] : [c, b, a];
    if (y >= 1300 && y <= 1600) {
      const g = moment(`${y}/${mo}/${d}`, "iYYYY/iM/iD");
      if (g.isValid()) out.add(g.locale("en").format("YYYY-MM-DD"));
    } else if (y >= 1900 && y <= 2100) {
      const v = iso(y, mo, d);
      if (v) out.add(v);
    }
  }
  for (const m of text.matchAll(new RegExp(`(\\d{1,2})\\s+(${MONTH_RE})\\s*,?\\s*(\\d{4})`, "gi"))) {
    const v = iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    if (v) out.add(v);
  }
  for (const m of text.matchAll(new RegExp(`(${MONTH_RE})\\s+(\\d{1,2}),?\\s*(\\d{4})`, "gi"))) {
    const v = iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
    if (v) out.add(v);
  }
  return [...out];
}

/** Amounts and identifiers (3+ digits, not a bare year). */
export const extractNumbers = (raw: string) =>
  [...westernDigits(raw).matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => m[0].replace(/,/g, "").replace(/\.$/, ""))
    .filter((n) => n.replace(".", "").length >= 3 && !/^(19|20)\d\d$/.test(n));

/** IBANs found in text whose checksum fails → almost always an OCR digit error. */
export function invalidIbans(raw: string) {
  const text = westernDigits(raw).toUpperCase();
  return [...text.matchAll(/\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?)\b/g)]
    .map((m) => m[1].replace(/\s/g, ""))
    .filter((iban) => iban.length >= 15 && !isValidIBAN(iban));
}

/**
 * Post-answer checks: answer language matches the question; every date/number in the answer
 * appears in the retrieved context; citations point at sources that were actually provided.
 */
export function verifyAnswer(opts: { question: string; answer: string; context: string; sourceCount: number; expectedLang?: string }) {
  const issues: string[] = [];
  const qLang = opts.expectedLang ?? detectLang(opts.question);
  const aLang = detectLang(opts.answer, qLang as "en");
  if (opts.answer.length > 40 && qLang !== aLang) issues.push(`language:${aLang}`);

  const ctxDates = new Set(extractDates(opts.context));
  for (const d of extractDates(opts.answer)) if (!ctxDates.has(d)) issues.push(`date:${d}`);

  const ctxNums = new Set(extractNumbers(opts.context));
  for (const n of extractNumbers(opts.answer)) if (!ctxNums.has(n)) issues.push(`number:${n}`);

  for (const m of westernDigits(opts.answer).matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (n < 1 || n > opts.sourceCount) issues.push(`citation:${n}`);
  }
  return { qLang, aLang, issues: [...new Set(issues)] };
}
