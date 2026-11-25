import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { handle, requireUser } from "@/lib/auth";
import { collection } from "@/lib/db";
import { ownedDocument } from "@/lib/docs";
import { CHUNKS } from "@/lib/models";

type Row = { _id: Types.ObjectId; page: number; pageEnd?: number; section?: string; content: string };

/**
 * Full text of cited passages for the source viewer in chat: ?chunks=<id>,<id> (from the answer's sources).
 * Chunks that no longer exist (document re-indexed) fall back to the chunks covering ?page=<n>.
 */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/documents/[id]/passages">) => {
  const user = await requireUser();
  const doc = await ownedDocument(user, (await ctx.params).id);
  const params = new URL(req.url).searchParams;
  const ids = (params.get("chunks") ?? "")
    .split(",")
    .filter((s) => Types.ObjectId.isValid(s))
    .slice(0, 10)
    .map((s) => new Types.ObjectId(s));
  const page = Number(params.get("page"));
  const col = await collection(CHUNKS);
  const projection = { page: 1, pageEnd: 1, section: 1, content: 1 };

  let rows = ids.length ? await col.find<Row>({ _id: { $in: ids }, documentId: doc._id, userId: user._id }, { projection }).toArray() : [];
  if (rows.length < ids.length && Number.isInteger(page) && page >= 1) {
    const onPage = await col
      .find<Row>({ documentId: doc._id, userId: user._id, page: { $lte: page }, $or: [{ pageEnd: { $gte: page } }, { page }] }, { projection })
      .sort({ page: 1, _id: 1 })
      .limit(10)
      .toArray();
    const have = new Set(rows.map((r) => String(r._id)));
    rows = [...rows, ...onPage.filter((r) => !have.has(String(r._id)))];
  }
  return NextResponse.json({
    passages: rows.map((r) => ({ id: String(r._id), page: r.page, pageEnd: r.pageEnd ?? r.page, section: r.section ?? "", content: r.content })),
  });
});
