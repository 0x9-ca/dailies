// Web Push reset reminders. Payload-less: the Worker sends an empty VAPID-signed POST to each subscription's push
// service; the service worker then asks GET /api/me/reminders/pending what to show. A cron (every 15 minutes) finds,
// per subscription, the user's rotation games that are scheduled today, unplayed, not skipped and about to reset.
import type { Env } from "../env";

const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
const CHUNK = 90; // D1 allows 100 bound variables per statement
export const PUSH_MAX_PER_RUN = 500;
export const PUSH_MAX_PER_USER = 5;
const SEND_CONCURRENCY = 20;

export type PushSub = { id: string; user_id: string; endpoint: string; lead_minutes: number; tz: string };
export type DueGame = { gameId: string; title: string; slug: string; minutesLeft: number; resetAt: number; day: string };

export function pushEnabled(env: Env): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

/** The Worker will POST to this URL, so only https push-service hosts are accepted (any host over http/https in dev). */
export function isAllowedEndpoint(env: Env, endpoint: string): boolean {
  if (endpoint.length > 1000) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (env.PUSH_ALLOW_HTTP) return url.protocol === "https:" || url.protocol === "http:";
  return url.protocol === "https:" && !url.username && !url.password && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz.length > 0 && tz.length <= 64; } catch { return false; }
}

// ---- VAPID (RFC 8292), ES256 with WebCrypto ----

const b64uToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
const bytesToB64u = (bytes: ArrayBuffer | Uint8Array) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const textB64u = (text: string) => bytesToB64u(new TextEncoder().encode(text));

let keyCache: { id: string; key: Promise<CryptoKey> } | null = null;

function signingKey(env: Env): Promise<CryptoKey> {
  const id = `${env.VAPID_PUBLIC_KEY}.${env.VAPID_PRIVATE_KEY}`;
  if (keyCache?.id === id) return keyCache.key;
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY || "");
  const key = crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY, x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  keyCache = { id, key };
  return key;
}

/** Signed VAPID JWT for one push service origin. WebCrypto's ECDSA output is already the raw r||s form JWT wants. */
export async function vapidJwt(env: Env, audience: string, nowMs = Date.now()): Promise<string> {
  const head = textB64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = textB64u(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT }));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(env), new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${bytesToB64u(sig)}`;
}

/** Sends an empty push. Returns the HTTP status, or 0 on a network error/timeout. */
export async function sendPush(env: Env, endpoint: string): Promise<number> {
  try {
    const jwt = await vapidJwt(env, new URL(endpoint).origin);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { TTL: "3600", Urgency: "normal", Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}` },
      signal: AbortSignal.timeout(8000)
    });
    await res.body?.cancel().catch(() => {});
    return res.status;
  } catch {
    return 0;
  }
}

// ---- Which games are due ----

function tzOffsetMinutes(timeZone: string, at: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Math.round((Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000) / MIN);
  } catch {
    return 0;
  }
}

const localDay = (at: number, offsetMin: number) => new Date(at + offsetMin * MIN).toISOString().slice(0, 10);
/** Monday = bit 0, matching favorites.weekday_mask. */
const weekdayBit = (at: number, offsetMin: number) => 1 << ((new Date(at + offsetMin * MIN).getUTCDay() + 6) % 7);

type RotationRow = {
  user_id: string; game_id: string; title: string; slug: string; weekday_mask: number;
  reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null;
};

async function chunked<T>(items: string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await run(items.slice(i, i + CHUNK))));
  return out;
}
const marks = (n: number, from = 1) => Array.from({ length: n }, (_v, i) => `?${i + from}`).join(",");

/**
 * Due games per user id for the given (userId, tz, lead) requests, batched: three D1 queries per 90 users.
 * Keys of the result are `${userId}|${tz}|${lead}`.
 */
