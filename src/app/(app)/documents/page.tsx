"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, FileUp, Loader2, MessageSquareText, RotateCw, Trash2, XCircle } from "lucide-react";
import type { PublicDocument } from "@/lib/docs";
import { ingestFile, type Progress } from "@/lib/ingest/ingest";
import { useT } from "@/i18n/client";
import { Button, Empty, PageHeader, Spinner, Tag, api, cn, errorCode, fmtBytes } from "@/components/ui";

type Job = { id: string; file: File; progress: Progress };

export default function DocumentsPage() {
  const { t, tError, intl } = useT();
  const [docs, setDocs] = useState<PublicDocument[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [over, setOver] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<Job[]>([]);
  const running = useRef(false);

  const load = useCallback(() => {
    api<{ documents: PublicDocument[] }>("/api/documents")
      .then((d) => setDocs(d.documents))
      .catch((e) => {
        setDocs([]);
        setError(tError(errorCode(e)));
      });
  }, [tError]);
  useEffect(load, [load]);

  // Warn before closing the tab while files are still being processed (uploads resume on re-upload anyway).
  useEffect(() => {
    const busy = jobs.some((j) => !["done", "failed"].includes(j.progress.stage));
    if (!busy) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [jobs]);

  // Files are processed one at a time: keeps Gemini under its per-minute limit and the browser responsive.
  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    while (queue.current.length) {
      const job = queue.current.shift()!;
      await ingestFile(job.file, (p) => setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, progress: p } : j))));
      load();
    }
    running.current = false;
  }, [load]);

  function addFiles(list: FileList | File[]) {
    const fresh = [...list].map((file) => ({ id: crypto.randomUUID(), file, progress: { stage: "hashing", done: 0, total: 0, flagged: 0 } as Progress }));
    if (!fresh.length) return;
    queue.current.push(...fresh);
    setJobs((js) => [...fresh, ...js]);
    pump();
  }

  async function remove(d: PublicDocument) {
    if (!confirm(t("docs.confirmDelete", { title: d.title }))) return;
    await api(`/api/documents/${d.id}`, { method: "DELETE" }).catch(() => {});
    setDocs((ds) => ds?.filter((x) => x.id !== d.id) ?? null);
  }

  async function finishEmbeddings(d: PublicDocument) {
    for (let i = 0; i < 50; i++) {
      const r = await api<{ remaining: number }>(`/api/documents/${d.id}/embed`, { method: "POST" }).catch(() => null);
      if (!r || r.remaining === 0) break;
    }
    load();
  }

  const activeJobs = jobs;

  return (
    <div>
      <PageHeader eyebrow={t("docs.eyebrow")} title={t("docs.title")} accent={t("docs.accent")} sub={t("docs.sub")} />

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          addFiles(e.dataTransfer.files);
        }}
        data-over={over}
        className="dropzone flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-cream-line bg-cream px-6 py-12 text-center transition"
      >
        <div className="grid size-14 place-items-center rounded-full bg-surface text-coral shadow-sm ring-1 ring-line">
          <FileUp className="size-7" />
        </div>
        <div className="mt-4 font-serif text-2xl font-black text-navy">{t("docs.drop")}</div>
        <div className="mt-1 text-ink-2">
          {t("docs.or")}{" "}
          <button onClick={() => input.current?.click()} className="cursor-pointer font-semibold text-coral-ink underline underline-offset-4">
            {t("docs.browse")}
          </button>
        </div>
        <div className="mt-3 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{t("docs.types")}</div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".pdf,.docx,.txt,.md,.csv,.tsv,.json,.html,image/*"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {error && <div className="mt-4 text-sm text-critical">{error}</div>}

      {/* Processing queue */}
      {activeJobs.length > 0 && (
        <section className="mt-8">
          <Tag>{t("docs.queue")}</Tag>
          <div className="mt-3 grid gap-px overflow-hidden rounded-lg border border-line bg-line">
            {activeJobs.map((j) => (
              <JobRow key={j.id} job={j} onDismiss={() => setJobs((js) => js.filter((x) => x.id !== j.id))} />
            ))}
          </div>
        </section>
      )}

      {/* Library */}
      <section className="mt-10">
        <Tag>{t("docs.library")}</Tag>
        <div className="mt-3 overflow-hidden rounded-lg border border-line bg-surface">
          {docs === null ? (
            <div className="grid place-items-center py-12">
              <Spinner />
            </div>
          ) : docs.length === 0 ? (
            <Empty icon={<FileText className="size-8" />} title={t("docs.empty")}>
              {t("docs.emptyBody")}
            </Empty>
          ) : (
            <ul className="divide-y divide-line">
              {docs.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4 sm:p-5">
                  <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-cream text-coral ring-1 ring-cream-line">
                      <FileText className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="bidi truncate font-semibold text-ink" title={d.fileName}>
                        {d.title}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                        <span>{t("common.pages", { n: d.pageCount.toLocaleString(intl) })}</span>
                        <span>· {d.chunkCount.toLocaleString(intl)} {t("docs.colChunks")}</span>
                        <span>· {fmtBytes(d.size)}</span>
                        {d.language && <span>· {t(`docs.lang.${d.language}`)}</span>}
                        <span>· {new Date(d.createdAt).toLocaleDateString(intl, { day: "numeric", month: "short", year: "numeric" })}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {d.ocr.gemini > 0 && <Badge>{t("docs.ocrBadge.gemini")} · {d.ocr.gemini}</Badge>}
                        {d.ocr.tesseract > 0 && <Badge>{t("docs.ocrBadge.tesseract")} · {d.ocr.tesseract}</Badge>}
                        {d.ocr.textLayer > 0 && <Badge>{t("docs.ocrBadge.textLayer")} · {d.ocr.textLayer}</Badge>}
                        {d.ocr.flagged.length > 0 && (
                          <Badge tone="warn" title={`${t("docs.flaggedHint")}: ${d.ocr.flagged.slice(0, 30).join(", ")}`}>
                            <AlertTriangle className="size-3" /> {t("docs.flagged", { n: d.ocr.flagged.length })}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill status={d.status} done={d.pagesDone} total={d.pageCount} />
                    {d.pendingEmbeddings > 0 && (
                      <Button size="sm" variant="outline" onClick={() => finishEmbeddings(d)}>
                        <RotateCw className="size-3.5" /> {t("docs.retryEmbeddings")}
                      </Button>
                    )}
                    {d.status === "ready" && (
                      <Link href={`/chat?doc=${d.id}`} className="inline-flex h-8 items-center gap-1.5 bg-invert px-3 text-sm text-invert-ink hover:opacity-90">
                        <MessageSquareText className="size-3.5" /> {t("docs.ask")}
                      </Link>
                    )}
                    <button onClick={() => remove(d)} aria-label={t("common.delete")} className="grid size-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-critical/10 hover:text-critical">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Badge({ children, tone, title }: { children: React.ReactNode; tone?: "warn"; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wide",
        tone === "warn" ? "border-warning/40 bg-warning/15 text-[#9a6a00] dark:text-warning" : "border-line bg-surface-2 text-ink-2",
      )}
    >
      {children}
    </span>
  );
}

function StatusPill({ status, done, total }: { status: string; done: number; total: number }) {
  const { t, intl } = useT();
  if (status === "ready")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-good/25 bg-good/10 px-2 py-0.5 text-xs font-medium text-good">
        <CheckCircle2 className="size-3.5" /> {t("docs.status.ready")}
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-critical/30 bg-critical/10 px-2 py-0.5 text-xs font-medium text-critical">
        <XCircle className="size-3.5" /> {t("docs.status.failed")}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/15 px-2 py-0.5 text-xs font-medium text-[#9a6a00] dark:text-warning">
      <Loader2 className="size-3.5 animate-spin" /> {t("docs.progress", { done: done.toLocaleString(intl), total: total.toLocaleString(intl) })}
    </span>
  );
}

function JobRow({ job, onDismiss }: { job: Job; onDismiss: () => void }) {
  const { t, tError, intl } = useT();
  const p = job.progress;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const finished = p.stage === "done" || p.stage === "failed";
  return (
    <div className="bg-surface p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="bidi truncate font-medium text-ink">{job.file.name}</div>
          <div className={cn("mt-0.5 text-sm", p.stage === "failed" ? "text-critical" : "text-ink-2")}>
            {p.stage === "failed" ? tError(p.errorCode ?? "server_error") : t(`docs.stage.${p.stage}`)}
            {p.total > 0 && !finished && <span className="ms-2 font-mono text-xs text-muted">{t("docs.progress", { done: p.done.toLocaleString(intl), total: p.total.toLocaleString(intl) })}</span>}
          </div>
          {p.resumed ? <div className="mt-0.5 text-xs text-muted">{t("docs.stage.resumed", { n: p.resumed })}</div> : null}
          {p.quota && <div className="mt-1 text-xs text-[#9a6a00] dark:text-warning">{t("docs.stage.quota")}</div>}
          {p.flagged > 0 && <div className="mt-1 text-xs text-[#9a6a00] dark:text-warning">{t("docs.flagged", { n: p.flagged })}</div>}
        </div>
        <div className="font-mono text-sm text-ink-2">{finished ? (p.stage === "done" ? <CheckCircle2 className="size-5 text-good" /> : <XCircle className="size-5 text-critical" />) : `${pct}%`}</div>
        {finished && (
          <button onClick={onDismiss} className="cursor-pointer text-xs text-muted underline">
            {t("common.close")}
          </button>
        )}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", p.stage === "failed" ? "bg-critical" : p.stage === "done" ? "bg-good" : "bg-coral progress-live")}
          style={{ width: `${finished ? 100 : Math.max(pct, p.total ? 3 : 8)}%` }}
        />
      </div>
    </div>
  );
}
