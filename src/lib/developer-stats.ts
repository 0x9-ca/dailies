// Stats shown to a game's verified developer. Everything is derived from existing tables. Daily plays come from
// game_click_days (counted from Nov 2, 2026 onward; games.click_count is the all-time total); rotation adds and votes
// have created_at and get a 30-day series. Votes are bucketed by when first cast (a changed vote keeps its created_at).
import type { Env } from "../env";
import { getCachedJson, setCachedJson } from "./cache";

export const DEV_STATS_DAYS = 30;
const TTL_SECONDS = 600;
const TZ = "America/New_York";

export type DeveloperStats = {
  days: string[];
  playsPerDay: number[];
  rotationAddsPerDay: number[];
  votesUpPerDay: number[];
  votesDownPerDay: number[];
  totals: {
    clicks: number;
    rotations: number;
    lists: number;
    publicLists: number;
    votesUp: number;
    votesDown: number;
    ratingPercent: number | null;
    rank: number | null;
    rankOf: number;
    score: number;
  };
  lists: { title: string; slug: string }[];
  generatedAt: string;
};

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const etDay = (d: Date) => dayFmt.format(d);

function lastDays(now: Date): string[] {
  const out: string[] = [];
  for (let i = DEV_STATS_DAYS - 1; i >= 0; i--) out.push(etDay(new Date(now.getTime() - i * 86_400_000)));
  return out;
}

export async function loadDeveloperStats(env: Env, gameId: string): Promise<DeveloperStats | null> {
  const key = `devstats:${gameId}`;
  const hit = await getCachedJson<DeveloperStats>(env, key);
  if (hit) return hit;
  const game = await env.DB.prepare(
    "SELECT id, score, click_count, vote_up_count, vote_down_count, nsfw, status, (SELECT COUNT(*) FROM favorites WHERE game_id = games.id) + (SELECT COUNT(*) FROM anonymous_favorites WHERE game_id = games.id) AS rotations FROM games WHERE id = ?1"
  ).bind(gameId).first<{ id: string; score: number; click_count: number; vote_up_count: number; vote_down_count: number; nsfw: number; status: string; rotations: number }>();
  if (!game) return null;
  const since = "datetime('now','-32 days')";
  const [favs, votes, lists, rank, rankOf, plays] = await Promise.all([
    env.DB.prepare(`SELECT created_at FROM favorites WHERE game_id = ?1 AND created_at > ${since} UNION ALL SELECT created_at FROM anonymous_favorites WHERE game_id = ?1 AND created_at > ${since}`).bind(gameId).all<{ created_at: string }>(),
    env.DB.prepare(`SELECT created_at, value FROM votes WHERE game_id = ?1 AND created_at > ${since} UNION ALL SELECT created_at, value FROM anonymous_votes WHERE game_id = ?1 AND created_at > ${since}`).bind(gameId).all<{ created_at: string; value: number }>(),
    env.DB.prepare(
      `SELECT curated_lists.title, curated_lists.slug, curated_lists.visibility FROM curated_list_items
       JOIN curated_lists ON curated_lists.id = curated_list_items.curated_list_id
       WHERE curated_list_items.game_id = ?1 ORDER BY curated_lists.title COLLATE NOCASE LIMIT 100`
    ).bind(gameId).all<{ title: string; slug: string; visibility: string }>(),
    game.status === "approved" && !game.nsfw
      ? env.DB.prepare(
          `SELECT COUNT(*) + 1 AS n FROM games g WHERE g.status = 'approved' AND g.nsfw = 0
           AND (g.score > ?1 OR (g.score = ?1 AND (g.vote_up_count > ?2 OR (g.vote_up_count = ?2 AND g.id < ?3))))`
        ).bind(game.score, game.vote_up_count, game.id).first<{ n: number }>()
      : Promise.resolve(null),
    env.DB.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'approved' AND nsfw = 0").first<{ n: number }>(),
    env.DB.prepare("SELECT day, clicks FROM game_click_days WHERE game_id = ?1 AND day >= date('now','-32 days')").bind(gameId).all<{ day: string; clicks: number }>()
  ]);
  const days = lastDays(new Date());
  const idx = new Map(days.map((d, i) => [d, i]));
  const bucket = (iso: string) => idx.get(etDay(new Date(iso.replace(" ", "T") + "Z")));
  const playsPerDay = days.map(() => 0);
  for (const r of plays.results) { const i = idx.get(r.day); if (i !== undefined) playsPerDay[i] = r.clicks; }
  const rotationAddsPerDay = days.map(() => 0);
  const votesUpPerDay = days.map(() => 0);
  const votesDownPerDay = days.map(() => 0);
  for (const r of favs.results) { const i = bucket(r.created_at); if (i !== undefined) rotationAddsPerDay[i]++; }
  for (const r of votes.results) { const i = bucket(r.created_at); if (i !== undefined) (r.value === 1 ? votesUpPerDay : votesDownPerDay)[i]++; }
  const publicLists = lists.results.filter((l) => l.visibility === "public");
  const nVotes = game.vote_up_count + game.vote_down_count;
  const stats: DeveloperStats = {
    days, playsPerDay, rotationAddsPerDay, votesUpPerDay, votesDownPerDay,
    totals: {
      clicks: game.click_count,
      rotations: game.rotations,
      lists: lists.results.length,
      publicLists: publicLists.length,
      votesUp: game.vote_up_count,
      votesDown: game.vote_down_count,
      ratingPercent: nVotes ? Math.round((game.vote_up_count / nVotes) * 100) : null,
      rank: rank?.n ?? null,
      rankOf: rankOf?.n ?? 0,
      score: Math.round(game.score * 1000) / 1000
    },
    lists: publicLists.map((l) => ({ title: l.title, slug: l.slug })),
    generatedAt: new Date().toISOString()
  };
  await setCachedJson(env, key, stats, TTL_SECONDS);
  return stats;
}

