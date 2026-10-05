import Link from "next/link";
import { FileSearch, Languages, MessagesSquare, ScanText } from "lucide-react";
import { LanguageSelect, ThemeToggle, Wordmark } from "@/components/brand";
import { ThemedSky } from "@/components/Sky";
import { getCurrentUser } from "@/lib/auth";
import { getMessages } from "@/i18n/server";

const ICONS = [ScanText, FileSearch, Languages, MessagesSquare];

export default async function Landing() {
  const [{ messages: m }, user] = await Promise.all([getMessages(), getCurrentUser().catch(() => null)]);
  const L = m.landing;
  return (
    <div className="min-h-dvh bg-bg">
      <header className="relative z-10 mx-auto flex h-[72px] max-w-7xl items-center justify-between px-4">
        <Wordmark className="text-ink" />
        <div className="flex items-center gap-2">
          <LanguageSelect compact />
          <ThemeToggle />
          <Link href={user ? "/chat" : "/login"} className="ms-1 inline-flex h-10 items-center whitespace-nowrap bg-invert px-3 font-mono text-[12px] uppercase tracking-wide text-invert-ink hover:opacity-90 sm:px-4 sm:text-[13px]">
            {user ? m.nav.chat : m.common.signIn} →
          </Link>
        </div>
      </header>

      <section className="relative isolate overflow-hidden">
        <ThemedSky day="dusk" />
        <div className="relative mx-auto max-w-5xl px-4 pb-24 pt-20 text-center sm:pt-28">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-white backdrop-blur">
            <span className="size-1.5 rounded-full bg-white" /> {L.eyebrow}
          </div>
          <h1 className="animate-rise mt-6 font-serif text-[44px] font-black leading-[1.12] text-white drop-shadow-sm sm:text-[76px]">
            {L.title} <span className="font-accent font-normal italic text-[#ffd2ad]">{L.accent}</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-white/90">{L.sub}</p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Link href={user ? "/documents" : "/signup"} className="btn-coral inline-flex h-12 items-center rounded-xl px-6 font-semibold">
              {L.ctaStart}
            </Link>
            {!user && (
              <Link href="/login" className="btn-cream inline-flex h-12 items-center rounded-xl px-6 font-semibold">
                {L.ctaSignIn}
              </Link>
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-16">
        <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {L.features.map((f, i) => {
            const Icon = ICONS[i];
            return (
              <div key={f.tag} className="bg-surface p-6 transition hover:bg-cream">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {String(i + 1).padStart(2, "0")} / {f.tag}
                  </span>
                  <Icon className="size-5 text-coral" />
                </div>
                <h3 className="mt-6 font-serif text-xl font-black text-navy">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{f.body}</p>
              </div>
            );
          })}
        </div>

        <div className="mt-16 grid gap-8 lg:grid-cols-[1fr_2fr]">
          <h2 className="font-serif text-3xl font-black text-navy sm:text-4xl">
            <mark className="vd-mark">{L.stepsTitle}</mark>
          </h2>
          <ol className="grid gap-px overflow-hidden rounded-lg border border-line bg-line">
            {L.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-4 bg-surface p-5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-coral font-mono text-sm font-semibold text-white">{i + 1}</span>
                <span className="pt-1 text-ink">{s}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <footer className="border-t border-line py-8 text-center text-sm text-muted">{L.footer}</footer>
    </div>
  );
}
