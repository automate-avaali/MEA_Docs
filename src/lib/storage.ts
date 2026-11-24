import "server-only";
import type { Types } from "mongoose";
import { BlobNotFoundError, del, get, head, issueSignedToken, list, presignUrl } from "@vercel/blob";

// Original uploaded files are kept in Vercel Blob with PRIVATE access — no file is reachable by URL alone.
//  • upload: the browser sends the file straight to Blob with a token from /api/documents/[id]/file, so the
//    file never passes through a function (no 4.5 MB body limit), then confirms the pathname it got back
//  • read:   /api/documents/[id]/file checks ownership, then redirects to a signed URL valid for 5 minutes
//  • layout: docs/<userId>/<documentId>/<file name>-<random suffix>
// Without BLOB_READ_WRITE_TOKEN (e.g. local dev with no store linked) uploads still index normally; only the
// original file is not kept.

type Id = Types.ObjectId | string;

export const fileStorageEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

export const userPrefix = (userId: Id) => `docs/${userId}/`;
export const filePrefix = (userId: Id, documentId: Id) => `${userPrefix(userId)}${documentId}/`;

/** Blob metadata, or null when nothing is stored at that pathname. */
export async function storedFile(pathname: string) {
  try {
    return await head(pathname);
  } catch (e) {
    if (e instanceof BlobNotFoundError) return null;
    throw e;
  }
}

/** A short-lived URL that reads one private blob (the browser follows it; the file never touches a function). */
export async function signedFileUrl(pathname: string, ttlMs = 5 * 60_000) {
  const validUntil = Date.now() + ttlMs;
  const token = await issueSignedToken({ pathname, operations: ["get"], validUntil });
  const { presignedUrl } = await presignUrl(token, { operation: "get", pathname, access: "private", validUntil });
  return presignedUrl;
}

/** Fallback read path: streams the blob through the function. */
export async function readFile(pathname: string) {
  return get(pathname, { access: "private" });
}

/** Deletes every blob under a prefix (a document's folder, or a whole user's). */
export async function deleteFiles(prefix: string) {
  if (!fileStorageEnabled()) return;
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    if (page.blobs.length) await del(page.blobs.map((b) => b.url));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

export async function deleteFile(pathname: string) {
  if (fileStorageEnabled()) await del(pathname);
}