/** Server-rendered shell; the script fills it in. Only rendered for the verified developer (signed in, so never publicly cached). */
export function renderDeveloperStatsPanel(gameId: string, cssUrl: string, jsUrl: string): string {
  return `<link rel="stylesheet" href="${cssUrl}">
    <section class="panel dev-stats" id="dev-stats" data-game-id="${gameId.replace(/[^a-zA-Z0-9-]/g, "")}">
      <h2>Your game's stats</h2>
      <p class="game-actions-note">Last 30 days, US/Eastern. Updated about every 10 minutes.</p>
      <div data-dev-stats-body aria-live="polite"><p class="status">Loading stats...</p></div>
    </section>
    <script src="${jsUrl}"></script>`;
}

export const DEVELOPER_STATS_CSS = `
.dev-stats .stat-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.6rem; margin: 0.75rem 0; }
.dev-stats .stat-tile { border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.7rem; background: var(--bg-soft); min-width: 0; overflow-wrap: anywhere; }
.dev-stats .stat-tile b { display: block; font-size: 1.4rem; line-height: 1.2; }
.dev-stats .stat-tile span { color: var(--muted); font-size: 0.85rem; }
.dev-stats figure { margin: 1rem 0 0; }
.dev-stats figcaption { font-weight: 600; margin-bottom: 0.25rem; }
.dev-stats svg { display: block; width: 100%; height: 100px; }
.dev-stats .bar-up { fill: var(--brand-blue); }
.dev-stats .bar-down { fill: var(--muted); }
.dev-stats .axis { stroke: var(--border); stroke-width: 1; }
.dev-stats .chart-range { display: flex; justify-content: space-between; color: var(--muted); font-size: 0.8rem; }
.dev-stats table { border-collapse: collapse; margin-top: 0.4rem; }
.dev-stats th, .dev-stats td { text-align: left; padding: 0.15rem 0.8rem 0.15rem 0; }
`;

