"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, ArrowUp, Check, ChevronDown, Copy, FileText, Files, History, Plus, Trash2, Wand2, X } from "lucide-react";
import { useApp } from "@/components/AppShell";
import { Mark, Spinner, Tag, api, cn, fmtMs } from "@/components/ui";
import type { PublicDocument } from "@/lib/docs";
import { useT } from "@/i18n/client";
import { LOCALE_META } from "@/i18n/config";
import { Dropdown } from "@/components/Dropdown";
import { detectLang, isRtl } from "@/lib/text/arabic";

type Source = { n: number; documentId: string; title: string; page: number; section: string; snippet: string; score: number };
type Msg = { id?: string; role: "user" | "assistant"; content: string; lang?: string; sources?: Source[]; issues?: string[]; timings?: Record<string, number> | null; pending?: "search" | "write" };
type ConvoItem = { id: string; title: string; documentIds: string[]; updatedAt: string };

const dirFor = (text: string, fallback: string) => (isRtl(detectLang(text, fallback as "en")) ? "rtl" : "ltr");

/** Source previews: Markdown tables → readable "cell · cell" rows, no separator lines or tags. */
const cleanSnippet = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))
    .map((l) => (/^\s*\|/.test(l) ? l.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" · ") : l))
    .join("\n")
    .replace(/<br\s*\/?>/gi, " / ")
    .replace(/\*\*/g, "")
    .trim();

