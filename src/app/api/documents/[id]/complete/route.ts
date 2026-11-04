import { NextResponse, after } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { ownedDocument, publicDocument } from "@/lib/docs";
import { DocumentModel, type DocumentDoc } from "@/lib/models";
import { finalizeDocument } from "@/lib/rag/ingest";
import { documentSuggestions, type Locale } from "@/lib/rag/suggest";

export const maxDuration = 30;

export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/documents/[id]/complete">) => {
  const user = await requireUser();
  const doc = await ownedDocument(user, (await ctx.params).id);
  await finalizeDocument(doc._id);
  const fresh = await DocumentModel.findById(doc._id).lean<DocumentDoc>();
  // Starter questions for the chat screen, written from this document (in the user's UI language) — in the
  // background so the upload finishes immediately.
  if (fresh?.chunkCount) after(() => documentSuggestions(fresh, (user.locale ?? "en") as Locale).catch((e) => console.warn("[suggest]", e.message)));
  return NextResponse.json({ document: publicDocument(fresh!) });
});
