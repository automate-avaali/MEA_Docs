import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { HttpError, handle, requireUser } from "@/lib/auth";
import { oid, ownedDocument } from "@/lib/docs";
import { DocumentModel, type DocumentDoc } from "@/lib/models";
import { deleteFile, fileStorageEnabled, filePrefix, readFile, signedFileUrl, storedFile } from "@/lib/storage";

// The original file of a document (see lib/storage.ts):
//   POST → upload token for the browser (@vercel/blob/client `upload()` calls this)
//   PUT  → the browser reports the finished upload; verified, then linked to the document
//   GET  → opens the file in the browser (owner only); ?download=1 → saves it under its original name;
//          ?as=url → signed URL as JSON (source viewer in chat)

// Downloads stream through this function (streamed responses aren't capped at 4.5 MB on Vercel); the time
// limit covers the whole transfer, so allow the Hobby maximum.
export const maxDuration = 300;

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/documents/[id]/file">) => {
  const user = await requireUser();
  const doc = await ownedDocument(user, (await ctx.params).id);
  if (!fileStorageEnabled()) throw new HttpError(503, "storage_disabled");
  const body = (await req.json()) as HandleUploadBody;
  // Only token requests: no completion callback is registered, the browser confirms with PUT instead
  // (callbacks can't reach localhost or a protected preview deployment).
  if (body.type !== "blob.generate-client-token") throw new HttpError(400, "bad_request");
  const prefix = filePrefix(user._id, doc._id);
  const result = await handleUpload({
    request: req,
    body,
    onBeforeGenerateToken: async (pathname) => {
      if (!pathname.startsWith(prefix) || pathname.includes("..")) throw new HttpError(400, "bad_pathname");
      return {
        addRandomSuffix: true,
        // The token only accepts the file that was registered (same byte size as at registration).
        maximumSizeInBytes: Math.max(1, doc.size ?? 0),
      };
    },
  });
  return NextResponse.json(result);
});

export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/documents/[id]/file">) => {
  const user = await requireUser();
  const id = (await ctx.params).id;
  const { pathname } = await req.json().catch(() => ({}));
  const prefix = filePrefix(user._id, oid(id));
  if (typeof pathname !== "string" || !pathname.startsWith(prefix) || pathname.includes("..")) throw new HttpError(400, "bad_pathname");

  const doc = await DocumentModel.findOne({ _id: oid(id), userId: user._id }).lean<DocumentDoc>();
  if (!doc) {
    // The document was deleted while its file was uploading → don't leave the file behind.
    await deleteFile(pathname).catch((e) => console.warn("[storage] orphan delete", e.message));
    throw new HttpError(404, "not_found");
  }
  const info = await storedFile(pathname);
  if (!info) throw new HttpError(404, "file_not_found");

  await DocumentModel.updateOne(
    { _id: doc._id },
    { $set: { file: { pathname, contentType: info.contentType, size: info.size, uploadedAt: info.uploadedAt } } },
  );
  // Replacing an earlier copy (same file uploaded again) → remove the old one.
  if (doc.file?.pathname && doc.file.pathname !== pathname) {
    await deleteFile(doc.file.pathname).catch((e) => console.warn("[storage] replace delete", e.message));
  }
  return NextResponse.json({ ok: true });
});

// Types the browser can show inline without running anything; everything else is downloaded.
const INLINE = /^(application\/pdf|image\/(png|jpe?g|webp|gif|bmp|tiff)|text\/plain)$/;

/** Content-Disposition with the original (often Arabic) name: RFC 6266 filename* plus an ASCII fallback. */
function disposition(kind: "inline" | "attachment", name: string) {
  const ascii = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const GET = handle(async (req: Request, ctx: RouteContext<"/api/documents/[id]/file">) => {
  const user = await requireUser();
  const doc = await ownedDocument(user, (await ctx.params).id);
  if (!doc.file?.pathname || !fileStorageEnabled()) throw new HttpError(404, "file_not_stored");
  const params = new URL(req.url).searchParams;
  const download = params.has("download");

  // ?as=url → JSON with a signed URL, for the in-app source viewer (pdf.js / <img> load it straight from Blob,
  // which allows cross-origin GETs). 15 minutes: the viewer downloads the file once and keeps it in memory.
  if (params.get("as") === "url") {
    const ttl = 15 * 60_000;
    return NextResponse.json(
      { url: await signedFileUrl(doc.file.pathname, ttl), contentType: doc.file.contentType ?? doc.mimeType ?? "", size: doc.file.size ?? doc.size ?? 0, expiresAt: Date.now() + ttl },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  if (!download) {
    try {
      // Viewing: redirect to a 5-minute signed URL — the file is served by Blob, not by this function.
      const res = NextResponse.redirect(await signedFileUrl(doc.file.pathname), 302);
      res.headers.set("Cache-Control", "private, no-store");
      return res;
    } catch (e) {
      console.warn("[storage] signed URL failed, streaming instead:", (e as Error).message);
    }
  }

  // Downloading (or viewing when signing failed): stream it here so the response can carry the original name.
  const r = await readFile(doc.file.pathname);
  if (!r || r.statusCode !== 200) throw new HttpError(404, "file_not_found");
  const type = r.blob.contentType || "application/octet-stream";
  return new Response(r.stream, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(r.blob.size),
      "Content-Disposition": disposition(download || !INLINE.test(type) ? "attachment" : "inline", doc.fileName || doc.title),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});
