// Browser-side ingestion. The browser does the heavy lifting so files of ANY size work on serverless:
//   • reads the PDF page by page (pdf.js) — the file itself is never uploaded
//   • digital pages → repaired text layer (free, ~4 ms/page)
//   • scanned pages → small PDFs of 5 pages → server → Gemini OCR (free tier: 15 RPM / 500 RPD)
//   • Gemini quota hit → Tesseract.js OCR right here in the browser (unlimited), text sent instead
//   • a sample of scanned pages is also read by Tesseract → server compares engines (catches bad OCR)
//   • bounded concurrency + backpressure: memory stays flat on 5,000-page files
//   • resumable: the server remembers finished pages by file hash; re-uploading continues where it stopped

import type { PDFDocument as PdfLibDoc } from "pdf-lib";
import { itemsToText, textLayerUsable } from "./pdf-text";

export type Stage = "hashing" | "reading" | "ocr" | "tesseract" | "indexing" | "finishing" | "done" | "failed";
export type Progress = {
  stage: Stage;
  done: number;
  total: number;
  docId?: string;
  resumed?: number;
  quota?: boolean;
  flagged: number;
  errorCode?: string;
};

const OCR_PAGES = 5; // pages per Gemini request (benchmarked best accuracy/quota balance)
const TEXT_PAGES = 25;
const SCAN_CONCURRENCY = 3; // ≈ 9 Gemini requests/min — under the free 15 RPM
const TEXT_CONCURRENCY = 2;
const MAX_BATCH_BYTES = 3_600_000; // under Vercel's 4.5 MB request limit
const CHECK_EVERY = 4; // Tesseract cross-check on 1 page of every 4th scanned batch

type TextPage = { page: number; text: string; source: "text" | "tesseract" | "docx" | "plain" };

class Pool {
  private active = 0;
  private waiters: (() => void)[] = [];
  private tasks: Promise<void>[] = [];
  error: unknown = null;
  constructor(private size: number) {}
  /** Waits for a free slot (backpressure), then starts the task without waiting for it. */
  async run(fn: () => Promise<void>) {
    while (this.active >= this.size) await new Promise<void>((r) => this.waiters.push(r));
    if (this.error) throw this.error;
    this.active++;
    const p = fn()
      .catch((e) => {
        this.error ??= e;
      })
      .finally(() => {
        this.active--;
        this.waiters.shift()?.();
      });
    this.tasks.push(p);
  }
  async drain() {
    await Promise.all(this.tasks);
    if (this.error) throw this.error;
  }
}

class IngestError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

async function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; data: Record<string, unknown> }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal });
      const data = await res.json().catch(() => ({}));
      if (res.status >= 500 && attempt < 3) throw new Error("retry");
      return { status: res.status, data };
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt >= 3) throw new IngestError("network");
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function sha256(buf: ArrayBuffer) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Kind = "pdf" | "image" | "docx" | "text";
function kindOf(f: File): Kind | null {
  const n = f.name.toLowerCase();
  if (f.type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (f.type.startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/.test(n)) return "image";
  if (n.endsWith(".docx")) return "docx";
  if (f.type.startsWith("text/") || /\.(txt|md|csv|tsv|json|html?)$/.test(n)) return "text";
  return null;
}

/** Splits long plain text into ~3,000-char "pages" on paragraph boundaries (for citations). */
function pseudoPages(text: string): string[] {
  const paras = text.split(/\n{2,}/);
  const pages: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length > 3000) {
      pages.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + p;
  }
  if (cur.trim()) pages.push(cur);
  return pages.length ? pages : [text];
}

// ── pdf.js / pdf-lib / tesseract are loaded only when needed (keeps the app bundle small) ──
async function pdfjs() {
  const lib = await import("pdfjs-dist");
  lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  return lib;
}

type TessWorker = { recognize: (img: HTMLCanvasElement | Blob) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> };
let tessPromise: Promise<TessWorker> | null = null;
async function tesseract(): Promise<TessWorker> {
  tessPromise ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const w = await createWorker("ara+eng", 1);
    await w.setParameters({ tessedit_pageseg_mode: "3" as never, preserve_interword_spaces: "1" });
    return w as unknown as TessWorker;
  })();
  return tessPromise;
}

