import type { Types } from "mongoose";
import { NextResponse } from "next/server";
import { HttpError, handle, requireUser } from "@/lib/auth";
import { oid } from "@/lib/docs";
import { Conversation, DocumentModel, Message } from "@/lib/models";

async function owned(userId: Types.ObjectId, id: string) {
  const c = await Conversation.findOne({ _id: oid(id), userId });
  if (!c) throw new HttpError(404, "not_found");
  return c;
}

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/conversations/[id]">) => {
  const user = await requireUser();
  const c = await owned(user._id, (await ctx.params).id);
  const messages = await Message.find({ conversationId: c._id }).sort({ createdAt: 1 }).limit(400).lean();
  return NextResponse.json({
    conversation: { id: String(c._id), title: c.title, documentIds: (c.documentIds ?? []).map(String) },
    messages: messages.map((m) => ({
      id: String(m._id),
      role: m.role,
      content: m.content,
      lang: m.lang,
      sources: (m.sources ?? []).map((s) => ({ ...s, documentId: String(s.documentId) })),
      issues: m.issues ?? [],
      timings: m.timings ?? null,
    })),
  });
});

export const PATCH = handle(async (req: Request, ctx: RouteContext<"/api/conversations/[id]">) => {
  const user = await requireUser();
  const c = await owned(user._id, (await ctx.params).id);
  const { title, documentIds } = await req.json();
  if (typeof title === "string" && title.trim()) c.title = title.trim().slice(0, 120);
  if (Array.isArray(documentIds)) {
    const docs = await DocumentModel.find({ _id: { $in: documentIds.map(oid) }, userId: user._id }, { _id: 1 }).lean();
    c.documentIds = docs.map((d) => d._id);
  }
  await c.save();
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/conversations/[id]">) => {
  const user = await requireUser();
  const c = await owned(user._id, (await ctx.params).id);
  await Message.deleteMany({ conversationId: c._id });
  await c.deleteOne();
  return NextResponse.json({ ok: true });
});
