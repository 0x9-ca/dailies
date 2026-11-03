import { z } from "zod";
import type { Env } from "../env";

// Played state synced for signed-in users (see PLAY_SYNC_SCRIPT). Plays are ISO UTC instants kept for KEEP_DAYS;
// the streak ({ last, count }) and the heatmap's per-day counts live in user_streaks and merge by "later last /
// larger count" and "larger count per day", so devices converge no matter the order they sync in.
const DAY_MS = 24 * 60 * 60 * 1000;
export const PLAYS_KEEP_DAYS = 120;
export const PLAYS_WINDOW_DAYS = 100;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const playsBodySchema = z.object({
  plays: z.array(z.object({ gameId: z.string().min(1).max(64), playedAt: z.string().max(40) })).max(200).optional(),
  unplayed: z.array(z.object({ gameId: z.string().min(1).max(64), since: z.string().max(40) })).max(200).optional(),
  streak: z.object({ last: z.string().regex(DAY_KEY), count: z.number().int().min(0).max(100000) }).optional(),
  log: z.record(z.string().regex(DAY_KEY), z.number().int().min(0).max(1000)).optional()
});

function isoOrNull(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

type Streak = { last: string; count: number; log: Record<string, number> };

async function loadStreak(env: Env, userId: string): Promise<Streak> {
  const row = await env.DB.prepare("SELECT last, count, day_log FROM user_streaks WHERE user_id = ?1")
    .bind(userId)
    .first<{ last: string; count: number; day_log: string }>();
  let log: Record<string, number> = {};
  try {
    const parsed = JSON.parse(row?.day_log || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) log = parsed;
  } catch {
    // Ignore a corrupt log.
  }
  return { last: row?.last || "", count: row?.count || 0, log };
}

export async function loadPlays(env: Env, userId: string, sinceParam: string | undefined) {
  const floor = Date.now() - PLAYS_KEEP_DAYS * DAY_MS;
  let since = Date.now() - PLAYS_WINDOW_DAYS * DAY_MS;
  const parsed = sinceParam ? Date.parse(sinceParam) : NaN;
  if (Number.isFinite(parsed)) since = Math.max(parsed, floor);
  const rows = await env.DB.prepare(
    "SELECT game_id, played_at FROM user_plays WHERE user_id = ?1 AND played_at >= ?2 ORDER BY played_at ASC LIMIT 5000"
  )
    .bind(userId, new Date(since).toISOString())
    .all<{ game_id: string; played_at: string }>();
  const streak = await loadStreak(env, userId);
  return {
    userId,
    plays: rows.results.map((r) => ({ gameId: r.game_id, playedAt: r.played_at })),
    streak: { last: streak.last, count: streak.count },
    log: streak.log
  };
}

export async function savePlays(env: Env, userId: string, body: z.infer<typeof playsBodySchema>): Promise<void> {
  const now = Date.now();
  const oldest = now - PLAYS_WINDOW_DAYS * DAY_MS;
  const stmts: D1PreparedStatement[] = [];
  // Unplays first: an unmark queued before a later play of the same game must not delete that play.
  for (const item of body.unplayed || []) {
    const since = isoOrNull(item.since);
    if (since) {
      stmts.push(env.DB.prepare("DELETE FROM user_plays WHERE user_id = ?1 AND game_id = ?2 AND played_at >= ?3").bind(userId, item.gameId, since));
    }
  }
  for (const item of body.plays || []) {
    const ms = Date.parse(item.playedAt);
    if (!Number.isFinite(ms)) continue;
    const clamped = Math.min(now, Math.max(oldest, ms));
    const at = new Date(clamped).toISOString();
    const near = new Date(clamped - DUPLICATE_WINDOW_MS).toISOString();
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO user_plays (user_id, game_id, played_at)
         SELECT ?1, games.id, ?3 FROM games
         WHERE games.id = ?2
           AND NOT EXISTS (SELECT 1 FROM user_plays WHERE user_id = ?1 AND game_id = ?2 AND played_at >= ?4 AND played_at <= ?3)`
      ).bind(userId, item.gameId, at, near)
    );
  }
  stmts.push(env.DB.prepare("DELETE FROM user_plays WHERE user_id = ?1 AND played_at < ?2").bind(userId, new Date(now - PLAYS_KEEP_DAYS * DAY_MS).toISOString()));
  if (body.streak || body.log) {
    const cur = await loadStreak(env, userId);
    let { last, count } = cur;
    const maxDay = new Date(now + 2 * DAY_MS).toISOString().slice(0, 10);
    const incoming = body.streak;
    if (incoming && incoming.last <= maxDay && (incoming.last > last || (incoming.last === last && incoming.count > count))) {
      last = incoming.last;
      count = incoming.count;
    }
    const oldestDay = new Date(now - PLAYS_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
    const log: Record<string, number> = {};
    for (const [day, n] of Object.entries(cur.log)) if (day >= oldestDay && Number(n) > 0) log[day] = Number(n);
    for (const [day, n] of Object.entries(body.log || {})) {
      if (day >= oldestDay && day <= maxDay && n > (log[day] || 0)) log[day] = n;
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO user_streaks (user_id, last, count, day_log) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id) DO UPDATE SET last = excluded.last, count = excluded.count, day_log = excluded.day_log`
      ).bind(userId, last, count, JSON.stringify(log))
    );
  }
  await env.DB.batch(stmts);
}
