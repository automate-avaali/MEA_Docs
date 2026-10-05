import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";

/** Liveness + configuration check (no secrets). */
export async function GET() {
  const t = Date.now();
  let db = "ok";
  try {
    await (await connectDB()).connection.db!.command({ ping: 1 });
  } catch {
    db = "down";
  }
  return NextResponse.json({
    db,
    dbMs: Date.now() - t,
    providers: {
      ocr: process.env.GEMINI_API_KEY ? process.env.GEMINI_OCR_MODEL || "gemini-3.5-flash-lite" : "tesseract-only",
      embeddings: process.env.HF_TOKEN || process.env.EMBED_URL ? "BAAI/bge-m3" : "missing",
      rerank: process.env.JINA_API_KEY ? process.env.JINA_RERANK_MODEL || "jina-reranker-v3.5" : "rrf-only",
      llm: process.env.FANAR_API_KEY ? process.env.FANAR_MODEL || "Fanar-C-2-27B" : "missing",
      mail: process.env.SMTP_HOST ? "smtp" : "dev-link",
    },
  });
}
