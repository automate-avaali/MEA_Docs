"use client";
import Link from "next/link";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";

export function cn(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type BtnVariant = "ink" | "coral" | "outline" | "ghost" | "danger";
const BTN: Record<BtnVariant, string> = {
  ink: "bg-invert text-invert-ink hover:opacity-90 font-medium",
  coral: "bg-coral text-white hover:brightness-105 font-medium",
  outline: "border border-navy/70 bg-surface hover:bg-cream text-navy",
  ghost: "hover:bg-surface-2 text-ink-2",
  danger: "border border-critical/40 text-critical hover:bg-critical/10",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; loading?: boolean; size?: "sm" | "md" | "lg" }>(
  function Button({ variant = "ink", loading, size = "md", className, children, disabled, ...rest }, ref) {
    const sz = size === "sm" ? "h-8 px-3 text-sm" : size === "lg" ? "h-12 px-6 text-base" : "h-10 px-4 text-sm";
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn("inline-flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer select-none", sz, BTN[variant], className)}
        {...rest}
      >
        {loading && <Loader2 className="size-4 animate-spin" />}
        {children}
      </button>
    );
  },
);

export function LinkButton({ href, variant = "ink", className, children }: { href: string; variant?: BtnVariant; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={cn("inline-flex items-center justify-center gap-2 h-10 px-4 text-sm transition", BTN[variant], className)}>
      {children}
    </Link>
  );
}

export function Card({ className, children, tone = "plain" }: { className?: string; children: ReactNode; tone?: "plain" | "cream" | "ink" }) {
  const t = tone === "cream" ? "bg-cream border-cream-line" : tone === "ink" ? "bg-invert text-invert-ink border-transparent" : "bg-surface border-line";
  return <div className={cn("rounded-lg border", t, className)}>{children}</div>;
}

/** Highlighted bold word(s) — the bribes.fyi headline accent. Trailing punctuation stays outside. */
export function Mark({ children }: { children: ReactNode }) {
  if (typeof children === "string") {
    const m = children.match(/^([\s\S]*?)([.,!?:؟۔]*)$/);
    if (m && m[2]) {
      return (
        <>
          <mark className="vd-mark">{m[1]}</mark>
          {m[2]}
        </>
      );
    }
  }
  return <mark className="vd-mark">{children}</mark>;
}

/** Mono "01 / LABEL" tag. */
export function Tag({ n, children, className }: { n?: number | string; children: ReactNode; className?: string }) {
  return (
    <span className={cn("font-mono text-[11px] uppercase tracking-[0.14em] text-muted", className)}>
      {n !== undefined && <>{typeof n === "number" ? String(n).padStart(2, "0") : n} / </>}
      {children}
    </span>
  );
}

/** Hairline-divided card grid. */
export function Grid({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("grid gap-px overflow-hidden rounded-lg border border-line bg-line", className)}>{children}</div>;
}

export function GridCell({ n, tag, icon, highlight, className, children }: { n?: number | string; tag?: ReactNode; icon?: ReactNode; highlight?: boolean; className?: string; children?: ReactNode }) {
  return (
    <div className={cn("block min-w-0 p-5 sm:p-6 transition", highlight ? "bg-cream" : "bg-surface hover:bg-cream", className)}>
      {(tag || icon) && (
        <div className="flex items-center justify-between gap-3">
          {tag ? <Tag n={n}>{tag}</Tag> : <span />}
          {icon && <span className="shrink-0 text-coral [&_svg]:size-5">{icon}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

export function SectionTitle({ eyebrow, n, title, accent, action }: { eyebrow?: string; n?: number; title: ReactNode; accent?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div>
        {eyebrow && <Tag n={n}>{eyebrow}</Tag>}
        <h2 className="mt-1 font-serif text-2xl sm:text-[30px] font-black leading-tight text-navy">
          {title} {accent && <Mark>{accent}</Mark>}
        </h2>
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ eyebrow, title, accent, sub, action }: { eyebrow?: string; title: ReactNode; accent?: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && (
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em] text-muted">
            <span className="size-1.5 rounded-full bg-muted" /> {eyebrow}
          </div>
        )}
        <h1 className="mt-3 font-serif text-4xl sm:text-[56px] font-black leading-[1.15] tracking-[-0.01em] text-navy">
          {title} {accent && <Mark>{accent}</Mark>}
        </h1>
        {sub && <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-ink-2">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Label({ children, htmlFor, hint }: { children: ReactNode; htmlFor?: string; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="flex items-baseline justify-between mb-1.5 text-sm font-medium text-ink-2">
      <span>{children}</span>
      {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
    </label>
  );
}

const field = "w-full rounded-md border border-line bg-surface px-3.5 h-11 text-ink placeholder:text-muted outline-none focus:border-ink focus:ring-2 focus:ring-ink/10 transition";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(field, className)} {...p} />;
});
export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(field, "pe-8", className)} {...p} />;
}
export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, "h-auto py-2.5 min-h-20", className)} {...p} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-5 animate-spin text-muted", className)} />;
}

export function ErrorNote({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <div role="alert" className="rounded-xl border border-critical/30 bg-critical/10 px-3.5 py-2.5 text-sm text-critical">
      {children}
    </div>
  );
}

export function SuccessNote({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <div className="rounded-xl border border-good/30 bg-good/10 px-3.5 py-2.5 text-sm text-good">{children}</div>;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center py-12 px-6">
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <div className="font-semibold text-ink">{title}</div>
      {children && <p className="mt-1 text-sm text-ink-2 max-w-sm">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Error carrying the API's stable code, so the UI can translate it. */
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: init?.json !== undefined ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    });
  } catch {
    throw new ApiError("network", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth")) {
    window.location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  }
  if (!res.ok) throw new ApiError(data.code || "server_error", res.status);
  return data as T;
}

export const errorCode = (e: unknown) => (e instanceof ApiError ? e.code : "server_error");

export function fmtBytes(n: number) {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtMs(ms?: number) {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
