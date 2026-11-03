import type { Env } from "../env";

export type LiveInfo = { live: true; title: string; gameName: string; startedAt: string; viewerCount: number };
export type LiveStatus = Record<string, LiveInfo>;

const TOKEN_KEY = "twitch:app_token";
const LIVE_KEY = "twitch:live:v2";
const LIVE_TTL_SECONDS = 90;
const FAIL_TTL_SECONDS = 60; // KV's minimum TTL: after a failure, don't retry for a minute
let failureLogged = false;

const idBase = (env: Env) => (env.TWITCH_ID_BASE || "https://id.twitch.tv").replace(/\/+$/, "");
const apiBase = (env: Env) => (env.TWITCH_API_BASE || "https://api.twitch.tv/helix").replace(/\/+$/, "");

function logOnce(error: unknown): void {
  if (failureLogged) return;
  failureLogged = true;
  console.error("Twitch live lookup failed:", error instanceof Error ? error.message : error);
}

/** App access token for Twitch's Helix API (client credentials), cached in KV until shortly before expiry. */
export async function getTwitchAppToken(env: Env): Promise<string | null> {
  if (!env.OAUTH_TWITCH_CLIENT_ID || !env.OAUTH_TWITCH_CLIENT_SECRET) return null;
  const cached = await env.CACHE.get(TOKEN_KEY);
  if (cached) return cached;
  const res = await fetch(`${idBase(env)}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.OAUTH_TWITCH_CLIENT_ID,
      client_secret: env.OAUTH_TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials"
    }),
    signal: AbortSignal.timeout(2500)
  });
  if (!res.ok) {
    console.error("Twitch app token request failed:", res.status, await res.text());
    return null;
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  await env.CACHE.put(TOKEN_KEY, json.access_token, { expirationTtl: Math.max(60, (json.expires_in ?? 3600) - 300) });
  return json.access_token;
}

async function fetchStreams(env: Env, logins: string[]): Promise<LiveStatus> {
  const token = await getTwitchAppToken(env);
  if (!token) throw new Error("no token");
  const out: LiveStatus = {};
  for (let i = 0; i < logins.length; i += 100) {
    const query = logins.slice(i, i + 100).map((l) => `user_login=${encodeURIComponent(l)}`).join("&");
    const res = await fetch(`${apiBase(env)}/streams?${query}&first=100`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": env.OAUTH_TWITCH_CLIENT_ID! },
      signal: AbortSignal.timeout(2500)
    });
    if (res.status === 401) await env.CACHE.delete(TOKEN_KEY);
    if (!res.ok) throw new Error(`streams ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ user_login?: string; type?: string; title?: string; game_name?: string; started_at?: string; viewer_count?: number }> };
    for (const s of json.data ?? []) {
      if (!s.user_login || (s.type && s.type !== "live")) continue;
      out[s.user_login.toLowerCase()] = {
        live: true,
        title: String(s.title ?? "").slice(0, 140),
        gameName: String(s.game_name ?? "").slice(0, 80),
        startedAt: String(s.started_at ?? ""),
        viewerCount: Number(s.viewer_count) || 0
      };
    }
  }
  return out;
}

/**
 * Live streams among the given Twitch logins. The whole creator set shares ONE KV key (90s TTL), so any number of
 * page views costs one KV read and at most one Helix call per 90s, instead of a read per login. The cached map
 * covers the logins asked for at fill time; a login added within those 90s shows up on the next refresh.
 * Fails soft: any error means "nobody live" (logged once per isolate, negative-cached for 60s).
 */
export async function getLiveStatus(env: Env, logins: string[]): Promise<LiveStatus> {
  const wanted = [...new Set(logins.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) return {};
  try {
    const cached = (await env.CACHE.get(LIVE_KEY, "json")) as { live: LiveStatus } | null;
    let live = cached?.live;
    if (!live) {
      let ttl = LIVE_TTL_SECONDS;
      try {
        live = await fetchStreams(env, wanted);
      } catch (error) {
        live = {};
        ttl = FAIL_TTL_SECONDS;
        logOnce(error);
      }
      await env.CACHE.put(LIVE_KEY, JSON.stringify({ live }), { expirationTtl: ttl });
    }
    const out: LiveStatus = {};
    for (const login of wanted) if (live[login]) out[login] = live[login];
    return out;
  } catch (error) {
    logOnce(error);
    return {};
  }
}
