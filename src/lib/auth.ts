import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { connectDB } from "./db";
import { RateHit, User, type UserDoc } from "./models";
import { SESSION_COOKIE, verifySession } from "./session";

/** Errors carry a stable `code` so the client can show them in the user's language. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

async function sessionUser(): Promise<UserDoc | null> {
  const store = await cookies();
  const s = await verifySession(store.get(SESSION_COOKIE)?.value);
  if (!s) return null;
  await connectDB();
  const user = await User.findById(s.userId).select("-passwordHash -resetTokenHash -resetTokenExpires").lean<UserDoc>();
  // A password change bumps sessionVersion, which invalidates every older session cookie.
  if (!user || (user.sessionVersion ?? 0) !== s.ver) return null;
  return user;
}

export async function getCurrentUser() {
  return sessionUser();
}

export async function requireUser(): Promise<UserDoc> {
  const u = await sessionUser();
  if (!u) throw new HttpError(401, "unauthorized");
  return u;
}

/** Wraps a route handler so thrown errors become JSON `{ error, code }` responses. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
      console.error(e);
      return NextResponse.json({ error: "Something went wrong", code: "server_error" }, { status: 500 });
    }
  };
}

/** Sliding-window limiter backed by a TTL collection (works across serverless instances). */
export async function rateLimit(scope: string, max: number, windowSec: number) {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  const key = `${scope}:${ip}`;
  await connectDB();
  const since = new Date(Date.now() - windowSec * 1000);
  const n = await RateHit.countDocuments({ key, at: { $gte: since } });
  if (n >= max) throw new HttpError(429, "rate_limited");
  await RateHit.create({ key });
}

export function publicUser(u: UserDoc) {
  return { id: String(u._id), name: u.name, email: u.email, locale: (u.locale ?? "en") as "en" | "ar" | "ur" };
}
export type PublicUser = ReturnType<typeof publicUser>;
