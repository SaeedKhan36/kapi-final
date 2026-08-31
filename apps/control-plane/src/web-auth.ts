import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ACCESS_COOKIE, Authenticator, REFRESH_COOKIE, WorkOSError } from "@kapi/identity";

const b64 = (value: string) => Buffer.from(value).toString("base64url");
const OAUTH_STATE_COOKIE = "kapi_oauth_state";

function sessionSecret(): string {
  const value = process.env.KAPI_SESSION_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("KAPI_SESSION_SECRET is required in production");
  return "kapi-development-session-secret-change-me";
}

function signState(returnTo: string): string {
  const payload = b64(JSON.stringify({ returnTo, expires: Date.now() + 10 * 60_000 }));
  const signature = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyState(state: string): string {
  const [payload, supplied] = state.split(".");
  if (!payload || !supplied) throw new Error("invalid sign-in state");
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("invalid sign-in state");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as { returnTo: string; expires: number };
  if (parsed.expires < Date.now()) throw new Error("sign-in state expired");
  return safeReturnTo(parsed.returnTo);
}

function safeReturnTo(value?: string): string {
  const configured = process.env.KAPI_WEB_URL ?? "http://localhost:5173";
  if (!value) return configured;
  if (value.startsWith("/") && !value.startsWith("//")) return new URL(value, configured).toString();
  try { if (new URL(value).origin === new URL(configured).origin) return value; } catch { /* invalid */ }
  return configured;
}

const cookieOptions = () => ({
  httpOnly: true, secure: process.env.NODE_ENV === "production",
  sameSite: (process.env.NODE_ENV === "production" ? "None" : "Lax") as "None" | "Lax",
  path: "/",
});

export function createWebAuthRoutes(auth: Authenticator) {
  const app = new Hono();
  const redirectUri = () => process.env.WORKOS_REDIRECT_URI
    ?? `${process.env.CONTROL_PLANE_PUBLIC_URL ?? "http://localhost:8787"}/auth/callback`;

  app.get("/auth/login", (c) => {
    if (auth.mode === "dev") return c.redirect(safeReturnTo(c.req.query("returnTo")));
    const state = signState(safeReturnTo(c.req.query("returnTo")));
    setCookie(c, OAUTH_STATE_COOKIE, state, { ...cookieOptions(), maxAge: 10 * 60 });
    return c.redirect(auth.authorizationUrl(redirectUri(), state));
  });

  app.get("/auth/callback", async (c) => {
    try {
      const state = c.req.query("state") ?? "";
      if (!state || getCookie(c, OAUTH_STATE_COOKIE) !== state) throw new Error("sign-in state was not issued to this browser");
      deleteCookie(c, OAUTH_STATE_COOKIE, cookieOptions());
      const returnTo = verifyState(state);
      const session = await auth.authenticateWithCode(c.req.query("code") ?? "", redirectUri());
      setCookie(c, ACCESS_COOKIE, session.accessToken, { ...cookieOptions(), maxAge: 60 * 60 });
      if (session.refreshToken) setCookie(c, REFRESH_COOKIE, session.refreshToken, { ...cookieOptions(), maxAge: 30 * 24 * 60 * 60 });
      return c.redirect(returnTo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, err instanceof WorkOSError ? err.status as 400 : 400);
    }
  });

  app.post("/auth/refresh", async (c) => {
    const refresh = getCookie(c, REFRESH_COOKIE);
    if (!refresh) return c.json({ error: "no refresh session" }, 401);
    try {
      const session = await auth.refreshSession(refresh);
      setCookie(c, ACCESS_COOKIE, session.accessToken, { ...cookieOptions(), maxAge: 60 * 60 });
      if (session.refreshToken) setCookie(c, REFRESH_COOKIE, session.refreshToken, { ...cookieOptions(), maxAge: 30 * 24 * 60 * 60 });
      return c.json({ ok: true });
    } catch { return c.json({ error: "session expired" }, 401); }
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, ACCESS_COOKIE, cookieOptions());
    deleteCookie(c, REFRESH_COOKIE, cookieOptions());
    return c.body(null, 204);
  });
  return app;
}
