import "server-only";
import { Types } from "mongoose";
import { HttpError } from "./auth";
import { DocumentModel, type DocumentDoc, type UserDoc } from "./models";

export function oid(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new HttpError(404, "not_found");
  return new Types.ObjectId(id);
}

/** Loads a document only if it belongs to the user (tenant isolation on every request). */
export async function ownedDocument(user: UserDoc, id: string) {
  const doc = await DocumentModel.findOne({ _id: oid(id), userId: user._id }).lean<DocumentDoc>();
  if (!doc) throw new HttpError(404, "not_found");
  return doc;
}

export function publicDocument(d: DocumentDoc) {
  return {
    id: String(d._id),
    title: d.title,
    fileName: d.fileName ?? "",
    mimeType: d.mimeType ?? "",
    size: d.size ?? 0,
    pageCount: d.pageCount ?? 0,
    pagesDone: d.pagesDone?.length ?? 0,
    chunkCount: d.chunkCount ?? 0,
    status: d.status,
    language: d.language ?? "",
    ocr: { gemini: d.ocr?.gemini ?? 0, tesseract: d.ocr?.tesseract ?? 0, textLayer: d.ocr?.textLayer ?? 0, flagged: d.ocr?.flagged ?? [] },
    pendingEmbeddings: d.pendingEmbeddings ?? 0,
    createdAt: (d as unknown as { createdAt: Date }).createdAt,
  };
}
export type PublicDocument = ReturnType<typeof publicDocument>;
