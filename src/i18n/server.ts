import "server-only";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, toLocale, type Locale } from "./config";
import en from "./messages/en";
import ar from "./messages/ar";
import ur from "./messages/ur";

export const DICTS = { en, ar, ur };

export async function getLocale(): Promise<Locale> {
  return toLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}

export async function getMessages() {
  const locale = await getLocale();
  return { locale, messages: DICTS[locale] };
}
