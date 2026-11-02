// Data behind /admin/health. Link failures come from the daily runLinkChecks (link_fail_count, last_checked_at).

export type BrokenRow = { id: string; slug: string; title: string; url: string; link_fail_count: number; last_checked_at: string | null };
export type GapRow = { slug: string; title: string; description_length: number };
export const GAP_LIMIT = 100;
/** Same threshold at which runLinkChecks files its auto-report. */
export const BROKEN_THRESHOLD = 3;

export async function loadGameHealth(db: D1Database) {
  const broken = await db.prepare(
    `SELECT id, slug, title, url, link_fail_count, last_checked_at FROM games
     WHERE status = 'approved' AND link_fail_count >= ?1 ORDER BY link_fail_count DESC, title LIMIT 200`
  ).bind(BROKEN_THRESHOLD).all<BrokenRow>();
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
