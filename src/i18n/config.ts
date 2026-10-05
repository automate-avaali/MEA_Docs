export const LOCALES = ["en", "ar", "ur"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "md_locale";

/** English name first so everyone can recognise each option, native name second. */
export const LOCALE_LABEL: Record<Locale, string> = { en: "English", ar: "Arabic — العربية", ur: "Urdu — اردو" };

/** For the language menu: native name (big), English name (small), short code badge. */
export const LOCALE_META: Record<Locale, { native: string; english: string; code: string; dir: "ltr" | "rtl" }> = {
  en: { native: "English", english: "English", code: "EN", dir: "ltr" },
  ar: { native: "العربية", english: "Arabic", code: "AR", dir: "rtl" },
  ur: { native: "اردو", english: "Urdu", code: "UR", dir: "rtl" },
};
export const dirOf = (l: Locale) => (l === "en" ? "ltr" : "rtl");
export const toLocale = (v: unknown): Locale => (LOCALES.includes(v as Locale) ? (v as Locale) : DEFAULT_LOCALE);

/** Intl locale per UI language (Arabic dates use Gregorian; Hijri is shown alongside where useful). */
export const INTL_LOCALE: Record<Locale, string> = { en: "en-GB", ar: "ar-SA-u-ca-gregory-nu-arab", ur: "ur-PK" };
