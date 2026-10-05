import { NextResponse } from "next/server";
import { HttpError, handle, requireUser } from "@/lib/auth";
import { publicDocument } from "@/lib/docs";
import { DocumentModel, type DocumentDoc } from "@/lib/models";
import { ensureRegularIndexes, ensureSearchIndexes } from "@/lib/rag/store";

export const GET = handle(async () => {
  const user = await requireUser();
  const docs = await DocumentModel.find({ userId: user._id }).sort({ createdAt: -1 }).limit(500).lean<DocumentDoc[]>();
  return NextResponse.json({ documents: docs.map(publicDocument) });
});

// Search indexes are created once per server instance, on the first upload.
const g = globalThis as unknown as { _indexesReady?: Promise<unknown> };

/**
 * Registers an upload. If the same file (sha256, computed in the browser) was uploaded before, returns
 * that document with the pages already done → the browser resumes instead of starting over.
 */
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const { title, fileName, mimeType, size, hash, pageCount } = await req.json();
  if (!title || !hash || !Number.isInteger(pageCount) || pageCount < 1) throw new HttpError(400, "missing_fields");
  if (pageCount > 20000) throw new HttpError(400, "too_many_pages");

  // ATLAS_AUTO_INDEXES=false → indexes are managed manually in the Atlas UI (see docs/atlas-indexes.md).
  const auto = process.env.ATLAS_AUTO_INDEXES !== "false";
  g._indexesReady ??= Promise.all(auto ? [ensureSearchIndexes(), ensureRegularIndexes()] : [ensureRegularIndexes()]).catch((e) => {
    g._indexesReady = undefined;
    console.error("[indexes]", e.message);
  });
  await g._indexesReady;

  const existing = await DocumentModel.findOne({ userId: user._id, hash }).lean<DocumentDoc>();
  if (existing) {
    return NextResponse.json({ document: publicDocument(existing), donePages: existing.pagesDone ?? [], resumed: true });
  }
  const doc = await DocumentModel.create({
    userId: user._id,
    title: String(title).slice(0, 200),
    fileName: String(fileName ?? title).slice(0, 255),
    mimeType,
    size,
    hash,
    pageCount,
  });
  return NextResponse.json({ document: publicDocument(doc.toObject()), donePages: [], resumed: false }, { status: 201 });
});
