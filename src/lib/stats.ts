// Numbers for /admin/stats. Everything is counted from existing tables; nothing is tracked just for this page.
// Page views and distinct anonymous visitors are not recorded anywhere, so "anonymous" here means anonymous
// voters and anonymous rotations (hashed IP / local id), not everyone who opened the site.

export type StatTables = {
  scalars: Record<string, number>;
  topClicked: { slug: string; title: string; n: number }[];
  topVoted: { slug: string; title: string; n: number }[];
  topFavorited: { slug: string; title: string; n: number }[];
  series: { date: string; users: number; votes: number; games: number }[];
};

const DAYS = 14;

/** Each entry is a query returning one row with one integer column `n`. */
const SCALARS: Record<string, string> = {
  usersTotal: "SELECT COUNT(*) n FROM users WHERE id != '00000000-0000-0000-0000-000000000001'",
  usersNew7: "SELECT COUNT(*) n FROM users WHERE created_at > datetime('now','-7 days') AND id != '00000000-0000-0000-0000-000000000001'",
  usersNew30: "SELECT COUNT(*) n FROM users WHERE created_at > datetime('now','-30 days') AND id != '00000000-0000-0000-0000-000000000001'",
  usersNew1: "SELECT COUNT(*) n FROM users WHERE created_at > datetime('now','-1 day') AND id != '00000000-0000-0000-0000-000000000001'",
  usersEditors: "SELECT COUNT(*) n FROM users WHERE role = 'editor'",
  usersAdmins: "SELECT COUNT(*) n FROM users WHERE role = 'admin'",
  usersSignedIn: "SELECT COUNT(DISTINCT user_id) n FROM sessions WHERE expires_at > datetime('now')",
  usersDiscord: "SELECT COUNT(DISTINCT user_id) n FROM oauth_accounts WHERE provider = 'discord'",
  usersTwitch: "SELECT COUNT(DISTINCT user_id) n FROM oauth_accounts WHERE provider = 'twitch'",
  usersBothProviders: "SELECT COUNT(*) n FROM (SELECT user_id FROM oauth_accounts WHERE provider IN ('discord','twitch') GROUP BY user_id HAVING COUNT(DISTINCT provider) = 2)",
  usersPublicProfile: "SELECT COUNT(*) n FROM users WHERE profile_public = 1",
  usersCreators: "SELECT COUNT(*) n FROM users WHERE creator_type IS NOT NULL",
  usersVoted: "SELECT COUNT(DISTINCT user_id) n FROM votes",
  usersWithFavorites: "SELECT COUNT(DISTINCT user_id) n FROM favorites",

  anonVoters: "SELECT COUNT(DISTINCT anon_ip_hash) n FROM anonymous_votes",
  anonRotations: "SELECT COUNT(DISTINCT anon_id) n FROM anonymous_favorites",

  votesUser: "SELECT COUNT(*) n FROM votes",
  votesUserUp: "SELECT COUNT(*) n FROM votes WHERE value = 1",
  votesAnon: "SELECT COUNT(*) n FROM anonymous_votes",
  votesAnonUp: "SELECT COUNT(*) n FROM anonymous_votes WHERE value = 1",
  votes1: "SELECT (SELECT COUNT(*) FROM votes WHERE created_at > datetime('now','-1 day')) + (SELECT COUNT(*) FROM anonymous_votes WHERE created_at > datetime('now','-1 day')) n",
  votes7: "SELECT (SELECT COUNT(*) FROM votes WHERE created_at > datetime('now','-7 days')) + (SELECT COUNT(*) FROM anonymous_votes WHERE created_at > datetime('now','-7 days')) n",
  votes30: "SELECT (SELECT COUNT(*) FROM votes WHERE created_at > datetime('now','-30 days')) + (SELECT COUNT(*) FROM anonymous_votes WHERE created_at > datetime('now','-30 days')) n",

  favUser: "SELECT COUNT(*) n FROM favorites",
  favAnon: "SELECT COUNT(*) n FROM anonymous_favorites",
  fav7: "SELECT (SELECT COUNT(*) FROM favorites WHERE created_at > datetime('now','-7 days')) + (SELECT COUNT(*) FROM anonymous_favorites WHERE created_at > datetime('now','-7 days')) n",

  clicksTotal: "SELECT COALESCE(SUM(click_count), 0) n FROM games",
  gamesApproved: "SELECT COUNT(*) n FROM games WHERE status = 'approved'",
  gamesPending: "SELECT COUNT(*) n FROM games WHERE status = 'pending'",
  gamesRejected: "SELECT COUNT(*) n FROM games WHERE status = 'rejected'",
  gamesDisabled: "SELECT COUNT(*) n FROM games WHERE status = 'disabled'",
  gamesNew7: "SELECT COUNT(*) n FROM games WHERE created_at > datetime('now','-7 days')",
  gamesNew30: "SELECT COUNT(*) n FROM games WHERE created_at > datetime('now','-30 days')",
  gamesPaywall: "SELECT COUNT(*) n FROM games WHERE status = 'approved' AND paywall = 1",
  gamesNsfw: "SELECT COUNT(*) n FROM games WHERE status = 'approved' AND nsfw = 1",
  gamesWithReset: "SELECT COUNT(*) n FROM games WHERE status = 'approved' AND reset_basis IS NOT NULL",
  gamesBroken: "SELECT COUNT(*) n FROM games WHERE status = 'approved' AND link_fail_count > 0",
  gamesNoVotes: "SELECT COUNT(*) n FROM games WHERE status = 'approved' AND vote_up_count + vote_down_count = 0",
  categories: "SELECT COUNT(*) n FROM categories",

  listsPublic: "SELECT COUNT(*) n FROM curated_lists WHERE visibility = 'public' AND kind = 'curated'",
  listsPrivate: "SELECT COUNT(*) n FROM curated_lists WHERE visibility = 'private' AND kind = 'curated'",
  listsCreator: "SELECT COUNT(*) n FROM curated_lists WHERE kind = 'creator'",
  listItems: "SELECT COUNT(*) n FROM curated_list_items",
  suggestions: "SELECT COUNT(*) n FROM list_suggestions",
  suggestionVotes: "SELECT COUNT(*) n FROM list_suggestion_votes",
  fandleMembers: "SELECT COUNT(*) n FROM fandle_members",
  fandleManual: "SELECT COUNT(*) n FROM fandle_members WHERE source = 'manual'",

  claimsVerified: "SELECT COUNT(*) n FROM game_claims WHERE status = 'verified'",
  claimsOpen: "SELECT COUNT(*) n FROM game_claims WHERE status IN ('pending','review')",
  claimsReview: "SELECT COUNT(*) n FROM game_claims WHERE status = 'review'",
  claimDevelopers: "SELECT COUNT(DISTINCT user_id) n FROM game_claims WHERE status = 'verified'",
  reportsOpen: "SELECT COUNT(*) n FROM reports WHERE status = 'open'",
  reportsTotal: "SELECT COUNT(*) n FROM reports"
};

