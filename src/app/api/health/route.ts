import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";

/** Liveness check only — no configuration or provider details. */
export async function GET() {
  let ok = true;
  try {
    await (await connectDB()).connection.db!.command({ ping: 1 });
  } catch {
    ok = false;
  }
  return NextResponse.json({ ok }, { status: ok ? 200 : 503 });
}
