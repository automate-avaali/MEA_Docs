"use client";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { dirOf, INTL_LOCALE, type Locale } from "./config";
import type { Messages } from "./messages/en";

type Ctx = { locale: Locale; messages: Messages };
const I18nCtx = createContext<Ctx | null>(null);

export function I18nProvider({ locale, messages, children }: Ctx & { children: ReactNode }) {
  return <I18nCtx.Provider value={{ locale, messages }}>{children}</I18nCtx.Provider>;
}

function lookup(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** `t("docs.stage.resumed", { n: 4 })` → string with {placeholders} filled. Falls back to the key. */
export function useT() {
  const ctx = useContext(I18nCtx)!;
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const v = lookup(ctx.messages, key);
      if (typeof v !== "string") return key;
      return vars ? v.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : v;
    },
    [ctx.messages],
  );
  /** Error codes from the API → localized message. */
  const tError = useCallback(
    (codeOrMessage: string) => {
      const v = lookup(ctx.messages, `errors.${codeOrMessage}`);
      return typeof v === "string" ? v : (ctx.messages.errors.server_error as string);
    },
    [ctx.messages],
  );
  return { t, tError, locale: ctx.locale, messages: ctx.messages, dir: dirOf(ctx.locale), intl: INTL_LOCALE[ctx.locale] };
}

/** Switch UI language: saves the cookie (and the account preference) then reloads server-rendered UI. */
export async function switchLocale(locale: Locale) {
  await fetch("/api/locale", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale }) });
  window.location.reload();
}
