import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { HttpError, handle, requireUser } from "@/lib/auth";
import { collection } from "@/lib/db";
import { CHUNKS, Conversation, DocumentModel, Message, User } from "@/lib/models";
import { SESSION_COOKIE } from "@/lib/session";

/** Deletes the account and ALL its data (documents, chunks, conversations). Requires the password. */
export const DELETE = handle(async (req: Request) => {
  const me = await requireUser();
  const { password } = await req.json().catch(() => ({}));
  const user = await User.findById(me._id);
  if (!user || !(await bcrypt.compare(password ?? "", user.passwordHash))) throw new HttpError(400, "wrong_password");
  await Promise.all([
    (await collection(CHUNKS)).deleteMany({ userId: user._id }),
    DocumentModel.deleteMany({ userId: user._id }),
    Message.deleteMany({ userId: user._id }),
    Conversation.deleteMany({ userId: user._id }),
  ]);
  await user.deleteOne();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
});
