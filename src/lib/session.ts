import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "md_session";
/** Set (for a year) when a limited client account signs in: that browser no longer offers sign-up. */
export const NO_SIGNUP_COOKIE = "md_nosignup";
const MAX_AGE = 60 * 60 * 24 * 7;

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) throw new Error("JWT_SECRET must be set (16+ chars) in .env.local");
  return new TextEncoder().encode(s);
}

/** `ver` is the user's sessionVersion — bumping it (password change/reset) signs out every device. */
export async function signSession(userId: string, ver = 0) {
  return new SignJWT({ sub: userId, ver })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
}

export async function verifySession(token?: string | null): Promise<{ userId: string; ver: number } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === "string" ? { userId: payload.sub, ver: Number(payload.ver ?? 0) } : null;
  } catch {
    return null;
  }
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: MAX_AGE,
};
