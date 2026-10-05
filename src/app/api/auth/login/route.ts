import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { HttpError, handle, publicUser, rateLimit } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { User, type UserDoc } from "@/lib/models";
import { SESSION_COOKIE, cookieOptions, signSession } from "@/lib/session";
import { LOCALE_COOKIE } from "@/i18n/config";

export const POST = handle(async (req: Request) => {
  await rateLimit("login", 10, 600); // 10 attempts / 10 min per IP
  const { email, password } = await req.json();
  if (!email || !password) throw new HttpError(400, "missing_fields");
  await connectDB();
  const user = await User.findOne({ email: String(email).toLowerCase().trim() }).lean<UserDoc>();
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, "bad_credentials");
  const res = NextResponse.json({ user: publicUser(user) });
  res.cookies.set(SESSION_COOKIE, await signSession(String(user._id), user.sessionVersion ?? 0), cookieOptions);
  res.cookies.set(LOCALE_COOKIE, user.locale ?? "en", { path: "/", maxAge: 31536000, sameSite: "lax" });
  return res;
});
