import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppUser, AppVariables, Env } from "../env";
import type { Context } from "hono";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function encodeBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hashToken(secret: string, token: string): Promise<string> {
  const data = new TextEncoder().encode(`${secret}:${token}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  // 32-byte cryptographically secure token for sessions and auth state.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export async function createSession(c: Context<{ Bindings: Env; Variables: AppVariables }>, userId: string): Promise<void> {
  // Store only a hash of the session token in D1 so leaked DB rows cannot be replayed.
  const token = randomToken();
  const tokenHash = await hashToken(c.env.SESSION_SECRET, token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?1, ?2, ?3)")
    .bind(tokenHash, userId, expiresAt)
    .run();

  const secureCookies = c.env.APP_URL.startsWith("https://");
  setCookie(c, c.env.SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: secureCookies,
    sameSite: "Lax",
    expires: new Date(expiresAt)
  });
}

export async function destroySession(c: Context<{ Bindings: Env; Variables: AppVariables }>): Promise<void> {
  const token = getCookie(c, c.env.SESSION_COOKIE_NAME);
  if (token) {
    const tokenHash = await hashToken(c.env.SESSION_SECRET, token);
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(tokenHash).run();
  }
  deleteCookie(c, c.env.SESSION_COOKIE_NAME, { path: "/" });
}

export const sessionMiddleware = createMiddleware<{ Bindings: Env; Variables: AppVariables }>(async (c, next) => {
  // Resolve current user from the session cookie for route handlers.
  const token = getCookie(c, c.env.SESSION_COOKIE_NAME);
  c.set("requestId", crypto.randomUUID());
  c.set("user", null);
  if (!token) {
    await next();
    return;
  }

  const tokenHash = await hashToken(c.env.SESSION_SECRET, token);
  const row = await c.env.DB.prepare(
    `SELECT users.id, users.email, users.display_name, users.role
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ?1 AND sessions.expires_at > datetime('now')`
  )
    .bind(tokenHash)
    .first<{ id: string; email: string; display_name: string | null; role: AppUser["role"] }>();

  if (row) {
    c.set("user", {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role
    });
  }

  await next();
});

export function requireAuth(c: Context<{ Bindings: Env; Variables: AppVariables }>): AppUser | Response {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return user;
}

export function requireRole(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  allowed: AppUser["role"][]
): AppUser | Response {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  if (!allowed.includes(auth.role)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return auth;
}
