import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Arabic, Instrument_Serif, Inter, Noto_Kufi_Arabic, Noto_Nastaliq_Urdu, Playfair_Display } from "next/font/google";
import { I18nProvider } from "@/i18n/client";
import { dirOf } from "@/i18n/config";
import { getMessages } from "@/i18n/server";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const serif = Playfair_Display({ variable: "--font-serif-display", subsets: ["latin"], weight: ["700", "800", "900"], style: ["normal", "italic"] });
const accent = Instrument_Serif({ variable: "--font-accent-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"] });
const mono = IBM_Plex_Mono({ variable: "--font-mono-code", subsets: ["latin"], weight: ["400", "500", "600"] });
// Arabic body + display, Urdu Nastaliq — loaded only when those scripts appear on the page.
const arabic = IBM_Plex_Sans_Arabic({ variable: "--font-arabic", subsets: ["arabic"], weight: ["400", "500", "600", "700"] });
const arabicDisplay = Noto_Kufi_Arabic({ variable: "--font-arabic-display", subsets: ["arabic"], weight: ["700", "800", "900"] });
const urdu = Noto_Nastaliq_Urdu({ variable: "--font-urdu", subsets: ["arabic"], weight: ["400", "600", "700"] });

export const metadata: Metadata = {
  title: { default: "Avagama MiddleEast Docs — ask your Arabic & English documents", template: "%s · Avagama MiddleEast Docs" },
  description: "Upload scanned or digital contracts and invoices in Arabic or English and ask questions with page-cited answers.",
  applicationName: "Avagama MiddleEast Docs",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0c1015" },
  ],
  width: "device-width",
  initialScale: 1,
};

// Applies the saved theme before first paint so there's no flash.
const themeScript = `try{var t=localStorage.getItem('md-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const { locale, messages } = await getMessages();
  const fonts = [inter, serif, accent, mono, arabic, arabicDisplay, urdu].map((f) => f.variable).join(" ");
  return (
    <html lang={locale} dir={dirOf(locale)} suppressHydrationWarning className={`${fonts} h-full`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">
        <I18nProvider locale={locale} messages={messages}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
