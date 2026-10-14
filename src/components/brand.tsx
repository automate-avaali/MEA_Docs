"use client";
import Link from "next/link";
import { Languages, Loader2, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { switchLocale, useT } from "@/i18n/client";
import { LOCALE_META, LOCALES, type Locale } from "@/i18n/config";
import { Dropdown } from "./Dropdown";
import { cn } from "./ui";

export function Wordmark({ className, href = "/" }: { className?: string; href?: string }) {
  // Brand stays LTR in every language.
  return (
    <Link href={href} dir="ltr" className={cn("font-mono font-semibold tracking-tight text-[14px] sm:text-[19px] leading-none", className)} aria-label="Avagama MiddleEast Docs home">
      {/* Too long for a phone header on one line — stacks below sm, sits inline above it. */}
      <span className="flex flex-col leading-[1.15] sm:block">
        Avagama <span className="text-muted font-normal">MiddleEast Docs</span>
      </span>
    </Link>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useT();
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const th = document.documentElement.dataset.theme;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- theme lives on <html>/media query, only readable after hydration
    setDark(th ? th === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      localStorage.setItem("md-theme", next ? "dark" : "light");
    } catch {}
  }
  return (
    <button onClick={toggle} aria-label={dark ? t("common.lightMode") : t("common.darkMode")} className={cn("grid place-items-center size-10 rounded-full hover:bg-surface-2 text-ink cursor-pointer", className)}>
      {dark ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </button>
  );
}

/** English / العربية / اردو — switches the whole UI (and right-to-left layout). */
export function LanguageSelect({ className, compact }: { className?: string; compact?: boolean }) {
  const { locale, t } = useT();
  const [busy, setBusy] = useState(false);
  const cur = LOCALE_META[locale];
  return (
    <Dropdown<Locale>
      className={className}
      ariaLabel={t("common.language")}
      title={locale === "en" ? "Language" : `${t("common.language")} · Language`}
      value={locale}
      disabled={busy}
      onChange={(l) => {
        setBusy(true);
        switchLocale(l);
      }}
      options={LOCALES.map((l) => ({
        value: l,
        label: LOCALE_META[l].native,
        sub: l === "en" ? undefined : LOCALE_META[l].english,
        badge: LOCALE_META[l].code,
        dir: LOCALE_META[l].dir,
      }))}
      trigger={
        <>
          {busy ? <Loader2 className="size-4 animate-spin text-muted" /> : <Languages className="size-4 text-muted" />}
          <span className={cn("font-medium", compact && "hidden sm:inline")}>{cur.native}</span>
          {locale !== "en" && <span className={cn("text-xs text-muted", compact && "hidden md:inline")}>{cur.english}</span>}
          {compact && <span className="font-mono text-xs font-semibold sm:hidden">{cur.code}</span>}
        </>
      }
    />
  );
}
