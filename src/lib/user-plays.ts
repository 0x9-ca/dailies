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

const skipItem = z.object({ day: z.string().regex(DAY_KEY), gameId: z.string().min(1).max(64) });
const utcDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

export const playsBodySchema = z.object({
  plays: z.array(z.object({ gameId: z.string().min(1).max(64), playedAt: z.string().max(40) })).max(200).optional(),
  unplayed: z.array(z.object({ gameId: z.string().min(1).max(64), since: z.string().max(40) })).max(200).optional(),
  skipped: z.array(skipItem).max(200).optional(),
  unskipped: z.array(skipItem).max(200).optional(),
  streak: z.object({ last: z.string().regex(DAY_KEY), count: z.number().int().min(0).max(100000) }).optional(),
  best: z.number().int().min(0).max(100000).optional(),
  log: z.record(z.string().regex(DAY_KEY), z.number().int().min(0).max(1000)).optional()
}).superRefine((body, ctx) => {
  // Viewer-local days: tolerate time zones by allowing yesterday..tomorrow relative to UTC now.
  const lo = utcDay(-1), hi = utcDay(1);
  for (const item of [...(body.skipped || []), ...(body.unskipped || [])]) {
    if (item.day < lo || item.day > hi || Number.isNaN(Date.parse(item.day))) {
      ctx.addIssue({ code: "custom", message: "Invalid skip day" });
      return;
    }
  }
});

function isoOrNull(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

type Streak = { last: string; count: number; best: number; log: Record<string, number> };

async function loadStreak(env: Env, userId: string): Promise<Streak> {
  const row = await env.DB.prepare("SELECT last, count, best, day_log FROM user_streaks WHERE user_id = ?1")
    .bind(userId)
    .first<{ last: string; count: number; best: number; day_log: string }>();
  let log: Record<string, number> = {};
  try {
    const parsed = JSON.parse(row?.day_log || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) log = parsed;
  } catch {
    // Ignore a corrupt log.
  }
  return { last: row?.last || "", count: row?.count || 0, best: row?.best || 0, log };
}

export async function loadPlays(env: Env, userId: string, sinceParam: string | undefined) {
  const floor = Date.now() - PLAYS_KEEP_DAYS * DAY_MS;
  let since = Date.now() - PLAYS_WINDOW_DAYS * DAY_MS;
  const parsed = sinceParam ? Date.parse(sinceParam) : NaN;
  if (Number.isFinite(parsed)) since = Math.max(parsed, floor);
  // Four independent reads, sent together.
  const [rows, streak, skipRows, resetRow] = await Promise.all([
    env.DB.prepare(
      "SELECT game_id, played_at FROM user_plays WHERE user_id = ?1 AND played_at >= ?2 ORDER BY played_at ASC LIMIT 5000"
    )
      .bind(userId, new Date(since).toISOString())
      .all<{ game_id: string; played_at: string }>(),
    loadStreak(env, userId),
    env.DB.prepare("SELECT day, game_id FROM user_skips WHERE user_id = ?1 AND day >= ?2 LIMIT 500")
      .bind(userId, utcDay(-2))
      .all<{ day: string; game_id: string }>(),
    env.DB.prepare("SELECT reset_at FROM user_plays_reset WHERE user_id = ?1").bind(userId).first<{ reset_at: string }>()
  ]);
  const skips: Record<string, string[]> = {};
  for (const r of skipRows.results) (skips[r.day] ||= []).push(r.game_id);
  return {
    userId,
    resetAt: resetRow?.reset_at || "",
    skips,
    plays: rows.results.map((r) => ({ gameId: r.game_id, playedAt: r.played_at })),
    streak: { last: streak.last, count: streak.count, best: streak.best },
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
  // Unskips first, like unplays.
  for (const item of body.unskipped || []) {
    stmts.push(env.DB.prepare("DELETE FROM user_skips WHERE user_id = ?1 AND day = ?2 AND game_id = ?3").bind(userId, item.day, item.gameId));
  }
  for (const item of body.skipped || []) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO user_skips (user_id, day, game_id) SELECT ?1, ?2, games.id FROM games WHERE games.id = ?3").bind(userId, item.day, item.gameId)
    );
  }
  stmts.push(env.DB.prepare("DELETE FROM user_skips WHERE user_id = ?1 AND day < ?2").bind(userId, utcDay(-4)));
  stmts.push(env.DB.prepare("DELETE FROM user_plays WHERE user_id = ?1 AND played_at < ?2").bind(userId, new Date(now - PLAYS_KEEP_DAYS * DAY_MS).toISOString()));
  if (body.streak || body.log || body.best) {
    const cur = await loadStreak(env, userId);
    let { last, count } = cur;
    const best = Math.max(cur.best, body.best || 0, body.streak?.count || 0, count);
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
        `INSERT INTO user_streaks (user_id, last, count, best, day_log) VALUES (?1, ?2, ?3, ?5, ?4)
         ON CONFLICT(user_id) DO UPDATE SET last = excluded.last, count = excluded.count, best = excluded.best, day_log = excluded.day_log`
      ).bind(userId, last, count, JSON.stringify(log), best)
    );
  }
  await env.DB.batch(stmts);
}

/** Deletes plays, skips and the streak row; records resetAt so other devices wipe their local copy. */
export async function clearPlays(env: Env, userId: string): Promise<string> {
  const resetAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_plays WHERE user_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM user_skips WHERE user_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM user_streaks WHERE user_id = ?1").bind(userId),
    env.DB.prepare(
      "INSERT INTO user_plays_reset (user_id, reset_at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET reset_at = excluded.reset_at"
    ).bind(userId, resetAt)
  ]);
  return resetAt;
}
