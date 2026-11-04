import { NextResponse } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { oid } from "@/lib/docs";
import { suggestionsFor, type Locale } from "@/lib/rag/suggest";

export const maxDuration = 30;

/** Starter questions for the chat welcome screen, written from the user's own documents. ?docs=id,id&locale=ar */
export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const locale = (["en", "ar", "ur"].includes(url.searchParams.get("locale") ?? "") ? url.searchParams.get("locale") : (user.locale ?? "en")) as Locale;
  const ids = (url.searchParams.get("docs") ?? "").split(",").filter((s) => /^[a-f0-9]{24}$/i.test(s)).slice(0, 20).map(oid);
  const questions = await suggestionsFor({ userId: user._id, documentIds: ids, locale });
  return NextResponse.json({ questions }, { headers: { "Cache-Control": "no-store" } });
});
