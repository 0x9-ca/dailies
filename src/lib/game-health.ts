// Daily play-URL health check (cron) and the data behind /admin/health.
import type { Env } from "../env";

const BATCH = 150;
const CONCURRENCY = 6;
const TIMEOUT_MS = 8_000;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 0x9dles-linkcheck";

type Outcome = { id: string; status: number; kind: "ok" | "unknown" | "fail" };

async function probe(id: string, url: string): Promise<Outcome> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" }, signal: ctl.signal });
    const status = res.status;
    const challenge = (status === 403 || status === 503) && (res.headers.has("cf-mitigated") || (res.headers.get("server") || "").toLowerCase() === "cloudflare");
    try { await res.body?.cancel(); } catch { /* ignore */ }
    if (status < 400) return { id, status, kind: "ok" };
    if (challenge || status === 401 || status === 403 || status === 429) return { id, status, kind: "unknown" };
    return { id, status, kind: "fail" };
  } catch {
    return { id, status: 0, kind: "fail" };
  } finally {
    clearTimeout(timer);
  }
}

export async function runGameLinkHealth(env: Env): Promise<void> {
  try {
    const rows = (await env.DB.prepare(
      `SELECT id, url FROM games WHERE status = 'approved' ORDER BY link_checked_at IS NOT NULL, link_checked_at ASC LIMIT ?1`
    ).bind(BATCH).all<{ id: string; url: string }>()).results;
    const outcomes: Outcome[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (next < rows.length) {
        const row = rows[next++];
        outcomes.push(await probe(row.id, row.url));
      }
    }));
    if (outcomes.length === 0) return;
    // One D1 call for all updates keeps the subrequest count at ~BATCH + 2.
    await env.DB.batch(outcomes.map((o) => env.DB.prepare(
      `UPDATE games SET link_checked_at = datetime('now'), link_status = ?1,
         link_failures = CASE ?2 WHEN 'ok' THEN 0 WHEN 'fail' THEN link_failures + 1 ELSE link_failures END
       WHERE id = ?3`
    ).bind(o.status, o.kind, o.id)));
  } catch (error) {
    console.error(JSON.stringify({ message: "game link health failed", error: String(error) }));
  }
}

export type BrokenRow = { id: string; slug: string; title: string; url: string; link_status: number | null; link_failures: number; link_checked_at: string | null };
export type GapRow = { slug: string; title: string; description_length: number };
export const GAP_LIMIT = 100;

export async function loadGameHealth(db: D1Database) {
  const broken = await db.prepare(
    `SELECT id, slug, title, url, link_status, link_failures, link_checked_at FROM games
     WHERE status = 'approved' AND link_failures >= 2 ORDER BY link_failures DESC, title LIMIT 200`
  ).all<BrokenRow>();
  const gap = async (cond: string) => {
    const where = `status = 'approved' AND (${cond})`;
    const [count, list] = await db.batch<{ n: number } | GapRow>([
      db.prepare(`SELECT COUNT(*) AS n FROM games WHERE ${where}`),
      db.prepare(`SELECT slug, title, LENGTH(TRIM(COALESCE(description, ''))) AS description_length FROM games WHERE ${where} ORDER BY score DESC, vote_up_count DESC, id LIMIT ${GAP_LIMIT}`)
    ]);
    return { count: (count.results[0] as { n: number }).n, rows: list.results as GapRow[] };
  };
  return {
    broken: broken.results,
    description: await gap("description IS NULL OR LENGTH(TRIM(description)) < 40"),
    reset: await gap("reset_basis IS NULL"),
    categories: await gap("NOT EXISTS (SELECT 1 FROM game_categories gc WHERE gc.game_id = games.id)")
  };
}
