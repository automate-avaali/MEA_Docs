import { NextResponse } from "next/server";
import { HttpError, handle, requireUser } from "@/lib/auth";
import { ownedDocument } from "@/lib/docs";
import { OcrQuotaError } from "@/lib/ai/gemini-ocr";
import { processBatch, type IncomingPage } from "@/lib/rag/ingest";

// One batch = up to 5 scanned pages (Gemini OCR) or up to ~25 text pages. Keeps every request well
// under Vercel's 4.5 MB body limit and its function time limit, whatever the size of the whole file.
export const maxDuration = 120;

const MAX_PDF_BYTES = 4 * 1024 * 1024;

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/documents/[id]/batch">) => {
  const user = await requireUser();
  const doc = await ownedDocument(user, (await ctx.params).id);

  let pages: IncomingPage[] = [];
  let pdf: Uint8Array | undefined;
  let pdfPages: number[] | undefined;
  let checks: { page: number; text: string }[] | undefined;

  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("pdf");
    if (file instanceof Blob) {
      if (file.size > MAX_PDF_BYTES) throw new HttpError(413, "batch_too_large");
      pdf = new Uint8Array(await file.arrayBuffer());
      pdfPages = JSON.parse(String(form.get("pdfPages") ?? "[]"));
    }
    pages = JSON.parse(String(form.get("pages") ?? "[]"));
    checks = JSON.parse(String(form.get("checks") ?? "[]"));
  } else {
    ({ pages = [] } = await req.json());
  }

  const valid = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= (doc.pageCount ?? 0);
  if (!pages.every((p) => valid(p.page) && typeof p.text === "string") || !(pdfPages ?? []).every(valid)) throw new HttpError(400, "bad_pages");
  if (!pages.length && !pdfPages?.length) throw new HttpError(400, "bad_pages");

  try {
    const result = await processBatch({ doc, pages, pdf, pdfPages, checks });
    return NextResponse.json(result);
  } catch (e) {
    // Gemini daily/minute quota → the browser OCRs these pages itself with Tesseract and resends text.
    if (e instanceof OcrQuotaError) return NextResponse.json({ error: "ocr_quota", code: "ocr_quota", retryAfter: e.retryAfterSec }, { status: 429 });
    throw e;
  }
});
