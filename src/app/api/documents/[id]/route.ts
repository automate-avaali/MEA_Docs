import { NextResponse } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { collection } from "@/lib/db";
import { ownedDocument, publicDocument } from "@/lib/docs";
import { CHUNKS, DocumentModel } from "@/lib/models";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/documents/[id]">) => {
  const user = await requireUser();
  const doc = await ownedDocument(user, (await ctx.params).id);
  return NextResponse.json({ document: publicDocument(doc) });
});

export const PATCH = handle(async (req: Request, ctx: RouteContext<"/api/documents/[id]">) => {
  const user = await requireUser();
  const doc = await ownedDocument(user, (await ctx.params).id);
  const title = String((await req.json()).title ?? "").trim().slice(0, 200);
  if (title) {
    await DocumentModel.updateOne({ _id: doc._id }, { title });
    await (await collection(CHUNKS)).updateMany({ documentId: doc._id }, { $set: { docTitle: title } });
  }
  return NextResponse.json({ document: publicDocument({ ...doc, title: title || doc.title }) });
});

export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/documents/[id]">) => {
  const user = await requireUser();
  const doc = await ownedDocument(user, (await ctx.params).id);
  await (await collection(CHUNKS)).deleteMany({ documentId: doc._id, userId: user._id });
  await DocumentModel.deleteOne({ _id: doc._id });
  return NextResponse.json({ ok: true });
});