const TOP_N = 10;
const TOP_QUERIES = {
  topClicked: `SELECT slug, title, click_count n FROM games WHERE status = 'approved' AND click_count > 0 ORDER BY click_count DESC LIMIT ${TOP_N}`,
  topVoted: `SELECT slug, title, vote_up_count + vote_down_count n FROM games WHERE status = 'approved' AND vote_up_count + vote_down_count > 0 ORDER BY n DESC LIMIT ${TOP_N}`,
  topFavorited: `SELECT g.slug, g.title, COUNT(*) n FROM (SELECT game_id FROM favorites UNION ALL SELECT game_id FROM anonymous_favorites) f JOIN games g ON g.id = f.game_id WHERE g.status = 'approved' GROUP BY g.id ORDER BY n DESC LIMIT ${TOP_N}`
} as const;

const SERIES_QUERIES = {
  users: `SELECT date(created_at) d, COUNT(*) n FROM users WHERE created_at > datetime('now','-${DAYS} days') AND id != '00000000-0000-0000-0000-000000000001' GROUP BY d`,
  votes: `SELECT d, SUM(n) n FROM (SELECT date(created_at) d, COUNT(*) n FROM votes WHERE created_at > datetime('now','-${DAYS} days') GROUP BY d UNION ALL SELECT date(created_at) d, COUNT(*) n FROM anonymous_votes WHERE created_at > datetime('now','-${DAYS} days') GROUP BY d) GROUP BY d`,
  games: `SELECT date(created_at) d, COUNT(*) n FROM games WHERE created_at > datetime('now','-${DAYS} days') GROUP BY d`
} as const;

export async function loadStats(db: D1Database): Promise<StatTables> {
  const scalarKeys = Object.keys(SCALARS);
  const topKeys = Object.keys(TOP_QUERIES) as (keyof typeof TOP_QUERIES)[];
  const seriesKeys = Object.keys(SERIES_QUERIES) as (keyof typeof SERIES_QUERIES)[];
  const results = await db.batch([
    ...scalarKeys.map((k) => db.prepare(SCALARS[k])),
    ...topKeys.map((k) => db.prepare(TOP_QUERIES[k])),
    ...seriesKeys.map((k) => db.prepare(SERIES_QUERIES[k]))
  ]);

  const scalars: Record<string, number> = {};
  scalarKeys.forEach((k, i) => {
    scalars[k] = Number((results[i].results?.[0] as { n?: number } | undefined)?.n ?? 0);
  });
  const tops: Record<string, { slug: string; title: string; n: number }[]> = {};
  topKeys.forEach((k, i) => {
    tops[k] = (results[scalarKeys.length + i].results ?? []) as { slug: string; title: string; n: number }[];
  });
  const byDay: Record<string, Map<string, number>> = {};
  seriesKeys.forEach((k, i) => {
    byDay[k] = new Map(((results[scalarKeys.length + topKeys.length + i].results ?? []) as { d: string; n: number }[]).map((r) => [r.d, Number(r.n)]));
  });

  const series: StatTables["series"] = [];
  const now = Date.now();
  for (let i = DAYS - 1; i >= 0; i--) {
    const date = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    series.push({ date, users: byDay.users.get(date) ?? 0, votes: byDay.votes.get(date) ?? 0, games: byDay.games.get(date) ?? 0 });
  }
  return { scalars, topClicked: tops.topClicked, topVoted: tops.topVoted, topFavorited: tops.topFavorited, series };
}
