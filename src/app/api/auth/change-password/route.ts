import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { HttpError, handle, requireUser } from "@/lib/auth";
import { User } from "@/lib/models";
import { SESSION_COOKIE, cookieOptions, signSession } from "@/lib/session";

export const POST = handle(async (req: Request) => {
  const me = await requireUser();
  const { currentPassword, newPassword } = await req.json();
  if (!newPassword || String(newPassword).length < 8) throw new HttpError(400, "weak_password");
  const user = await User.findById(me._id);
  if (!user) throw new HttpError(404, "not_found");
  if (!(await bcrypt.compare(currentPassword ?? "", user.passwordHash))) throw new HttpError(400, "wrong_password");
  user.passwordHash = await bcrypt.hash(newPassword, 11);
  user.sessionVersion = (user.sessionVersion ?? 0) + 1; // other devices are signed out…
  await user.save();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await signSession(String(user._id), user.sessionVersion), cookieOptions); // …this one stays in
  return res;
});
