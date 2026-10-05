import type { ReactNode } from "react";

export function AuthCard({ title, accent, sub, children, footer }: { title: string; accent?: string; sub?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="animate-rise rounded-3xl bg-surface/95 p-7 sm:p-9 shadow-[0_30px_80px_-30px_rgba(14,21,80,0.45)] ring-1 ring-black/5 backdrop-blur">
      <h1 className="font-serif text-[34px] leading-[1.15] font-extrabold tracking-[-0.02em] text-navy">
        {title} {accent && <span className="font-accent font-normal text-coral">{accent}</span>}
      </h1>
      {sub && <p className="mt-2 text-ink-2">{sub}</p>}
      <div className="mt-7">{children}</div>
      {footer && <div className="mt-6 text-center text-sm text-ink-2">{footer}</div>}
    </div>
  );
}
