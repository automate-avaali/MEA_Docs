"use client";
// Source viewer (Copilot-style citation pane): opens the original document at the cited page, renders it with
// pdf.js straight from Vercel Blob (signed URL, no function in between), highlights the cited passage where the
// page has a text layer, and shows the passage text underneath (scanned pages have no text layer to highlight).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Minus, Plus, X } from "lucide-react";
import { Spinner, api, cn } from "@/components/ui";
import { useT } from "@/i18n/client";
import { cleanSnippet, factTokens, highlightBoxes, markWords, tokens, type HighlightBox, type Reference } from "@/lib/citations";
import { loadPdfjs, pdfAssetOptions } from "@/lib/pdfjs";

type DocInfo = { id: string; title: string; fileName: string; mimeType: string; pageCount: number; hasFile: boolean };
type FileInfo = { url: string; contentType: string; expiresAt: number };

// ── Session caches: document info, signed URLs, loaded PDFs (a few, least recently used dropped) ──
const docCache = new Map<string, Promise<DocInfo | null>>();
const urlCache = new Map<string, Promise<FileInfo>>();
const pdfCache = new Map<string, Promise<PDFDocumentProxy>>();
const PDF_KEEP = 4;

function docInfo(id: string) {
  if (!docCache.has(id))
    docCache.set(
      id,
      api<{ document: DocInfo }>(`/api/documents/${id}`)
        .then((d) => d.document)
        .catch(() => (docCache.delete(id), null)),
    );
  return docCache.get(id)!;
}

async function fileInfo(id: string): Promise<FileInfo> {
  const hit = urlCache.get(id);
  if (hit) {
    const f = await hit.catch(() => null);
    if (f && f.expiresAt - Date.now() > 60_000) return f;
  }
  const p = api<FileInfo>(`/api/documents/${id}/file?as=url`);
  urlCache.set(id, p);
  p.catch(() => urlCache.delete(id));
  return p;
}

function loadPdf(id: string, onProgress: (pct: number) => void) {
  const hit = pdfCache.get(id);
  if (hit) {
    pdfCache.delete(id); // re-insert → most recently used
    pdfCache.set(id, hit);
    return hit;
  }
  const p = (async () => {
    const [lib, file] = await Promise.all([loadPdfjs(), fileInfo(id)]);
    // Blob allows cross-origin GETs but not range requests from the browser → one streamed download, cached.
    // pdfAssetOptions: decoders for scanned pages (CCITT/JBIG2 text layers) — without them pages render blank.
    const task = lib.getDocument({ url: file.url, disableRange: true, ...pdfAssetOptions() });
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => total && onProgress(Math.min(99, Math.round((loaded / total) * 100)));
    return task.promise;
  })();
  pdfCache.set(id, p);
  p.catch(() => pdfCache.delete(id));
  while (pdfCache.size > PDF_KEEP) {
    const [oldId, old] = pdfCache.entries().next().value!;
    pdfCache.delete(oldId);
    old.then((d) => d.destroy()).catch(() => {});
  }
  return p;
}

/** Several cited chunks of one page, each shown once (a chunk contained in another one is dropped). */
function joinPassages(texts: string[]) {
  const norm = texts.map((t) => t.replace(/\s+/g, " ").trim());
  return texts.filter((_, i) => norm[i] && norm.indexOf(norm[i]) === i && !norm.some((o, j) => j !== i && o.length > norm[i].length && o.includes(norm[i]))).join("\n\n");
}

async function loadPassage(ref: Reference) {
  const ids = ref.sources.map((s) => s.chunkId).filter(Boolean);
  const fallback = joinPassages(ref.sources.map((s) => cleanSnippet(s.snippet)));
  try {
    const { passages } = await api<{ passages: { id: string; content: string }[] }>(
      `/api/documents/${ref.documentId}/passages?chunks=${ids.join(",")}&page=${ref.page}`,
    );
    const ordered = ids.length ? ids.map((id) => passages.find((p) => p.id === id)).filter(Boolean) : passages;
    const text = joinPassages((ordered.length ? ordered : passages).map((p) => cleanSnippet(p!.content)));
    return text || fallback;
  } catch {
    return fallback;
  }
}

