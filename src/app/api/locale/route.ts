import { NextResponse } from "next/server";
import { getCurrentUser, handle } from "@/lib/auth";
import { User } from "@/lib/models";
import { LOCALE_COOKIE, toLocale } from "@/i18n/config";

/** Switches the UI language (cookie for everyone, saved on the account when signed in). */
export const POST = handle(async (req: Request) => {
  const { locale } = await req.json();
  const l = toLocale(locale);
  const user = await getCurrentUser();
  if (user) await User.updateOne({ _id: user._id }, { locale: l });
  const res = NextResponse.json({ locale: l });
  res.cookies.set(LOCALE_COOKIE, l, { path: "/", maxAge: 31536000, sameSite: "lax" });
  return res;
});
