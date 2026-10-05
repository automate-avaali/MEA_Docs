import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "./lib/session";

const APP = ["/chat", "/documents", "/settings"];
const AUTH = ["/login", "/signup"];

// Optimistic check only — every API route re-verifies the session (and its version) itself.
export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);

  if (!session && APP.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  if (session && AUTH.includes(pathname)) return NextResponse.redirect(new URL("/chat", req.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/chat/:path*", "/documents/:path*", "/settings/:path*", "/login", "/signup"],
};