// ── Highlight boxes from the page's text layer ──
const NONE = new Set<string>(); // pages outside the cited range: nothing to highlight

// ── One rendered PDF page with its highlight overlay ──
function PdfPage({ pdf, pageNo, zoom, passage, facts, scroller }: { pdf: PDFDocumentProxy; pageNo: number; zoom: number; passage: Set<string>; facts: Set<string>; scroller: React.RefObject<HTMLDivElement | null> }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [boxes, setBoxes] = useState<HighlightBox[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth((w) => (Math.abs(w - e.contentRect.width) > 8 ? Math.round(e.contentRect.width) : w)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!width || !canvas.current) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      try {
        const [lib, page] = await Promise.all([loadPdfjs(), pdf.getPage(pageNo)]);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / base.width) * zoom });
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const ratio = Math.min(dpr, Math.sqrt(16_000_000 / (viewport.width * viewport.height))); // stay under canvas limits
        const el = canvas.current!;
        el.width = Math.floor(viewport.width * ratio);
        el.height = Math.floor(viewport.height * ratio);
        setSize({ w: viewport.width, h: viewport.height });
        setFailed(false);
        task = page.render({ canvas: el, canvasContext: el.getContext("2d")!, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
        task.promise.catch(() => {}); // cancelled when the page/zoom changes mid-render — handled below, not an error
        const content = await page.getTextContent();
        if (cancelled) return;
        const items = content.items.filter((i): i is TextItem => "str" in i && !!i.str.trim());
        const b = highlightBoxes(items, viewport, lib.Util.transform, passage, facts);
        setBoxes(b);
        await task.promise;
        // Bring the highlight into view (the cited fact first, else the passage).
        const target = b.find((x) => x.fact) ?? b[0];
        if (target && scroller.current) scroller.current.scrollTo({ top: Math.max(0, target.y - scroller.current.clientHeight / 3), behavior: "smooth" });
      } catch (e) {
        if (!cancelled && (e as Error)?.name !== "RenderingCancelledException") setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNo, zoom, width, passage, facts, scroller]);

  const { t } = useT();
  return (
    // dir="ltr": the canvas inherits text direction, and pdf.js glyph placement breaks under an RTL (Arabic/Urdu) UI.
    <div ref={wrap} dir="ltr" className="w-full">
      {failed ? (
        <div className="p-6 text-center text-sm text-muted">{t("viewer.loadFailed")}</div>
      ) : (
        <div className="relative mx-auto bg-white shadow-[0_6px_24px_-12px_rgba(13,15,18,0.45)]" style={size ? { width: size.w, height: size.h } : { aspectRatio: "1 / 1.414" }}>
          <canvas ref={canvas} className="block size-full" />
          {size && boxes.length > 0 && (
            <svg className="pointer-events-none absolute inset-0" width={size.w} height={size.h} aria-hidden>
              <g opacity="0.32">
                {boxes.filter((b) => !b.fact).map((b, i) => (
                  <rect key={`p${i}`} x={b.x} y={b.y} width={b.w} height={b.h} rx="2" fill="#f5c542" />
                ))}
              </g>
              <g opacity="0.45">
                {boxes.filter((b) => b.fact).map((b, i) => (
                  <rect key={`f${i}`} x={b.x} y={b.y} width={b.w} height={b.h} rx="2" fill="#f08a24" />
                ))}
              </g>
            </svg>
          )}
          {!size && (
            <div className="absolute inset-0 grid place-items-center">
              <Spinner />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── The pane ──
export function SourceViewer({ refs, index, answer, onIndex, onClose }: { refs: Reference[]; index: number; answer: string; onIndex: (i: number) => void; onClose: () => void }) {
  const { t, intl } = useT();
  const ref = refs[index];
  const [doc, setDoc] = useState<DocInfo | null | undefined>(undefined); // undefined = loading, null = gone
  const [passage, setPassage] = useState<string | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [loadPct, setLoadPct] = useState<number | null>(null);
  const [fileError, setFileError] = useState(false);
  const [page, setPage] = useState(ref.page);
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);

  // New reference → its document, its page, its passage.
  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- reset the pane for the newly selected reference */
    setPage(ref.page);
    setZoom(1);
    setPassage(null);
    setFileError(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    loadPassage(ref).then((p) => !cancelled && setPassage(p));
    docInfo(ref.documentId).then((d) => {
      if (cancelled) return;
      setDoc(d);
      setPdf(null);
      setImage(null);
      if (!d?.hasFile) return;
      const isPdf = d.mimeType === "application/pdf" || /\.pdf$/i.test(d.fileName);
      const isImage = d.mimeType.startsWith("image/");
      if (isPdf) {
        setLoadPct(0);
        loadPdf(d.id, (p) => !cancelled && setLoadPct(p))
          .then((x) => !cancelled && (setPdf(x), setLoadPct(null)))
          .catch(() => !cancelled && (setFileError(true), setLoadPct(null)));
      } else if (isImage) {
        fileInfo(d.id)
          .then((f) => !cancelled && setImage(f.url))
          .catch(() => !cancelled && setFileError(true));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ref]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Like Copilot's citation pane: focus moves into the pane when it opens and back to the citation when it closes.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  const passageSet = useMemo(() => new Set(tokens(passage ?? ref.snippet)), [passage, ref.snippet]);
  const facts = useMemo(() => factTokens(answer, ref, passage ?? ref.snippet), [answer, ref, passage]);
  const pageCount = pdf?.numPages ?? doc?.pageCount ?? ref.pageEnd;
  const go = useCallback((p: number) => setPage(Math.min(Math.max(1, p), pageCount || 1)), [pageCount]);
  const cited = page >= ref.page && page <= ref.pageEnd;

  const notice = doc === null ? t("viewer.docGone") : doc && !doc.hasFile ? t("viewer.noFile") : fileError ? t("viewer.loadFailed") : doc && !pdf && !image && loadPct === null ? t("viewer.noPreview") : null;

  return (
    <div ref={root} tabIndex={-1} className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface outline-none lg:rounded-3xl lg:border lg:border-line">
      {/* Header: which reference, which document, actions */}
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <span className="cite-badge mt-0.5">{ref.k}</span>
        <div className="min-w-0 flex-1">
          <div className="bidi truncate font-semibold text-ink" title={ref.title}>
            {ref.title}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted">
            {ref.pageEnd > ref.page ? t("viewer.pages", { a: ref.page, b: ref.pageEnd }) : t("viewer.page", { n: ref.page })}
            {ref.section && <span className="bidi"> · {ref.section}</span>}
          </div>
        </div>
        {doc?.hasFile && (
          <>
            <a href={`/api/documents/${ref.documentId}/file`} target="_blank" rel="noopener" title={t("docs.openFile")} aria-label={t("docs.openFile")} className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink">
              <ExternalLink className="size-4" />
            </a>
            <a href={`/api/documents/${ref.documentId}/file?download=1`} download={doc.fileName || doc.title} title={t("docs.download")} aria-label={t("docs.download")} className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink">
              <Download className="size-4" />
            </a>
          </>
        )}
        <button onClick={onClose} title={t("common.close")} aria-label={t("common.close")} className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink">
          <X className="size-4" />
        </button>
      </div>

      {/* Switch between the answer's references */}
      {refs.length > 1 && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line px-4 py-2" role="tablist" aria-label={t("chat.references")}>
          {refs.map((r, i) => (
            <button
              key={r.k}
              role="tab"
              aria-selected={i === index}
              onClick={() => onIndex(i)}
              title={`${r.title} · ${t("viewer.page", { n: r.page })}`}
              className={cn("cite-badge cursor-pointer transition", i === index ? "!bg-coral !text-white" : "hover:!bg-coral/80 hover:!text-white")}
            >
              {r.k}
            </button>
          ))}
        </div>
      )}

      {/* The page */}
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto bg-surface-2 p-3 sm:p-4">
        {doc === undefined || (loadPct !== null && !pdf) ? (
          <div className="grid h-full min-h-48 place-items-center text-sm text-muted">
            <div className="flex flex-col items-center gap-2">
              <Spinner />
              {loadPct ? t("viewer.loading", { pct: loadPct }) : null}
            </div>
          </div>
        ) : pdf ? (
          <PdfPage pdf={pdf} pageNo={page} zoom={zoom} passage={cited ? passageSet : NONE} facts={cited ? facts : NONE} scroller={scroller} />
        ) : image ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed Blob URL, rendered as-is
          <img src={image} alt={ref.title} onError={() => (setImage(null), setFileError(true))} className="mx-auto block bg-white shadow-[0_6px_24px_-12px_rgba(13,15,18,0.45)]" style={{ width: `${zoom * 100}%`, maxWidth: "none" }} />
        ) : (
          <div className="mx-auto flex max-w-sm flex-col items-center gap-2 py-10 text-center text-sm text-muted">
            <FileText className="size-8" />
            {notice}
          </div>
        )}
      </div>

      {/* Page + zoom controls */}
      {(pdf || image) && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-sm">
          <div className="flex items-center gap-1">
            {pdf && (
              <>
                <button onClick={() => go(page - 1)} disabled={page <= 1} aria-label={t("viewer.prev")} className="grid size-8 cursor-pointer place-items-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-30">
                  <ChevronLeft className="size-4 rtl:-scale-x-100" />
                </button>
                <span className="min-w-24 text-center font-mono text-xs text-ink-2">{t("viewer.pageOf", { n: page.toLocaleString(intl), total: pageCount.toLocaleString(intl) })}</span>
                <button onClick={() => go(page + 1)} disabled={page >= pageCount} aria-label={t("viewer.next")} className="grid size-8 cursor-pointer place-items-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-30">
                  <ChevronRight className="size-4 rtl:-scale-x-100" />
                </button>
                {!cited && (
                  <button onClick={() => go(ref.page)} className="ms-1 cursor-pointer rounded-full bg-coral-soft px-2.5 py-1 text-xs font-medium text-coral-ink hover:opacity-90">
                    {t("viewer.backToCited")}
                  </button>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(1)))} disabled={zoom <= 1} aria-label={t("viewer.zoomOut")} className="grid size-8 cursor-pointer place-items-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-30">
              <Minus className="size-4" />
            </button>
            <span className="w-10 text-center font-mono text-xs text-ink-2">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.5).toFixed(1)))} disabled={zoom >= 3} aria-label={t("viewer.zoomIn")} className="grid size-8 cursor-pointer place-items-center rounded-md text-ink-2 hover:bg-surface-2 disabled:opacity-30">
              <Plus className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* The cited passage (the text the answer was built from), cited words marked */}
      <div className="max-h-[32%] min-h-0 shrink-0 overflow-y-auto border-t border-line px-4 py-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{t("viewer.passage")}</div>
        {passage === null ? (
          <div className="mt-2 h-12 animate-pulse rounded bg-line/60" />
        ) : (
          <p dir="auto" className="bidi mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-ink-2">
            {markWords(passage, facts).map(([s, hit], i) =>
              hit ? (
                <mark key={i} className="rounded-sm bg-[#f5c542]/45 px-0.5 text-ink">
                  {s}
                </mark>
              ) : (
                s
              ),
            )}
          </p>
        )}
      </div>
    </div>
  );
}
