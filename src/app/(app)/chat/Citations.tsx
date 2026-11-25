"use client";
// Copilot-style citations in an answer: numbered chips in the text (hover/focus → preview card, click → source
// viewer at the cited page) and a reference list under the answer showing the top 3 cited pages (+N more).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, FileText } from "lucide-react";
import { cn } from "@/components/ui";
import { useT } from "@/i18n/client";
import { cleanSnippet, type Reference } from "@/lib/citations";

export const TOP_REFERENCES = 3;

/** Inline citation: the shown number; hover/focus shows where it comes from, click opens the page. */
export function CiteChip({ refData, onOpen }: { refData: Reference; onOpen: () => void }) {
  const { t } = useT();
  const btn = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => btn.current && setRect(btn.current.getBoundingClientRect()), 180);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setRect(null);
  };
  useEffect(() => {
    if (!rect) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [rect]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const page = refData.pageEnd > refData.page ? t("viewer.pages", { a: refData.page, b: refData.pageEnd }) : t("viewer.page", { n: refData.page });
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="cite"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => {
          hide();
          onOpen();
        }}
        aria-label={t("chat.citeLabel", { k: refData.k, title: refData.title, page })}
      >
        {refData.k}
      </button>
      {rect &&
        createPortal(
          <PreviewCard refData={refData} page={page} anchor={rect} />,
          document.body,
        )}
    </>
  );
}

function PreviewCard({ refData, page, anchor }: { refData: Reference; page: string; anchor: DOMRect }) {
  const W = 320;
  const below = anchor.bottom + 190 < window.innerHeight;
  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - W / 2), window.innerWidth - W - 8);
  return (
    <div
      role="tooltip"
      className="animate-pop pointer-events-none fixed z-[60] rounded-xl border border-line bg-surface p-3 text-start shadow-[0_18px_40px_-16px_rgba(13,15,18,0.45)]"
      style={{ width: W, left, ...(below ? { top: anchor.bottom + 6 } : { bottom: window.innerHeight - anchor.top + 6 }) }}
    >
      <div className="flex items-center gap-2">
        <FileText className="size-4 shrink-0 text-coral" />
        <span className="bidi min-w-0 flex-1 truncate text-sm font-semibold text-ink">{refData.title}</span>
      </div>
      <div className="mt-0.5 truncate text-xs text-muted">
        {page}
        {refData.section && <span className="bidi"> · {refData.section}</span>}
      </div>
      <p dir="auto" className="bidi mt-2 line-clamp-4 whitespace-pre-line text-xs leading-relaxed text-ink-2">
        {cleanSnippet(refData.snippet)}
      </p>
    </div>
  );
}

/** Reference list under an answer: top 3 cited pages, the rest behind "+N more". */
export function ReferenceList({ refs, active, onOpen }: { refs: Reference[]; active: number | null; onOpen: (i: number) => void }) {
  const { t } = useT();
  const [all, setAll] = useState(false);
  if (!refs.length) return null;
  const shown = all ? refs : refs.slice(0, TOP_REFERENCES);
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
        <FileText className="size-3.5" /> {t("chat.references")}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {shown.map((r, i) => (
          <button
            key={r.k}
            type="button"
            onClick={() => onOpen(i)}
            className={cn(
              "group flex min-w-0 cursor-pointer flex-col rounded-xl border bg-surface p-2.5 text-start transition hover:border-coral/50 hover:bg-cream",
              active === i ? "border-coral/60 bg-cream" : "border-line",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="cite-badge shrink-0">{r.k}</span>
              <span className="bidi min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={r.title}>
                {r.title}
              </span>
            </div>
            <div className="mt-1 truncate text-[11px] text-muted">
              {r.pageEnd > r.page ? t("viewer.pages", { a: r.page, b: r.pageEnd }) : t("viewer.page", { n: r.page })}
              {r.section && <span className="bidi"> · {r.section}</span>}
            </div>
            <p dir="auto" className="bidi mt-1 line-clamp-2 text-xs leading-snug text-ink-2">
              {cleanSnippet(r.snippet)}
            </p>
          </button>
        ))}
      </div>
      {refs.length > TOP_REFERENCES && (
        <button onClick={() => setAll((a) => !a)} className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-xs text-muted hover:text-ink">
          {all ? t("chat.fewerRefs") : t("chat.moreRefs", { n: refs.length - TOP_REFERENCES })}
          <ChevronDown className={cn("size-3.5 transition", all && "rotate-180")} />
        </button>
      )}
    </div>
  );
}
