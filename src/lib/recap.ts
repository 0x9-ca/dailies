import type { Env } from "../env";

// Monthly recap data for /me/recap: the signed-in viewer's plays in one month, bucketed into days of their own time zone.
const MONTH = /^(\d{4})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseMonth(value: string | undefined): { year: number; month: number } | null {
  const m = MONTH.exec(value || "");
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
  return { year, month };
}

export function dayFormatter(tz: string): Intl.DateTimeFormat | null {
  if (!tz || tz.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return null;
  }
}

function localDay(fmt: Intl.DateTimeFormat, iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export async function loadRecap(env: Env, userId: string, month: { year: number; month: number }, fmt: Intl.DateTimeFormat) {
  const key = `${month.year}-${String(month.month).padStart(2, "0")}`;
  // Time zones span UTC-12..UTC+14, so a day of padding on each side always covers the local month.
  const from = new Date(Date.UTC(month.year, month.month - 1, 1) - DAY_MS).toISOString();
  const to = new Date(Date.UTC(month.year, month.month, 1) + 2 * DAY_MS).toISOString();
  const rows = await env.DB.prepare(
    "SELECT game_id, played_at FROM user_plays WHERE user_id = ?1 AND played_at >= ?2 AND played_at < ?3 ORDER BY played_at ASC LIMIT 5000"
  )
    .bind(userId, from, to)
    .all<{ game_id: string; played_at: string }>();

  // A game counts once per local day, like the client's play log.
  const days: Record<string, string[]> = {};
  for (const row of rows.results) {
    const day = localDay(fmt, row.played_at);
    if (!day.startsWith(key + "-")) continue;
    const list = (days[day] ||= []);
    if (!list.includes(row.game_id)) list.push(row.game_id);
  }

  const counts = new Map<string, number>();
  for (const list of Object.values(days)) for (const id of list) counts.set(id, (counts.get(id) || 0) + 1);
  const ids = [...counts.keys()];
  const info = new Map<string, { slug: string; title: string }>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const found = await env.DB.prepare(`SELECT id, slug, title FROM games WHERE id IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})`)
      .bind(...chunk)
      .all<{ id: string; slug: string; title: string }>();
    for (const g of found.results) info.set(g.id, { slug: g.slug, title: g.title });
  }
  const games = ids
    .map((id) => ({ id, title: info.get(id)?.title || "", slug: info.get(id)?.slug || "", plays: counts.get(id) || 0 }))
    .sort((a, b) => b.plays - a.plays || a.title.localeCompare(b.title));

  const first = await env.DB.prepare("SELECT MIN(played_at) AS first FROM user_plays WHERE user_id = ?1")
    .bind(userId)
    .first<{ first: string | null }>();
  const firstDay = first?.first ? localDay(fmt, first.first) : "";
  const availableFrom = firstDay ? firstDay.slice(0, 7) : localDay(fmt, new Date().toISOString()).slice(0, 7);
  return { month: key, days, games, available: { from: availableFrom } };
}
