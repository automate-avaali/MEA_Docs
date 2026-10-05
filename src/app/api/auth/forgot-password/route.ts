import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { HttpError, handle, rateLimit } from "@/lib/auth";
import { connectDB } from "@/lib/db";
import { appUrl, mailConfigured, sendMail } from "@/lib/mail";
import { User } from "@/lib/models";
import { RESET_EMAIL } from "@/i18n/emails";
import { toLocale } from "@/i18n/config";

export const POST = handle(async (req: Request) => {
  await rateLimit("forgot", 5, 900);
  const { email } = await req.json();
  if (!email) throw new HttpError(400, "missing_fields");
  await connectDB();
  const user = await User.findOne({ email: String(email).toLowerCase().trim() });
  // Same response whether or not the account exists (no account enumeration).
  if (!user) return NextResponse.json({ ok: true });

  const token = crypto.randomBytes(32).toString("hex");
  user.resetTokenHash = crypto.createHash("sha256").update(token).digest("hex");
  user.resetTokenExpires = new Date(Date.now() + 30 * 60 * 1000);
  await user.save();

  const link = `${appUrl()}/reset-password?token=${token}`;
  const mail = RESET_EMAIL[toLocale(user.locale)];
  await sendMail(user.email, mail.subject, mail.html(user.name, link), mail.text(link));

  // Without SMTP in development, hand the link back so the flow is still testable.
  const devLink = !mailConfigured() && process.env.NODE_ENV !== "production" ? link : undefined;
  return NextResponse.json({ ok: true, devLink });
});
