import Link from "next/link";
import { ThemedSky } from "@/components/Sky";
import { LanguageSelect } from "@/components/brand";
import { getMessages } from "@/i18n/server";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { messages } = await getMessages();
  return (
    <main className="relative isolate min-h-dvh overflow-hidden">
      <ThemedSky day="day" />
      <div className="relative flex min-h-dvh flex-col items-center px-4 py-6">
        <div className="flex w-full max-w-md items-center justify-between">
          <Link href="/" dir="ltr" className="font-mono font-semibold text-[22px] text-sky-ink">
            mea<span className="text-sky-ink-2 font-normal">.docs</span>
          </Link>
          <LanguageSelect compact />
        </div>
        <div className="my-auto w-full max-w-md py-10">{children}</div>
        <p className="text-center text-xs text-sky-ink-3">{messages.brand.tagline}</p>
      </div>
    </main>
  );
}
