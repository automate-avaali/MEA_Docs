"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useState, type ReactNode } from "react";
import { FileText, LogOut, MessageSquareText, Settings, Upload } from "lucide-react";
import type { PublicUser } from "@/lib/auth";
import { useT } from "@/i18n/client";
import { LanguageSelect, ThemeToggle, Wordmark } from "./brand";
import { cn } from "./ui";

type Ctx = { user: PublicUser; setUser: (u: PublicUser) => void };
const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

export function AppShell({ user: initial, children }: { user: PublicUser; children: ReactNode }) {
  const { t } = useT();
  const pathname = usePathname();
  const [user, setUser] = useState(initial);

  const NAV = [
    { href: "/chat", label: t("nav.chat"), Icon: MessageSquareText },
    { href: "/documents", label: t("nav.documents"), Icon: FileText },
    { href: "/settings", label: t("nav.settings"), Icon: Settings },
  ];
  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <AppCtx.Provider value={{ user, setUser }}>
      <div className="min-h-dvh bg-bg">
        <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-2 px-4 sm:h-[72px]">
            <Wordmark href="/chat" className="text-lg text-ink sm:text-[22px]" />
            <div className="flex items-center gap-1 sm:gap-2">
              <LanguageSelect compact />
              <ThemeToggle className="size-9 sm:size-10" />
              <Link
                href="/documents"
                className="ms-1 hidden h-11 items-center bg-invert px-5 font-mono text-[13px] font-medium uppercase tracking-wide text-invert-ink hover:opacity-90 sm:inline-flex"
              >
                <Upload className="me-2 size-4" />
                {t("nav.documents")}
              </Link>
              <button
                onClick={logout}
                aria-label={t("common.signOut")}
                title={t("common.signOut")}
                className="ms-1 inline-flex h-9 cursor-pointer items-center gap-2 border border-line px-2.5 text-sm text-ink hover:bg-surface-2 sm:h-11 sm:px-3"
              >
                <LogOut className="size-4 rtl:-scale-x-100" />
                <span className="hidden sm:inline">{t("common.signOut")}</span>
              </button>
            </div>
          </div>
        </header>

        <div className="mx-auto flex max-w-7xl gap-8 px-4">
          <aside className="sticky top-[88px] hidden h-[calc(100dvh-108px)] w-52 shrink-0 flex-col py-6 lg:flex">
            <nav className="space-y-0.5">
              {NAV.map(({ href, label, Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] transition",
                    active(href) ? "bg-surface font-semibold text-ink shadow-sm ring-1 ring-line" : "text-ink-2 hover:bg-surface-2",
                  )}
                >
                  <Icon className={cn("size-[18px]", active(href) && "text-coral")} />
                  {label}
                </Link>
              ))}
            </nav>
            <div className="mt-auto border-t border-line pt-4">
              <div className="truncate px-3 text-sm font-semibold text-ink">{user.name}</div>
              <div className="truncate px-3 text-xs text-muted" dir="ltr">
                {user.email}
              </div>
            </div>
          </aside>

          <main className="min-w-0 flex-1 py-6 pb-28 sm:py-8 lg:pb-12">{children}</main>
        </div>

        {/* mobile tab bar */}
        <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          <div className="grid grid-cols-3">
            {NAV.map(({ href, label, Icon }) => (
              <Link key={href} href={href} className={cn("flex flex-col items-center gap-1 py-2.5 text-[11px]", active(href) ? "font-semibold text-coral" : "text-muted")}>
                <Icon className="size-5" />
                {label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </AppCtx.Provider>
  );
}