export async function dueGames(env: Env, requests: { userId: string; tz: string; lead: number }[], now = Date.now()): Promise<Map<string, DueGame[]>> {
  const result = new Map<string, DueGame[]>();
  const userIds = [...new Set(requests.map((r) => r.userId))];
  if (userIds.length === 0) return result;

  const rotation = await chunked<RotationRow>(userIds, async (ids) =>
    (await env.DB.prepare(
      `SELECT favorites.user_id, games.id AS game_id, games.title, games.slug, favorites.weekday_mask, games.reset_basis, games.reset_time_minutes, games.reset_timezone
       FROM favorites JOIN games ON games.id = favorites.game_id
       WHERE favorites.user_id IN (${marks(ids.length)}) AND games.status = 'approved' AND games.reset_time_minutes IS NOT NULL`
    ).bind(...ids).all<RotationRow>()).results
  );
  const plays = await chunked<{ user_id: string; game_id: string; played_at: string }>(userIds, async (ids) =>
    (await env.DB.prepare(
      `SELECT user_id, game_id, MAX(played_at) AS played_at FROM user_plays WHERE user_id IN (${marks(ids.length)}) AND played_at > ?${ids.length + 1} GROUP BY user_id, game_id`
    ).bind(...ids, new Date(now - 26 * 60 * MIN).toISOString()).all<{ user_id: string; game_id: string; played_at: string }>()).results
  );
  const skipDays = [-1, 0, 1].map((d) => new Date(now + d * DAY_MS).toISOString().slice(0, 10));
  const skips = await chunked<{ user_id: string; day: string; game_id: string }>(userIds, async (ids) =>
    (await env.DB.prepare(
      `SELECT user_id, day, game_id FROM user_skips WHERE user_id IN (${marks(ids.length)}) AND day IN (?${ids.length + 1}, ?${ids.length + 2}, ?${ids.length + 3})`
    ).bind(...ids, ...skipDays).all<{ user_id: string; day: string; game_id: string }>()).results
  );

  const byUser = new Map<string, RotationRow[]>();
  for (const row of rotation) {
    const list = byUser.get(row.user_id);
    if (list) list.push(row); else byUser.set(row.user_id, [row]);
  }
  const playedAt = new Map(plays.map((p) => [`${p.user_id}|${p.game_id}`, Date.parse(p.played_at)]));
  const skipped = new Set(skips.map((s) => `${s.user_id}|${s.day}|${s.game_id}`));
  const offsets = new Map<string, number>();
  const offsetOf = (tz: string) => {
    let v = offsets.get(tz);
    if (v === undefined) { v = tzOffsetMinutes(tz, now); offsets.set(tz, v); }
    return v;
  };

  for (const req of requests) {
    const key = `${req.userId}|${req.tz}|${req.lead}`;
    if (result.has(key)) continue;
    const off = offsetOf(req.tz);
    const today = localDay(now, off);
    const bit = weekdayBit(now, off);
    const due: DueGame[] = [];
    for (const g of byUser.get(req.userId) || []) {
      if (!(g.weekday_mask & bit) || g.reset_time_minutes === null) continue;
      if (skipped.has(`${req.userId}|${today}|${g.game_id}`)) continue;
      // Reset as a minute of the day on the clock it is defined on: viewer's zone, a named zone, or UTC.
      let clockOffset = 0;
      let minute = g.reset_time_minutes;
      if (g.reset_basis === "local") clockOffset = off;
      else if (g.reset_basis === "server" && g.reset_timezone) minute = (((minute - offsetOf(g.reset_timezone)) % 1440) + 1440) % 1440;
      const msOfDay = (((now + clockOffset * MIN) % DAY_MS) + DAY_MS) % DAY_MS;
      let delta = (minute * MIN - msOfDay + DAY_MS) % DAY_MS;
      if (delta === 0) delta = DAY_MS;
      const resetAt = now + delta;
      const minutesLeft = Math.ceil(delta / MIN);
      if (minutesLeft > req.lead) continue;
      if ((playedAt.get(`${req.userId}|${g.game_id}`) || 0) > resetAt - DAY_MS) continue;
      due.push({ gameId: g.game_id, title: g.title, slug: g.slug, minutesLeft, resetAt, day: localDay(resetAt, off) });
    }
    due.sort((a, b) => a.minutesLeft - b.minutesLeft);
    result.set(key, due);
  }
  return result;
}

const keyOf = (s: { user_id: string; tz: string; lead_minutes: number }) => `${s.user_id}|${s.tz}|${s.lead_minutes}`;

