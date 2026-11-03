import { NextResponse } from "next/server";
import { handle, requireUser } from "@/lib/auth";
import { usageSummary } from "@/lib/limits";

/** Today's quota usage for the signed-in account (limits: null = unlimited). */
export const GET = handle(async () => {
  const user = await requireUser();
  return NextResponse.json(await usageSummary(user), { headers: { "Cache-Control": "no-store" } });
});