async function renderPage(pdf: Awaited<ReturnType<Awaited<ReturnType<typeof pdfjs>>["getDocument"]>["promise"]>, n: number, scale: number) {
  const page = await pdf.getPage(n);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
  page.cleanup();
  return canvas;
}

export async function ingestFile(file: File, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<Progress> {
  const progress: Progress = { stage: "hashing", done: 0, total: 0, flagged: 0 };
  const emit = (patch: Partial<Progress>) => {
    Object.assign(progress, patch);
    onProgress({ ...progress });
  };

  try {
    const kind = kindOf(file);
    if (!kind) throw new IngestError("unsupported_file");
    emit({ stage: "hashing" });
    const bytes = await file.arrayBuffer();
    const hash = await sha256(bytes);

    // ── Work out the pages ──
    let textPages: string[] | null = null;
    let pdfBytes: Uint8Array | null = null;
    if (kind === "pdf") pdfBytes = new Uint8Array(bytes);
    else if (kind === "image") pdfBytes = await imageToPdf(file);
    else if (kind === "docx") {
      const mammoth = await import("mammoth/mammoth.browser");
      const { value } = await mammoth.extractRawText({ arrayBuffer: bytes });
      textPages = pseudoPages(value);
    } else textPages = pseudoPages(new TextDecoder().decode(bytes));

    const pdf = pdfBytes ? await (await pdfjs()).getDocument({ data: pdfBytes.slice() }).promise : null;
    const total = pdf ? pdf.numPages : textPages!.length;
    emit({ total, stage: "reading" });

    // ── Register (or resume) the document ──
    const reg = await request("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: file.name.replace(/\.[^.]+$/, ""), fileName: file.name, mimeType: file.type, size: file.size, hash, pageCount: total }),
    }, signal);
    if (reg.status >= 400) throw new IngestError(String(reg.data.code ?? "server_error"));
    const docId = (reg.data.document as { id: string }).id;
    const done = new Set<number>((reg.data.donePages as number[]) ?? []);
    emit({ docId, done: done.size, resumed: reg.data.resumed ? done.size : undefined });

    const batchUrl = `/api/documents/${docId}/batch`;
    const ack = (r: { data: Record<string, unknown> }, pages: number[]) => {
      pages.forEach((p) => done.add(p));
      emit({ done: done.size, flagged: progress.flagged + ((r.data.flagged as number[]) ?? []).length });
    };

    const sendText = async (pages: TextPage[]) => {
      const r = await request(batchUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages }) }, signal);
      if (r.status >= 400) throw new IngestError(String(r.data.code ?? "server_error"));
      ack(r, pages.map((p) => p.page));
    };

    // ── Plain text / DOCX ──
    if (textPages) {
      const pool = new Pool(TEXT_CONCURRENCY);
      emit({ stage: "indexing" });
      for (let i = 0; i < textPages.length; i += TEXT_PAGES) {
        const pages = textPages
          .slice(i, i + TEXT_PAGES)
          .map((text, k) => ({ page: i + k + 1, text, source: kind === "docx" ? "docx" : "plain" }) as TextPage)
          .filter((p) => !done.has(p.page));
        if (pages.length) await pool.run(() => sendText(pages));
      }
      await pool.drain();
    }

    // ── PDF (and images, which were wrapped into a 1-page PDF) ──
    if (pdf && pdfBytes) {
      const textPool = new Pool(TEXT_CONCURRENCY);
      const scanPool = new Pool(SCAN_CONCURRENCY);
      let lib: PdfLibDoc | null = null;
      let quota = false;
      let scanBatches = 0;
      const pdfLib = async () => (lib ??= await (await import("pdf-lib")).PDFDocument.load(pdfBytes!, { ignoreEncryption: true }));

      const tesseractPages = async (pages: number[]) => {
        emit({ stage: "tesseract" });
        const w = await tesseract();
        const out: TextPage[] = [];
        for (const p of pages) {
          const canvas = await renderPage(pdf, p, 2);
          out.push({ page: p, text: (await w.recognize(canvas)).data.text, source: "tesseract" });
        }
        await sendText(out);
      };

      const buildPdf = async (pages: number[]) => {
        const { PDFDocument } = await import("pdf-lib");
        const src = await pdfLib();
        const out = await PDFDocument.create();
        (await out.copyPages(src, pages.map((p) => p - 1))).forEach((pg) => out.addPage(pg));
        return out.save();
      };

      const sendScan = async (pages: number[]): Promise<void> => {
        if (quota) return tesseractPages(pages);
        let sub = await buildPdf(pages);
        if (sub.byteLength > MAX_BATCH_BYTES) {
          if (pages.length > 1) {
            const mid = Math.ceil(pages.length / 2);
            await sendScan(pages.slice(0, mid));
            return sendScan(pages.slice(mid));
          }
          sub = await rasterizeToPdf(await renderPage(pdf, pages[0], 1.6)); // one huge scan → 150-dpi JPEG
        }
        emit({ stage: "ocr" });
        const form = new FormData();
        form.append("pdf", new Blob([sub as BlobPart], { type: "application/pdf" }), "batch.pdf");
        form.append("pdfPages", JSON.stringify(pages));
        if (++scanBatches % CHECK_EVERY === 1) {
          // Independent second reading of one page → server flags/re-reads it if the engines disagree.
          const w = await tesseract();
          const canvas = await renderPage(pdf, pages[0], 2);
          form.append("checks", JSON.stringify([{ page: pages[0], text: (await w.recognize(canvas)).data.text }]));
        }
        const r = await request(batchUrl, { method: "POST", body: form }, signal);
        if (r.status === 429 && r.data.code === "ocr_quota") {
          quota = true;
          emit({ quota: true });
          return tesseractPages(pages);
        }
        if (r.status >= 400) throw new IngestError(String(r.data.code ?? "server_error"));
        ack(r, pages);
      };

      let textBuf: TextPage[] = [];
      let scanBuf: number[] = [];
      for (let p = 1; p <= total; p++) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        if (done.has(p)) continue;
        const page = await pdf.getPage(p);
        const text = itemsToText((await page.getTextContent()).items);
        page.cleanup();
        if (textLayerUsable(text)) {
          textBuf.push({ page: p, text, source: "text" });
          if (textBuf.length >= TEXT_PAGES) {
            const batch = textBuf;
            textBuf = [];
            await textPool.run(() => sendText(batch));
          }
        } else {
          scanBuf.push(p);
          if (scanBuf.length >= OCR_PAGES) {
            const batch = scanBuf;
            scanBuf = [];
            await scanPool.run(() => sendScan(batch));
          }
        }
      }
      if (textBuf.length) await textPool.run(() => sendText(textBuf));
      if (scanBuf.length) await scanPool.run(() => sendScan(scanBuf));
      await Promise.all([textPool.drain(), scanPool.drain()]);
      await pdf.destroy();
    }

    // ── Finish ──
    emit({ stage: "finishing" });
    const fin = await request(`/api/documents/${docId}/complete`, { method: "POST" }, signal);
    if (fin.status >= 400) throw new IngestError(String(fin.data.code ?? "server_error"));
    let pending = ((fin.data.document as { pendingEmbeddings?: number })?.pendingEmbeddings ?? 0) as number;
    for (let i = 0; pending > 0 && i < 50; i++) {
      const r = await request(`/api/documents/${docId}/embed`, { method: "POST" }, signal);
      if (r.status >= 400) break;
      pending = Number(r.data.remaining ?? 0);
    }
    emit({ stage: "done", done: total });
    return progress;
  } catch (e) {
    const code = e instanceof IngestError ? e.code : (e as Error)?.name === "AbortError" ? "aborted" : "server_error";
    if (code !== "aborted") console.error("[ingest]", e);
    emit({ stage: "failed", errorCode: code });
    return progress;
  }
}

async function rasterizeToPdf(canvas: HTMLCanvasElement) {
  const { PDFDocument } = await import("pdf-lib");
  const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.82));
  const out = await PDFDocument.create();
  const img = await out.embedJpg(await blob.arrayBuffer());
  out.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return out.save();
}

/** Wraps an image (any browser-readable format) into a 1-page PDF so it follows the scanned-page path. */
async function imageToPdf(file: File) {
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  const buf = await file.arrayBuffer();
  let img;
  if (/jpe?g/i.test(file.type) || /\.jpe?g$/i.test(file.name)) img = await out.embedJpg(buf);
  else if (/png/i.test(file.type) || /\.png$/i.test(file.name)) img = await out.embedPng(buf);
  else {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    const png: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
    img = await out.embedPng(await png.arrayBuffer());
  }
  out.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return out.save();
}
