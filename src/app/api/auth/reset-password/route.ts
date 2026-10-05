import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { HttpError, handle, rateLimit } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { User } from "@/lib/models";

export const POST = handle(async (req: Request) => {
  await rateLimit("reset", 10, 900);
  const { token, password } = await req.json();
  if (!token) throw new HttpError(400, "reset_invalid");
  if (!password || String(password).length < 8) throw new HttpError(400, "weak_password");
  await connectDB();
  const hash = crypto.createHash("sha256").update(String(token)).digest("hex");
  const user = await User.findOne({ resetTokenHash: hash, resetTokenExpires: { $gt: new Date() } });
  if (!user) throw new HttpError(400, "reset_invalid");
  user.passwordHash = await bcrypt.hash(password, 11);
  user.resetTokenHash = undefined;
  user.resetTokenExpires = undefined;
  user.sessionVersion = (user.sessionVersion ?? 0) + 1; // sign out every device
  await user.save();
  return NextResponse.json({ ok: true });
});
