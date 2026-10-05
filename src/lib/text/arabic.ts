// Arabic / Urdu / English text helpers shared by the browser (ingestion) and the server (search, verification).

const DIGIT_MAP: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};
export const westernDigits = (s: string) => s.replace(/[٠-٩۰-۹]/g, (d) => DIGIT_MAP[d]);

/** Cleans text for storage/display: fixes PDF presentation-form glyphs (NFKC), tatweel, zero-width chars, spacing. */
export function cleanText(s: string) {
  return s
    .normalize("NFKC")
    .replace(/<br\s*\/?>/gi, " / ") // OCR puts bilingual table headers on two lines with <br>
    .replace(/ـ/g, "") // tatweel
    .replace(/[​-‍﻿]/g, "") // zero-width
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Aggressive normalisation for keyword search only (never shown to users):
 * Arabic-Indic digits → 0-9, drop diacritics, unify alef / yeh / teh-marbuta / heh forms, lowercase Latin.
 * Applied identically to indexed text and to queries, so spelling variants still match.
 */
export function searchNormalize(s: string) {
  return westernDigits(cleanText(s))
    .replace(/[ً-ْٰۡ]/g, "") // tashkeel
    .replace(/[إأآٱ]/g, "ا")
    .replace(/[ىی]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ھہ]/g, "ه")
    .replace(/ک/g, "ك")
    .toLowerCase();
}

export type Lang = "ar" | "en" | "ur";
const URDU_ONLY = /[ٹڈڑںےۓھۃ]/g;

/**
 * Language of a question or answer. Script ratio first (reliable on 2-word questions, where statistical
 * detectors fail), Urdu-only letters to split Urdu from Arabic. Tested 13/13 vs franc-min's 10/13.
 */
export function detectLang(text: string, fallback: Lang = "en"): Lang {
  const arabicScript = (text.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (arabicScript + latin === 0) return fallback;
  if (latin > arabicScript) return "en";
  if ((text.match(URDU_ONLY) ?? []).length >= 2) return "ur";
  return "ar";
}

export const isRtl = (l: string) => l === "ar" || l === "ur";

/** Like detectLang, but returns "mixed" for genuinely bilingual text (both scripts ≥ 25% of letters). */
export function detectContentLang(text: string): Lang | "mixed" {
  const arabicScript = (text.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = arabicScript + latin;
  if (total > 40 && arabicScript / total >= 0.25 && latin / total >= 0.25) return "mixed";
  return detectLang(text);
}
