import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { HttpError, handle, publicUser, rateLimit } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { User } from "@/lib/models";
import { SESSION_COOKIE, cookieOptions, signSession } from "@/lib/session";
import { LOCALE_COOKIE, toLocale } from "@/i18n/config";

export const POST = handle(async (req: Request) => {
  await rateLimit("signup", 10, 3600);
  const { name, email, password, locale } = await req.json();
  if (!name?.trim() || !email?.trim() || !password) throw new HttpError(400, "missing_fields");
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, "invalid_email");
  if (String(password).length < 8) throw new HttpError(400, "weak_password");

  await connectDB();
  if (await User.exists({ email: email.toLowerCase().trim() })) throw new HttpError(409, "email_taken");
  const user = await User.create({ name: name.trim(), email, passwordHash: await bcrypt.hash(password, 11), locale: toLocale(locale) });

  const res = NextResponse.json({ user: publicUser(user.toObject()) }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, await signSession(String(user._id), 0), cookieOptions);
  res.cookies.set(LOCALE_COOKIE, user.locale, { path: "/", maxAge: 31536000, sameSite: "lax" });
  return res;
});
