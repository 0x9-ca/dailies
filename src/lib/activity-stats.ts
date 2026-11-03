// Activity numbers for /admin/stats. All day buckets are US/Eastern dates.
// Timestamps are ISO UTC; SQL groups by (key, UTC hour) and the day bucketing happens here, since DST shifts the offset.

export type ActivityData = {
  days: string[]; // 30 ET dates, oldest first
  opens: number[];
  dau: number[];
  sessions: number[];
  wau: number;
  mau: number;
  opens7: number;
  openPrev7: number;
  favs7: number;
  favs30: number;
  topOpened: { slug: string; title: string; n: number; prev: number }[];
  topStreamed: { slug: string; title: string; n: number }[];
};

const etFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDay = (d: Date) => etFmt.format(d);

/** ET date for a stored timestamp ("2026-11-03T14" hour prefix, ISO, or "YYYY-MM-DD HH:MM:SS"). */
function etDayOfStamp(s: string): string {
  const t = s.replace(" ", "T");
  const full = t.length === 13 ? `${t}:00:00Z` : /Z|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`;
  return etDay(new Date(full));
}

export function labelDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

export async function loadActivity(db: D1Database, now = new Date()): Promise<ActivityData> {
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) days.push(etDay(new Date(now.getTime() - i * 86400000)));
  const idx = new Map(days.map((d, i) => [d, i]));
  const last7 = new Set(days.slice(-7));
  const utcFrom = new Date(now.getTime() - 31 * 86400000).toISOString();
  const favFrom = utcFrom.slice(0, 19).replace("T", " ");
  const weekStart = days[23];
  const prevStart = days[16];

  const [clicks, plays, hist, topHist, favs, topRows] = await db.batch([
    db.prepare("SELECT day, SUM(clicks) AS n FROM game_click_days WHERE day >= ?1 GROUP BY day").bind(days[0]),
    db.prepare("SELECT user_id, substr(played_at, 1, 13) AS h FROM user_plays WHERE played_at >= ?1 GROUP BY user_id, h").bind(utcFrom),
    db.prepare("SELECT list_id, substr(started_at, 1, 13) AS h FROM list_play_history WHERE started_at >= ?1 GROUP BY list_id, h").bind(utcFrom),
    db.prepare("SELECT g.slug, g.title, COUNT(*) AS n FROM list_play_history h JOIN games g ON g.id = h.game_id WHERE h.started_at >= ?1 GROUP BY g.id ORDER BY n DESC, g.title LIMIT 5").bind(new Date(now.getTime() - 7 * 86400000).toISOString()),
    db.prepare("SELECT created_at AS c FROM favorites WHERE created_at >= ?1").bind(favFrom),
    db
      .prepare(
        `SELECT g.slug, g.title,
           SUM(CASE WHEN c.day >= ?1 THEN c.clicks ELSE 0 END) AS n,
           SUM(CASE WHEN c.day < ?1 THEN c.clicks ELSE 0 END) AS prev
         FROM game_click_days c JOIN games g ON g.id = c.game_id
         WHERE c.day >= ?2 GROUP BY c.game_id HAVING n > 0 ORDER BY n DESC, g.title LIMIT 10`
      )
      .bind(weekStart, prevStart)
  ]);

  const opens = days.map(() => 0);
  for (const r of clicks.results as { day: string; n: number }[]) {
    const i = idx.get(r.day);
    if (i !== undefined) opens[i] = r.n;
  }

  const dauSets = days.map(() => new Set<string>());
  const wauSet = new Set<string>();
  for (const r of plays.results as { user_id: string; h: string }[]) {
    const d = etDayOfStamp(r.h);
    const i = idx.get(d);
    if (i === undefined) continue;
    dauSets[i].add(r.user_id);
    if (last7.has(d)) wauSet.add(r.user_id);
  }
  const mauSet = new Set<string>();
  for (const s of dauSets) for (const u of s) mauSet.add(u);

  const sessSets = days.map(() => new Set<string>());
  for (const r of hist.results as { list_id: string; h: string }[]) {
    const i = idx.get(etDayOfStamp(r.h));
    if (i !== undefined) sessSets[i].add(r.list_id);
  }

  let favs7 = 0;
  let favs30 = 0;
  for (const r of favs.results as { c: string }[]) {
    const d = etDayOfStamp(r.c);
    if (idx.has(d)) favs30++;
    if (last7.has(d)) favs7++;
  }

  const sum = (a: number[]) => a.reduce((t, v) => t + v, 0);
  return {
    days,
    opens,
    dau: dauSets.map((s) => s.size),
    sessions: sessSets.map((s) => s.size),
    wau: wauSet.size,
    mau: mauSet.size,
    opens7: sum(opens.slice(-7)),
    openPrev7: sum(opens.slice(-14, -7)),
    favs7,
    favs30,
    topOpened: topRows.results as ActivityData["topOpened"],
    topStreamed: topHist.results as ActivityData["topStreamed"]
  };
}

/** Server-rendered SVG bar chart with a title, aria summary and a visually hidden data table. */
export function barChartSvg(title: string, days: string[], values: number[], esc: (s: string) => string): string {
  const W = 300;
  const H = 90;
  const max = Math.max(1, ...values);
  const step = W / values.length;
  const bars = values
    .map((v, i) => {
      const h = v > 0 ? Math.max(2, Math.round((v / max) * (H - 4))) : 1;
      return `<rect x="${(i * step + 1).toFixed(1)}" y="${H - h}" width="${(step - 2).toFixed(1)}" height="${h}" rx="1.5" fill="var(--primary)"><title>${esc(labelDay(days[i]))}: ${v}</title></rect>`;
    })
    .join("");
  const total = values.reduce((t, v) => t + v, 0);
  const rows = values.map((v, i) => `<tr><td>${esc(labelDay(days[i]))}</td><td>${v}</td></tr>`).join("");
  return `<svg class="act-svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" role="img" aria-label="${esc(title)}, ${esc(labelDay(days[0]))} to ${esc(labelDay(days[days.length - 1]))}, total ${total}, peak ${max === 1 && total === 0 ? 0 : max}"><title>${esc(title)}</title><line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="var(--border)" stroke-width="1"/>${bars}</svg><div class="bars-axis"><span>${esc(labelDay(days[0]))}</span><span>${esc(labelDay(days[days.length - 1]))}</span></div><table class="visually-hidden"><caption>${esc(title)}</caption><tbody>${rows}</tbody></table>`;
}
