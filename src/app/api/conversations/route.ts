import { NextResponse } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { Conversation } from "@/lib/models";

export const GET = handle(async () => {
  const user = await requireUser();
  const list = await Conversation.find({ userId: user._id }).sort({ updatedAt: -1 }).limit(100).lean();
  return NextResponse.json({
    conversations: list.map((c) => ({
      id: String(c._id),
      title: c.title,
      documentIds: (c.documentIds ?? []).map(String),
      updatedAt: (c as unknown as { updatedAt: Date }).updatedAt,
    })),
  });
});