export function ChatView() {
  const { t, tError, messages } = useT();
  const { user } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const convoId = params.get("c");

  const [docs, setDocs] = useState<PublicDocument[] | null>(null);
  const [convos, setConvos] = useState<ConvoItem[]>([]);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [scope, setScope] = useState<string[]>(() => (params.get("doc") ? [params.get("doc")!] : []));
  const [answerLang, setAnswerLang] = useState<"auto" | "ar" | "en" | "ur">("auto");
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const activeConvo = useRef<string | null>(convoId);

  const loadConvos = useCallback(() => {
    api<{ conversations: ConvoItem[] }>("/api/conversations")
      .then((d) => setConvos(d.conversations))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api<{ documents: PublicDocument[] }>("/api/documents")
      .then((d) => setDocs(d.documents.filter((x) => x.status === "ready" || x.chunkCount > 0)))
      .catch(() => setDocs([]));
    loadConvos();
  }, [loadConvos]);

  // Load the selected conversation (or start empty).
  useEffect(() => {
    if (activeConvo.current === convoId && msgs !== null && streaming) return; // our own URL update mid-stream
    activeConvo.current = convoId;
    if (!convoId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset view when leaving a conversation
      setMsgs([]);
      return;
    }
    setMsgs(null);
    api<{ conversation: { documentIds: string[] }; messages: Msg[] }>(`/api/conversations/${convoId}`)
      .then((d) => {
        setMsgs(d.messages);
        setScope(d.conversation.documentIds);
        requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
      })
      .catch(() => {
        setMsgs([]);
        router.replace("/chat");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convoId]);

  const scrollToEnd = () => requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }));

  async function send(text: string) {
    const q = text.trim();
    if (!q || streaming) return;
    setError("");
    setInput("");
    setStreaming(true);
    setMsgs((m) => [...(m ?? []), { role: "user", content: q }, { role: "assistant", content: "", pending: "search" }]);
    scrollToEnd();
    const patchLast = (fn: (m: Msg) => Msg) => setMsgs((ms) => (ms ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, conversationId: activeConvo.current, documentIds: scope, answerLang: answerLang === "auto" ? undefined : answerLang }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.code ?? "server_error");
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.t === "meta") {
            if (!activeConvo.current) {
              activeConvo.current = ev.conversationId;
              router.replace(`/chat?c=${ev.conversationId}`, { scroll: false });
            }
            patchLast((m) => ({ ...m, lang: ev.lang }));
          } else if (ev.t === "sources") patchLast((m) => ({ ...m, sources: ev.sources, pending: "write" }));
          else if (ev.t === "delta") patchLast((m) => ({ ...m, content: m.content + ev.d, pending: undefined }));
          else if (ev.t === "verify") patchLast((m) => ({ ...m, issues: ev.issues }));
          else if (ev.t === "done") patchLast((m) => ({ ...m, id: ev.messageId, timings: ev.timings, pending: undefined }));
          else if (ev.t === "error") throw new Error(ev.code);
        }
      }
    } catch (e) {
      setError(tError((e as Error).message));
      setMsgs((ms) => (ms && !ms[ms.length - 1].content ? ms.slice(0, -1) : ms));
    } finally {
      setStreaming(false);
      loadConvos();
    }
  }

  function newChat() {
    activeConvo.current = null;
    setMsgs([]);
    setHistoryOpen(false);
    router.push("/chat");
  }

  async function deleteConvo(id: string) {
    if (!confirm(t("chat.deleteConfirm"))) return;
    await api(`/api/conversations/${id}`, { method: "DELETE" }).catch(() => {});
    setConvos((c) => c.filter((x) => x.id !== id));
    if (id === activeConvo.current) newChat();
  }

  const noDocs = docs !== null && docs.length === 0;

  return (
    <div className="-mt-2 flex h-[calc(100dvh-150px)] min-h-[480px] gap-6 lg:h-[calc(100dvh-120px)]">
      {/* History (desktop column / mobile drawer) */}
      <aside className={cn("w-64 shrink-0 flex-col", historyOpen ? "fixed inset-0 z-50 flex bg-bg p-4" : "hidden xl:flex")}>
        <div className="mb-3 flex items-center justify-between">
          <Tag>{t("chat.history")}</Tag>
          {historyOpen && (
            <button onClick={() => setHistoryOpen(false)} aria-label={t("common.close")} className="cursor-pointer p-1 text-muted">
              <X className="size-5" />
            </button>
          )}
        </div>
        <button onClick={newChat} className="mb-3 inline-flex h-10 cursor-pointer items-center justify-center gap-2 bg-invert text-sm font-medium text-invert-ink hover:opacity-90">
          <Plus className="size-4" /> {t("chat.newChat")}
        </button>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {convos.length === 0 && <p className="px-2 text-sm text-muted">{t("chat.noHistory")}</p>}
          {convos.map((c) => (
            <div key={c.id} className={cn("group flex items-center rounded-lg", c.id === convoId ? "bg-surface ring-1 ring-line" : "hover:bg-surface-2")}>
              <Link href={`/chat?c=${c.id}`} onClick={() => setHistoryOpen(false)} className="bidi min-w-0 flex-1 truncate px-3 py-2 text-sm text-ink-2">
                {c.title || "…"}
              </Link>
              <button onClick={() => deleteConvo(c.id)} aria-label={t("common.delete")} className="me-1 cursor-pointer p-1.5 text-muted opacity-0 hover:text-critical group-hover:opacity-100 focus:opacity-100">
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Conversation */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="hidden font-mono text-xs uppercase tracking-[0.16em] text-muted sm:block">{t("chat.eyebrow")}</div>
            <h1 className="font-serif text-2xl font-black leading-tight text-navy sm:mt-1 sm:text-4xl">
              {t("chat.title")} <Mark>{t("chat.accent")}</Mark>
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setHistoryOpen(true)} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm text-ink-2 hover:bg-surface-2 xl:hidden">
              <History className="size-4" /> {t("chat.history")}
            </button>
            <ScopePicker docs={docs ?? []} value={scope} onChange={setScope} />
            <Dropdown<typeof answerLang>
              ariaLabel={t("chat.answerIn")}
              title={t("chat.answerIn")}
              value={answerLang}
              onChange={setAnswerLang}
              triggerClassName="!h-9"
              options={[
                { value: "auto", label: t("chat.answerAuto"), badge: <Wand2 className="size-3.5" /> },
                ...(["ar", "en", "ur"] as const).map((l) => ({
                  value: l,
                  label: LOCALE_META[l].native,
                  sub: l === "en" ? undefined : LOCALE_META[l].english,
                  badge: LOCALE_META[l].code,
                  dir: LOCALE_META[l].dir,
                })),
              ]}
              trigger={
                <>
                  <span className="hidden text-muted sm:inline">{t("chat.answerIn")}</span>
                  <span className="font-medium">{answerLang === "auto" ? t("chat.answerAuto") : LOCALE_META[answerLang].native}</span>
                </>
              }
            />
          </div>
        </div>

        <div ref={scroller} className="relative -mx-4 min-h-0 flex-1 overflow-y-auto border-y border-line bg-surface px-4 py-5 sm:mx-0 sm:rounded-3xl sm:border sm:p-6">
          {msgs === null ? (
            <div className="grid h-full place-items-center">
              <Spinner />
            </div>
          ) : msgs.length === 0 ? (
            <div className="flex min-h-full flex-col items-center justify-center text-center">
              <div className="font-serif text-2xl font-black text-navy sm:text-3xl">
                <Mark>{t("chat.hello", { name: user.name.split(" ")[0] })}</Mark>
              </div>
              <p className="mt-2 max-w-md text-sm text-ink-2">{noDocs ? t("chat.noDocs") : t("chat.sub")}</p>
              {noDocs ? (
                <Link href="/documents" className="mt-6 inline-flex h-11 items-center bg-invert px-5 font-mono text-[13px] uppercase tracking-wide text-invert-ink">
                  {t("chat.goUpload")}
                </Link>
              ) : (
                <div className="mt-8 grid w-full max-w-3xl gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
                  {messages.chat.starters.map((s, i) => (
                    <button key={s} onClick={() => send(s)} className="flex cursor-pointer flex-col justify-start bg-surface p-5 text-start transition hover:bg-cream">
                      <Tag n={i + 1}>{t("chat.send")}</Tag>
                      <div className="bidi mt-3 text-[15px] font-medium text-ink">{s}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-7">
              {msgs.map((m, i) =>
                m.role === "user" ? (
                  <div key={m.id ?? i} className="flex justify-end">
                    <div dir="auto" className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-ee-md bg-invert px-4 py-2.5 text-[15px] leading-relaxed text-invert-ink">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <AssistantMessage key={m.id ?? i} m={m} streaming={streaming && i === msgs.length - 1} />
                ),
              )}
            </div>
          )}
        </div>

        {error && <div className="mt-2 text-sm text-critical">{error}</div>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="mt-3 flex items-end gap-2 rounded-2xl border border-cream-line bg-cream p-1.5 ps-4 sm:p-2 sm:ps-4"
        >
          <textarea
            value={input}
            dir="auto"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            disabled={noDocs}
            placeholder={t("chat.placeholder")}
            className="max-h-36 min-h-10 flex-1 resize-none bg-transparent py-2 text-[16px] text-ink outline-none placeholder:text-muted sm:text-[15px]"
          />
          <button disabled={!input.trim() || streaming || noDocs} aria-label={t("chat.send")} className="btn-coral grid size-10 shrink-0 cursor-pointer place-items-center rounded-full disabled:opacity-40">
            {streaming ? <Spinner className="size-4 text-white" /> : <ArrowUp className="size-5" />}
          </button>
        </form>
      </div>
    </div>
  );
}

function AssistantMessage({ m, streaming }: { m: Msg; streaming: boolean }) {
  const { t, locale } = useT();
  const [openSources, setOpenSources] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const dir = dirFor(m.content || "x", m.lang ?? locale);

  // [n] → clickable citation chips (only for numbers that match a source).
  const md = useMemo(() => {
    const max = m.sources?.length ?? 0;
    return m.content.replace(/\[(\d{1,2})\]/g, (all, n) => (Number(n) >= 1 && Number(n) <= max ? `[${n}](#src-${n})` : all));
  }, [m.content, m.sources]);

  const showSource = (n: number) => {
    setOpenSources(true);
    setHighlight(n);
    setTimeout(() => document.getElementById(`src-${m.id ?? "live"}-${n}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  };

  return (
    <div className="flex gap-3">
      <div className="hidden size-8 shrink-0 place-items-center rounded-full bg-coral font-mono text-sm font-semibold text-white sm:grid">m</div>
      <div className="min-w-0 flex-1 sm:max-w-[92%]">
        {m.pending ? (
          <div className="flex items-center gap-2 py-1 text-sm text-muted">
            <span className="flex gap-1">
              {[0, 1, 2].map((d) => (
                <span key={d} className="size-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: `${d * 120}ms` }} />
              ))}
            </span>
            {m.pending === "search" ? t("chat.searching") : t("chat.writing")}
          </div>
        ) : (
          <div dir={dir} className="prose-chat text-[16px] leading-[1.75] text-ink sm:text-[15px]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => {
                  const cite = href?.match(/^#src-(\d+)$/);
                  if (cite)
                    return (
                      <button type="button" className="cite" onClick={() => showSource(Number(cite[1]))}>
                        {cite[1]}
                      </button>
                    );
                  return (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  );
                },
                table: ({ children }) => (
                  <div className="-mx-1 overflow-x-auto">
                    <table>{children}</table>
                  </div>
                ),
              }}
            >
              {md}
            </ReactMarkdown>
          </div>
        )}

        {!streaming && m.issues && m.issues.length > 0 && (
          <div className="mt-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-[#7a5300] dark:text-warning">
            <div className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="size-4" /> {t("chat.verifyTitle")}
            </div>
            <ul className="mt-1 list-disc ps-5">
              {m.issues.map((iss) => {
                const [kind, v] = iss.split(":");
                return <li key={iss}>{t(`chat.issue.${kind}`, { v: v ?? "" })}</li>;
              })}
            </ul>
          </div>
        )}

        {m.sources && m.sources.length > 0 && (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={() => setOpenSources((o) => !o)} className="inline-flex cursor-pointer items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted hover:text-ink">
                <FileText className="size-3.5" /> {t("chat.sources")} · {m.sources.length}
                <ChevronDown className={cn("size-3.5 transition", openSources && "rotate-180")} />
              </button>
              {!streaming && m.content && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(m.content).catch(() => {});
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted hover:text-ink"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? t("chat.copied") : t("chat.copy")}
                </button>
              )}
              {m.timings?.total != null && (
                <span className="font-mono text-[11px] text-muted">
                  {t("chat.timing", { r: fmtMs(m.timings.retrieval), f: fmtMs(m.timings.firstToken), t: fmtMs(m.timings.total) })}
                </span>
              )}
            </div>
            {openSources && (
              <div className="mt-2 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
                {m.sources.map((s) => (
                  <div key={s.n} id={`src-${m.id ?? "live"}-${s.n}`} className={cn("bg-surface p-3 text-sm transition", highlight === s.n && "bg-cream")}>
                    <div className="flex items-center gap-2">
                      <span className="cite !m-0 shrink-0" style={{ fontSize: "11px" }}>
                        {s.n}
                      </span>
                      <span className="bidi min-w-0 flex-1 truncate font-medium text-ink">{s.title}</span>
                      <span className="shrink-0 font-mono text-[11px] text-muted">{t("chat.sourcePage", { n: s.page })}</span>
                    </div>
                    {s.section && <div className="bidi mt-1 truncate text-xs font-medium text-ink-2">{s.section}</div>}
                    <p className="bidi mt-1 line-clamp-4 whitespace-pre-line text-xs leading-relaxed text-ink-2">{cleanSnippet(s.snippet)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Multi-select of documents to search in (empty = all). */
function ScopePicker({ docs, value, onChange }: { docs: PublicDocument[]; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const label = value.length ? t("chat.scopeSome", { n: value.length }) : t("chat.scopeAll");
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface ps-3 pe-2.5 text-sm text-ink hover:border-ink/25 hover:bg-surface-2">
        <Files className="size-4 text-coral" /> {label} <ChevronDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="animate-pop absolute end-0 z-50 mt-2 max-h-80 w-72 overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-[0_24px_60px_-20px_rgba(13,15,18,0.45)]">
            <div className="px-2 pb-2 pt-1">
              <Tag>{t("chat.scopeTitle")}</Tag>
            </div>
            <button onClick={() => onChange([])} className={cn("flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-start text-sm hover:bg-surface-2", !value.length && "font-semibold")}>
              <span className={cn("grid size-4 place-items-center rounded border", !value.length ? "border-coral bg-coral text-white" : "border-line")}>{!value.length && <Check className="size-3" />}</span>
              {t("chat.scopeAll")}
            </button>
            {docs.map((d) => {
              const on = value.includes(d.id);
              return (
                <button
                  key={d.id}
                  onClick={() => onChange(on ? value.filter((x) => x !== d.id) : [...value, d.id])}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-start text-sm hover:bg-surface-2"
                >
                  <span className={cn("grid size-4 shrink-0 place-items-center rounded border", on ? "border-coral bg-coral text-white" : "border-line")}>{on && <Check className="size-3" />}</span>
                  <span className="bidi min-w-0 truncate">{d.title}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
