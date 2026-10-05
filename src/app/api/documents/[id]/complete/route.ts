import { NextResponse } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { ownedDocument, publicDocument } from "@/lib/docs";
import { DocumentModel, type DocumentDoc } from "@/lib/models";
import { finalizeDocument } from "@/lib/rag/ingest";

export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/documents/[id]/complete">) => {
  const user = await requireUser();
  const doc = await ownedDocument(user, (await ctx.params).id);
  await finalizeDocument(doc._id);
  const fresh = await DocumentModel.findById(doc._id).lean<DocumentDoc>();
  return NextResponse.json({ document: publicDocument(fresh!) });
});