/** The cron job: at most PUSH_MAX_PER_RUN subscriptions, least recently notified first. */
export async function runPushReminders(env: Env): Promise<{ checked: number; sent: number; removed: number }> {
  if (!pushEnabled(env)) return { checked: 0, sent: 0, removed: 0 };
  const now = Date.now();
  await env.DB.prepare("DELETE FROM push_sent WHERE day < ?1").bind(new Date(now - 3 * DAY_MS).toISOString().slice(0, 10)).run();
  const subs = (await env.DB.prepare(
    "SELECT id, user_id, endpoint, lead_minutes, tz FROM push_subscriptions ORDER BY COALESCE(last_sent_day, '') ASC, created_at ASC LIMIT ?1"
  ).bind(PUSH_MAX_PER_RUN).all<PushSub>()).results;
  if (subs.length === 0) return { checked: 0, sent: 0, removed: 0 };

  const due = await dueGames(env, subs.map((s) => ({ userId: s.user_id, tz: s.tz, lead: s.lead_minutes })), now);
  const sentRows = await chunked<{ subscription_id: string; game_id: string; day: string }>(subs.map((s) => s.id), async (ids) =>
    (await env.DB.prepare(`SELECT subscription_id, game_id, day FROM push_sent WHERE subscription_id IN (${marks(ids.length)})`)
      .bind(...ids).all<{ subscription_id: string; game_id: string; day: string }>()).results
  );
  const already = new Set(sentRows.map((r) => `${r.subscription_id}|${r.game_id}|${r.day}`));

  const todo: { sub: PushSub; fresh: DueGame[] }[] = [];
  for (const sub of subs) {
    const fresh = (due.get(keyOf(sub)) || []).filter((g) => !already.has(`${sub.id}|${g.gameId}|${g.day}`));
    if (fresh.length > 0) todo.push({ sub, fresh });
  }

  let sent = 0;
  const gone: string[] = [];
  const records: D1PreparedStatement[] = [];
  for (let i = 0; i < todo.length; i += SEND_CONCURRENCY) {
    const batch = todo.slice(i, i + SEND_CONCURRENCY);
    const statuses = await Promise.all(batch.map((t) => sendPush(env, t.sub.endpoint)));
    batch.forEach((t, n) => {
      const status = statuses[n];
      if (status >= 200 && status < 300) {
        sent++;
        const today = localDay(now, tzOffsetMinutes(t.sub.tz, now));
        records.push(env.DB.prepare("UPDATE push_subscriptions SET last_sent_day = ?2 WHERE id = ?1").bind(t.sub.id, today));
        for (const g of t.fresh) records.push(env.DB.prepare("INSERT OR IGNORE INTO push_sent (subscription_id, game_id, day) VALUES (?1, ?2, ?3)").bind(t.sub.id, g.gameId, g.day));
      } else if (status === 404 || status === 410) {
        gone.push(t.sub.id);
      } else {
        console.error(JSON.stringify({ message: "push send failed", status }));
      }
    });
  }
  for (let i = 0; i < records.length; i += 100) await env.DB.batch(records.slice(i, i + 100));
  for (let i = 0; i < gone.length; i += CHUNK) {
    await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id IN (${marks(gone.slice(i, i + CHUNK).length)})`).bind(...gone.slice(i, i + CHUNK)).run();
  }
  return { checked: subs.length, sent, removed: gone.length };
}

/** What the service worker shows after a push: everything due now for this user, using their latest subscription's zone and widest lead. */
export async function pendingReminder(env: Env, userId: string): Promise<{ title: string; body: string; url: string } | null> {
  const subs = (await env.DB.prepare("SELECT id, user_id, endpoint, lead_minutes, tz FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at DESC")
    .bind(userId).all<PushSub>()).results;
  if (subs.length === 0) return null;
  const tz = subs[0].tz;
  const lead = Math.max(...subs.map((s) => s.lead_minutes));
  const games = (await dueGames(env, [{ userId, tz, lead }])).get(`${userId}|${tz}|${lead}`) || [];
  const url = "/me/rotation";
  if (games.length === 0) return null;
  const left = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
  if (games.length === 1) return { title: `${games[0].title} resets in ${left(games[0].minutesLeft)}`, body: "You haven't played it yet.", url };
  return {
    title: `${games.length} games reset soon`,
    body: games.slice(0, 3).map((g) => `${g.title} (${left(g.minutesLeft)})`).join(", ") + (games.length > 3 ? ` and ${games.length - 3} more` : ""),
    url
  };
}
