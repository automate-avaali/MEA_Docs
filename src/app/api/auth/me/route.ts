import { NextResponse } from "next/server";
import { HttpError, getCurrentUser, handle, publicUser, requireUser } from "@/lib/auth";
import { User } from "@/lib/models";

export const GET = handle(async () => {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({ user: publicUser(user) });
});

/** Update profile (display name). */
export const PATCH = handle(async (req: Request) => {
  const user = await requireUser();
  const name = String((await req.json()).name ?? "").trim().slice(0, 80);
  if (!name) throw new HttpError(400, "missing_fields");
  await User.updateOne({ _id: user._id }, { name });
  return NextResponse.json({ user: { ...publicUser(user), name } });
});