export const DEVELOPER_STATS_SCRIPT = `(function () {
  var root = document.getElementById("dev-stats");
  if (!root) return;
  var body = root.querySelector("[data-dev-stats-body]");
  var NS = "http://www.w3.org/2000/svg";
  var fmt = new Intl.NumberFormat("en-US");
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svgEl(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function label(iso) { var p = iso.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }); }
  function tile(value, name) { var t = el("div", "stat-tile"); t.appendChild(el("b", null, value)); t.appendChild(el("span", null, name)); return t; }
  function chart(title, days, a, b, aName, bName) {
    var n = days.length, W = 300, H = 80, bw = W / n, max = 1, i;
    for (i = 0; i < n; i++) max = Math.max(max, a[i] + (b ? b[i] : 0));
    var totalA = a.reduce(function (s, v) { return s + v; }, 0), totalB = b ? b.reduce(function (s, v) { return s + v; }, 0) : 0;
    var summary = title + ": " + fmt.format(totalA) + " " + aName + (b ? " and " + fmt.format(totalB) + " " + bName : "") + " from " + label(days[0]) + " to " + label(days[n - 1]) + ".";
    var fig = el("figure"); fig.appendChild(el("figcaption", null, title));
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + (H + 2), role: "img", "aria-label": summary, preserveAspectRatio: "none" });
    svg.appendChild(svgEl("title", {})).textContent = summary;
    for (i = 0; i < n; i++) {
      var ha = a[i] / max * H, hb = b ? b[i] / max * H : 0;
      if (ha) svg.appendChild(svgEl("rect", { "class": "bar-up", x: i * bw + 1, width: Math.max(1, bw - 2), y: H - ha, height: ha }));
      if (hb) svg.appendChild(svgEl("rect", { "class": "bar-down", x: i * bw + 1, width: Math.max(1, bw - 2), y: H - ha - hb, height: hb }));
    }
    svg.appendChild(svgEl("line", { "class": "axis", x1: 0, x2: W, y1: H + 1, y2: H + 1 }));
    fig.appendChild(svg);
    var r = el("div", "chart-range"); r.appendChild(el("span", null, label(days[0]))); r.appendChild(el("span", null, label(days[n - 1]))); fig.appendChild(r);
    fig.appendChild(el("p", "visually-hidden", summary));
    var d = el("details"); d.appendChild(el("summary", null, "Daily numbers"));
    var tbl = el("table"), th = el("tr");
    ["Date", aName].concat(b ? [bName] : []).forEach(function (h) { th.appendChild(el("th", null, h)); });
    tbl.appendChild(th);
    for (i = 0; i < n; i++) { if (!a[i] && !(b && b[i])) continue; var tr = el("tr"); tr.appendChild(el("td", null, label(days[i]))); tr.appendChild(el("td", null, String(a[i]))); if (b) tr.appendChild(el("td", null, String(b[i]))); tbl.appendChild(tr); }
    d.appendChild(tbl); fig.appendChild(d);
    return fig;
  }
  fetch("/api/games/" + encodeURIComponent(root.getAttribute("data-game-id")) + "/developer-stats", { credentials: "same-origin" })
    .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
    .then(function (s) {
      var t = s.totals;
      body.textContent = "";
      var tiles = el("div", "stat-tiles");
      tiles.appendChild(tile(fmt.format(t.clicks), "play clicks, all time"));
      tiles.appendChild(tile(fmt.format(t.rotations), "players with it in their rotation"));
      tiles.appendChild(tile(fmt.format(t.lists), t.lists === 1 ? "list featuring it" : "lists featuring it"));
      tiles.appendChild(tile(t.ratingPercent == null ? "No votes" : t.ratingPercent + "%", "rating (" + fmt.format(t.votesUp) + " up, " + fmt.format(t.votesDown) + " down)"));
      tiles.appendChild(tile(t.rank == null ? "Not ranked" : "#" + fmt.format(t.rank), t.rank == null ? "in the top ranking" : "of " + fmt.format(t.rankOf) + " games, score " + t.score));
      body.appendChild(tiles);
      body.appendChild(chart("Plays per day", s.days, s.playsPerDay, null, "plays"));
      body.appendChild(chart("New rotation adds per day", s.days, s.rotationAddsPerDay, null, "rotation adds"));
      body.appendChild(chart("Votes per day", s.days, s.votesUpPerDay, s.votesDownPerDay, "up", "down"));
      body.appendChild(el("p", "game-actions-note", "Daily plays are counted from Nov 2, 2026 onward; the play total above includes earlier clicks."));
      if (s.lists.length) {
        body.appendChild(el("h3", null, "Public lists featuring your game"));
        var ul = el("ul");
        s.lists.forEach(function (l) { var li = el("li"), a = el("a", null, l.title); a.href = "/lists/" + encodeURIComponent(l.slug); li.appendChild(a); ul.appendChild(li); });
        body.appendChild(ul);
      }
    })
    .catch(function () { body.textContent = ""; body.appendChild(el("p", "status", "Couldn't load stats. Try again later.")); });
})();`;
