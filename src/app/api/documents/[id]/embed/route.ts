import { NextResponse } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { ownedDocument } from "@/lib/docs";
import { backfillEmbeddings } from "@/lib/rag/ingest";

export const maxDuration = 60;

/** Fills in vectors for chunks stored while the embedding service was unavailable. Call until remaining = 0. */
export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/documents/[id]/embed">) => {
  const user = await requireUser();
  const doc = await ownedDocument(user, (await ctx.params).id);
  return NextResponse.json(await backfillEmbeddings(doc._id));
});
