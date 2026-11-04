import { parseMonth, dayFormatter, loadRecap } from "./lib/recap";
import { DurableObject } from "cloudflare:workers";
import { queueDeveloperRole, runDeveloperRoleMaintenance } from "./lib/developer-role";
export { DeveloperRoleSync } from "./lib/developer-role";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppUser, AppVariables, Env } from "./env";
import { computeGameScore } from "./lib/ranking";
import { EMBED_DIALOG_SCRIPT, parseEmbedOptions, renderEmbedDialog, renderEmbedNotFound, renderEmbedPage, type EmbedItem } from "./lib/embed";
import { appOrigin, expandShortPath, isShortHost, SHORT_PATHS, shortOrigin } from "./lib/origins";
import { canonicalizeUrl, normalizeTimeInput, normalizeUrlInput, slugify } from "./lib/url";
import { createSession, destroySession, hashToken, randomToken, requireAuth, requireRole, sessionMiddleware, wantsSecureCookies } from "./lib/auth";
import { ICON_180, ICON_192, ICON_48, ICON_512, OG_IMAGE_PNG } from "./lib/assets";
import { getCachedJson, invalidateGameCaches, secondsUntilNextUtcDay, setCachedJson } from "./lib/cache";
import { CHANGELOG } from "./lib/changelog";
import { fuzzyTitleMatch } from "./lib/search";
import { DuplicateIndex, type DuplicateGame } from "./lib/duplicates";
import { IMPORT_MAX_BYTES, IMPORT_MAX_LINES, matchImportLines, parseImportText } from "./lib/import-match";
import { RESET_SUGGESTION_DAILY_LIMIT, groupSuggestions, resetSuggestionSchema, type OpenSuggestionRow } from "./lib/reset-suggestions";
import { checkClaimToken, claimMetaSnippet, claimNames, newClaimToken } from "./lib/claims";
import { loadStats } from "./lib/stats";
import { barChartSvg, labelDay, loadActivity } from "./lib/activity-stats";
import { DEVELOPER_STATS_CSS, DEVELOPER_STATS_SCRIPT, loadDeveloperStats, renderDeveloperStatsPanel } from "./lib/developer-stats";
import { BROKEN_THRESHOLD, GAP_LIMIT, loadGameHealth } from "./lib/game-health";
import { getLiveStatus, getTwitchAppToken } from "./lib/twitch-live";
import { FANDLE_HARD_MAX_SHOWN, FANDLE_NO_EXPIRY, FANDLE_SETTING_LIMIT_MAX, FANDLE_SETTING_MEMBERSHIP_DAYS, fandleActiveSql, FANDLE_SETTING_MAX_PER_DEVELOPER, FANDLE_SETTING_MAX_SHOWN, FANDLE_MIN_FOLLOW_DAYS, FANDLE_SCOPES, TwitchCheckError, decideFandle, fetchTwitchRelationship, type FandleRelationship } from "./lib/fandles";
import { categoryHue, renderGameOgPng } from "./lib/og";
import { PLAY_SYNC_SCRIPT } from "./lib/play-sync";
import { buildServiceWorker, OFFLINE_SCRIPT } from "./lib/service-worker";
import { PLAY_HISTORY_CSS, PLAY_HISTORY_KEEP_DAYS, PLAY_HISTORY_PAGE_DAYS, PLAY_HISTORY_SCRIPT, recordPlay } from "./lib/play-history";
import { withDbTrace } from "./lib/db-trace";
import { NOW_PLAYING_CSS, NOW_PLAYING_SCRIPT, gameInList, nowPlayingKey, readNowPlaying, resolveNowPlaying } from "./lib/now-playing";
import { PUSH_MAX_PER_USER, isAllowedEndpoint, pendingReminder, pushEnabled, runPushReminders, validTimeZone } from "./lib/push";
import { clearPlays, loadPlays, playsBodySchema, savePlays } from "./lib/user-plays";
import { CSRF_FETCH_SCRIPT, ERROR_REPORT_SCRIPT, LAYOUT_SCRIPT, PAGE_SCRIPTS, SHARED_CSS, registerAsset, serveAsset } from "./lib/static-assets";

type Bindings = Env;

const app = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

// Deployed sites are HTTPS only: plain-HTTP requests are redirected (308 keeps the method for non-GETs), and every
// response carries the standard hardening headers. Local dev runs on plain HTTP, so it's left alone.
app.use("*", async (c, next) => {
  if (!isDevEnv(c.env)) {
    const url = new URL(c.req.url);
    if (url.protocol === "http:") {
      // Built by hand: assigning url.protocol is a no-op in the Workers runtime's legacy URL implementation.
      return c.redirect(`https://${url.host}${url.pathname}${url.search}`, c.req.method === "GET" || c.req.method === "HEAD" ? 301 : 308);
    }
  }
  await next();
  if (!isDevEnv(c.env)) c.header("Strict-Transport-Security", "max-age=31536000");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  if (isEmbedPath(c.req.path)) {
    // The embeddable list widget may be framed by any site.
    c.res.headers.delete("X-Frame-Options");
    c.header("Content-Security-Policy", "frame-ancestors *");
    c.header("X-Robots-Tag", "noindex");
  } else {
    c.header("X-Frame-Options", "DENY");
    // Routes such as the badge SVG set their own policy.
    if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", "frame-ancestors 'none'");
  }
});

// Largest legitimate API body is a favorites import (500 items, roughly 170 KB at the field limits); 256 KB leaves headroom.
// Requests with no Content-Length (chunked) are not measured here.
const MAX_API_BODY_BYTES = 256 * 1024;
app.use("/api/*", async (c, next) => {
  const length = Number(c.req.header("content-length"));
  if (Number.isFinite(length) && length > MAX_API_BODY_BYTES) return c.json({ error: "Request body too large" }, 413);
  await next();
});

// The short host only forwards to APP_URL (expanding short paths), so cookies and sessions live on one host.
app.use("*", async (c, next) => {
  if (!isShortHost(c.env, c.req.url)) return next();
  const url = new URL(c.req.url);
  const status = c.req.method === "GET" || c.req.method === "HEAD" ? 301 : 308;
  return c.redirect(`${appOrigin(c.env)}${expandShortPath(url.pathname)}${url.search}`, status);
});

// Trailing slashes: /games/ redirects to /games (query kept, relative Location).
app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  const url = new URL(c.req.url);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return c.redirect(`${path}${url.search}`, 301);
  }
  return next();
});

// Content-hashed static CSS/JS (see ASSET at the end of the file). Registered before the session, cookie and cache
// middleware on purpose: no D1 lookup, no Set-Cookie (it would make the response uncacheable), no noindex header.
app.get("/assets/:file", (c) => serveAsset(c.req.param("file"), c.req.method));

// Service worker (offline support, src/lib/service-worker.ts). Root scope, always revalidated; never edge-cached.
app.get("/sw.js", (c) => c.body(buildServiceWorker(appVersion(c.env), [ASSET.appJs, ASSET.headJs, ASSET.appCss]), 200, {
  "Content-Type": "text/javascript; charset=utf-8",
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff"
}));

// Session bootstrap for every request.
app.use("*", sessionMiddleware);

// Only production should be indexed; staging and local dev ask crawlers to stay away.
app.use("*", async (c, next) => {
  await next();
  if (c.env.APP_ENV !== "production") {
    c.header("X-Robots-Tag", "noindex, nofollow");
  }
});

// Marks signed-in HTML so the service worker (src/lib/service-worker.ts) saves such pages offline only for /me/rotation.
app.use("*", async (c, next) => {
  await next();
  if (c.get("user") && (c.res.headers.get("Content-Type") ?? "").startsWith("text/html")) c.header("X-Dgl-Signed-In", "1");
});

// Short paths for sharing (no clash with the long routes): /c/<list>, /g/<game>, /r/<rotation token>. Relative
// redirects keep the visitor on the host they used.
for (const [short, long] of SHORT_PATHS) {
  app.get(`/${short}/:id`, (c) => {
    const query = new URL(c.req.url).search;
    return c.redirect(`/${long}/${encodeURIComponent(c.req.param("id"))}${query}`, 301);
  });
}

// Logged-out views of public pages are served from Cloudflare's edge cache for a minute, so they cost no D1 reads.
// Visitors with a session, or who have voted (dgl_voted cookie, set by dglGames.saveVote), get a fresh render that
// shows their own votes. Cached copies never contain cookies; the CSRF cookie is added per response instead.
const PUBLIC_CACHE_SECONDS = 60;
const PUBLIC_CACHE_PATHS = /^\/(games(\/[^/]+)?|lists(\/[^/]+)?|categories(\/[^/]+)?|new|mod-log|changelog|daily|offline|embed\/lists\/[^/]+)?$/;

// The embed widget never shows per-visitor state and sets no cookies, so it is cached whatever cookies the request has.
function isEmbedPath(path: string): boolean {
  return path.startsWith("/embed/");
}

// Query parameters that change a cached page's HTML, per route. Every other parameter (cache busters, utm_*, the
// client-side ones such as ?add, ?view, ?top, ?pos, ?edit on a logged-out list) is dropped from the cache key, so those
// URLs share the plain page's entry. Values are normalized the way the route reads them, so junk values don't make
// new entries. Cached routes: / (importLocal), /games (sort, category, q, hidePaywall, hideNsfw, page),
// /games/:slug, /categories, /new, /changelog, /lists, /offline (none), /categories/:slug and /mod-log (page),
// /daily (before), /lists/:slug (fandle notice), /embed/lists/:slug (theme, limit, title, transparent).
const FANDLE_NOTICE_KEYS = ["joined", "not_following", "too_new", "cancelled", "conflict", "need_claim", "self", "error"];
function pageCacheQuery(path: string, q: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  const get = (name: string) => q.get(name) ?? undefined;
  const page = () => { const n = parsePositiveInt(get("page"), 1); if (n > 1) out.set("page", String(n)); };
  if (path === "/") {
    if (get("importLocal") === "1") out.set("importLocal", "1");
  } else if (path === "/games") {
    const sort = get("sort");
    if (sort && sort !== "top") out.set("sort", sort); // unknown sorts are kept as given: the route may treat them differently from "top"
    for (const name of ["category", "q"]) if (get(name)) out.set(name, get(name)!);
    for (const name of ["hidePaywall", "hideNsfw"]) if (get(name) === "1") out.set(name, "1");
    page();
  } else if (path === "/mod-log" || path.startsWith("/categories/")) {
    page();
  } else if (path === "/daily") {
    const before = get("before") ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(before)) out.set("before", before);
  } else if (path.startsWith("/lists/")) {
    const notice = get("fandle");
    if (notice && FANDLE_NOTICE_KEYS.includes(notice)) out.set("fandle", notice);
  } else if (path.startsWith("/embed/lists/")) {
    const o = parseEmbedOptions((name) => get(name));
    if (o.theme !== "auto") out.set("theme", o.theme);
    if (o.limit !== null) out.set("limit", String(o.limit));
    if (!o.showTitle) out.set("title", "0");
    if (o.transparent) out.set("transparent", "1");
  }
  out.sort();
  return out;
}

app.use("*", async (c, next) => {
  const cacheable =
    c.req.method === "GET" &&
    !isDevEnv(c.env) &&
    PUBLIC_CACHE_PATHS.test(c.req.path) &&
    (isEmbedPath(c.req.path) || (!getCookie(c, c.env.SESSION_COOKIE_NAME) && !getCookie(c, "dgl_voted")));
  c.set("publicCache", cacheable);
  if (!cacheable) {
    await next();
    return;
  }

  // Keyed by deployed version too, so a deploy starts with an empty page cache (pages reloaded by
  // APP_UPDATE_SCRIPT always get the new HTML, never a copy cached by the previous version).
  // A list page's live refresh asks for a unique ?live= to get a fresh render: it neither reads nor writes the cache.
  if (c.req.query("live") !== undefined) {
    await next();
    c.header("Cache-Control", "no-cache");
    c.header("X-Page-Cache", "BYPASS");
    return;
  }
  const cacheUrl = new URL(c.req.url);
  cacheUrl.search = pageCacheQuery(c.req.path, cacheUrl.searchParams).toString();
  cacheUrl.searchParams.set("__v", appVersion(c.env));
  const cacheKey = new Request(cacheUrl.toString());
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const embed = isEmbedPath(c.req.path);
    if (!embed) ensureCsrfCookie(c);
    return c.body(await cached.text(), 200, { "Content-Type": cached.headers.get("Content-Type") ?? "text/html; charset=UTF-8", "Cache-Control": embed ? `public, max-age=${PUBLIC_CACHE_SECONDS}` : "no-cache", "X-Page-Cache": "HIT" });
  }

  await next();
  if (c.res.status === 200 && (c.res.headers.get("Content-Type") ?? "").startsWith("text/html")) {
    const copy = new Response(c.res.clone().body, { headers: { "Content-Type": c.res.headers.get("Content-Type")!, "Cache-Control": `public, max-age=${PUBLIC_CACHE_SECONDS}` } });
    c.executionCtx.waitUntil(caches.default.put(cacheKey, copy));
  }
  // Browsers must revalidate, or a visitor who just voted could be shown their own stale copy.
  c.header("Cache-Control", isEmbedPath(c.req.path) ? `public, max-age=${PUBLIC_CACHE_SECONDS}` : "no-cache");
  c.header("X-Page-Cache", "MISS");
});

// Double-submit-cookie CSRF token for browser API calls.
function ensureCsrfCookie(c: Context<{ Bindings: Bindings; Variables: AppVariables }>): void {
  if (!getCookie(c, "csrf_token")) {
    setCookie(c, "csrf_token", randomToken(), {
      path: "/",
      sameSite: "Lax",
      secure: wantsSecureCookies(c.env),
      httpOnly: false,
      maxAge: 60 * 60 * 24 * 30
    });
  }
}

app.use("*", async (c, next) => {
  if (!isEmbedPath(c.req.path) && !c.req.path.startsWith(EMBED_CLICK_PREFIX) && c.req.path !== CLIENT_ERRORS_PATH) ensureCsrfCookie(c);
  await next();
});

// The embed widget runs in third-party iframes with no site fetch wrapper (and maybe no cookies); this one anonymous,
// rate-limited click endpoint is exempt from CSRF.
const EMBED_CLICK_PREFIX = "/api/embed/click/";
const CLIENT_ERRORS_PATH = "/api/client-errors";

app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS" || c.req.path.startsWith(EMBED_CLICK_PREFIX) || c.req.path === CLIENT_ERRORS_PATH) {
    await next();
    return;
  }
  const cookieToken = getCookie(c, "csrf_token");
  const headerToken = c.req.header("x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return c.json({ error: "Invalid CSRF token" }, 403);
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

// The deployed version, polled by APP_UPDATE_SCRIPT so open pages reload after a deploy.
app.get("/api/version", (c) => c.json({ version: appVersion(c.env) }, 200, { "Cache-Control": "no-store" }));

// Development-only quick role login helper. Besides APP_ENV, the request must arrive on APP_URL's own host, so a
// dev-config build that ends up deployed (e.g. reachable on workers.dev) can never hand out sessions.
function mockAuthAllowed(c: Context<{ Bindings: Bindings; Variables: AppVariables }>): boolean {
  return isDevEnv(c.env) && new URL(c.req.url).hostname === new URL(c.env.APP_URL).hostname;
}

app.get("/auth/mock-login/:role", async (c) => {
  if (!mockAuthAllowed(c)) {
    return c.text("Not found", 404);
  }
  const role = c.req.param("role") as AppUser["role"];
  if (!role || !["user", "editor", "admin"].includes(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }
  const email = `${role}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const userId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO users (id, email, display_name, role) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(userId, email, `${role} user`, role)
    .run();
  await createSession(c, userId);
  return c.redirect("/");
});

// Development-only stand-in for a Discord/Twitch sign-in: runs the same completeOAuth() as the real callbacks with a
// made-up provider account id, to test login, linking (?link=1) and merging locally. Same gate as mock login.
// Development only: stands in for the Twitch follow/sub check on Fan-dles (?followDays=10 and/or ?sub=1).
app.get("/auth/mock-fandle/:slug", async (c) => {
  const user = c.get("user");
  if (!mockAuthAllowed(c) || !user) {
    return c.text("Not found", 404);
  }
  const slug = c.req.param("slug");
  const list = await getFandleList(c.env, slug);
  if (!list) return c.text("Not found", 404);
  const days = Number(c.req.query("followDays") ?? "");
  const rel: FandleRelationship = {
    followedAt: Number.isFinite(days) && c.req.query("followDays") !== undefined ? new Date(Date.now() - days * 86_400_000).toISOString() : null,
    subscribed: c.req.query("sub") === "1"
  };
  return c.redirect(`/lists/${encodeURIComponent(slug)}?fandle=${(await applyFandleResult(c.env, list, user.id, rel)).code}`);
});

app.get("/auth/mock-oauth/:provider/:providerUserId", async (c) => {
  const provider = c.req.param("provider");
  if (!mockAuthAllowed(c) || (provider !== "discord" && provider !== "twitch")) {
    return c.text("Not found", 404);
  }
  const role = c.req.query("role");
  return completeOAuth(
    c,
    {
      provider,
      providerUserId: c.req.param("providerUserId"),
      displayName: `${provider} ${c.req.param("providerUserId")}`,
      role: provider === "discord" ? (role === "admin" || role === "editor" ? role : "user") : undefined,
      avatarUrl: c.req.query("avatar") ?? null,
      // Development only: ?creator=affiliate|partner and ?login=<channel> stand in for Twitch's profile fields.
      twitchLogin: provider === "twitch" ? c.req.query("login") ?? `mock${c.req.param("providerUserId")}` : null,
      creatorType: provider === "twitch" ? (c.req.query("creator") === "partner" ? "partner" : c.req.query("creator") === "affiliate" ? "affiliate" : null) : null
    },
    c.req.query("link") === "1",
    c.req.query("next")
  );
});

// Discord OAuth. Scopes: identify (user id + name) and guilds.members.read (roles in our guild, for editor/admin).
app.get("/auth/discord", (c) => {
  if (!c.env.OAUTH_DISCORD_CLIENT_ID) {
    return c.text("Discord OAuth not configured", 501);
  }
  return beginOAuth(c, "discord", "login");
});

app.get("/auth/discord/callback", async (c) => {
  const callback = readOAuthCallback(c, "discord");
  if (callback instanceof Response) {
    return callback;
  }
  const { code, link } = callback;
  if (!c.env.OAUTH_DISCORD_CLIENT_ID || !c.env.OAUTH_DISCORD_CLIENT_SECRET) {
    return c.text("Discord OAuth not configured", 501);
  }
  if (!c.env.DISCORD_GUILD_ID) {
    return c.text("Discord guild not configured", 501);
  }

  const accessToken = await exchangeOAuthCode(c, "discord", "https://discord.com/api/oauth2/token", c.env.OAUTH_DISCORD_CLIENT_ID, c.env.OAUTH_DISCORD_CLIENT_SECRET, code);
  if (accessToken instanceof Response) {
    return accessToken;
  }
  try {
    const authHeaders = { Authorization: `Bearer ${accessToken}` };
    const userRes = await fetch("https://discord.com/api/users/@me", { headers: authHeaders });
    const discordUser = userRes.ok ? ((await userRes.json()) as { id?: string; username?: string | null; global_name?: string | null; avatar?: string | null }) : null;
    if (!discordUser?.id) {
      return c.text("OAuth profile fetch failed", 400);
    }

    // Role mirrors the user's current guild roles on every login, so removing a Discord role also revokes
    // editor/admin here. Not being in the guild (or Discord failing to answer) means a plain user.
    const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${c.env.DISCORD_GUILD_ID}/member`, { headers: authHeaders });
    const memberRoles = memberRes.ok ? ((await memberRes.json()) as { roles?: string[] }).roles ?? [] : [];
    const role: AppUser["role"] =
      c.env.DISCORD_ROLE_ADMIN && memberRoles.includes(c.env.DISCORD_ROLE_ADMIN)
        ? "admin"
        : c.env.DISCORD_ROLE_EDITOR && memberRoles.includes(c.env.DISCORD_ROLE_EDITOR)
          ? "editor"
          : "user";

    return await completeOAuth(
      c,
      {
        provider: "discord",
        providerUserId: discordUser.id,
        displayName: discordUser.username || discordUser.global_name || null,
        role,
        avatarUrl: discordUser.avatar ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128` : null
      },
      link
    );
  } finally {
    revokeOAuthToken(c, "discord", accessToken);
  }
});

// Twitch OAuth. Requests no scopes, so Twitch never shares the user's email; role is always "user".
app.get("/auth/twitch", (c) => {
  if (!c.env.OAUTH_TWITCH_CLIENT_ID) {
    return c.text("Twitch OAuth not configured", 501);
  }
  return beginOAuth(c, "twitch", "login");
});

// Link another sign-in provider to the signed-in account (Settings). POST, so other sites can't start it: the
// SameSite=Lax session cookie isn't sent on cross-site POSTs, which lands them on the login page instead.
app.post("/auth/:provider/link", (c) => {
  const provider = c.req.param("provider");
  if (provider !== "discord" && provider !== "twitch") {
    return c.text("Not found", 404);
  }
  if (!c.get("user")) {
    return c.redirect("/login");
  }
  if (!oauthClientId(c.env, provider)) {
    return c.text("OAuth not configured", 501);
  }
  return beginOAuth(c, provider, "link");
});

// Fan-dles: a verified developer proves they follow or subscribe to a streamer, so their games show in that streamer's
// Fan-dles. This is the only place Twitch is asked for scopes (follows and subscriptions); ordinary sign-ins ask for none.
// POST, so other sites can't start it. The token is used once for the check and revoked right after.
app.post("/auth/twitch/fandle", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.redirect("/login");
  }
  if (!c.env.OAUTH_TWITCH_CLIENT_ID) {
    return c.text("Twitch OAuth not configured", 501);
  }
  const slug = String((await c.req.parseBody().catch(() => ({})) as Record<string, unknown>).list ?? "");
  const list = await getFandleList(c.env, slug);
  const back = (code: string) => c.redirect(`/lists/${encodeURIComponent(slug)}?fandle=${code}`);
  if (!list) return notFoundPage(c);
  // Only the streamer's own list counts as "yours": an editor-made list is owned by an editor, not by the streamer.
  if (list.kind === "creator" && list.owner_user_id === user.id) return back("self");
  if (!(await hasVerifiedClaim(c.env, user.id))) return back("need_claim");
  setCookie(c, "fandle_list", list.slug, { path: "/", httpOnly: true, sameSite: "Lax", secure: wantsSecureCookies(c.env), maxAge: 600 });
  return beginOAuth(c, "twitch", "fandle", FANDLE_SCOPES);
});

/**
 * SQL for "this list belongs to a verified creator" (needs `curated_lists` and `users` joined on the owner): a creator's
 * own list, or an editor-tagged list for a Twitch channel an admin has verified by username who hasn't got a list of
 * their own yet. The second case is what lets a streamer count as verified before they ever sign in.
 */
const VERIFIED_LIST_SQL = `(
  (curated_lists.kind = 'creator' AND users.creator_type IS NOT NULL)
  OR (curated_lists.kind = 'curated' AND curated_lists.twitch_user_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM creator_allowlist WHERE creator_allowlist.twitch_user_id = curated_lists.twitch_user_id)
      AND NOT EXISTS (SELECT 1 FROM curated_lists own WHERE own.kind = 'creator' AND own.twitch_user_id = curated_lists.twitch_user_id))
)`;

type FandleList = { id: string; slug: string; owner_user_id: string; kind: string; twitch_user_id: string };

/** A creator list that takes Fan-dles: public, tagged with a Twitch channel, and with Fan-dles switched on. */
async function getFandleList(env: Env, slug: string): Promise<FandleList | null> {
  return env.DB.prepare(
    `SELECT curated_lists.id, curated_lists.slug, curated_lists.owner_user_id, curated_lists.kind, curated_lists.twitch_user_id
     FROM curated_lists LEFT JOIN users ON users.id = curated_lists.owner_user_id
     WHERE curated_lists.slug = ?1 AND ${VERIFIED_LIST_SQL}
       AND curated_lists.visibility = 'public' AND curated_lists.twitch_user_id IS NOT NULL AND curated_lists.fandles_enabled = 1`
  )
    .bind(slug)
    .first<FandleList>();
}

async function hasVerifiedClaim(env: Env, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS ok FROM game_claims WHERE user_id = ?1 AND status = 'verified' LIMIT 1").bind(userId).first());
}

/**
 * Turns a Twitch relationship into Fan-dles membership. Returns the code shown on the list page: "joined" (follow or
 * sub), "not_following", "too_new" (followed under a week ago), or "error".
 */
async function applyFandleResult(env: Env, list: FandleList, userId: string, rel: FandleRelationship): Promise<{ code: string; source?: string }> {
  const decision = decideFandle(rel);
  if (!decision.ok) {
    return { code: decision.reason };
  }
  await env.DB.prepare(
    `INSERT INTO fandle_members (list_id, user_id, source, followed_at, verified_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'), ?5)
     ON CONFLICT (list_id, user_id) DO UPDATE SET source = excluded.source, followed_at = excluded.followed_at,
       verified_at = excluded.verified_at, expires_at = excluded.expires_at`
  )
    .bind(list.id, userId, decision.source, rel.followedAt, FANDLE_NO_EXPIRY)
    .run();
  await writeAudit(env, userId, "list", list.id, "fandle_join", { source: decision.source });
  await invalidateGameCaches(env);
  return { code: "joined", source: decision.source };
}

async function completeFandleVerification(
  c: Context<{ Bindings: Bindings; Variables: AppVariables }>,
  accessToken: string,
  twitchUser: { id: string; login?: string; display_name?: string; profile_image_url?: string; broadcaster_type?: string }
): Promise<Response> {
  const slug = getCookie(c, "fandle_list") ?? "";
  deleteCookie(c, "fandle_list", { path: "/" });
  const user = c.get("user");
  if (!user || !slug) {
    return c.redirect(user ? "/" : "/login");
  }
  const back = (code: string) => c.redirect(`/lists/${encodeURIComponent(slug)}?fandle=${code}`);
  const list = await getFandleList(c.env, slug);
  if (!list) return back("error");
  if ((list.kind === "creator" && list.owner_user_id === user.id) || twitchUser.id === list.twitch_user_id) return back("self");
  // The Twitch account used has to be this account's: link it if it isn't yet (as Settings would), refuse a clash.
  const linked = await linkOAuthAccount(c.env, user.id, {
    provider: "twitch",
    providerUserId: twitchUser.id,
    displayName: twitchUser.display_name || twitchUser.login || null,
    avatarUrl: twitchUser.profile_image_url ?? null,
    twitchLogin: twitchUser.login ?? null,
    creatorType: twitchUser.broadcaster_type === "partner" ? "partner" : twitchUser.broadcaster_type === "affiliate" ? "affiliate" : null
  });
  if (linked === "conflict") return back("conflict");
  try {
    const rel = await fetchTwitchRelationship(c.env.OAUTH_TWITCH_CLIENT_ID!, accessToken, twitchUser.id, list.twitch_user_id);
    return back((await applyFandleResult(c.env, list, user.id, rel)).code);
  } catch (error) {
    if (error instanceof TwitchCheckError) return back("error");
    throw error;
  }
}

app.get("/auth/twitch/callback", async (c) => {
  const callback = readOAuthCallback(c, "twitch");
  if (callback instanceof Response) {
    return callback;
  }
  const { code, link, fandle } = callback;
  if (!c.env.OAUTH_TWITCH_CLIENT_ID || !c.env.OAUTH_TWITCH_CLIENT_SECRET) {
    return c.text("Twitch OAuth not configured", 501);
  }

  const accessToken = await exchangeOAuthCode(c, "twitch", "https://id.twitch.tv/oauth2/token", c.env.OAUTH_TWITCH_CLIENT_ID, c.env.OAUTH_TWITCH_CLIENT_SECRET, code);
  if (accessToken instanceof Response) {
    return accessToken;
  }
  try {
    const userRes = await fetch("https://api.twitch.tv/helix/users", {
      headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": c.env.OAUTH_TWITCH_CLIENT_ID }
    });
    const twitchUser = userRes.ok
      ? ((await userRes.json()) as { data?: Array<{ id: string; login?: string; display_name?: string; profile_image_url?: string; broadcaster_type?: string }> }).data?.[0]
      : undefined;
    if (!twitchUser?.id) {
      return c.text("OAuth profile fetch failed", 400);
    }

    if (fandle) {
      return await completeFandleVerification(c, accessToken, twitchUser);
    }

    return await completeOAuth(
      c,
      {
        provider: "twitch",
        providerUserId: twitchUser.id,
        displayName: twitchUser.display_name || twitchUser.login || null,
        avatarUrl: twitchUser.profile_image_url ?? null,
        twitchLogin: twitchUser.login ?? null,
        creatorType: twitchUser.broadcaster_type === "partner" ? "partner" : twitchUser.broadcaster_type === "affiliate" ? "affiliate" : null
      },
      link
    );
  } finally {
    revokeOAuthToken(c, "twitch", accessToken);
  }
});

// POST so other sites can't log people out with a link or image; the SameSite=Lax session cookie is not sent on cross-site POSTs.
app.post("/auth/logout", async (c) => {
  await destroySession(c);
  return c.redirect("/");
});

app.get("/login", async (c) => {
  const user = c.get("user");
  if (user) {
    return c.redirect("/");
  }

  return c.html(await layout("Login", null, `
    <style>
      html, body { height: 100%; overflow: hidden; }
      body { height: 100dvh; display: flex; flex-direction: column; }
      body > main { flex: 1; min-height: 0; max-width: none; width: 100%; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; }
      body > footer { margin-top: 0 !important; padding: 1rem !important; }
    </style>
    <main>
      <div style="display:flex;flex-direction:column;gap:0.75rem;align-items:stretch;">
          <h1 style="margin:0;font-size:1.5rem;text-align:center;">Log in</h1>
          <p style="max-width:22rem;margin:0 0 0.25rem;text-align:center;">Sign in to keep your rotation on every device, submit games and claim ones you made.</p>
          <a class="btn" href="/auth/discord" style="background:#5865F2;border-color:#5865F2;color:#fff;display:inline-flex;align-items:center;justify-content:flex-start;gap:0.5rem;text-decoration:none;">
            ${DISCORD_ICON_SVG}
            Login using Discord
          </a>
          ${c.env.OAUTH_TWITCH_CLIENT_ID ? `<a class="btn" href="/auth/twitch" style="background:#9146FF;border-color:#9146FF;color:#fff;display:inline-flex;align-items:center;justify-content:flex-start;gap:0.5rem;text-decoration:none;">
            ${TWITCH_ICON_SVG}
            Login using Twitch
          </a>` : ""}
          <p style="max-width:22rem;margin:0.5rem 0 0;font-size:0.85rem;text-align:center;">We only receive your account ID and username (and, for Discord, your roles in our server). We never see your password or email, and we don't keep access to your account after you sign in.</p>
      </div>
    </main>
  `, c.env, { path: "/login", description: "Sign in to 0x9 dles to save your rotation and manage curated lists." }));
});
// Game of the day: one game per UTC date, the same for every visitor. Picked from well-liked games (or the top 50 by
// score when too few qualify), skipping the picks of the previous 14 dates. The pick is cached in KV until the next
// UTC midnight under its own key (not games:, so catalogue edits don't reshuffle the day).
const GOTD_MIN_VOTES = 5;
const GOTD_MIN_POOL = 10;
const GOTD_FALLBACK_POOL = 50;
const GOTD_REPEAT_DAYS = 14;

type GameOfTheDay = {
  id: string;
  slug: string;
  url: string;
  title: string;
  description: string | null;
  vote_up_count: number;
  vote_down_count: number;
  paywall: number;
  categories: Array<{ slug: string; name: string }>;
};

function utcDateKey(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

// FNV-1a: a stable 32-bit hash of a date key.
function dateHash(dateKey: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < dateKey.length; i++) {
    hash = Math.imul(hash ^ dateKey.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash;
}

function gameOfTheDayIndex(dateKey: string, poolSize: number): number {
  const dayMs = 86_400_000;
  const today = Date.parse(`${dateKey}T00:00:00Z`);
  const recent = new Set<number>();
  for (let back = 1; back <= GOTD_REPEAT_DAYS; back++) {
    recent.add(dateHash(utcDateKey(today - back * dayMs)) % poolSize);
  }
  let index = dateHash(dateKey) % poolSize;
  // Step past indices the recent days would have used, as long as the pool has an unused one.
  if (recent.size < poolSize) {
    while (recent.has(index)) index = (index + 1) % poolSize;
  }
  return index;
}

async function gameOfTheDayPool(env: Env): Promise<string[]> {
  const qualified = await env.DB.prepare(
    `SELECT id FROM games
     WHERE status = 'approved' AND nsfw = 0
       AND vote_up_count + vote_down_count >= ?1
       AND vote_up_count * 10 >= (vote_up_count + vote_down_count) * 7
     ORDER BY id`
  )
    .bind(GOTD_MIN_VOTES)
    .all<{ id: string }>();
  if (qualified.results.length >= GOTD_MIN_POOL) {
    return qualified.results.map((row) => row.id);
  }
  const top = await env.DB.prepare(
    `SELECT id FROM (SELECT id FROM games WHERE status = 'approved' AND nsfw = 0 ORDER BY score DESC, vote_up_count DESC, id LIMIT ?1)
     ORDER BY id`
  )
    .bind(GOTD_FALLBACK_POOL)
    .all<{ id: string }>();
  return top.results.map((row) => row.id);
}

async function loadGameOfTheDay(env: Env, id: string): Promise<GameOfTheDay | null> {
  const game = await env.DB.prepare(
    `SELECT id, slug, url, title, description, vote_up_count, vote_down_count, paywall
     FROM games WHERE id = ?1 AND status = 'approved' AND nsfw = 0`
  )
    .bind(id)
    .first<Omit<GameOfTheDay, "categories">>();
  if (!game) {
    return null;
  }
  const categories = await getCategoriesForGames(env, [id]);
  return { ...game, categories: categories.get(id) ?? [] };
}

/** The game of the day for the UTC date of `now`, or null when no game is listed. */
async function getGameOfTheDay(env: Env, now: number = Date.now()): Promise<GameOfTheDay | null> {
  const dateKey = utcDateKey(now);
  const cacheKey = `gotd:v1:${dateKey}`;
  const cachedId = await getCachedJson<string>(env, cacheKey);
  const cached = cachedId ? await loadGameOfTheDay(env, cachedId) : null;
  if (cached) {
    return cached;
  }
  // The stored pick wins; it is written once (insert-or-ignore) so later pool changes never alter a day.
  let id = (await env.DB.prepare("SELECT game_id FROM daily_picks WHERE day = ?1").bind(dateKey).first<{ game_id: string }>())?.game_id;
  if (!id) {
    const pool = await gameOfTheDayPool(env);
    if (pool.length === 0) {
      return null;
    }
    id = pool[gameOfTheDayIndex(dateKey, pool.length)];
    await env.DB.prepare("INSERT OR IGNORE INTO daily_picks (day, game_id, picked_at) VALUES (?1, ?2, ?3)")
      .bind(dateKey, id, new Date(now).toISOString())
      .run();
    id = (await env.DB.prepare("SELECT game_id FROM daily_picks WHERE day = ?1").bind(dateKey).first<{ game_id: string }>())?.game_id ?? id;
  }
  await setCachedJson(env, cacheKey, id, secondsUntilNextUtcDay(now));
  return loadGameOfTheDay(env, id);
}

function gameOfTheDaySnippet(description: string | null): string {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  return text.length <= 140 ? text : `${text.slice(0, 139).trimEnd()}…`;
}

function renderGameOfTheDay(game: GameOfTheDay): string {
  const snippet = gameOfTheDaySnippet(game.description);
  return `<section class="game-of-the-day" aria-labelledby="game-of-the-day-title" data-vote-counts="${escapeHtml(game.id)}">
        <p class="gotd-kicker">Game of the day</p>
        <h2 id="game-of-the-day-title" class="gotd-title"><a href="/games/${encodeURIComponent(game.slug)}">${escapeHtml(game.title)}</a>${game.paywall ? ` <span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}</h2>
        ${snippet ? `<p class="gotd-desc">${escapeHtml(snippet)}</p>` : ""}
        ${renderCategoryPills(game.categories)}
        <div class="gotd-foot">
          <div class="meta gotd-meta">${renderLikedLabel(game.vote_up_count, game.vote_down_count)}</div>
          <a class="btn btn-play gotd-play" href="${escapeHtml(game.url)}" target="_blank" rel="noopener noreferrer" data-play-id="${escapeHtml(game.id)}">Play<span class="visually-hidden"> ${escapeHtml(game.title)}</span> ↗</a>
          <a class="gotd-past" href="/daily">Past picks</a>
        </div>
      </section>`;
}

app.get("/", async (c) => {
  const user = c.get("user");
  const shouldPromptImport = c.req.query("importLocal") === "1";
  // 8 per list for the two-column desktop layout; narrower screens show the first 5 (see .home-columns CSS).
  const famousTitles = ["NYT Wordle", "NYT Connections", "NYT Strands", "Worldle", "Globle", "Bandle", "Framed", "Costcodle"];
  // Independent reads run together; the viewer's votes and favorites follow once the game ids are known.
  const [[topGames, newGames, popularGames], playableRow, famousRows, homeCategoryRows, gameOfTheDay] = await Promise.all([
    listGamesMany(c.env, [
      { sort: "top", limit: 8 },
      { sort: "new", limit: 8 },
      { sort: "popular", limit: 8, openedThisWeek: true }
    ]),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'approved'").first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT slug, title FROM games WHERE status = 'approved' AND title IN (${famousTitles.map((_, i) => `?${i + 1}`).join(",")})`
    ).bind(...famousTitles).all<{ slug: string; title: string }>(),
    c.env.DB.prepare(
      `SELECT categories.slug, categories.name, COUNT(*) AS n
       FROM categories
       JOIN game_categories ON game_categories.category_id = categories.id
       JOIN games ON games.id = game_categories.game_id AND games.status = 'approved'
       WHERE categories.is_active = 1
       GROUP BY categories.id
       ORDER BY n DESC, categories.name ASC`
    ).all<{ slug: string; name: string; n: number }>(),
    getGameOfTheDay(c.env)
  ]);
  const topGameIds = topGames.map((game) => game.id);
  const newGameIds = newGames.map((game) => game.id);
  const { votes: userVotes, favorites: userFavorites } = await getViewerGameState(c, [...new Set([...topGameIds, ...newGameIds, ...popularGames.map((game) => game.id)])]);
  const playableCount = playableRow?.n ?? 0;
  // For the title, description and "What is a dle?": a rounded-down count ("800+") and well-known games people search
  // for, linked only when they're listed.
  const roundedCount = playableCount >= 100 ? `${Math.floor(playableCount / 100) * 100}+` : String(playableCount);
  const famousGames = famousRows.results
    .sort((a, b) => famousTitles.indexOf(a.title) - famousTitles.indexOf(b.title));
  const famousGamesMarkup = famousGames.map((game) => `<a href="/games/${escapeHtml(game.slug)}">${escapeHtml(game.title.replace(/^NYT /, ""))}</a>`);
  const homeCategories = homeCategoryRows.results;

  const topGamesMarkup = renderCompactGameList(topGames, user, userVotes, userFavorites, { hideable: true });
  const newGamesMarkup = renderCompactGameList(newGames, user, userVotes, userFavorites, { hideable: true });
  const popularMarkup = popularGames.length >= 3
    ? `<section class="popular-week" aria-labelledby="popular-week-title">
        <h2 id="popular-week-title">Popular this week</h2>
        ${renderCompactGameList(popularGames, user, userVotes, userFavorites, { hideable: true })}
        <p><a href="/games?sort=popular">See more popular games</a></p>
      </section>`
    : "";
  return c.html(await layout(`0x9 dles – ${roundedCount} Free Daily Games like Wordle & Connections`, user, `
    <main>
      ${user ? "" : `<p class="intro" id="home-intro">0x9 dles collects the best daily games, the Wordle-style puzzles that reset every day. Vote, favorite and build your own daily rotation, no account needed.</p>
      <script>
        // Returning visitors (anyone who has favorited or voted) don't need the introduction.
        if (window.dglGames.isReturningVisitor()) document.getElementById("home-intro").hidden = true;
      </script>`}
      <h1 class="game-count"><strong data-count-up="${playableCount}">${playableCount.toLocaleString("en-US")}</strong> daily games to play</h1>
      <script>
        // Count up to the total once on load (skipped for reduced motion); the server-rendered number is the fallback.
        (() => {
          const el = document.querySelector("[data-count-up]");
          const target = Number(el?.getAttribute("data-count-up"));
          if (!el || !target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
          const start = performance.now();
          const tick = (now) => {
            const progress = Math.min(1, (now - start) / 900);
            el.textContent = Math.round(target * (1 - Math.pow(1 - progress, 3))).toLocaleString("en-US");
            if (progress < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })();
      </script>
      ${HOME_ROTATION_MARKUP}
      ${gameOfTheDay ? renderGameOfTheDay(gameOfTheDay) : ""}
      ${popularMarkup}
      <section class="new-in-cats" id="new-in-cats" aria-labelledby="new-in-cats-title" hidden>
        <h2 id="new-in-cats-title">New in your categories</h2>
        <ul class="games compact" id="new-in-cats-list"></ul>
      </section>
      <div class="actions home-actions">
        <a class="btn" href="/games">Browse games</a>
        <button type="button" class="btn" id="feeling-auspicious-btn">Feeling auspicious?</button>
      </div>
      ${
        user
          ? `<section id="local-favorites-import-panel" class="panel" ${shouldPromptImport ? "" : "hidden"}>
               <h2>Import local favorites</h2>
               <p id="local-favorites-import-summary">Checking this browser for saved favorites...</p>
               <div class="actions">
                 <button type="button" id="local-favorites-import-btn">Import to account</button>
                 <button type="button" id="local-favorites-import-dismiss">Not now</button>
               </div>
               <p id="local-favorites-import-status" class="status" aria-live="polite"></p>
             </section>`
          : ""
      }
      <section id="live-now" class="live-now" data-live-home hidden aria-labelledby="live-now-h"><h2 id="live-now-h">Live now</h2><ul class="live-now-list"></ul></section>
      <div class="home-columns">
        <section>
          <h2>Popular Today</h2>
          ${topGamesMarkup}
        </section>
        <section>
          <h2>Newly Added</h2>
          <p class="feed-link"><a href="/new">All new games</a> · <a href="/feed.xml" type="application/atom+xml">Feed</a></p>
          ${newGamesMarkup}
        </section>
      </div>
      <section class="about">
        <h2>About 0x9 dles</h2>
        <p>0x9 dles is a free, community-run directory of ${playableCount.toLocaleString("en-US")} daily games. It keeps them all in one place so you can find the ones worth playing and build a daily routine around them.</p>
        <h3>What is a dle?</h3>
        <p>A daily game, or "dle", is a short puzzle that resets once a day with the same challenge for every player, so you can compare results with friends. Wordle started the trend, and the name stuck: many of them end in "-dle". There are now hundreds, covering words, geography, movies, music, logic, math and more. Nearly all are free to play in your browser, with no account or download.</p>
        ${famousGamesMarkup.length > 0 ? `<p>Popular ones include ${famousGamesMarkup.length > 1 ? `${famousGamesMarkup.slice(0, -1).join(", ")} and ${famousGamesMarkup[famousGamesMarkup.length - 1]}` : famousGamesMarkup[0]}.</p>` : ""}
        ${homeCategories.length > 0 ? `<h3>Browse by category</h3>
        <ul class="about-categories">${homeCategories.map((cat) => `<li>${renderCategoryPill(cat, cat.n)}</li>`).join("")}</ul>` : ""}
        <h3>How games are ranked</h3>
        <p>Every game has a community score based on up and down votes, so a game with a few votes can't outrank one that many people like. Newer games get a small freshness boost, and games that are frequently reported or whose links stop working are ranked lower. Anyone can vote, with or without an account.</p>
        <h3>Build your daily rotation</h3>
        <p>Favorite the games you play and arrange them into a personal rotation, in your own order and even by weekday. Without an account, your favorites are stored in your browser. Sign in with Discord or Twitch to keep them across devices, and export or import your rotation as a file whenever you like.</p>
        <h3>Find something new</h3>
        <p>Browse the <a href="/games">full game list</a>, filter by category, or explore <a href="/lists">curated lists</a> put together by our editors. Some games are marked <span class="paywall-badge" title="This game requires payment to play">$</span> if they require payment, and NSFW games are labelled. Know a daily we're missing? <a href="/submit">Submit it</a> and, once reviewed, it will show up in the directory.</p>
      </section>
    </main>
    <script src="${ASSET.liveBadgesJs}"></script>
    <script src="${ASSET.page_home_strip}"></script>
    <script src="${ASSET.page_home_new_cats}"></script>
    ${renderGameListInteractionScript({ includeImportPanel: !!user, promptFromQuery: shouldPromptImport })}
  `, c.env, { path: "/", description: `${roundedCount} free daily games like Wordle, Connections, Worldle and Bandle in one place: word, geography, music, trivia and logic puzzles. Vote, favorite and build your daily rotation.` }));
});

app.get("/submit", async (c) => {
  const user = c.get("user");

  const categories = await c.env.DB.prepare("SELECT slug, name FROM categories WHERE is_active = 1 ORDER BY name ASC").all<{
    slug: string;
    name: string;
  }>();

  return c.html(await layout("Submit a Daily Game", user, `
    <main class="narrow">
      <h1>Submit a Daily Game</h1>
      <p>${user && (user.role === "editor" || user.role === "admin") ? "As an editor, your submission is published straight away." : "An editor reviews every submission before it appears. Signed in? You can still see your pending game and claim it if you made it."}</p>
      <section class="panel">
        <form id="submission-form" class="stack-form">
          <label>Game title
            <input type="text" name="title" placeholder="e.g. Wordle" required />
          </label>
          <label>Game URL
            <input type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" name="url" placeholder="example.com/game" required />
          </label>
          <label>Why it is good <small>(optional)</small>
            <textarea name="description" placeholder="A sentence on what makes it worth playing" rows="3"></textarea>
          </label>
          <label>How to play <small>(optional)</small>
            <textarea name="howToPlay" rows="4" maxlength="2000" placeholder="A few lines on the rules, e.g. You get six guesses. Tiles show which letters are right."></textarea>
          </label>
          <fieldset>
            <legend>Suggested categories</legend>
            <div class="check-grid">
            ${categories.results
              .map(
                (cat) =>
                  `<label class="check"><input type="checkbox" name="categories" value="${escapeHtml(cat.slug)}" /> ${escapeHtml(cat.name)}</label>`
              )
              .join("")}
            </div>
          </fieldset>
          <fieldset>
            <legend>Reset timing (optional)</legend>
            <div data-reset-group class="reset-grid">
            <label>Time basis
              <select name="resetBasis" data-basis-select>
                <option value="">Unknown</option>
                <option value="local">Local time</option>
                <option value="server">Server time</option>
              </select>
            </label>
            <label>Reset time
              <input type="time" name="resetTime" />
            </label>
            ${renderTimeZoneField("resetTimezone", null)}
            </div>
          </fieldset>
          <label class="check"><input type="checkbox" name="paywall" value="1" /> This game is paywalled</label>
          <label class="check"><input type="checkbox" name="nsfw" value="1" /> This game is NSFW</label>
          <fieldset>
            <legend>Did you make this game?</legend>
            <label class="check"><input type="radio" name="isDeveloper" value="no" /> No</label>
            <label class="check"><input type="radio" name="isDeveloper" value="yes" /> Yes, I'm the developer</label>
            <div id="dev-yes-note" hidden>
              ${user
                ? `<p>You'll get a verified developer badge once you prove it. After you submit, you add a small tag to your game's page, or ask an editor to confirm it another way. You can then edit the game's details yourself.</p>`
                : `<p>Sign in to get the verified developer badge for this game. We'll bring you back here with your answers saved.</p>
                   <div class="actions">
                     <a class="btn btn-discord" href="/auth/discord?next=/submit" data-save-draft>${DISCORD_ICON_SVG} Sign in with Discord</a>
                     ${c.env.OAUTH_TWITCH_CLIENT_ID ? `<a class="btn btn-twitch" href="/auth/twitch?next=/submit" data-save-draft>${TWITCH_ICON_SVG} Sign in with Twitch</a>` : ""}
                   </div>
                   <p>Or submit without signing in. The game will be listed, but not verified.</p>`}
            </div>
          </fieldset>
          <div id="duplicate-notice" class="duplicate-warning" aria-live="polite" hidden></div>
          <button type="submit" class="btn">Submit for review</button>
        </form>
        <p id="submission-status" class="status" aria-live="polite"></p>
      </section>
    </main>
    <script type="application/json" id="data-submit-page">${scriptJson({ signedIn: !!user })}</script>
    <script src="${ASSET.page_submit_page}"></script>
  `, c.env, { path: "/submit", description: "Submit a daily game for the community to discover." }));
});

const MOD_LOG_LABELS: Record<string, string> = {
  approve: "Approved",
  reject: "Denied",
  disable: "Hidden",
  restore: "Restored",
  delete: "Deleted",
  nsfw_add: "Marked NSFW",
  nsfw_remove: "NSFW label removed",
  paywall_add: "Marked as paywalled",
  paywall_remove: "Paywall label removed",
  developer_verified: "Developer verified",
  developer_removed: "Developer verification removed",
  reset_update: "Reset time updated"
};

app.get("/mod-log", async (c) => {
  const user = c.get("user");
  const page = Math.max(1, parsePositiveInt(c.req.query("page"), 1));
  const perPage = 50;
  const showActor = !!user && (user.role === "editor" || user.role === "admin");
  const actions = Object.keys(MOD_LOG_LABELS);
  // actor_name is only selected for editors/admins; it is never sent to anyone else.
  const rows = await c.env.DB.prepare(
    `SELECT audit_log.id, audit_log.action, audit_log.created_at,
            COALESCE(json_extract(audit_log.metadata_json, '$.title'), games.title, '(deleted game)') AS game_title,
            COALESCE(json_extract(audit_log.metadata_json, '$.slug'), games.slug) AS game_slug,
            games.status AS current_status,
            ${showActor ? "users.display_name" : "NULL"} AS actor_name
     FROM audit_log
     LEFT JOIN games ON games.id = audit_log.entity_id
     ${showActor ? "LEFT JOIN users ON users.id = audit_log.actor_user_id" : ""}
     WHERE audit_log.entity_type = 'game' AND audit_log.entity_id != 'bulk'
       AND audit_log.action IN (${actions.map((_, i) => `?${i + 3}`).join(",")})
     ORDER BY audit_log.created_at DESC, audit_log.rowid DESC
     LIMIT ?1 OFFSET ?2`
  )
    .bind(perPage + 1, (page - 1) * perPage, ...actions)
    .all<{ id: string; game_title: string; game_slug: string | null; action: string; created_at: string; current_status: string | null; actor_name: string | null }>();
  const hasNext = rows.results.length > perPage;
  const entries = rows.results.slice(0, perPage);
  const pager = page > 1 || hasNext
    ? `<div class="pagination">
         ${page > 1 ? `<a href="/mod-log?page=${page - 1}">&larr; Newer</a>` : ""}
         <span>Page ${page}</span>
         ${hasNext ? `<a href="/mod-log?page=${page + 1}">Older &rarr;</a>` : ""}
       </div>`
    : "";
  return c.html(await layout("Mod Log | 0x9 dles", user, `
    <main class="narrow">
      <h1>Mod Log</h1>
      <p>A public record of games being approved, denied, hidden, restored, or deleted, and of NSFW and paywall label changes and developer verifications. Newest first.${showActor ? " <em>Editors and admins can also see who made each change.</em>" : ""}</p>
      ${entries.length === 0 ? "<p>Nothing has been logged yet.</p>" : `<ul class="games">
        ${entries
          .map((entry) => {
            const title = entry.current_status === "approved" && entry.game_slug
              ? `<a href="/games/${escapeHtml(entry.game_slug)}">${escapeHtml(entry.game_title)}</a>`
              : escapeHtml(entry.game_title);
            const iso = entry.created_at.replace(" ", "T") + "Z";
            return `<li><strong>${escapeHtml(MOD_LOG_LABELS[entry.action] || entry.action)}</strong>: ${title} <small><time datetime="${escapeHtml(iso)}" data-mod-time>${escapeHtml(entry.created_at)} UTC</time>${showActor ? ` · by ${escapeHtml(entry.actor_name || "unknown")}` : ""}</small></li>`;
          })
          .join("")}
      </ul>`}
      ${pager}
    </main>
    <script>
      document.querySelectorAll("[data-mod-time]").forEach((el) => {
        const d = new Date(el.getAttribute("datetime"));
        if (!Number.isNaN(d.getTime())) el.textContent = d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      });
    </script>
  `, c.env, { path: "/mod-log", description: "A public log of moderation changes to games on 0x9 dles." }));
});

app.get("/changelog", async (c) => {
  const formatDay = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString("en", { dateStyle: "long", timeZone: "UTC" });
  return c.html(await layout("Changelog | 0x9 dles", c.get("user"), `
    <main class="narrow changelog">
      <h1>Changelog</h1>
      <p>What's new on 0x9 dles, newest first.</p>
      ${CHANGELOG.map((day) => `<section>
        <h2><time datetime="${escapeHtml(day.date)}">${escapeHtml(formatDay(day.date))}</time></h2>
        <ul>${day.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </section>`).join("")}
    </main>
  `, c.env, { path: "/changelog", description: "What's new on 0x9 dles: every feature update since launch." }));
});

app.get("/daily", async (c) => {
  const PAGE = 20;
  const DAYS = 60;
  const today = utcDateKey(Date.now());
  const oldest = utcDateKey(Date.parse(`${today}T00:00:00Z`) - (DAYS - 1) * 86_400_000);
  const beforeParam = c.req.query("before") ?? "";
  const before = /^\d{4}-\d{2}-\d{2}$/.test(beforeParam) ? beforeParam : "9999-12-31";
  const rows = await c.env.DB.prepare(
    `SELECT dp.day, g.id, g.slug, g.url, g.title, g.vote_up_count, g.vote_down_count, g.paywall
     FROM daily_picks dp JOIN games g ON g.id = dp.game_id
     WHERE dp.day >= ?1 AND dp.day <= ?2 AND dp.day < ?3 AND g.status = 'approved' AND g.nsfw = 0
     ORDER BY dp.day DESC LIMIT ?4`
  )
    .bind(oldest, today, before, PAGE + 1)
    .all<{ day: string; id: string; slug: string; url: string; title: string; vote_up_count: number; vote_down_count: number; paywall: number }>();
  const more = rows.results.length > PAGE;
  const picks = rows.results.slice(0, PAGE);
  const categories = picks.length ? await getCategoriesForGames(c.env, picks.map((p) => p.id)) : new Map();
  const formatDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return c.html(await layout("Past games of the day | 0x9 dles", c.get("user"), `
    <main class="narrow daily-archive">
      <h1>Past games of the day</h1>
      <p>The last ${DAYS} days of picks. Days are UTC.</p>
      ${picks.length === 0 ? `<p class="meta">No picks recorded${beforeParam ? " before that date" : " yet"}.</p>` : `<ol class="daily-list">
        ${picks.map((p) => `<li class="daily-item" data-vote-counts="${escapeHtml(p.id)}">
          <time datetime="${escapeHtml(p.day)}">${escapeHtml(formatDay(p.day))}</time>
          <h2><a href="/games/${encodeURIComponent(p.slug)}">${escapeHtml(p.title)}</a>${p.paywall ? ` <span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}</h2>
          ${renderCategoryPills(categories.get(p.id))}
          <div class="gotd-foot"><div class="meta">${renderLikedLabel(p.vote_up_count, p.vote_down_count)}</div>
          <a class="btn btn-play" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" data-play-id="${escapeHtml(p.id)}">Play<span class="visually-hidden"> ${escapeHtml(p.title)}</span> ↗</a></div>
        </li>`).join("")}
      </ol>`}
      <p class="daily-nav">${beforeParam ? `<a href="/daily">Newest</a> ` : ""}${more ? `<a rel="next" href="/daily?before=${picks[picks.length - 1].day}">Older picks</a>` : ""}</p>
    </main>
  `, c.env, { path: "/daily", description: "Every recent Game of the day on 0x9 dles, newest first." }));
});

app.get("/games", async (c) => {
  const user = c.get("user");
  const sort = (c.req.query("sort") || "top") as "top" | "new" | "trending" | "popular" | "reset";
  const category = c.req.query("category") || undefined;
  const q = c.req.query("q") || undefined;
  const hidePaywall = c.req.query("hidePaywall") === "1";
  const hideNsfw = c.req.query("hideNsfw") === "1";
  const page = Math.max(1, parsePositiveInt(c.req.query("page"), 1));
  const perPage = 98; // Max 98 to stay within D1's 100 bind parameter limit (1 for user_id + up to 99 for game_ids when fetching perPage+1)
  const offset = (page - 1) * perPage;

  // Get total count for pagination
  const countParams: Array<string | number> = [];
  let countWhereSql = "WHERE games.status = 'approved'";
  if (category) {
    countWhereSql += " AND categories.slug = ?";
    countParams.push(category);
  }
  if (q) {
    countWhereSql += " AND (games.title LIKE ? OR games.description LIKE ?)";
    countParams.push(`%${q}%`, `%${q}%`);
  }
  if (hidePaywall) {
    countWhereSql += " AND games.paywall = 0";
  }
  if (hideNsfw) {
    countWhereSql += " AND games.nsfw = 0";
  }

  const countSql = `
    SELECT COUNT(DISTINCT games.id) as total
    FROM games
    LEFT JOIN game_categories ON games.id = game_categories.game_id
    LEFT JOIN categories ON categories.id = game_categories.category_id
    ${countWhereSql}
  `;

  // Fetch one extra to check if there are more pages. Count, games and categories are independent reads.
  const [countResult, gamesWithExtra, categories] = await Promise.all([
    c.env.DB.prepare(countSql).bind(...countParams).first<{ total: number }>(),
    listGames(c.env, { sort, category, q, hidePaywall, hideNsfw, limit: perPage + 1, offset }),
    c.env.DB.prepare("SELECT slug, name, description FROM categories WHERE is_active = 1 ORDER BY name ASC").all<{
      slug: string;
      name: string;
      description: string | null;
    }>()
  ]);
  const totalGames = countResult?.total || 0;
  const totalPages = Math.ceil(totalGames / perPage);
  const hasMore = gamesWithExtra.length > perPage;
  const games = gamesWithExtra.slice(0, perPage);

  if (page > 1 && games.length === 0) {
    return notFoundPage(c);
  }

  // Typo fallback: on page 1, when the plain search finds fewer than 3 games, add the closest titles (max 12).
  const fuzzyQuery = q?.trim() ?? "";
  let similarGames: Awaited<ReturnType<typeof listGames>> = [];
  let similarStrong = false;
  if (page === 1 && fuzzyQuery.length >= 3 && games.length < 3) {
    const similar = await findSimilarGameIds(c.env, fuzzyQuery, { category, hidePaywall, hideNsfw }, new Set(games.map((game) => game.id)));
    if (similar.ids.length > 0) {
      const rows = await listGames(c.env, { sort: "top", ids: similar.ids, limit: similar.ids.length });
      const order = new Map(similar.ids.map((id, index) => [id, index]));
      similarGames = rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      similarStrong = similar.strongest;
    }
  }
  const { votes: userVotes, favorites: userFavorites } = await getViewerGameState(c, [...games, ...similarGames].map((game) => game.id));

  // Render games as flat list
  const gamesMarkup = games.length > 0
    ? renderCompactGameList(games, user, userVotes, userFavorites, { hideable: true })
    : "<p>No games found.</p>";
  // Search links keep the current filters.
  const searchHref = (term: string) => {
    const params = new URLSearchParams({ q: term });
    if (sort !== "top") params.set("sort", sort);
    if (category) params.set("category", category);
    if (hidePaywall) params.set("hidePaywall", "1");
    if (hideNsfw) params.set("hideNsfw", "1");
    return `/games?${params.toString()}`;
  };
  const similarMarkup = similarGames.length > 0
    ? `<section class="similar-results" aria-labelledby="similar-title">
        ${games.length === 0 && similarStrong ? `<p class="did-you-mean">Did you mean <a href="${escapeHtml(searchHref(similarGames[0].title))}">${escapeHtml(similarGames[0].title)}</a>?</p>` : ""}
        <h2 id="similar-title" class="similar-title">${games.length === 0 && !similarStrong ? "Did you mean" : "Similar titles"}</h2>
        ${renderCompactGameList(similarGames, user, userVotes, userFavorites, { hideable: true })}
      </section>`
    : "";

  // Build pagination links
  const buildPageUrl = (newPage: number) => {
    const params = new URLSearchParams();
    if (sort !== "top") params.set("sort", sort);
    if (category) params.set("category", category);
    if (q) params.set("q", q);
    if (hidePaywall) params.set("hidePaywall", "1");
    if (hideNsfw) params.set("hideNsfw", "1");
    if (newPage > 1) params.set("page", String(newPage));
    return `/games${params.toString() ? "?" + params.toString() : ""}`;
  };

  const paginationMarkup = renderPagination(page, totalPages, hasMore, buildPageUrl);

  const activeCategory = category ? categories.results.find((cat) => cat.slug === category) : undefined;
  if (category && !activeCategory) {
    return notFoundPage(c);
  }
  const heading = activeCategory ? `Daily ${categoryGamesLabel(activeCategory.name)}` : "Browse Games";
  const pageSuffix = page > 1 ? ` – Page ${page}` : "";
  const pageTitle = (activeCategory ? `${heading} (${totalGames})` : "All Daily Games") + pageSuffix;
  const categoryPath = activeCategory ? `/games?category=${encodeURIComponent(activeCategory.slug)}` : "/games";
  const categoryPagePath = activeCategory ? `/categories/${encodeURIComponent(activeCategory.slug)}` : "";
  // Later pages list different games, so each is its own canonical page (the sort order is not).
  // A plain category filter (no search, sort or hide filters) is the same list as the category's landing page.
  const plainCategory = !!activeCategory && sort === "top" && !q && !hidePaywall && !hideNsfw;
  const canonicalPath = plainCategory
    ? (page > 1 ? `${categoryPagePath}?page=${page}` : categoryPagePath)
    : page > 1 ? `${categoryPath}${activeCategory ? "&" : "?"}page=${page}` : categoryPath;
  const categoryDescription = activeCategory?.description && !activeCategory.description.startsWith("Imported from") ? activeCategory.description : "";
  const activeFilterCount = [sort !== "top", !!category, hidePaywall, hideNsfw].filter(Boolean).length;
  const sortLabels: Record<string, string> = { top: "Top rated", new: "Newest", trending: "Trending", popular: "Popular this week", reset: "Resetting soonest" };
  const crumbs: Array<[string, string]> = [["Home", "/"], ["Games", "/games"]];
  if (activeCategory) crumbs.push([activeCategory.name, categoryPagePath]);
  const categoryFeedPath = activeCategory ? `/feed.xml?category=${encodeURIComponent(activeCategory.slug)}` : "";
  return c.html(await layout(pageTitle, user, `
    <main>
      <h1>${escapeHtml(heading)}</h1>
      ${activeCategory ? `<p class="feed-link"><a href="${escapeHtml(categoryFeedPath)}" type="application/atom+xml">Feed</a></p>` : ""}
      ${activeCategory ? `<p>${categoryDescription ? `${escapeHtml(categoryDescription)} ` : ""}${totalGames} daily game${totalGames === 1 ? "" : "s"} in the ${escapeHtml(activeCategory.name)} category, ranked by community votes. Vote for your favorites, add them to your daily rotation, or <a href="/categories">browse every category</a>.</p>` : ""}
      <form method="GET" action="/games" class="game-filters" id="game-filters">
        <div class="search-row">
          <input type="search" name="q" placeholder="Search games" aria-label="Search games" value="${escapeHtml(q || "")}" />
          <button type="submit">Search</button>
          <button type="button" id="surprise-btn" title="Open a random game from these filters">Surprise me</button>
        </div>
        <details class="filters" id="filters-panel" ${activeFilterCount > 0 ? "open" : ""}>
          <summary>Filters${activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</summary>
          <div class="filters-body">
            <select name="sort" aria-label="Sort">
              ${["top", "new", "trending", "popular", "reset"]
                .map((s) => `<option value="${s}" ${s === sort ? "selected" : ""}>${sortLabels[s]}</option>`)
                .join("")}
            </select>
            <select name="category" aria-label="Category">
              <option value="">All categories</option>
              ${categories.results
                .map((cat) => `<option value="${escapeHtml(cat.slug)}" ${cat.slug === category ? "selected" : ""}>${escapeHtml(cat.name)}</option>`)
                .join("")}
            </select>
            <label class="check"><input type="checkbox" name="hidePaywall" value="1" ${hidePaywall ? "checked" : ""} /> Hide paywalled</label>
            <label class="check"><input type="checkbox" name="hideNsfw" value="1" ${hideNsfw ? "checked" : ""} /> Hide NSFW</label>
          </div>
        </details>
      </form>
      <script src="${ASSET.page_games_page}"></script>
      <p id="search-status" class="visually-hidden" aria-live="polite"></p>
      <div id="game-results">
        ${gamesMarkup}
        ${paginationMarkup}
        ${similarMarkup}
      </div>
      ${HIDDEN_TOGGLE_MARKUP}
    </main>
    ${renderGameListInteractionScript({ includeImportPanel: false, promptFromQuery: false })}
  `, c.env, {
    path: canonicalPath,
    description: (activeCategory
      ? `${categoryDescription ? `${categoryDescription} ` : ""}${totalGames} daily game${totalGames === 1 ? "" : "s"} in the ${activeCategory.name} category, ranked by community votes.`
      : `Browse all ${totalGames} daily games: Wordle-style puzzles for words, geography, music, movies and more. Filter by category, sort by rating, trending or newest.`) + pageSuffix,
    jsonLd: [breadcrumbLd(crumbs), gameItemListLd(games, offset)],
    noindex: !!q || hidePaywall || hideNsfw,
    feed: activeCategory ? { href: categoryFeedPath, title: `New games in ${activeCategory.name} on 0x9 dles` } : undefined
  }));
});

// Category landing pages: /categories lists every category that has games, /categories/:slug is one category's
// overview, ranked game grid, related categories and FAQ. /games?category= stays as the filterable Browse view.
const CATEGORY_PER_PAGE = 98;

function categoryHeading(name: string): string {
  return /\bgames$/i.test(name) ? `Daily ${name}` : `${name} daily games`;
}

function categoryBlurb(description: string | null | undefined): string {
  return description && !description.startsWith("Imported from") ? description.trim() : "";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// New games: approved in the last 30 days, grouped by week (Monday start, US/Eastern), newest first.
const NEW_PAGE_DAYS = 30;
const NEW_PAGE_FALLBACK = 12;

function easternDateParts(value: string): { y: number; m: number; d: number } | null {
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return null;
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date).split("-").map(Number);
  return { y, m, d };
}

/** Days since epoch of the Monday starting the (US/Eastern) week that contains this date. */
function easternWeekStartDay(parts: { y: number; m: number; d: number }): number {
  const day = Math.floor(Date.UTC(parts.y, parts.m - 1, parts.d) / 86400000);
  return day - ((new Date(day * 86400000).getUTCDay() + 6) % 7);
}

app.get("/new", async (c) => {
  const user = c.get("user");
  let games = await listGames(c.env, { sort: "new", limit: 200, listedWithinDays: NEW_PAGE_DAYS });
  const isRecent = games.length > 0;
  if (!isRecent) games = await listGames(c.env, { sort: "new", limit: NEW_PAGE_FALLBACK });
  const stamp = (listedAt: string) => { const t = new Date(listedAt.includes("T") ? listedAt : listedAt.replace(" ", "T") + "Z").getTime(); return Number.isNaN(t) ? 0 : t; };
  games.sort((a, b) => stamp(b.listedAt) - stamp(a.listedAt));
  const { votes: userVotes, favorites: userFavorites } = await getViewerGameState(c, games.map((game) => game.id));

  const nowParts = easternDateParts(new Date().toISOString())!;
  const thisWeek = easternWeekStartDay(nowParts);
  const groups: Array<{ start: number; games: typeof games }> = [];
  for (const game of games) {
    const parts = easternDateParts(game.listedAt);
    const start = parts ? easternWeekStartDay(parts) : thisWeek;
    const last = groups[groups.length - 1];
    if (last && last.start === start) last.games.push(game);
    else groups.push({ start, games: [game] });
  }
  const weekLabel = (start: number) =>
    start >= thisWeek ? "This week" : start === thisWeek - 7 ? "Last week" : `Week of ${new Date(start * 86400000).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}`;

  const counts = new Map<string, { name: string; n: number }>();
  for (const game of games) for (const cat of game.categories) counts.set(cat.slug, { name: cat.name, n: (counts.get(cat.slug)?.n ?? 0) + 1 });
  const topCats = [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 2).map((cat) => cat.name);
  const mostly = topCats.length > 0 ? `, mostly ${topCats.join(" and ")}` : "";
  const summary = isRecent
    ? `${plural(games.length, "new daily game")} in the last ${NEW_PAGE_DAYS} days${mostly}`
    : `No games were added in the last ${NEW_PAGE_DAYS} days, so here are the ${plural(games.length, "most recent addition")}${mostly}`;

  const sections = groups.map((group) => `<section class="new-week">
        <h2>${escapeHtml(weekLabel(group.start))}</h2>
        ${renderCompactGameList(group.games, user, userVotes, userFavorites, { hideable: true })}
      </section>`).join("");
  const newest = games[0] ? stamp(games[0].listedAt) : 0;
  const lastmodNote = newest ? ` Latest: ${games[0].title}.` : "";
  const description = `${summary}.${lastmodNote} Updated as games are approved.`.slice(0, 160);
  return c.html(await layout(isRecent ? "New Daily Games" : "Latest Daily Games", user, `
    <main>
      <h1>${isRecent ? "New daily games" : "Latest daily games"}</h1>
      <p class="feed-link"><a href="/feed.xml" type="application/atom+xml">Atom feed</a></p>
      ${games.length > 0 ? `<p>${escapeHtml(summary)}. Vote for your favorites or add them to your daily rotation, or <a href="/games?sort=new">browse every game</a> by newest.</p>
      <div id="game-results">${sections}</div>
      ${HIDDEN_TOGGLE_MARKUP}` : `<p>No games yet. <a href="/games">Browse all games</a>.</p>`}
    </main>
    ${renderGameListInteractionScript({ includeImportPanel: false, promptFromQuery: false })}
  `, c.env, {
    path: "/new",
    description,
    jsonLd: [breadcrumbLd([["Home", "/"], ["New games", "/new"]]), gameItemListLd(games)],
    feed: { href: "/feed.xml", title: "New games on 0x9 dles" }
  }));
});

app.get("/categories", async (c) => {
  const user = c.get("user");
  const cats = (await c.env.DB.prepare(
    `SELECT categories.id, categories.slug, categories.name, categories.description, COUNT(DISTINCT games.id) AS n
     FROM categories
     JOIN game_categories ON game_categories.category_id = categories.id
     JOIN games ON games.id = game_categories.game_id AND games.status = 'approved'
     WHERE categories.is_active = 1
     GROUP BY categories.id
     ORDER BY n DESC, categories.name ASC`
  ).all<{ id: string; slug: string; name: string; description: string | null; n: number }>()).results;
  const top = (await c.env.DB.prepare(
    `SELECT category_id, title, slug FROM (
       SELECT game_categories.category_id AS category_id, games.title AS title, games.slug AS slug,
              ROW_NUMBER() OVER (PARTITION BY game_categories.category_id ORDER BY games.score DESC, games.vote_up_count DESC) AS rn
       FROM game_categories
       JOIN games ON games.id = game_categories.game_id AND games.status = 'approved'
     ) WHERE rn <= 3 ORDER BY category_id, rn`
  ).all<{ category_id: string; title: string; slug: string }>()).results;
  const topByCategory = new Map<string, Array<{ title: string; slug: string }>>();
  for (const row of top) {
    const list = topByCategory.get(row.category_id) ?? [];
    list.push(row);
    topByCategory.set(row.category_id, list);
  }
  if (cats.length === 0) return notFoundPage(c);
  const totalGames = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'approved'").first<{ n: number }>())?.n ?? 0;
  const itemLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: cats.map((cat, index) => ({ "@type": "ListItem", position: index + 1, name: categoryHeading(cat.name), url: `${c.env.APP_URL}/categories/${encodeURIComponent(cat.slug)}` }))
  };
  return c.html(await layout("Daily Game Categories", user, `
    <main class="narrow">
      <h1>Daily game categories</h1>
      <p>${plural(cats.length, "category").replace(/^1 category$/, "1 category")} covering ${totalGames.toLocaleString("en-US")} daily games. Pick a category to see its games ranked by community votes, or <a href="/games">browse every game</a> with filters.</p>
      <ul class="category-index">
        ${cats.map((cat) => {
          const blurb = categoryBlurb(cat.description);
          const tops = topByCategory.get(cat.id) ?? [];
          return `<li class="panel">
          <h2>${renderCategoryPill(cat, cat.n)}</h2>
          ${blurb ? `<p>${escapeHtml(blurb)}</p>` : ""}
          <p class="category-index-top">Top rated: ${tops.map((game) => `<a href="/games/${escapeHtml(encodeURIComponent(game.slug))}">${escapeHtml(game.title)}</a>`).join(", ")}</p>
          <p><a href="/categories/${escapeHtml(encodeURIComponent(cat.slug))}">All ${plural(cat.n, "game")} in ${escapeHtml(cat.name)}</a></p>
        </li>`;
        }).join("")}
      </ul>
    </main>
  `, c.env, {
    path: "/categories",
    description: `Browse ${cats.length} categories of daily games, from ${cats.slice(0, 3).map((cat) => cat.name).join(", ")} and more. ${totalGames} games ranked by community votes.`.slice(0, 160),
    jsonLd: [breadcrumbLd([["Home", "/"], ["Categories", "/categories"]]), itemLd]
  }));
});

app.get("/categories/:slug", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const page = Math.max(1, parsePositiveInt(c.req.query("page"), 1));
  const offset = (page - 1) * CATEGORY_PER_PAGE;
  const category = await c.env.DB.prepare("SELECT id, slug, name, description FROM categories WHERE slug = ?1 AND is_active = 1")
    .bind(slug)
    .first<{ id: string; slug: string; name: string; description: string | null }>();
  if (!category) return notFoundPage(c);
  // Everything below depends only on the category row, so the reads go out together.
  const statsP = c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(games.reset_basis = 'server') AS fixed_reset,
            SUM(games.reset_basis = 'local') AS local_reset,
            SUM(games.paywall = 1) AS paid
     FROM games
     JOIN game_categories ON game_categories.game_id = games.id AND game_categories.category_id = ?1
     WHERE games.status = 'approved'`
  ).bind(category.id).first<{ total: number; fixed_reset: number | null; local_reset: number | null; paid: number | null }>();
  const gamesWithExtraP = listGames(c.env, { sort: "top", category: slug, limit: CATEGORY_PER_PAGE + 1, offset });
  const leadersP = page === 1 ? null : listGames(c.env, { sort: "top", category: slug, limit: 3 });
  const newestP = c.env.DB.prepare(
    `SELECT games.title, games.slug FROM games
     JOIN game_categories ON game_categories.game_id = games.id AND game_categories.category_id = ?1
     WHERE games.status = 'approved'
     ORDER BY COALESCE(games.approved_at, games.created_at) DESC LIMIT 1`
  ).bind(category.id).first<{ title: string; slug: string }>();
  const relatedP = c.env.DB.prepare(
    `SELECT other.slug, other.name, COUNT(DISTINCT mine.game_id) AS shared
     FROM game_categories mine
     JOIN game_categories theirs ON theirs.game_id = mine.game_id AND theirs.category_id != mine.category_id
     JOIN categories other ON other.id = theirs.category_id AND other.is_active = 1
     JOIN games ON games.id = mine.game_id AND games.status = 'approved'
     WHERE mine.category_id = ?1
     GROUP BY other.id
     ORDER BY shared DESC, other.name ASC
     LIMIT 6`
  ).bind(category.id).all<{ slug: string; name: string; shared: number }>();
  const [stats, gamesWithExtra, newest, relatedRows] = await Promise.all([statsP, gamesWithExtraP, newestP, relatedP]);
  const totalGames = stats?.total ?? 0;
  if (totalGames === 0) return notFoundPage(c);
  const totalPages = Math.ceil(totalGames / CATEGORY_PER_PAGE);
  const hasMore = gamesWithExtra.length > CATEGORY_PER_PAGE;
  const games = gamesWithExtra.slice(0, CATEGORY_PER_PAGE);
  if (page > 1 && games.length === 0) return notFoundPage(c);

  const leaders = leadersP ? await leadersP : games.slice(0, 3);
  const related = relatedRows.results;

  const { votes: userVotes, favorites: userFavorites } = await getViewerGameState(c, games.map((game) => game.id));
  const gamesMarkup = renderCompactGameList(games, user, userVotes, userFavorites, { hideable: true });
  const basePath = `/categories/${encodeURIComponent(category.slug)}`;
  const buildPageUrl = (n: number) => (n > 1 ? `${basePath}?page=${n}` : basePath);
  const paginationMarkup = renderPagination(page, totalPages, hasMore, buildPageUrl);

  const blurb = categoryBlurb(category.description);
  const heading = categoryHeading(category.name);
  const fixed = stats?.fixed_reset ?? 0;
  const local = stats?.local_reset ?? 0;
  const paid = stats?.paid ?? 0;
  const feedPath = `/feed.xml?category=${encodeURIComponent(category.slug)}`;
  const lc = heading;
  const inCategory = `${plural(totalGames, "daily game")} in the ${category.name} category`;
  const resetSentence = fixed + local > 0
    ? `${fixed > 0 ? `${plural(fixed, "game")} reset${fixed === 1 ? "s" : ""} at a fixed time, the same moment for everyone` : ""}${fixed > 0 && local > 0 ? ", and " : ""}${local > 0 ? `${local} ${local === 1 ? "resets" : "reset"} at the same clock time in your own time zone` : ""}.`
    : "";
  const introText = [
    `0x9 dles lists ${inCategory}${paid > 0 ? `, ${paid === totalGames ? "all of them paid" : `${paid} of them paid`}` : ", all free to play in your browser"}.`,
    leaders[0] ? `The top-rated one is ${leaders[0].title}${leaders[0].voteUpCount + leaders[0].voteDownCount >= 5 ? ` (${Math.round((leaders[0].voteUpCount / (leaders[0].voteUpCount + leaders[0].voteDownCount)) * 100)}% liked)` : ""}.` : "",
    newest ? `The newest addition is ${newest.title}.` : "",
    resetSentence ? resetSentence.charAt(0).toUpperCase() + resetSentence.slice(1) : ""
  ].filter(Boolean).join(" ");

  const faqItems: Array<[string, string]> = [
    [`What are the best ${lc}?`, leaders.length > 0 ? `Based on community votes, the top rated are ${joinNames(leaders.map((game) => game.title))}.` : `There are no ${lc} games yet.`],
    [`How many ${lc} are there?`, `0x9 dles lists ${inCategory}${newest ? `, most recently ${newest.title}` : ""}.`],
    [`Are ${lc} free?`, paid === 0 ? `Yes, all ${totalGames} are free to play in your web browser.` : `${totalGames - paid} of ${totalGames} are free to play. ${plural(paid, "game")} ${paid === 1 ? "requires" : "require"} payment, marked with a $ badge.`],
    [`When do ${lc} reset?`, resetSentence ? resetSentence.charAt(0).toUpperCase() + resetSentence.slice(1) : "Each game gets a new puzzle every day. Reset times are shown on game pages when known."]
  ];

  const pageSuffix = page > 1 ? ` – Page ${page}` : "";
  const metaParts = [
    `${inCategory.charAt(0).toUpperCase()}${inCategory.slice(1)}${paid === 0 ? ", free to play" : ""}, ranked by community votes.`,
    leaders[0] ? `Top rated: ${leaders[0].title}.` : "",
    blurb
  ].filter(Boolean);
  let metaDescription = metaParts.join(" ");
  while (metaDescription.length > 160 - pageSuffix.length && metaParts.length > 1) {
    metaParts.pop();
    metaDescription = metaParts.join(" ");
  }
  if (metaDescription.length > 160 - pageSuffix.length) metaDescription = metaDescription.slice(0, 160 - pageSuffix.length - 1).replace(/\s+\S*$/, "") + "…";
  metaDescription += pageSuffix;

  const crumbs: Array<[string, string]> = [["Home", "/"], ["Categories", "/categories"], [category.name, basePath]];
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map(([question, answer]) => ({ "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer } }))
  };
  return c.html(await layout(`${heading} (${totalGames})${pageSuffix}`, user, `
    <main>
      <h1>${escapeHtml(heading)}</h1>
      <p class="feed-link"><a href="${escapeHtml(feedPath)}" type="application/atom+xml">Feed</a></p>
      ${blurb ? `<p>${escapeHtml(blurb)}</p>` : ""}
      <p>${escapeHtml(introText)} Vote for your favorites, add them to your daily rotation, or <a href="/games?category=${escapeHtml(encodeURIComponent(category.slug))}">filter and sort these games</a> in Browse.</p>
      <div id="game-results">
        ${gamesMarkup}
        ${paginationMarkup}
      </div>
      ${HIDDEN_TOGGLE_MARKUP}
      ${related.length > 0 ? `<section class="related-categories">
        <h2>Related categories</h2>
        <ul class="about-categories">${related.map((cat) => `<li>${renderCategoryPill(cat, cat.shared)}</li>`).join("")}</ul>
        <p><a href="/categories">All categories</a></p>
      </section>` : `<p><a href="/categories">All categories</a></p>`}
      <section class="game-faq">
        <h2>${escapeHtml(heading)} FAQ</h2>
        ${faqItems.map(([question, answer]) => `<h3>${escapeHtml(question)}</h3><p>${escapeHtml(answer)}</p>`).join("")}
      </section>
    </main>
    ${renderGameListInteractionScript({ includeImportPanel: false, promptFromQuery: false })}
  `, c.env, {
    path: page > 1 ? `${basePath}?page=${page}` : basePath,
    description: metaDescription,
    jsonLd: [breadcrumbLd(crumbs), gameItemListLd(games, offset), faqLd],
    feed: { href: feedPath, title: `New games in ${category.name} on 0x9 dles` }
  }));
});

app.get("/games/:slug", async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user");
  const isAdminOrEditor = user && (user.role === "admin" || user.role === "editor");
  const game = await c.env.DB.prepare(
    `SELECT id, title, slug, url, description, status, vote_up_count, vote_down_count, report_count, reset_basis, reset_time_minutes, reset_timezone, paywall, nsfw,
            COALESCE(approved_at, created_at) AS listed_at, how_to_play, link_fail_count, last_checked_at
     FROM games
     WHERE slug = ?1 AND (?2 = 1 OR status = 'approved' OR (status = 'pending' AND submitted_by_user_id = ?3))`
  )
    .bind(slug, isAdminOrEditor ? 1 : 0, user?.id ?? null)
    .first<{
      id: string;
      title: string;
      slug: string;
      url: string;
      description: string | null;
      status: string;
      vote_up_count: number;
      vote_down_count: number;
      report_count: number;
      reset_basis: "local" | "server" | null;
      reset_time_minutes: number | null;
      reset_timezone: string | null;
      paywall: number;
      nsfw: number;
      listed_at: string;
      how_to_play: string | null;
      link_fail_count: number;
      last_checked_at: string | null;
    }>();
  if (!game) {
    // A renamed game keeps the first 8 characters of its id in its slug, so an old URL can find it.
    const moved = await findRenamedGameSlug(c.env, slug, !!isAdminOrEditor, user?.id ?? null);
    if (moved) {
      return c.redirect(`/games/${encodeURIComponent(moved)}${new URL(c.req.url).search}`, 301);
    }
    return notFoundPage(c);
  }

  // Everything below depends only on the game row, so the reads go out together.
  const allCategoriesP = c.env.DB.prepare(
    `SELECT id, slug, name FROM categories WHERE is_active = 1 ORDER BY name ASC`
  ).all<{ id: string; slug: string; name: string }>();

  const categoriesP = c.env.DB.prepare(
    `SELECT categories.slug, categories.name, categories.description
     FROM game_categories
     JOIN categories ON categories.id = game_categories.category_id
     WHERE game_categories.game_id = ?1
     ORDER BY categories.name ASC`
  )
    .bind(game.id)
    .all<{ slug: string; name: string; description: string | null }>();
  const publicListsP = c.env.DB.prepare(
    `SELECT curated_lists.slug, curated_lists.title
     FROM curated_list_items
     JOIN curated_lists ON curated_lists.id = curated_list_items.curated_list_id
     WHERE curated_list_items.game_id = ?1 AND curated_lists.visibility = 'public'
     ORDER BY curated_lists.title ASC`
  )
    .bind(game.id)
    .all<{ slug: string; title: string }>();

  const viewerP = getViewerGameState(c, [game.id]);

  // The game's verified developer is public. The viewer's own claim only exists for signed-in visitors, who never get the cached page.
  const developerP = c.env.DB.prepare(
    `SELECT game_claims.user_id, users.display_name, users.profile_handle, users.profile_public FROM game_claims JOIN users ON users.id = game_claims.user_id
     WHERE game_claims.game_id = ?1 AND game_claims.status = 'verified'`
  )
    .bind(game.id)
    .first<{ user_id: string; display_name: string | null; profile_handle: string | null; profile_public: number }>();
  const ownClaimP = user ? getOwnClaim(c.env, game.id, user.id) : Promise.resolve(null);

  // Other well-liked games sharing a category: useful next stops for visitors and internal links for crawlers.
  const relatedP = c.env.DB.prepare(
    `SELECT games.slug, games.title
     FROM games
     JOIN game_categories ON game_categories.game_id = games.id
     WHERE game_categories.category_id IN (SELECT category_id FROM game_categories WHERE game_id = ?1)
       AND games.id != ?1 AND games.status = 'approved' AND (games.nsfw = 0 OR ?2 = 1)
     GROUP BY games.id
     ORDER BY games.score DESC
     LIMIT 6`
  )
    .bind(game.id, game.nsfw)
    .all<{ slug: string; title: string }>();
  // Games that most often share a rotation with this one. Not per-visitor; cached in KV (stale is fine, so
  // invalidateGameCaches doesn't touch the "coplay:" prefix).
  const coplayKey = `coplay:v1:${game.id}:${game.nsfw}`;
  const alsoPlayP = (async () => {
  let alsoPlay = await getCachedJson<Array<{ slug: string; title: string }>>(c.env, coplayKey).catch(() => null);
  if (!alsoPlay) {
    const coplay = await c.env.DB.prepare(
      `SELECT games.slug, games.title
       FROM (
         SELECT f2.game_id AS gid FROM favorites f1
         JOIN favorites f2 ON f2.user_id = f1.user_id AND f2.game_id != f1.game_id
         WHERE f1.game_id = ?1
         UNION ALL
         SELECT a2.game_id FROM anonymous_favorites a1
         JOIN anonymous_favorites a2 ON a2.anon_id = a1.anon_id AND a2.game_id != a1.game_id
         WHERE a1.game_id = ?1
       ) co
       JOIN games ON games.id = co.gid
       WHERE games.status = 'approved' AND (games.nsfw = 0 OR ?2 = 1)
       GROUP BY games.id
       HAVING COUNT(*) >= 2
       ORDER BY COUNT(*) DESC, games.score DESC
       LIMIT 6`
    )
      .bind(game.id, game.nsfw)
      .all<{ slug: string; title: string }>();
    alsoPlay = coplay.results;
    await setCachedJson(c.env, coplayKey, alsoPlay, 6 * 3600).catch(() => undefined);
  }
  return alsoPlay;
  })();
  // Public creator lists that put this game on stream in the last 30 days (same for every visitor).
  const streamedByP = game.status === "approved"
    ? c.env.DB.prepare(
        `SELECT curated_lists.slug, curated_lists.title, curated_lists.twitch_login, MAX(h.started_at) AS last_at,
                CASE WHEN ${VERIFIED_LIST_SQL} THEN 1 ELSE 0 END AS is_verified_list
         FROM list_play_history h
         JOIN curated_lists ON curated_lists.id = h.list_id AND curated_lists.visibility = 'public'
         LEFT JOIN users ON users.id = curated_lists.owner_user_id
         WHERE h.game_id = ?1 AND h.started_at >= ?2
         GROUP BY curated_lists.id
         ORDER BY last_at DESC
         LIMIT 5`
      ).bind(game.id, new Date(Date.now() - 30 * 86400000).toISOString()).all<{ slug: string; title: string; twitch_login: string | null; last_at: string; is_verified_list: number }>().then((r) => r.results)
    : Promise.resolve([] as Array<{ slug: string; title: string; twitch_login: string | null; last_at: string; is_verified_list: number }>);
  const [allCategories, categories, publicLists, viewer, developer, ownClaim, related, alsoPlay, streamedBy] = await Promise.all([
    allCategoriesP, categoriesP, publicListsP, viewerP, developerP, ownClaimP, relatedP, alsoPlayP, streamedByP
  ]);
  const userVote: -1 | 0 | 1 = viewer.votes.get(game.id) ?? 0;
  const userFavorite = viewer.favorites.has(game.id);
  const relatedHeading = `Daily games like ${game.title}`;

  const gameLd = {
    "@context": "https://schema.org",
    "@type": "VideoGame",
    name: game.title,
    ...(game.description ? { description: game.description } : {}),
    url: game.url,
    applicationCategory: "GameApplication",
    gamePlatform: "Web browser",
    operatingSystem: "Any",
    isAccessibleForFree: !game.paywall,
    ...(categories.results.length > 0 ? { genre: categories.results.map((cat) => cat.name) } : {})
  };
  // Facts the site already knows about the game, so its page says more than the one-line description.
  const mainCategory = categories.results.find((cat) => cat.slug !== "miscellaneous" && cat.slug !== "novelty") ?? categories.results[0];
  const gameKind = mainCategory ? `daily ${categoryGameLabel(mainCategory.name).replace(/Game$/, "game")}` : "daily game";
  const totalVotes = game.vote_up_count + game.vote_down_count;
  const ratingText = totalVotes > 0
    ? `${Math.round((game.vote_up_count / totalVotes) * 100)}% upvoted, from ${totalVotes} community vote${totalVotes === 1 ? "" : "s"}`
    : "No votes yet. Played it? Vote above.";
  // Rows from SQLite's datetime() are "YYYY-MM-DD HH:MM:SS" (UTC); rows written by the API are ISO strings.
  const listedDate = new Date(game.listed_at.includes("T") ? game.listed_at : game.listed_at.replace(" ", "T") + "Z");
  const listedText = Number.isNaN(listedDate.getTime()) ? "" : listedDate.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const describedCategories = categories.results.filter((cat) => cat.description && !cat.description.startsWith("Imported from"));
  const trimmedDesc = game.description?.trim() ?? "";
  const resetSentence = describeReset(game.reset_basis, game.reset_time_minutes, game.reset_timezone);
  // Empty in the HTML (pages are edge-cached); the page script fills in "(8:00 PM your time)" for server-basis resets.
  const resetHint = game.reset_basis === "server" && game.reset_time_minutes !== null && game.reset_time_minutes >= 0 && game.reset_time_minutes <= 1439
    ? `<span data-reset-minutes="${game.reset_time_minutes}" data-reset-tz="${escapeHtml(game.reset_timezone ?? "UTC")}"></span>`
    : "";
  const introText = [
    `${game.title} is a ${game.paywall ? "paid " : "free "}${gameKind} you play in your web browser, with a new puzzle every day.${game.nsfw ? " It contains NSFW content." : ""}`,
    categories.results.length > 0 ? `0x9 dles files it under ${joinNames(categories.results.map((cat) => cat.name))}.` : "",
    resetSentence ?? "",
    totalVotes >= 5 ? `${Math.round((game.vote_up_count / totalVotes) * 100)}% of ${totalVotes} voters liked it.` : "",
    publicLists.results.length > 0 ? `It appears in ${publicLists.results.length} public list${publicLists.results.length === 1 ? "" : "s"}, such as ${joinNames(publicLists.results.slice(0, 3).map((list) => list.title))}.` : "",
    developer?.display_name ? `Its developer, ${developer.display_name}, is verified.` : ""
  ].filter(Boolean).join(" ");
  const gameFacts = `
      <section class="game-facts">
        <h2>About ${escapeHtml(game.title)}</h2>
        ${game.how_to_play ? `<h3>How to play</h3>${game.how_to_play.split(/\n\s*\n/).map((para) => `<p>${escapeHtml(para.trim()).replace(/\n/g, "<br />")}</p>`).join("")}<h3>Details</h3>` : ""}
        <p>${escapeHtml(introText)}${resetHint}</p>
        <dl>
          ${categories.results.length > 0 ? `<dt>Category</dt><dd>${categories.results.map((cat) => `<a href="/categories/${encodeURIComponent(cat.slug)}">${escapeHtml(cat.name)}</a>`).join(", ")}${describedCategories.length > 0 ? `: ${describedCategories.map((cat) => escapeHtml(cat.description!)).join(" ")}` : ""}</dd>` : ""}
          <dt>Community rating</dt><dd data-rating>${escapeHtml(ratingText)}</dd>
          ${publicLists.results.length > 0 ? `<dt>Featured in</dt><dd>${publicLists.results.map((list) => `<a href="/lists/${encodeURIComponent(list.slug)}">${escapeHtml(list.title)}</a>`).join(", ")}</dd>` : ""}
          ${listedText ? `<dt>Listed on 0x9 dles since</dt><dd>${escapeHtml(listedText)}</dd>` : ""}
        </dl>
      </section>`;
  const faqItems: Array<[string, string]> = [
    [`When does ${game.title} reset?`, resetSentence ?? `${game.title} has no reset time listed yet. It offers a new puzzle each day, so check the game itself for the exact time.`],
    [`Is ${game.title} free?`, game.paywall ? `${game.title} requires payment to play. Check the game's own site for current pricing.` : `Yes. ${game.title} is free to play in your web browser, with no download needed.`],
    [`What is ${game.title} like?`, [
      trimmedDesc ? (/[.!?]$/.test(trimmedDesc) ? trimmedDesc : `${trimmedDesc}.`) : `${game.title} is a ${gameKind}.`,
      describedCategories.length > 0 ? describedCategories.map((cat) => cat.description!).join(" ") : ""
    ].filter(Boolean).join(" ")]
  ];
  // Visible FAQ only: Google limits FAQ rich results to a few site types, so no FAQPage JSON-LD.
  const faqSection = `
      <section class="game-faq">
        <h2>${escapeHtml(game.title)} FAQ</h2>
        ${faqItems.map(([question, answer]) => `<h3>${escapeHtml(question)}</h3><p>${escapeHtml(answer)}</p>`).join("")}
      </section>`;
  // Facts first so every game's snippet differs even when the imported description is shared with other sites.
  const metaParts = [
    `${game.title}: a ${game.paywall ? "" : "free "}${gameKind} you play in your browser.`,
    describeReset(game.reset_basis, game.reset_time_minutes, game.reset_timezone, true) ?? "",
    totalVotes >= 5 ? `${Math.round((game.vote_up_count / totalVotes) * 100)}% liked on 0x9 dles.` : ""
  ].filter(Boolean);
  let metaDescription = metaParts.join(" ");
  while (metaDescription.length > 160 && metaParts.length > 1) {
    metaParts.pop();
    metaDescription = metaParts.join(" ");
  }
  if (trimmedDesc && 160 - metaDescription.length >= 40) {
    const room = 160 - metaDescription.length - 1;
    const cut = trimmedDesc.length <= room ? trimmedDesc : `${trimmedDesc.slice(0, room - 1).replace(/\s+\S*$/, "").replace(/[\s,;:.-]+$/, "")}…`;
    metaDescription = `${metaDescription} ${cut}`;
  }
  // Changes whenever something drawn on the social image changes, so shares pick up edits.
  const ogVersion = shortHash([game.title, game.description ?? "", game.paywall, ...categories.results.map((cat) => cat.slug)].join("|"));
  // The reset the "Mark as played" toggle checks against (same as dglIsPlayed; none = since local midnight).
  const playReset = getResetSortData(game.reset_basis, game.reset_time_minutes, game.reset_timezone);
  // Same for every visitor (edge-cache safe) except the extra line for the game's verified developer.
  const linkCheckedOn = game.last_checked_at ? new Date(game.last_checked_at.replace(" ", "T") + (game.last_checked_at.includes("T") ? "" : "Z")) : null;
  const linkNotice = game.link_fail_count >= 3
    ? `<p class="game-actions-note link-down-note" role="note">Our link checker couldn't reach this game recently. It may be down or moved.${linkCheckedOn && !Number.isNaN(linkCheckedOn.getTime()) ? ` Last checked ${escapeHtml(linkCheckedOn.toLocaleDateString("en-US", { timeZone: "America/New_York", dateStyle: "medium" }))} ET.` : ""}${ownClaim?.status === "verified" ? " If the game moved, update its URL below." : ""}</p>`
    : "";
  return c.html(await layout(`${game.title} – ${mainCategory ? `Daily ${categoryGameLabel(mainCategory.name)}` : "Daily Game"}`, user, `
    <main class="narrow" data-vote-counts="${escapeHtml(game.id)}" data-game-title="${escapeHtml(game.title)}">
      <h1>${escapeHtml(game.title)}${isNewlyListed(game.listed_at) ? ` ${renderNewBadge()}` : ""}${game.paywall ? ` <span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}${game.nsfw ? ` <span class="nsfw-badge" title="This game contains NSFW content">nsfw</span>` : ""}</h1>
      ${renderCategoryPills(categories.results)}
      ${developer ? `<p class="developer-line">${renderCheckBadge("Verified developer")} Verified developer${developer.display_name ? `: ${developer.profile_public && developer.profile_handle ? `<a href="/u/${encodeURIComponent(developer.profile_handle)}">${escapeHtml(developer.display_name)}</a>` : escapeHtml(developer.display_name)}` : ""}</p>` : ""}
      <p>${escapeHtml(game.description || "")}</p>
      <p class="play-row"><a class="btn btn-play" href="${escapeHtml(game.url)}" target="_blank" rel="noopener noreferrer" data-play-id="${game.id}">Play ${escapeHtml(game.title)} ↗</a><button type="button" class="btn played-toggle" data-played-toggle="${escapeHtml(game.id)}" data-played-kind="${playReset?.kind ?? ""}" data-played-min="${playReset ? playReset.min : ""}" hidden>Mark as played</button></p>
      <p class="play-history-line" id="play-history-line" hidden></p>
      ${linkNotice}
      <div class="game-actions" role="group" aria-label="Vote and favorite">
        <button type="button" id="vote-up" data-vote-button="up" class="${userVote === 1 ? "active" : ""}" aria-pressed="${userVote === 1 ? "true" : "false"}" aria-label="${escapeHtml(voteButtonLabel("up", game.title, game.vote_up_count))}" title="Vote up"><span aria-hidden="true">▲</span> <span id="vote-up-count" data-up-count>${game.vote_up_count}</span></button>
        <button type="button" id="vote-down" data-vote-button="down" class="${userVote === -1 ? "active" : ""}" aria-pressed="${userVote === -1 ? "true" : "false"}" aria-label="${escapeHtml(voteButtonLabel("down", game.title, game.vote_down_count))}" title="Vote down"><span aria-hidden="true">▼</span> <span id="vote-down-count" data-down-count>${game.vote_down_count}</span></button>
        ${user
          ? `<button type="button" id="favorite-toggle" data-favorited="${userFavorite ? "yes" : "no"}">${userFavorite ? "Remove favorite" : "Add favorite"}</button>`
          : `<button type="button" id="favorite-local-toggle" data-favorited="no">Add favorite</button>`}
        <button type="button" data-share data-share-title="${escapeHtml(game.title)}">Share</button>
      </div>
      ${renderGameMeta(game.vote_up_count, game.vote_down_count, renderResetSpan(game.reset_basis, game.reset_time_minutes, game.reset_timezone, "long")).replace('class="meta"', 'class="meta game-meta"')}
      ${renderResetSuggest(game, user, ownClaim?.status === "verified")}
      <p class="game-actions-note">${user ? `Favorites are added to <a href="/me/rotation">your rotation</a>.` : `Favorites are added to <a href="/me/rotation">your rotation</a>, no account needed.`}${isAdminOrEditor ? ` Reports: ${game.report_count}.` : ""}</p>
      <p id="game-action-status" class="status" aria-live="polite"></p>
      ${gameFacts}
      ${faqSection}
      ${alsoPlay.length > 0 ? `<section class="related-games">
        <h2>Players who like ${escapeHtml(game.title)} also play</h2>
        <ul>${alsoPlay.map((item) => `<li><a href="/games/${encodeURIComponent(item.slug)}">${escapeHtml(item.title)}</a></li>`).join("")}</ul>
      </section>` : ""}
      ${streamedBy.length > 0 ? `<section class="related-games recent-stream">
        <h2>Recently on stream</h2>
        <ul>${streamedBy.map((row) => `<li><a href="/lists/${encodeURIComponent(row.slug)}/history">${escapeHtml(row.title)}</a>${row.is_verified_list ? renderCheckBadge("Verified content creator") : renderVerifiedBadge(row.twitch_login)} <time data-local-date datetime="${escapeHtml(row.last_at)}">${escapeHtml(new Date(row.last_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }))}</time></li>`).join("")}</ul>
      </section>` : ""}
      ${related.results.length > 0 ? `<section class="related-games">
        <h2>${escapeHtml(relatedHeading)}</h2>
        <ul>${related.results.map((item) => `<li><a href="/games/${encodeURIComponent(item.slug)}">${escapeHtml(item.title)}</a></li>`).join("")}</ul>
      </section>` : ""}
      <details class="panel report-panel">
        <summary>Report a problem</summary>
        <form id="report-form" class="stack-form">
          <label>Reason
            <select name="reason">
              <option value="broken">Broken link</option>
              <option value="not_daily">Not a daily game</option>
              <option value="spam">Spam</option>
              <option value="other">Other</option>
            </select>
          </label>
          <textarea name="note" rows="3" placeholder="Optional notes" aria-label="Notes (optional)"></textarea>
          <button type="submit">Send report</button>
        </form>
        <p id="report-status" class="status" aria-live="polite"></p>
      </details>
      ${renderDeveloperSections(game, user, ownClaim, !!developer, c.env.APP_ENV, c.env.APP_URL, shortOrigin(c.env) ?? c.env.APP_URL)}
      ${
        user && (user.role === "admin" || user.role === "editor")
          ? `<section class="panel">
               <h2>Admin: Edit Game</h2>
               <form id="admin-edit-form" class="stack-form">
                 <label>Title
                   <input type="text" name="title" value="${escapeHtml(game.title)}" required />
                 </label>
                 <label>URL
                   <input type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" name="url" value="${escapeHtml(game.url)}" required />
                 </label>
                 <label>Description
                   <textarea name="description" rows="3">${escapeHtml(game.description || "")}</textarea>
                 </label>
                 <label>How to play <small>(optional, shown on this page; blank line between paragraphs)</small>
                   <textarea name="how_to_play" rows="5" maxlength="2000" placeholder="e.g. You get six guesses. After each one, tiles show which letters are in the answer.">${escapeHtml(game.how_to_play || "")}</textarea>
                 </label>
                 <label>Status
                   <select name="status" required>
                     <option value="pending" ${game.status === "pending" ? "selected" : ""}>Pending</option>
                     <option value="approved" ${game.status === "approved" ? "selected" : ""}>Approved</option>
                     <option value="rejected" ${game.status === "rejected" ? "selected" : ""}>Rejected</option>
                     <option value="disabled" ${game.status === "disabled" ? "selected" : ""}>Disabled</option>
                   </select>
                 </label>
                 <div data-reset-group>
                 <label>Reset Basis
                   <select name="reset_basis" data-basis-select>
                     <option value="" ${!game.reset_basis ? "selected" : ""}>None</option>
                     <option value="local" ${game.reset_basis === "local" ? "selected" : ""}>Local</option>
                     <option value="server" ${game.reset_basis === "server" ? "selected" : ""}>Server</option>
                   </select>
                 </label>
                  <label>Reset Time (in the zone above for Server, otherwise viewer's local time)
                    <input type="time" name="reset_time" value="${game.reset_time_minutes === null ? "" : escapeHtml(formatResetTime(game.reset_time_minutes))}" />
                  </label>
                  ${renderTimeZoneField("reset_timezone", game.reset_timezone)}
                  </div>
                  <label style="display:block;"><input type="checkbox" name="paywall" value="1" ${game.paywall ? "checked" : ""} /> Paywall</label>
                  <label style="display:block;"><input type="checkbox" name="nsfw" value="1" ${game.nsfw ? "checked" : ""} /> NSFW</label>
                 <fieldset>
                   <legend>Categories</legend>
                   ${allCategories.results
                     .map((cat) => {
                       const checked = categories.results.some((c) => c.slug === cat.slug);
                       return `<label style="display:block;"><input type="checkbox" name="categories" value="${escapeHtml(cat.id)}" ${checked ? "checked" : ""} /> ${escapeHtml(cat.name)}</label>`;
                     })
                     .join("")}
                 </fieldset>
                 <button type="submit">Save Changes</button>
               </form>
               <p id="admin-edit-status" class="status" aria-live="polite"></p>
             </section>`
          : ""
      }
      ${
        user && (user.role === "admin" || user.role === "editor")
          ? `<section class="panel" id="add-to-list-section">
               <h2>Add to curated list</h2>
               <form id="add-to-list-form" class="stack-form">
                 <select name="listId" id="list-select" aria-label="Curated list" required>
                   <option value="">Select a list...</option>
                 </select>
                 <button type="submit">Add game</button>
               </form>
               <p id="add-to-list-status" class="status" aria-live="polite"></p>
             </section>`
          : ""
      }
    </main>
    <script type="application/json" id="data-game-page">${scriptJson({ id: game.id, title: game.title, slug: game.slug, vote: userVote })}</script>
    <script src="${ASSET.page_game_page}"></script>
  `, c.env, { path: `/games/${game.slug}`, description: metaDescription, noindex: game.status !== "approved",
    image: { path: `/og/games/${encodeURIComponent(game.slug)}.png?v=${ogVersion}`, alt: `${game.title}: ${gameKind} on 0x9 dles` },
    jsonLd: [breadcrumbLd([["Home", "/"], ["Games", "/games"], [game.title, `/games/${game.slug}`]]), gameLd] }));
});

// ---- Public profiles (/u/:handle, opt-in; see migrations/0026) ----

const PROFILE_HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,29}$/;
const RESERVED_PROFILE_HANDLES = new Set(["admin", "administrator", "editor", "mod", "moderator", "staff", "system", "support", "0x9", "dailies", "dles", "official"]);
const AVATAR_HOSTS = new Set(["cdn.discordapp.com", "static-cdn.jtvnw.net"]);

/** Provider avatars are only ever shown from the providers' own image CDNs. */
function safeAvatarUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && AVATAR_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Verified content creators: Twitch affiliates and partners (read from Twitch at every Twitch sign-in) plus anyone
 * an editor or admin grants ("manual"). A creator has one public list of their own, created the first time they
 * qualify; it is theirs from then on, so losing the status later never makes it private or removes it.
 */
async function syncCreatorStatus(env: Env, userId: string, profile: OAuthProfile): Promise<void> {
  if (profile.provider !== "twitch") return;
  const row = await env.DB.prepare("SELECT creator_type FROM users WHERE id = ?1").bind(userId).first<{ creator_type: string | null }>();
  if (!row) return;
  let next = row.creator_type;
  const allowlisted = !!(await env.DB.prepare("SELECT 1 AS ok FROM creator_allowlist WHERE twitch_user_id = ?1").bind(profile.providerUserId).first());
  if (profile.creatorType) {
    next = profile.creatorType;
  } else if (allowlisted) {
    // Verified by hand: not an affiliate or partner (any more), but staff have vouched for them.
    next = "manual";
  } else if (row.creator_type === "affiliate" || row.creator_type === "partner") {
    next = null;
  }
  if (next !== row.creator_type) {
    await env.DB.prepare("UPDATE users SET creator_type = ?2, updated_at = datetime('now') WHERE id = ?1").bind(userId, next).run();
    await writeAudit(env, userId, "user", userId, "creator_status", { from: row.creator_type, to: next });
  }
  if (next) {
    await ensureCreatorList(env, userId, { twitchId: profile.providerUserId, twitchLogin: profile.twitchLogin ?? null });
  }
}

/**
 * Gives a creator their public list if they don't have one. Games from any editor-tagged list for the same Twitch
 * channel are copied into it (in that list's order, without duplicates); the originals stay as they are. Public,
 * with suggestions open, by default. Returns the list id.
 */
async function ensureCreatorList(env: Env, userId: string, twitch?: { twitchId: string; twitchLogin: string | null }): Promise<string | null> {
  const existing = await env.DB.prepare("SELECT id, twitch_user_id FROM curated_lists WHERE owner_user_id = ?1 AND kind = 'creator'")
    .bind(userId)
    .first<{ id: string; twitch_user_id: string | null }>();
  if (existing) {
    // Keep the channel name fresh (renames), and attach a Twitch channel the list didn't have yet.
    if (twitch) {
      await env.DB.prepare("UPDATE curated_lists SET twitch_user_id = ?2, twitch_login = COALESCE(?3, twitch_login) WHERE id = ?1")
        .bind(existing.id, twitch.twitchId, twitch.twitchLogin)
        .run();
    }
    return existing.id;
  }
  const user = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?1").bind(userId).first<{ display_name: string | null }>();
  const name = (user?.display_name || twitch?.twitchLogin || "Creator").trim().slice(0, 60);
  const id = crypto.randomUUID();
  let slug = slugify(name) || "creator";
  // A taken slug (an editor's list for the same streamer, say) falls back to "-dailies", then to a short id.
  for (const candidate of [`${slug}-dailies`, `${slug}-${userId.slice(0, 6)}`]) {
    if (!(await env.DB.prepare("SELECT 1 FROM curated_lists WHERE slug = ?1").bind(slug).first())) break;
    slug = candidate;
  }
  const description = twitch ? `Daily games played by ${name} on Twitch.` : `Daily games picked by ${name}.`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO curated_lists (id, slug, title, description, visibility, owner_user_id, created_by_user_id, updated_by_user_id, twitch_login, twitch_user_id, suggestions_enabled, kind)
         VALUES (?1, ?2, ?3, ?4, 'public', ?5, ?5, ?5, ?6, ?7, 1, 'creator')`
      ).bind(id, slug, `${name}'s Dailies`, description, userId, twitch?.twitchLogin ?? null, twitch?.twitchId ?? null),
      // Copy from editor-tagged lists for the same channel: oldest list first, each game once, positions 1..n.
      env.DB.prepare(
        `INSERT INTO curated_list_items (curated_list_id, game_id, position, added_by_user_id)
         SELECT ?1, game_id, ROW_NUMBER() OVER (ORDER BY ord), ?2
         FROM (
           SELECT i.game_id AS game_id, MIN(l.created_at || '|' || printf('%06d', i.position)) AS ord
           FROM curated_list_items i
           JOIN curated_lists l ON l.id = i.curated_list_id
           WHERE ?3 IS NOT NULL AND l.twitch_user_id = ?3 AND l.kind = 'curated'
           GROUP BY i.game_id
         )`
      ).bind(id, userId, twitch?.twitchId ?? null)
    ]);
  } catch (error) {
    // A concurrent sign-in created it first.
    if (isUniqueViolation(error)) {
      return (await env.DB.prepare("SELECT id FROM curated_lists WHERE owner_user_id = ?1 AND kind = 'creator'").bind(userId).first<{ id: string }>())?.id ?? null;
    }
    throw error;
  }
  // Fan-dles members (and hidden games) from the streamer's earlier tagged list(s) carry over to their own list.
  if (twitch) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE OR IGNORE fandle_members SET list_id = ?1
         WHERE list_id IN (SELECT id FROM curated_lists WHERE twitch_user_id = ?2 AND kind = 'curated' AND id != ?1)`
      ).bind(id, twitch.twitchId),
      env.DB.prepare(
        `UPDATE OR IGNORE fandle_hidden SET list_id = ?1
         WHERE list_id IN (SELECT id FROM curated_lists WHERE twitch_user_id = ?2 AND kind = 'curated' AND id != ?1)`
      ).bind(id, twitch.twitchId)
    ]);
  }
  const copied = await env.DB.prepare("SELECT COUNT(*) AS n FROM curated_list_items WHERE curated_list_id = ?1").bind(id).first<{ n: number }>();
  await writeAudit(env, userId, "list", id, "create_creator_list", { slug, copiedGames: copied?.n ?? 0 });
  await invalidateGameCaches(env);
  return id;
}

/** Stores the picture a provider reported at sign-in, refreshed on every login or link. */
async function saveOAuthAvatar(env: Env, profile: OAuthProfile): Promise<void> {
  const avatarUrl = safeAvatarUrl(profile.avatarUrl);
  await env.DB.prepare("UPDATE oauth_accounts SET avatar_url = ?3 WHERE provider = ?1 AND provider_user_id = ?2")
    .bind(profile.provider, profile.providerUserId, avatarUrl)
    .run();
}

/** The current Twitch channel name for a stable Twitch id (followed through renames), cached for a few hours. */
async function getTwitchLoginById(env: Env, twitchId: string): Promise<string | null> {
  const cacheKey = `twitch:login:${twitchId}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return cached;
  const token = await getTwitchAppToken(env);
  if (!token) return null;
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(twitchId)}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": env.OAUTH_TWITCH_CLIENT_ID! },
      signal: AbortSignal.timeout(2500)
    });
    if (res.status === 401) await env.CACHE.delete("twitch:app_token");
    if (!res.ok) return null;
    const login = ((await res.json()) as { data?: Array<{ login: string }> }).data?.[0]?.login ?? null;
    if (login) await env.CACHE.put(cacheKey, login, { expirationTtl: 6 * 60 * 60 });
    return login;
  } catch {
    return null;
  }
}

const publicProfileSchema = z.object({
  public: z.boolean(),
  handle: z.preprocess((value) => (typeof value === "string" ? value.trim().toLowerCase() || null : value), z.string().regex(PROFILE_HANDLE_PATTERN).nullable()),
  showRotation: z.boolean(),
  showTwitch: z.boolean(),
  showStreak: z.boolean().optional(),
  avatarProvider: z.enum(["discord", "twitch"]).nullable()
});

app.put("/api/me/public-profile", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const rate = await enforceRateLimit(c.env, `public-profile:${auth.id}`, 30, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const parsed = publicProfileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Handles are 3-30 characters: letters, numbers, - and _" }, 400);
  }
  const { public: isPublic, handle, showRotation, showTwitch, avatarProvider, showStreak } = parsed.data;
  if (handle && RESERVED_PROFILE_HANDLES.has(handle)) {
    return c.json({ error: "That handle is reserved" }, 400);
  }
  if (isPublic && !handle) {
    return c.json({ error: "Choose a handle for your profile address first" }, 400);
  }
  const linked = new Set((await c.env.DB.prepare("SELECT provider FROM oauth_accounts WHERE user_id = ?1").bind(auth.id).all<{ provider: string }>()).results.map((row) => row.provider));
  if ((showTwitch && !linked.has("twitch")) || (avatarProvider && !linked.has(avatarProvider))) {
    return c.json({ error: "Link that account first" }, 400);
  }
  try {
    await c.env.DB.prepare(
      `UPDATE users SET profile_public = ?2, profile_handle = ?3, profile_show_rotation = ?4, profile_show_twitch = ?5,
              profile_avatar_provider = ?6, profile_show_streak = COALESCE(?7, profile_show_streak), updated_at = datetime('now')
       WHERE id = ?1`
    )
      .bind(auth.id, isPublic ? 1 : 0, handle, showRotation ? 1 : 0, showTwitch ? 1 : 0, avatarProvider, showStreak === undefined ? null : showStreak ? 1 : 0)
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) {
      return c.json({ error: "That handle is taken" }, 409);
    }
    throw error;
  }
  await writeAudit(c.env, auth.id, "user", auth.id, "update_public_profile", { public: isPublic, handle });
  return c.json({ ok: true, handle });
});

app.get("/u/:handle", async (c) => {
  const user = c.get("user");
  const owner = await c.env.DB.prepare(
    `SELECT id, display_name, role, creator_type, profile_handle, profile_public, profile_show_rotation, profile_show_twitch, profile_show_streak, profile_avatar_provider
     FROM users WHERE profile_handle = ?1`
  )
    .bind(c.req.param("handle").toLowerCase())
    .first<{ id: string; display_name: string | null; role: AppUser["role"]; creator_type: string | null; profile_handle: string; profile_public: number; profile_show_rotation: number; profile_show_twitch: number; profile_show_streak: number; profile_avatar_provider: string | null }>();
  // A profile that isn't public looks like no profile at all, except to its owner (who gets a preview).
  const isOwner = !!user && !!owner && user.id === owner.id;
  if (!owner || (!owner.profile_public && !isOwner)) {
    return notFoundPage(c);
  }

  const accounts = await c.env.DB.prepare("SELECT provider, provider_user_id, avatar_url FROM oauth_accounts WHERE user_id = ?1")
    .bind(owner.id)
    .all<{ provider: string; provider_user_id: string; avatar_url: string | null }>();
  const avatarUrl = safeAvatarUrl(accounts.results.find((row) => row.provider === owner.profile_avatar_provider)?.avatar_url);
  const twitchAccount = owner.profile_show_twitch ? accounts.results.find((row) => row.provider === "twitch") : undefined;
  const twitchLogin = twitchAccount ? await getTwitchLoginById(c.env, twitchAccount.provider_user_id) : null;

  const developed = await listGames(c.env, { sort: "top", limit: 60, developerUserId: owner.id });
  const { votes: userVotes, favorites: userFavorites } = await getViewerGameState(c, developed.map((game) => game.id));
  const rotation = owner.profile_show_rotation
    ? (await c.env.DB.prepare(
        `SELECT games.title, games.slug, games.paywall, games.nsfw
         FROM favorites JOIN games ON games.id = favorites.game_id
         WHERE favorites.user_id = ?1 AND games.status = 'approved'
         ORDER BY favorites.position ASC LIMIT 100`
      )
        .bind(owner.id)
        .all<{ title: string; slug: string; paywall: number; nsfw: number }>()).results
    : [];

  // Public lists the owner made (their creator list included), with games, same verified check as /lists.
  const ownedLists = (
    await c.env.DB.prepare(
      `SELECT curated_lists.slug, curated_lists.title, curated_lists.twitch_login,
              CASE WHEN ${VERIFIED_LIST_SQL} THEN 1 ELSE 0 END AS is_creator_list,
              (SELECT COUNT(*) FROM curated_list_items WHERE curated_list_id = curated_lists.id) AS game_count
       FROM curated_lists
       LEFT JOIN users ON users.id = curated_lists.owner_user_id
       WHERE curated_lists.owner_user_id = ?1 AND curated_lists.visibility = 'public'
       ORDER BY curated_lists.kind = 'creator' DESC, curated_lists.updated_at DESC`
    )
      .bind(owner.id)
      .all<{ slug: string; title: string; twitch_login: string | null; is_creator_list: number; game_count: number }>()
  ).results.filter((row) => row.game_count > 0);
  let streakRow = "";
  if (owner.profile_show_streak) {
    const row = await c.env.DB.prepare("SELECT last, count, best, day_log FROM user_streaks WHERE user_id = ?1")
      .bind(owner.id)
      .first<{ last: string; count: number; best: number; day_log: string }>();
    if (row) {
      // The owner's time zone is unknown: a streak is current if it was last extended within the last 2 UTC days.
      const dayKey = (offset: number) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
      const current = row.last >= dayKey(2) ? row.count : 0;
      let log: Record<string, number> = {};
      try {
        const parsed = JSON.parse(row.day_log || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) log = parsed;
      } catch {
        // Ignore a corrupt log.
      }
      const since = dayKey(29);
      const played = Object.entries(log).filter(([day, n]) => day >= since && Number(n) > 0).length;
      const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
      streakRow = `<p class="profile-streak muted">Current streak: <strong>${days(current)}</strong> &middot; Best: <strong>${days(Math.max(row.best, current))}</strong> &middot; Played ${days(played)} in the last 30</p>`;
    }
  }
  const name = owner.display_name || owner.profile_handle;
  const badges = [
    owner.creator_type ? `<span class="profile-badge profile-badge-dev">${renderCheckBadge("Verified content creator")} ${owner.creator_type === "partner" ? "Twitch Partner" : owner.creator_type === "affiliate" ? "Twitch Affiliate" : "Verified creator"}</span>` : "",
    owner.role === "admin" ? `<span class="profile-badge profile-badge-staff">Admin</span>` : "",
    owner.role === "editor" ? `<span class="profile-badge profile-badge-staff">Editor</span>` : "",
    developed.length > 0 ? `<span class="profile-badge profile-badge-dev">${renderCheckBadge("Verified developer")} Verified developer</span>` : ""
  ].join("");
  const initial = escapeHtml([...name][0]?.toUpperCase() ?? "?");
  return c.html(await layout(`${name}`, user, `
    <main class="narrow">
      ${!owner.profile_public ? `<p class="panel profile-preview">Only you can see this page. <a href="/me/settings">Make your profile public</a> in Settings to share it.</p>` : ""}
      <header class="profile-head">
        ${avatarUrl
          ? `<img class="profile-avatar" src="${escapeHtml(avatarUrl)}" alt="" width="96" height="96" referrerpolicy="no-referrer" />`
          : `<span class="profile-avatar profile-avatar-initial" aria-hidden="true">${initial}</span>`}
        <div>
          <h1>${escapeHtml(name)}</h1>
          ${badges ? `<p class="profile-badges">${badges}</p>` : ""}
          ${twitchLogin ? `<p class="twitch-watch"><a class="btn btn-twitch" href="https://www.twitch.tv/${encodeURIComponent(twitchLogin)}" target="_blank" rel="noopener noreferrer">${TWITCH_ICON_SVG}<span>${escapeHtml(twitchLogin)} on Twitch</span><span class="external-arrow" aria-hidden="true">↗</span><span class="visually-hidden"> (opens in a new tab)</span></a></p>` : ""}
        </div>
      </header>
      ${streakRow}
      ${ownedLists.length > 0 ? `<section>
        <h2>Lists</h2>
        <ul class="list-index">
          ${ownedLists.map((row) => `<li${row.twitch_login ? ` data-live-list="${escapeHtml(row.slug)}" data-live-login="${escapeHtml(row.twitch_login)}"` : ""}><a href="/lists/${encodeURIComponent(row.slug)}">${escapeHtml(row.title)}</a>${row.is_creator_list ? renderCheckBadge("Verified content creator") : renderVerifiedBadge(row.twitch_login)}
            <br /><small class="muted">${row.game_count} game${row.game_count === 1 ? "" : "s"}</small></li>`).join("")}
        </ul>
      </section>` : ""}
      ${developed.length > 0 ? `<section>
        <h2>Games by ${escapeHtml(name)}</h2>
        ${renderCompactGameList(developed.map((game) => ({ ...game, developer: null })), user, userVotes, userFavorites)}
      </section>` : ""}
      ${rotation.length > 0 ? `<section>
        <h2>Daily rotation</h2>
        <ol class="profile-rotation">${rotation.map((item) => `<li><a href="/games/${encodeURIComponent(item.slug)}">${renderRowTitle(item.title, item.paywall, item.nsfw)}</a></li>`).join("")}</ol>
      </section>` : ""}
      ${developed.length === 0 && rotation.length === 0 && ownedLists.length === 0 ? `<p class="muted">Nothing to show here yet.</p>` : ""}
    </main>
    ${developed.length > 0 ? renderGameListInteractionScript({ includeImportPanel: false, promptFromQuery: false }) : ""}
  `, c.env, { path: `/u/${owner.profile_handle}`, noindex: true, description: `${name} on 0x9 dles.` }));
});

app.get("/rotation/:shareToken", async (c) => {
  const shareToken = c.req.param("shareToken");
  const user = c.get("user");
  
  // Find the user with this share token
  const owner = await c.env.DB.prepare(
    "SELECT id, display_name FROM users WHERE rotation_share_token = ?1"
  )
    .bind(shareToken)
    .first<{ id: string; display_name: string | null }>();
  
  if (!owner) {
    return c.text("Rotation not found or link has been disabled", 404);
  }
  
  const favorites = await c.env.DB.prepare(
    `SELECT games.id, games.title, games.slug, games.url, games.paywall, games.nsfw, games.reset_basis, games.reset_time_minutes, games.reset_timezone, favorites.position
     FROM favorites
     JOIN games ON games.id = favorites.game_id
     WHERE favorites.user_id = ?1
     ORDER BY favorites.position ASC`
  )
    .bind(owner.id)
    .all<{ id: string; title: string; slug: string; url: string; paywall: number; nsfw: number; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null; position: number }>();

  const categoriesByGameId = await getCategoriesForGames(c.env, favorites.results.map((item) => item.id));
  const developersByGameId = await getDevelopersForGames(c.env, favorites.results.map((item) => item.id));
  const ownerName = owner.display_name || "Someone";

  return c.html(await layout(`${ownerName}'s Rotation`, user, `
    <main class="narrow">
      <h1>${escapeHtml(ownerName)}'s Daily Rotation</h1>
      <p>This is a shared view of ${escapeHtml(ownerName)}'s favorite daily games.</p>
      ${favorites.results.length > 0 && user?.id !== owner.id ? `<div id="rotation-compare" class="muted" hidden></div><p><button type="button" id="copy-rotation-btn">Copy to my rotation</button> <label id="only-new-label" hidden><input type="checkbox" id="only-new-toggle"> Show only new to you</label></p>` : ""}
      ${favorites.results.length > 0 ? `
        ${renderListSortControl({ rotation: true })}
        <ol class="rotation-list" id="shared-rotation-list">
          ${favorites.results
            .map(
              (item) => {
                const reset = renderResetItemData(item.reset_basis, item.reset_time_minutes, item.reset_timezone);
                return `<li class="card-click" data-game-id="${item.id}" ${reset.attrs}>
                <div class="item-main">
                  <a class="game-title card-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${renderRowTitle(item.title, item.paywall, item.nsfw)}</a>
                  ${renderCategoryPills(categoriesByGameId.get(item.id), developersByGameId.get(item.id))}
                  ${reset.span ? `<div class="meta">${reset.span}</div>` : ""}
                </div>
                <div class="card-actions">
                  ${renderDetailsLink(item.slug, item.title)}
                </div>
              </li>`;
              }
            )
            .join("")}
        </ol>
      ` : '<p>No favorites in this rotation yet.</p>'}
    </main>
    <script src="${ASSET.listSortJs}"></script>
    <script>
      window.dglListSort.init(document.getElementById("shared-rotation-list"), document.getElementById("list-sort-select"));
      (() => {
        const button = document.getElementById("copy-rotation-btn");
        if (!button) return;
        const games = ${scriptJson(favorites.results.map((item) => ({ id: item.id, slug: item.slug, title: item.title })))};
        let missing = games;
        button.addEventListener("click", async () => {
          button.disabled = true;
          const result = await window.dglAddManyToRotation(missing);
          if (result && result.ok && result.added > 0) {
            // Re-run the comparison so pills, counts and the button reflect the new rotation.
            compare();
          } else {
            button.disabled = false;
          }
        });
        // Per-visitor comparison runs client-side so this page carries no visitor state.
        const compare = async () => {
          let mine = [];
          try {
            const session = await fetch("/api/me/session").then((r) => (r.ok ? r.json() : null), () => null);
            if (!session) return;
            if (session.signedIn) {
              const r = await fetch("/api/me/favorites/export");
              const body = r.ok ? await r.json() : null;
              mine = body && Array.isArray(body.items) ? body.items.map((i) => i.id) : [];
            } else {
              mine = window.dglGames.readLocalFavorites().map((i) => i.id);
            }
          } catch { return; }
          if (mine.length === 0) return;
          const have = new Set(mine);
          const theirs = new Set(games.map((g) => g.id));
          const both = games.filter((g) => have.has(g.id)).length;
          missing = games.filter((g) => !have.has(g.id));
          const yoursOnly = mine.filter((id) => !theirs.has(id)).length;
          document.querySelectorAll("#shared-rotation-list > li").forEach((li) => {
            const has = have.has(li.dataset.gameId);
            li.dataset.inYours = has ? "1" : "0";
            const existing = li.querySelector(".in-rotation-pill");
            if (has && !existing) {
              const pill = document.createElement("span");
              pill.className = "tag in-rotation-pill";
              pill.textContent = "In your rotation";
              li.querySelector(".item-main").appendChild(pill);
            }
          });
          const box = document.getElementById("rotation-compare");
          const plural = (n) => n + (n === 1 ? " game" : " games");
          box.textContent = missing.length === 0 && yoursOnly === 0
            ? "This matches your rotation."
            : "You both play " + plural(both) + " \u00b7 " + missing.length + " new to you \u00b7 " + yoursOnly + " of yours " + (yoursOnly === 1 ? "isn't" : "aren't") + " in this one";
          box.hidden = false;
          if (both > 0) button.textContent = missing.length === 0 ? "You have all of these" : "Add the " + missing.length + " new " + (missing.length === 1 ? "game" : "games");
          button.disabled = missing.length === 0;
          const label = document.getElementById("only-new-label");
          const toggle = document.getElementById("only-new-toggle");
          label.hidden = both === 0 || missing.length === 0;
          const apply = () => document.querySelectorAll("#shared-rotation-list > li").forEach((li) => { li.hidden = toggle.checked && li.dataset.inYours === "1"; });
          if (!toggle.dataset.bound) { toggle.dataset.bound = "1"; toggle.addEventListener("change", apply); }
          apply();
        };
        compare();
      })();
    </script>
  `, c.env, { path: `/rotation/${shareToken}`, description: `${ownerName}'s shared daily game rotation.`, noindex: true }));
});

// Shown by the service worker when a page isn't cached and there's no connection. Always rendered logged-out (it is
// precached by the worker and may be edge-cached), so it carries no per-visitor state.
app.get("/offline", async (c) => c.html(await layout("Offline", null, `
  <main class="narrow" data-offline-page>
    <h1>You're offline</h1>
    <p>This page isn't saved on your device yet. Check your connection and try again.</p>
    <div class="actions"><button type="button" data-offline-retry>Retry</button></div>
    <p><a href="/me/rotation">Your rotation, as of your last visit</a></p>
  </main>
`, c.env, { path: "/offline", description: "You're offline.", noindex: true })));

app.get("/me/rotation", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.html(await layout("My Rotation", null, `
      <main class="narrow">
        <h1>My Daily Rotation</h1>
        <p>Your favorites are stored in this browser via local storage.</p>
        <p><a href="/login">Sign in</a> to sync favorites across devices.</p>
        <div class="actions">
          <button type="button" id="export-btn">Export JSON</button>
          <button type="button" id="copy-text-btn" hidden>Copy as text</button>
          <button type="button" id="import-btn">Import JSON</button>
          <button type="button" id="rotation-paste-btn" aria-expanded="false" aria-controls="rotation-paste-panel">Import games</button>
          <input type="file" id="import-file" accept=".json" hidden>
        </div>
        <p id="import-status" class="status" aria-live="polite"></p>
        <section id="rotation-paste-panel" class="panel" hidden aria-labelledby="rotation-paste-title">
        <h2 id="rotation-paste-title">Import games</h2>
        <label for="rotation-paste-text">Paste game names or links, one per line or separated by commas.</label>
        <textarea id="rotation-paste-text" rows="6" maxlength="10000" placeholder="1. Wordle ✅&#10;- Connections https://www.nytimes.com/games/connections"></textarea>
        <div class="actions">
          <button type="button" id="rotation-paste-preview">Preview</button>
          <button type="button" id="rotation-paste-close" class="secondary">Close</button>
        </div>
        <p id="rotation-paste-status" class="status" aria-live="polite"></p>
        <div id="rotation-paste-results" class="paste-results" hidden>
          <ul id="rotation-paste-rows" class="paste-rows"></ul>
          <div class="actions"><button type="button" id="rotation-paste-add" disabled>Add games</button></div>
        </div>
      </section>
        ${DAILY_PROGRESS_MARKUP}
        ${renderListSortControl({ rotation: true })}
        <ol id="local-rotation-list" class="rotation-list"></ol>
        <p id="rotation-status" class="status" aria-live="polite"></p>
      </main>
      <script src="${ASSET.listSortJs}"></script>
      <script src="${ASSET.page_rotation_signed_in}"></script>
      <script src="${ASSET.page_rotation_paste}"></script>
      <script src="${ASSET.dailyProgressJs}"></script>
      <script>
        window.dglDailyProgress("local-rotation-list");
      </script>
      <script src="${ASSET.rotationWeekJs}"></script>
      <div class="install-app muted" data-install-app hidden><button type="button" class="link-button" hidden>Install app</button><small class="install-ios" hidden>On iPhone or iPad: tap Share, then Add to Home Screen.</small></div>
      <script src="${ASSET.installJs}"></script>
  `, c.env, { path: "/me/rotation", description: "Your personal daily game rotation. Drag to reorder, export, and share." }));
  }

  const userWithTokenP = c.env.DB.prepare(
    "SELECT rotation_share_token FROM users WHERE id = ?1"
  )
    .bind(user.id)
    .first<{ rotation_share_token: string | null }>();
  const favorites = await c.env.DB.prepare(
    `SELECT games.id, games.title, games.slug, games.url, games.paywall, games.nsfw, games.reset_basis, games.reset_time_minutes, games.reset_timezone, favorites.position, favorites.weekday_mask
     FROM favorites
     JOIN games ON games.id = favorites.game_id
     WHERE favorites.user_id = ?1
     ORDER BY favorites.position ASC`
  )
    .bind(user.id)
    .all<{ id: string; title: string; slug: string; url: string; paywall: number; nsfw: number; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null; position: number; weekday_mask: number }>();

  const [categoriesByGameId, developersByGameId, userWithToken] = await Promise.all([
    getCategoriesForGames(c.env, favorites.results.map((item) => item.id)),
    getDevelopersForGames(c.env, favorites.results.map((item) => item.id)),
    userWithTokenP
  ]);

  const shareToken = userWithToken?.rotation_share_token;
  const shareUrl = shareToken ? `${shortOrigin(c.env) ?? appOrigin(c.env)}/r/${shareToken}` : null;

  return c.html(await layout("My Rotation", user, `
    <main class="narrow">
      <div class="page-head">
        <h1>My Daily Rotation</h1>
        <div class="actions">
          ${shareUrl ? `
            <button type="button" id="copy-share-btn" style="white-space: nowrap;">Copy Share Link</button>
            <button type="button" id="disable-share-btn" style="white-space: nowrap;">Disable</button>
          ` : `
            <button type="button" id="generate-share-btn" style="white-space: nowrap;">Generate Share Link</button>
          `}
        </div>
      </div>
      <p id="share-status" class="status" aria-live="polite"></p>
      <p>Drag games to reorder your daily flow.</p>
      <section id="rotation-local-import-panel" class="panel" hidden>
        <h2>Import local favorites</h2>
        <p id="rotation-local-import-summary">Checking this browser for local favorites...</p>
        <div class="actions">
          <button type="button" id="rotation-local-import-btn">Import to account</button>
          <button type="button" id="rotation-local-import-dismiss">Not now</button>
        </div>
        <p id="rotation-local-import-status" class="status" aria-live="polite"></p>
      </section>
      <div class="actions">
        ${favorites.results.length > 0 ? `<button type="button" id="export-btn">Export JSON</button><button type="button" id="copy-text-btn">Copy as text</button>` : ""}
        <button type="button" id="import-btn">Import JSON</button>
        <button type="button" id="rotation-paste-btn" aria-expanded="false" aria-controls="rotation-paste-panel">Import games</button>
        <input type="file" id="import-file" accept=".json" hidden>
      </div>
      <p id="import-status" class="status" aria-live="polite"></p>
      <section id="rotation-paste-panel" class="panel" hidden aria-labelledby="rotation-paste-title">
        <h2 id="rotation-paste-title">Import games</h2>
        <label for="rotation-paste-text">Paste game names or links, one per line or separated by commas.</label>
        <textarea id="rotation-paste-text" rows="6" maxlength="10000" placeholder="1. Wordle ✅&#10;- Connections https://www.nytimes.com/games/connections"></textarea>
        <div class="actions">
          <button type="button" id="rotation-paste-preview">Preview</button>
          <button type="button" id="rotation-paste-close" class="secondary">Close</button>
        </div>
        <p id="rotation-paste-status" class="status" aria-live="polite"></p>
        <div id="rotation-paste-results" class="paste-results" hidden>
          <ul id="rotation-paste-rows" class="paste-rows"></ul>
          <div class="actions"><button type="button" id="rotation-paste-add" disabled>Add games</button></div>
        </div>
      </section>
      ${favorites.results.length > 0 ? DAILY_PROGRESS_MARKUP + renderListSortControl({ rotation: true }) : `<div class="empty-state"><p>Your rotation is empty. Tap ☆ on any game to add it here.</p><a class="btn" href="/games">Browse games</a></div>`}
      <ol id="rotation-list" class="rotation-list">
        ${favorites.results
          .map(
            (item) => {
              const reset = renderResetItemData(item.reset_basis, item.reset_time_minutes, item.reset_timezone);
              return `<li class="card-click" data-game-id="${item.id}" data-game-slug="${escapeHtml(item.slug)}" data-game-title="${escapeHtml(item.title)}" data-weekday-mask="${item.weekday_mask}" ${reset.attrs}>
              <span class="drag">::</span>
              <div class="item-main">
                <a class="game-title card-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${renderRowTitle(item.title, item.paywall, item.nsfw)}</a>
                ${renderCategoryPills(categoriesByGameId.get(item.id), developersByGameId.get(item.id))}
                ${reset.span ? `<div class="meta">${reset.span}</div>` : ""}
              </div>
              <div class="card-actions">
                <div class="reorder-controls">
                  <button type="button" data-move="up" aria-label="Move up">↑</button>
                  <button type="button" data-move="down" aria-label="Move down">↓</button>
                </div>
                ${renderDetailsLink(item.slug, item.title)}
                <button type="button" data-unfavorite="${item.id}">X</button>
              </div>
            </li>`;
            }
          )
          .join("")}
      </ol>
      <p id="rotation-status" class="status" aria-live="polite"></p>
    </main>
    <script src="${ASSET.listSortJs}"></script>
    <script>
      window.dglListSort.init(document.getElementById("rotation-list"), document.getElementById("list-sort-select"));
    </script>
    <script src="${ASSET.dailyProgressJs}"></script>
    <script>
      window.dglDailyProgress("rotation-list");
    </script>
    <script src="${ASSET.rotationWeekJs}"></script>
    <script type="application/json" id="data-rotation-share">${scriptJson({ shareUrl })}</script>
    <script src="${ASSET.page_rotation_share}"></script>
    <script src="${ASSET.page_rotation_paste}"></script>
    <div class="install-app muted" data-install-app hidden><button type="button" class="link-button" hidden>Install app</button><small class="install-ios" hidden>On iPhone or iPad: tap Share, then Add to Home Screen.</small></div>
    <script src="${ASSET.installJs}"></script>
  `, c.env, { path: "/me/rotation", description: "Your personal daily game rotation. Drag to reorder, export, and share." }));
});

app.get("/me/settings", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }

  const sessionToken = getCookie(c, c.env.SESSION_COOKIE_NAME) || "";
  const currentSessionId = sessionToken ? await hashToken(c.env.SESSION_SECRET, sessionToken) : "";
  const sessions = await c.env.DB.prepare(
    `SELECT id, created_at, expires_at
     FROM sessions
     WHERE user_id = ?1 AND datetime(expires_at) > datetime('now')
     ORDER BY created_at DESC
     LIMIT 30`
  )
    .bind(auth.id)
    .all<{ id: string; created_at: string; expires_at: string }>();

  const linkedProviders = new Set(
    (await c.env.DB.prepare("SELECT provider FROM oauth_accounts WHERE user_id = ?1").bind(auth.id).all<{ provider: string }>()).results.map((r) => r.provider)
  );
  const providerNames: Record<OAuthProvider, string> = { discord: "Discord", twitch: "Twitch" };
  const publicProfile = await c.env.DB.prepare(
    "SELECT profile_handle, profile_public, profile_show_rotation, profile_show_twitch, profile_show_streak, profile_avatar_provider FROM users WHERE id = ?1"
  )
    .bind(auth.id)
    .first<{ profile_handle: string | null; profile_public: number; profile_show_rotation: number; profile_show_twitch: number; profile_show_streak: number; profile_avatar_provider: string | null }>();
  const avatarProviders = new Set(
    (await c.env.DB.prepare("SELECT provider, avatar_url FROM oauth_accounts WHERE user_id = ?1").bind(auth.id).all<{ provider: string; avatar_url: string | null }>()).results
      .filter((row) => safeAvatarUrl(row.avatar_url))
      .map((row) => row.provider)
  );
  const suggestedHandle = slugify(auth.displayName || "").slice(0, 30);
  const creator = await c.env.DB.prepare(
    `SELECT users.creator_type, curated_lists.slug, curated_lists.visibility, curated_lists.suggestions_enabled
     FROM users LEFT JOIN curated_lists ON curated_lists.owner_user_id = users.id AND curated_lists.kind = 'creator'
     WHERE users.id = ?1`
  )
    .bind(auth.id)
    .first<{ creator_type: string | null; slug: string | null; visibility: string | null; suggestions_enabled: number | null }>();
  const creatorLabel = creator?.creator_type === "partner" ? "Twitch Partner" : creator?.creator_type === "affiliate" ? "Twitch Affiliate" : "verified creator";
  const linkResult = c.req.query("link");
  const linkProvider = c.req.query("provider") === "twitch" ? "Twitch" : "Discord";
  const linkMessages: Record<string, string> = {
    linked: `${linkProvider} account linked. You can now sign in with either.`,
    merged: `${linkProvider} account linked. Its favorites, votes and submissions were merged into this account.`,
    already: `That ${linkProvider} account was already linked to this account.`,
    conflict: `Couldn't link that ${linkProvider} account: it would give this account two sign-ins from the same service. Unlink the existing one first, then try again.`
  };
  const accountRows = (["discord", "twitch"] as const)
    .filter((provider) => oauthClientId(c.env, provider))
    .map((provider) => {
      const name = providerNames[provider];
      const icon = provider === "discord" ? DISCORD_ICON_SVG : TWITCH_ICON_SVG;
      return `<li>
        <span class="linked-account-name">${icon} ${name}</span>
        ${
          linkedProviders.has(provider)
            ? `<span class="linked-account-status">✓ Linked</span>${linkedProviders.size > 1 ? `<button type="button" data-unlink="${provider}">Unlink</button>` : ""}`
            : `<form method="post" action="/auth/${provider}/link" class="link-account-form"><button type="submit" class="btn btn-${provider}">Link ${name}</button></form>`
        }
      </li>`;
    })
    .join("");

  return c.html(await layout("Account Settings", auth, `
    <main class="narrow">
      <h1>Account Settings</h1>
      <section class="panel">
        <h2>Profile</h2>
        <p class="muted"><small>Your played games sync across devices while you're signed in. <a href="/me/recap">Monthly recap</a></small></p>
        <form id="profile-form" class="stack-form">
          <label for="display-name">Display name</label>
          <input id="display-name" name="displayName" maxlength="80" placeholder="Your name" value="${escapeHtml(auth.displayName || "")}" />
          <button type="submit">Save profile</button>
        </form>
      </section>
      ${creator?.creator_type && creator.slug ? `<section class="panel">
        <h2>Creator list</h2>
        <p>You're a ${escapeHtml(creatorLabel)}, so you get a verified check and a list of your own. It's <strong>${escapeHtml(creator.visibility || "public")}</strong> and suggestions from viewers are <strong>${creator.suggestions_enabled === 1 ? "open" : "off"}</strong>. Anyone can suggest games to a public list; you decide what gets added.</p>
        <p><a class="btn" href="/lists/${encodeURIComponent(creator.slug)}">View your list</a> <a href="/lists/${encodeURIComponent(creator.slug)}?edit=1">Edit it, or make it private</a></p>
      </section>` : ""}
      <section class="panel">
        <h2>Public profile</h2>
        <p>A page at <code>/u/your-handle</code> with your name, picture, badges (verified developer, staff, Twitch channel) and the games you've made. It's off until you turn it on, and only shows what you pick below.</p>
        <form id="public-profile-form" class="stack-form">
          <label class="check"><input type="checkbox" name="public" ${publicProfile?.profile_public ? "checked" : ""} /> Make my profile public</label>
          <label>Handle <small>(your profile address: letters, numbers, - and _)</small>
            <input type="text" name="handle" maxlength="30" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${escapeHtml(suggestedHandle || "your-handle")}" value="${escapeHtml(publicProfile?.profile_handle || "")}" />
          </label>
          <label class="check"><input type="checkbox" name="showRotation" ${publicProfile?.profile_show_rotation ? "checked" : ""} /> Show my daily rotation</label>
          <label class="check"><input type="checkbox" name="showStreak" ${publicProfile?.profile_show_streak ? "checked" : ""} /> Show my streak on my public profile</label>
          ${linkedProviders.has("twitch") ? `<label class="check"><input type="checkbox" name="showTwitch" ${publicProfile?.profile_show_twitch ? "checked" : ""} /> Show a link to my Twitch channel</label>` : ""}
          <fieldset>
            <legend>Picture</legend>
            <label class="check"><input type="radio" name="avatarProvider" value="" ${!publicProfile?.profile_avatar_provider ? "checked" : ""} /> Initial only</label>
            ${(["discord", "twitch"] as const)
              .filter((provider) => linkedProviders.has(provider))
              .map((provider) => `<label class="check"><input type="radio" name="avatarProvider" value="${provider}" ${publicProfile?.profile_avatar_provider === provider ? "checked" : ""} /> ${providerNames[provider]} picture${avatarProviders.has(provider) ? "" : " (appears after you next sign in with it)"}</label>`)
              .join("")}
          </fieldset>
          <button type="submit">Save public profile</button>
        </form>
        ${publicProfile?.profile_handle ? `<p><a href="/u/${encodeURIComponent(publicProfile.profile_handle)}">${publicProfile.profile_public ? "View" : "Preview"} my profile</a></p>` : ""}
      </section>
      <section class="panel">
        <h2>App</h2>
        <p>Install 0x9 dles for quick access from your home screen or desktop.</p>
        <div class="install-app muted" data-install-app hidden><button type="button" class="link-button" hidden>Install app</button><small class="install-ios" hidden>On iPhone or iPad: tap Share, then Add to Home Screen.</small></div>
      <script src="${ASSET.installJs}"></script>
      </section>
      <section class="panel">
        <h2>Sign-in accounts</h2>
        <p>Link Discord and Twitch to sign in with either one. If the account you link already has its own 0x9 dles profile, it's merged into this one: favorites, votes and submissions move over.</p>
        ${linkResult && linkMessages[linkResult] ? `<p class="status${linkResult === "conflict" ? " error" : ""}" role="status">${escapeHtml(linkMessages[linkResult])}</p>` : ""}
        <ul class="linked-accounts">${accountRows}</ul>
      </section>
      <section class="panel">
        <h2>Sessions</h2>
        <p>Revoke any session you no longer recognize.</p>
        <ul>
          ${sessions.results
            .map(
              (session) => `<li>
                <code>${escapeHtml(session.id.slice(0, 12))}...</code>
                · created ${escapeHtml(session.created_at)}
                · expires ${escapeHtml(session.expires_at)}
                ${session.id === currentSessionId ? "· current session" : `<button type=\"button\" data-session-revoke=\"${session.id}\">Revoke</button>`}
              </li>`
            )
            .join("")}
        </ul>
      </section>
      <section class="panel" id="your-data">
        <h2>Your data</h2>
        <p>Download your play history, or clear it. Clearing removes your play history, streak and recap data on every device. Your rotation stays.</p>
        <div class="actions">
          <a class="button" href="/api/me/plays/export?format=json" download>Download JSON</a>
          <a class="button" href="/api/me/plays/export?format=csv" download>Download CSV</a>
          <button type="button" id="plays-clear" class="danger">Clear play history</button>
        </div>
      </section>
      <section class="panel" id="push-devices-panel" hidden>
        <h2>Reminder notifications</h2>
        <p>Devices that get your reset reminders. <a href="/me/rotation">Turn on reminders</a> on a device from your rotation.</p>
        <ul id="push-devices-list" class="stack"></ul>
      </section>
      <section class="panel" id="hidden-games-panel" hidden>
        <h2>Hidden games</h2>
        <p>Games you hid from the home page and Browse. This is saved in this browser only.</p>
        <ul id="hidden-games-list" class="hidden-games-list"></ul>
        <div class="actions"><button type="button" id="hidden-games-clear">Unhide all</button></div>
      </section>
      <p id="me-settings-status" class="status" aria-live="polite"></p>
    </main>
    <script src="${ASSET.page_settings_hidden}"></script>
    <script src="${ASSET.page_settings_page}"></script>
  `, c.env));
});

app.get("/lists", async (c) => {
  const user = c.get("user");
  const isAdminEditor = !!user && (user.role === "editor" || user.role === "admin");
  const lists = await c.env.DB.prepare(
    `SELECT curated_lists.id, curated_lists.slug, curated_lists.title, curated_lists.description, curated_lists.visibility, curated_lists.owner_user_id,
            curated_lists.twitch_login, curated_lists.twitch_user_id,
            CASE WHEN ${VERIFIED_LIST_SQL} THEN 1 ELSE 0 END AS is_creator_list,
            (SELECT COUNT(*) FROM curated_list_items WHERE curated_list_id = curated_lists.id) AS game_count
     FROM curated_lists
     LEFT JOIN users ON users.id = curated_lists.owner_user_id
     ORDER BY curated_lists.updated_at DESC`
  ).all<{
    is_creator_list: number;
    game_count: number;
    id: string;
    slug: string;
    title: string;
    description: string | null;
    visibility: "public" | "private";
    owner_user_id: string;
    twitch_login: string | null;
    twitch_user_id: string | null;
  }>();

  const userTwitchId = await getUserTwitchId(c.env, user);
  // A creator's list starts out empty; it joins the index once it has games (its owner and staff always see it).
  const visible = lists.results.filter(
    (row) =>
      canViewList(row.visibility, row.owner_user_id, user, { listTwitchUserId: row.twitch_user_id, userTwitchId }) &&
      (row.game_count > 0 || isAdminEditor || (!!user && row.owner_user_id === user.id))
  );
  return c.html(await layout("Curated Lists of Daily Games", user, `
    <main class="narrow">
      <h1>Curated Lists</h1>
      ${isAdminEditor ? `
        <section class="panel">
          <h2>Create list</h2>
          <form id="create-list-form" class="stack-form">
            <input name="title" placeholder="List title" aria-label="List title" required />
            <textarea name="description" rows="2" placeholder="Description" aria-label="Description"></textarea>
            <select name="visibility" aria-label="Visibility">
              <option value="private">private</option>
              <option value="public">public</option>
            </select>
            <button type="submit">Create list</button>
          </form>
          <p id="create-list-status" class="status" aria-live="polite"></p>
        </section>
      ` : ""}
      ${visible.length > 0 ? `
        <ul class="list-index">
          ${visible
            .map((row) => `<li${row.twitch_login && row.visibility === "public" ? ` data-live-list="${escapeHtml(row.slug)}" data-live-login="${escapeHtml(row.twitch_login)}"` : ""}><a href="/lists/${row.slug}">${escapeHtml(row.title)}</a>${row.is_creator_list ? renderCheckBadge("Verified content creator") : renderVerifiedBadge(row.twitch_login)}${row.visibility === "private" ? " <small>(private)</small>" : ""}
              <br /><small class="muted">${row.game_count} game${row.game_count === 1 ? "" : "s"}${row.twitch_login ? ` · picked by ${escapeHtml(row.twitch_login)} on Twitch` : ""}${row.description ? ` · ${escapeHtml(row.description)}` : ""}</small></li>`)
            .join("")}
        </ul>
      ` : `<p>No curated lists yet.</p>`}
    </main>
    <script src="${ASSET.page_lists_page}"></script>
    <script src="${ASSET.liveBadgesJs}"></script>
  `, c.env, { path: "/lists", description: "Curated lists of daily games picked by editors and Twitch streamers. See which dailies they play, then add them to your own rotation.", jsonLd: [breadcrumbLd([["Home", "/"], ["Lists", "/lists"]])] }));
});

app.get("/embed/lists/:slug", async (c) => {
  const slug = c.req.param("slug");
  const siteUrl = appOrigin(c.env);
  const list = await c.env.DB.prepare(
    `SELECT curated_lists.id, curated_lists.slug, curated_lists.title,
            CASE WHEN ${VERIFIED_LIST_SQL} THEN 1 ELSE 0 END AS is_verified_list
     FROM curated_lists
     LEFT JOIN users ON users.id = curated_lists.owner_user_id
     WHERE curated_lists.slug = ?1 AND curated_lists.visibility = 'public'`
  )
    .bind(slug)
    .first<{ id: string; slug: string; title: string; is_verified_list: number }>();
  if (!list) return c.html(renderEmbedNotFound(siteUrl), 404);
  const options = parseEmbedOptions((name) => c.req.query(name));
  const rows = await c.env.DB.prepare(
    `SELECT games.id, games.title, games.url, games.paywall, games.reset_basis, games.reset_time_minutes, games.reset_timezone
     FROM curated_list_items
     JOIN games ON games.id = curated_list_items.game_id
     WHERE curated_list_items.curated_list_id = ?1 AND games.status = 'approved' AND games.nsfw = 0
     ORDER BY curated_list_items.position ASC
     LIMIT ?2`
  )
    .bind(list.id, options.limit ?? 500)
    .all<{ id: string; title: string; url: string; paywall: number; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null }>();
  const items: EmbedItem[] = rows.results.map((row) => {
    const reset = getResetSortData(row.reset_basis, row.reset_time_minutes, row.reset_timezone);
    return {
      id: row.id,
      title: row.title,
      url: row.url,
      paywall: !!row.paywall,
      resetKind: reset?.kind ?? null,
      resetMin: reset?.min ?? null,
      resetLabel: getResetMetaLabel(row.reset_basis, row.reset_time_minutes, row.reset_timezone)
    };
  });
  const short = shortOrigin(c.env);
  return c.html(renderEmbedPage({
    title: list.title,
    verified: !!list.is_verified_list,
    items,
    options,
    canonicalUrl: `${siteUrl}/lists/${encodeURIComponent(list.slug)}`,
    suggestLabel: `${new URL(short ?? siteUrl).host}/c/${list.slug}`,
    siteUrl,
    checkSvg: CHECK_SVG
  }));
});

// Stream history. Not in PUBLIC_CACHE_PATHS (the × buttons are per-visitor), so it is rendered for each request;
// signed-in visitors get private/no-cache, anonymous ones a 60s public copy (identical for everyone without a session).
app.get("/lists/:slug/history", async (c) => {
  const user = c.get("user");
  const list = await c.env.DB.prepare("SELECT id, slug, title, visibility FROM curated_lists WHERE slug = ?1")
    .bind(c.req.param("slug"))
    .first<{ id: string; slug: string; title: string; visibility: string }>();
  if (!list || list.visibility !== "public") return notFoundPage(c);
  const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM list_play_history WHERE list_id = ?1").bind(list.id).first<{ n: number }>();
  if (!total?.n) return notFoundPage(c);
  const nowMs = Date.now();
  const beforeParam = c.req.query("before");
  const beforeMs = beforeParam && !Number.isNaN(Date.parse(beforeParam)) ? Math.min(Date.parse(beforeParam), nowMs + 60_000) : nowMs + 60_000;
  const before = new Date(beforeMs).toISOString();
  const from = new Date(beforeMs - PLAY_HISTORY_PAGE_DAYS * 86400000).toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT h.id, h.started_at, g.slug, g.title FROM list_play_history h JOIN games g ON g.id = h.game_id AND g.status = 'approved'
     WHERE h.list_id = ?1 AND h.started_at < ?2 AND h.started_at >= ?3 ORDER BY h.started_at DESC, h.id DESC LIMIT 1000`
  )
    .bind(list.id, before, from)
    .all<{ id: number; started_at: string; slug: string; title: string }>();
  const older = await c.env.DB.prepare("SELECT 1 AS ok FROM list_play_history WHERE list_id = ?1 AND started_at < ?2 LIMIT 1").bind(list.id, from).first();
  let canManage = false;
  if (user) {
    canManage = user.role === "editor" || user.role === "admin" || (await isCreatorListOwner(c.env, list.id, user.id));
    if (!canManage) {
      const twitchId = await getUserTwitchId(c.env, user);
      canManage = !!twitchId && !!(await c.env.DB.prepare("SELECT 1 AS ok FROM curated_lists WHERE id = ?1 AND twitch_user_id = ?2").bind(list.id, twitchId).first());
    }
  }
  const listHref = `/lists/${encodeURIComponent(list.slug)}`;
  const entries = rows.results.map((r) => ({ id: r.id, at: r.started_at, slug: r.slug, title: r.title }));
  const html = await layout(`Stream history – ${list.title} | 0x9 dles`, user, `
    <main class="narrow">
      <h1>Stream history</h1>
      <p><a href="${listHref}">${escapeHtml(list.title)}</a> · every game set as Now playing, kept for ${PLAY_HISTORY_KEEP_DAYS} days. Times are in your time zone.</p>
      <p id="ph-empty"${entries.length ? " hidden" : ""}>Nothing in this stretch.${before !== new Date(nowMs + 60_000).toISOString() ? "" : ""}</p>
      <div id="ph-days"></div>
      <div class="ph-actions">
        ${older ? `<a class="btn secondary" rel="nofollow" href="${listHref}/history?before=${encodeURIComponent(from)}">Show older</a>` : ""}
        ${beforeParam ? `<a class="btn secondary" href="${listHref}/history">Back to latest</a>` : ""}
        ${canManage ? `<button type="button" class="secondary" id="ph-clear">Clear history</button>` : ""}
      </div>
    </main>
    <link rel="stylesheet" href="${ASSET.phCss}" />
    <script type="application/json" id="data-play-history">${scriptJson({ slug: list.slug, listId: list.id, canManage, entries })}</script>
    <script src="${ASSET.phJs}"></script>
  `, c.env, { path: `${listHref}/history`, noindex: true, description: `Games ${list.title} has played on stream.` });
  c.header("Vary", "Cookie");
  c.header("Cache-Control", user ? "private, no-cache" : "public, max-age=60");
  return c.html(html);
});

app.get("/lists/:slug", async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user");
  const isStaff = !!user && (user.role === "editor" || user.role === "admin");
  const userTwitchIdP = getUserTwitchId(c.env, user);
  const listP = c.env.DB.prepare(
    `SELECT curated_lists.id, curated_lists.slug, curated_lists.title, curated_lists.description, curated_lists.visibility, curated_lists.owner_user_id,
            curated_lists.twitch_login, curated_lists.twitch_user_id, curated_lists.suggestions_enabled, curated_lists.fandles_enabled,
            CASE WHEN curated_lists.kind = 'creator' AND users.creator_type IS NOT NULL THEN 1 ELSE 0 END AS is_creator_list,
            CASE WHEN ${VERIFIED_LIST_SQL} THEN 1 ELSE 0 END AS is_verified_list
     FROM curated_lists
     LEFT JOIN users ON users.id = curated_lists.owner_user_id
     WHERE curated_lists.slug = ?1`
  )
    .bind(slug)
    .first<{ id: string; slug: string; title: string; description: string | null; visibility: "public" | "private"; owner_user_id: string; twitch_login: string | null; twitch_user_id: string | null; is_creator_list: number; is_verified_list: number; fandles_enabled: number; suggestions_enabled: number }>();
  const [list, userTwitchId] = await Promise.all([listP, userTwitchIdP]);
  if (!list || !canViewList(list.visibility, list.owner_user_id, user, { listTwitchUserId: list.twitch_user_id, userTwitchId })) {
    return notFoundPage(c);
  }
  // The list's tagged Twitch user can edit its games, title and description; staff can edit everything.
  const isTwitchOwner = !!list.twitch_user_id && list.twitch_user_id === userTwitchId;
  // A verified creator owns their own creator list, with or without a Twitch channel.
  const isCreatorOwner = !!list.is_creator_list && !!user && list.owner_user_id === user.id;
  const canEdit = isStaff || isTwitchOwner || isCreatorOwner;
  const canSetVisibility = isStaff || isCreatorOwner;
  // Everyone who can edit views the list normally and opts in to edit mode with ?edit=1.
  const isAdminEditor = canEdit && c.req.query("edit") === "1";
  // Played on stream: admins always; everyone once the site setting is on. Editors mark games when it applies to them.
  // Reads that need only the list row go out together; those that need the game ids follow.
  const showPlayedP = isAdminEditor ? Promise.resolve(false) : playedOnStreamFor(c.env, user);
  const suggestionsOn = !isAdminEditor && list.suggestions_enabled === 1;
  const suggestionsP = suggestionsOn ? getListSuggestions(c.env, list.id, user ? `user:${user.id}` : null) : Promise.resolve([] as Awaited<ReturnType<typeof getListSuggestions>>);
  const fandlesAvailable = !!list.is_verified_list && !!list.twitch_user_id && list.visibility === "public";
  const fandlesOn = fandlesAvailable && list.fandles_enabled === 1;
  const fandleLimitsP = fandlesOn ? getFandleLimits(c.env) : Promise.resolve({ perDeveloper: null, shown: null, membershipDays: null });
  const lastOnStreamP = !isAdminEditor && list.visibility === "public"
    ? c.env.DB.prepare("SELECT game_id, MAX(started_at) AS last_at FROM list_play_history WHERE list_id = ?1 GROUP BY game_id").bind(list.id).all<{ game_id: string; last_at: string }>()
    : Promise.resolve(null);
  const itemsP = c.env.DB.prepare(
    `SELECT games.id, games.slug, games.title, games.url, games.paywall, games.nsfw, games.reset_basis, games.reset_time_minutes, games.reset_timezone,
            games.vote_up_count, games.vote_down_count, curated_list_items.position,
            curated_list_items.last_played_at, curated_list_items.created_at AS added_at
     FROM curated_list_items
     JOIN games ON games.id = curated_list_items.game_id
     WHERE curated_list_items.curated_list_id = ?1
     ORDER BY curated_list_items.position ASC`
  )
    .bind(list.id)
    .all<{ id: string; slug: string; title: string; url: string; paywall: number; nsfw: number; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null; vote_up_count: number; vote_down_count: number; position: number; last_played_at: string | null; added_at: string }>();
  // The Fan-dles rows need only the limits, so they load beside the list's own reads.
  const fandleGamesP = fandlesOn && !isAdminEditor
    ? fandleLimitsP.then((limits) => listGames(c.env, { sort: "top", limit: limits.shown ?? FANDLE_HARD_MAX_SHOWN, fandleListId: list.id, fandlePerDeveloper: limits.perDeveloper, fandleMembershipDays: limits.membershipDays }))
    : Promise.resolve([] as Awaited<ReturnType<typeof listGames>>);
  const [showPlayed, items, suggestions, fandleLimits, lastOnStreamRows, fandleGames] = await Promise.all([showPlayedP, itemsP, suggestionsP, fandleLimitsP, lastOnStreamP, fandleGamesP]);
  const canMarkPlayed = showPlayed && canEdit;

  // When each game was last set as Now playing (same for every viewer; the page script turns it into a viewer-local date).
  const lastOnStream = new Map<string, string>();
  for (const row of lastOnStreamRows?.results ?? []) lastOnStream.set(row.game_id, row.last_at);

  // The viewer's own votes and favorites, for the vote/favorite buttons (read-only view only).
  // One viewer lookup covers the list's games and the Fan-dles games.
  const [categoriesByGameId, developersByGameId, viewerState] = await Promise.all([
    getCategoriesForGames(c.env, items.results.map((item) => item.id)),
    getDevelopersForGames(c.env, items.results.map((item) => item.id)),
    isAdminEditor
      ? Promise.resolve({ votes: new Map<string, -1 | 1>(), favorites: new Set<string>() })
      : getViewerGameState(c, [...new Set([...items.results.map((item) => item.id), ...fandleGames.map((game) => game.id)])])
  ]);
  const { votes: userVotes, favorites: userFavorites } = viewerState;

  let adminGames: Array<{ id: string; title: string; slug: string }> = [];
  if (isAdminEditor) {
    const games = await c.env.DB.prepare(
      "SELECT id, title, slug FROM games WHERE status = 'approved' ORDER BY title ASC"
    ).all<{ id: string; title: string; slug: string }>();
    adminGames = games.results;
  }

  // Suggestions sit beside the list in view mode. Votes are per visitor, so only signed-in (uncached) views get the
  // viewer's own; logged-out pages load theirs from the API.

  // Fan-dles: games by the streamer's community, on a public creator list tagged with a Twitch channel.
  const fandleViewer = viewerState;
  const fandleNotice = (({
    joined: "You're in. Your verified games now show in Fan-dles below.",
    not_following: "Twitch says you don't follow or subscribe to this channel yet. Follow it for a week (or subscribe), then check again.",
    too_new: `You've followed this channel for under ${FANDLE_MIN_FOLLOW_DAYS} days. Check again once it has been a week, or subscribe to join now.`,
    cancelled: "No problem. Nothing was checked or saved.",
    conflict: "That Twitch account is already used by another 0x9 dles account, so it can't be checked from this one.",
    need_claim: "Only verified developers can show games here. Verify a game you made first.",
    self: "This is your own list.",
    error: "Twitch couldn't check that just now. Please try again in a minute."
  }) as Record<string, string>)[c.req.query("fandle") ?? ""];
  let fandleJoin = "";
  if (fandlesOn && user && !isCreatorOwner && !isAdminEditor) {
    const [membership, hasClaim] = await Promise.all([
      c.env.DB.prepare(`SELECT source, verified_at FROM fandle_members fm WHERE list_id = ?1 AND user_id = ?2 AND ${fandleActiveSql("fm", fandleLimits.membershipDays)}`)
        .bind(list.id, user.id)
        .first<{ source: string; verified_at: string }>(),
      hasVerifiedClaim(c.env, user.id)
    ]);
    if (hasClaim) {
      // Where each of the developer's games stands here, so a member is never left wondering why one isn't shown.
      const mine = membership
        ? (await c.env.DB.prepare(
            `SELECT games.title,
                    EXISTS(SELECT 1 FROM fandle_hidden WHERE list_id = ?1 AND game_id = games.id) AS hidden
             FROM game_claims JOIN games ON games.id = game_claims.game_id AND games.status = 'approved'
             WHERE game_claims.user_id = ?2 AND game_claims.status = 'verified'
             ORDER BY games.title`
          )
            .bind(list.id, user.id)
            .all<{ title: string; hidden: number }>()).results
        : [];
      const gameStatus = mine.length > 0
        ? `<ul>${mine
            .map((game) => `<li><strong>${escapeHtml(game.title)}</strong>: ${game.hidden ? "hidden by the streamer" : "shown in Fan-dles"}</li>`)
            .join("")}</ul>`
        : "";
      const formHtml = (label: string) => `<form method="post" action="/auth/twitch/fandle" class="fandle-form"><input type="hidden" name="list" value="${escapeHtml(list.slug)}" /><button type="submit" class="btn">${label}</button></form>`;
      fandleJoin = membership
        ? `<p>Your verified games are in ${escapeHtml(list.title.replace(/'s Dailies$/, ""))}'s Fan-dles (${membership.source === "sub" ? "subscriber" : membership.source === "manual" ? "added by an admin" : "follower"})${fandleLimits.membershipDays && membership.source !== "manual" ? ` until ${escapeHtml(new Date(Date.parse(membership.verified_at.replace(" ", "T") + "Z") + fandleLimits.membershipDays * 86_400_000).toISOString().slice(0, 10))}` : ""}.</p>
           ${gameStatus}
           <div class="actions">${formHtml("Check again")}<button type="button" id="fandle-leave" data-list-id="${escapeHtml(list.id)}">Leave Fan-dles</button></div>`
        : `<p><strong>Made a game?</strong> Show it in this community's Fan-dles. Subscribers qualify straight away, and followers after ${FANDLE_MIN_FOLLOW_DAYS} days. We ask Twitch once, with your permission, whether you follow or subscribe to this channel. Nothing else is read, and we don't keep access to your Twitch account.</p>
           ${formHtml("Check with Twitch")}`;
    }
  }
  // Admins also manage who is a member.
  const isAdminUser = !!user && user.role === "admin";
  const fandleMembersP = isAdminEditor && fandlesAvailable
    ? (c.env.DB.prepare(
        `SELECT fm.user_id, fm.source, COALESCE(users.display_name, users.profile_handle, 'Developer') AS name,
                (SELECT COUNT(*) FROM game_claims WHERE game_claims.user_id = fm.user_id AND game_claims.status = 'verified') AS games
         FROM fandle_members fm JOIN users ON users.id = fm.user_id
         WHERE fm.list_id = ?1 AND ${fandleActiveSql("fm", fandleLimits.membershipDays)}
         ORDER BY name ASC LIMIT 200`
      )
        .bind(list.id)
        .all<{ user_id: string; source: string; name: string; games: number }>()).then((r) => r.results)
    : Promise.resolve([] as Array<{ user_id: string; source: string; name: string; games: number }>);
  // Editors and the streamer manage which Fan-dles show.
  const fandleManageP = isAdminEditor && fandlesAvailable
    ? (c.env.DB.prepare(
        `SELECT games.id, games.title, users.display_name,
                EXISTS(SELECT 1 FROM fandle_hidden WHERE list_id = ?1 AND game_id = games.id) AS hidden
         FROM fandle_members fm
         JOIN game_claims gc ON gc.user_id = fm.user_id AND gc.status = 'verified'
         JOIN games ON games.id = gc.game_id AND games.status = 'approved'
         JOIN users ON users.id = fm.user_id
         WHERE fm.list_id = ?1 AND ${fandleActiveSql("fm", fandleLimits.membershipDays)}
         ORDER BY games.title ASC LIMIT 100`
      )
        .bind(list.id)
        .all<{ id: string; title: string; display_name: string | null; hidden: number }>()).then((r) => r.results)
    : Promise.resolve([] as Array<{ id: string; title: string; display_name: string | null; hidden: number }>);
  const [fandleMembers, fandleManage] = await Promise.all([fandleMembersP, fandleManageP]);

  // Fan-dles section: no vote buttons here, and the streamer / editors get an "Add" button to copy a game to the main list.
  const onMainList = new Set(items.results.map((item) => item.id));
  const fandleAddAction = canEdit
    ? (game: { id: string; title: string }) => (onMainList.has(game.id) ? "" : `<button type="button" data-fandle-add="${escapeHtml(game.id)}" title="Add ${escapeHtml(game.title)} to the main list" aria-label="Add ${escapeHtml(game.title)} to the main list">Add</button>`)
    : undefined;
  const fandleSection = fandlesOn && !isAdminEditor && (fandleGames.length > 0 || fandleJoin)
    ? `<section class="fandles" id="fandles">
        <div class="fandles-head">
          <h2>Fan-dles</h2>
          <p class="muted">Games made by people in ${escapeHtml(list.title.replace(/'s Dailies$/, ""))}'s community.</p>
        </div>
        <div class="fandles-body">
        ${fandleNotice ? `<p class="panel fandle-notice" role="status">${escapeHtml(fandleNotice)}</p>` : ""}
        ${fandleGames.length > 0 ? renderCompactGameList(fandleGames, user, fandleViewer.votes, fandleViewer.favorites, { showVotes: false, extraActions: fandleAddAction }) : ""}
        ${fandleJoin ? `<div class="panel fandle-join">${fandleJoin}</div>
        <script>
          document.getElementById("fandle-leave")?.addEventListener("click", async (event) => {
            const res = await fetch("/api/lists/" + event.currentTarget.getAttribute("data-list-id") + "/fandle-membership", { method: "DELETE" }).catch(() => null);
            if (res && res.ok) window.location.reload();
          });
        </script>` : ""}
        ${canEdit && fandleGames.length > 0 ? `<script>
          document.querySelectorAll("[data-fandle-add]").forEach((button) => {
            button.addEventListener("click", async () => {
              button.disabled = true;
              const res = await fetch("/api/lists/" + ${scriptJson(list.id)} + "/items", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ gameId: button.getAttribute("data-fandle-add"), position: ${items.results.length + 1} })
              }).catch(() => null);
              if (res && res.ok) window.location.reload();
              else { button.disabled = false; if (window.appToast) window.appToast("Could not add the game.", "error"); }
            });
          });
        </script>` : ""}
        </div>
      </section>`
    : "";

  const suggestPanelHtml = suggestionsOn ? `<details class="suggest-panel" id="suggest-panel">
        <summary><span class="suggest-heading">Suggestions</span> <span class="suggest-count" id="suggest-count">${suggestions.length > 0 ? `(${suggestions.length})` : ""}</span></summary>
        <div class="suggest-body">
          <form class="suggest-form" id="suggest-form" autocomplete="off">
            <div class="game-search-wrap">
              <input type="text" id="suggest-input" placeholder="Suggest a game…" aria-label="Search for a game to suggest" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="suggest-options" maxlength="100" />
              <div id="suggest-options" class="game-search-list" role="listbox"></div>
            </div>
            <button type="submit" id="suggest-submit" disabled>Suggest</button>
          </form>
          <ol class="suggest-list" id="suggest-list"></ol>
          <button type="button" class="suggest-more" id="suggest-more" aria-expanded="false" hidden></button>
          <p class="suggest-empty" id="suggest-empty"${suggestions.length > 0 ? " hidden" : ""}>No suggestions yet. Know a game that belongs here? Suggest it.</p>
        </div>
      </details>` : "";
  // Shown on stream: the short host (the shortest address), falling back to APP_URL's host.
  const streamHost = new URL(shortOrigin(c.env) ?? c.env.APP_URL).host;
  // The side-by-side / tabbed layout applies whenever there is a second section: suggestions, Fan-dles, or both.
  const layoutOn = suggestionsOn || !!fandleSection;
  const hasHistory = !isAdminEditor && list.visibility === "public" && !!(await c.env.DB.prepare("SELECT 1 AS ok FROM list_play_history WHERE list_id = ?1 LIMIT 1").bind(list.id).first());
  return c.html(await layout(`${list.title} – Daily Game List | 0x9 dles`, user, `
    <main class="narrow${layoutOn ? " list-page" : ""}">
      <div class="list-head">
      <h1>${escapeHtml(list.title)}${list.is_verified_list ? renderCheckBadge("Verified content creator") : renderVerifiedBadge(list.twitch_login)}${isAdminEditor ? "" : `<span class="stream-pane-title" id="stream-pane-title"></span>`}</h1>
      ${showPlayed ? `<p class="played-count" id="played-count" hidden></p>` : ""}
      ${list.twitch_login ? `<p class="twitch-watch"><a class="btn btn-twitch" data-live-list="${escapeHtml(list.slug)}" data-live-login="${escapeHtml(list.twitch_login)}" href="https://www.twitch.tv/${encodeURIComponent(list.twitch_login)}" target="_blank" rel="noopener noreferrer" title="Opens Twitch in a new tab">${TWITCH_ICON_SVG}<span>Watch ${escapeHtml(list.twitch_login)}<span class="wide-only"> on Twitch</span></span><span class="external-arrow" aria-hidden="true">↗</span><span class="visually-hidden"> (opens in a new tab)</span></a></p>` : ""}
      <div class="list-head-actions" id="head-actions">
        <button type="button" class="secondary" data-head-item data-share data-share-title="${escapeHtml(list.title)}">Share</button>
        ${canEdit ? `<a class="btn" data-head-item data-head-keep href="/lists/${encodeURIComponent(list.slug)}${isAdminEditor ? "" : "?edit=1"}">${isAdminEditor ? "Done editing" : "Edit list"}</a>` : ""}
        ${isAdminEditor || list.visibility !== "public" ? "" : `<button type="button" class="secondary" data-head-item id="embed-btn">Embed</button>`}
        ${hasHistory ? `<a class="btn secondary" data-head-item href="/lists/${encodeURIComponent(list.slug)}/history">Stream history</a>` : ""}
        ${isAdminEditor || items.results.length === 0 ? "" : `<button type="button" class="secondary" data-head-item id="add-all-btn">Add all to my rotation</button>`}
        ${isAdminEditor ? "" : `<button type="button" class="secondary" data-head-item id="stream-toggle" aria-pressed="false" title="Large-type view for streaming (Esc exits)">Stream mode</button>`}
        <div class="head-more" id="head-more" hidden>
          <button type="button" class="secondary" id="head-more-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="head-more-menu" aria-label="More actions" title="More actions">⋯</button>
          <div class="head-more-menu" id="head-more-menu" role="menu" aria-label="More actions" hidden></div>
        </div>
      </div>
      </div>
      ${list.description ? `<div class="list-desc-wrap"><p class="list-desc" id="list-desc">${escapeHtml(list.description)}</p><button type="button" class="list-desc-more" id="list-desc-more" aria-expanded="false" aria-controls="list-desc" hidden>More</button></div>` : ""}
      ${isCreatorOwner ? `<p class="panel creator-note">This is your creator list. It's <strong>${list.visibility}</strong>${list.visibility === "public" ? " and anyone can see it" : ""}, and suggestions are <strong>${list.suggestions_enabled === 1 ? "open" : "off"}</strong>. Use Edit list to change either. <a href="/me/settings">Creator settings</a></p>` : ""}
      ${canEdit ? `<p class="list-meta-line"><code>${escapeHtml(list.slug)}</code> · ${list.visibility}</p>` : ""}
      ${isAdminEditor ? `
        <section class="panel">
          <h2>Edit list</h2>
          <form id="list-edit-form" class="stack-form">
            <input type="text" name="title" value="${escapeHtml(list.title)}" required />
            ${isStaff ? `<input type="text" name="slug" value="${escapeHtml(list.slug)}" required pattern="[a-z0-9-]+" title="Lowercase alphanumeric with hyphens" />` : ""}
            <textarea name="description" rows="2" placeholder="Description" aria-label="Description">${escapeHtml(list.description || "")}</textarea>
            <label class="check"><input type="checkbox" id="list-suggestions-toggle"${list.suggestions_enabled === 1 ? " checked" : ""} /> Allow suggestions <small class="muted">(turning this off hides the panel; existing suggestions are kept)</small></label>
            ${fandlesAvailable ? `<label class="check"><input type="checkbox" id="list-fandles-toggle"${list.fandles_enabled === 1 ? " checked" : ""} /> Show Fan-dles <small class="muted">(games made by verified developers who follow or subscribe to this channel)</small></label>` : ""}
            <div class="actions">
              <button type="submit">Save details</button>
              ${canSetVisibility ? `<button type="button" id="list-visibility-toggle">Set ${list.visibility === "public" ? "private" : "public"}</button>` : ""}
              ${isStaff ? `<button type="button" id="list-delete-btn">Delete list</button>` : ""}
            </div>
          </form>
          <p id="list-edit-status" class="status" aria-live="polite"></p>
        </section>
        ${fandlesAvailable ? `<section class="panel">
          <h2>Fan-dles</h2>
          ${fandleManage.length === 0 ? `<p class="muted">No community games yet. They show up here after a verified developer who follows or subscribes to ${escapeHtml(list.twitch_login || "this channel")} checks in from this page.</p>` : `<ul class="stack">${fandleManage
            .map((game) => `<li class="panel"><strong>${escapeHtml(game.title)}</strong> <small class="muted">by ${escapeHtml(game.display_name || "a community member")}${game.hidden ? " · hidden" : ""}</small>
              <div class="actions"><button type="button" data-fandle-hidden="${game.hidden ? "0" : "1"}" data-game-id="${escapeHtml(game.id)}">${game.hidden ? "Show again" : "Hide"}</button></div></li>`)
            .join("")}</ul>`}
          ${isAdminUser ? `<h3>Community members</h3>
          ${fandleMembers.length === 0 ? `<p class="muted">No members yet.</p>` : `<ul class="stack">${fandleMembers
            .map((member) => `<li class="panel" data-member-id="${escapeHtml(member.user_id)}"><strong>${escapeHtml(member.name)}</strong> <small class="muted">${member.source === "sub" ? "subscriber" : member.source === "follow" ? "follower" : "added by an admin"} · ${member.games} verified game${member.games === 1 ? "" : "s"}</small>
              <div class="actions"><button type="button" class="danger" data-fandle-member-remove>Remove</button></div></li>`)
            .join("")}</ul>`}
          <h3>Add a developer</h3>
          <p class="muted">Adds a verified developer without a Twitch check. Their verified games show here.</p>
          <div class="game-search-wrap">
            <input type="text" id="fandle-dev-search" placeholder="Search verified developers by name or handle…" aria-label="Search verified developers" autocomplete="off" />
            <div id="fandle-dev-results" class="game-search-list"></div>
          </div>` : ""}
          <p id="fandle-status" class="status" aria-live="polite"></p>
        </section>` : ""}
        ${isStaff ? `<section class="panel">
          <h2>Twitch owner</h2>
          <p>Tagging a Twitch user adds a verified checkmark and a channel link, and lets that user edit this list's games, title and description when logged in with Twitch.</p>
          <form id="list-twitch-form" class="stack-form">
            <input type="text" name="login" value="${escapeHtml(list.twitch_login || "")}" placeholder="Twitch username (blank to remove)" maxlength="25" pattern="[A-Za-z0-9_]{4,25}|" />
            <button type="submit">Save Twitch owner</button>
          </form>
          <p id="list-twitch-status" class="status" aria-live="polite"></p>
        </section>` : ""}
        <section class="panel">
          <h2>Add game</h2>
          <div class="game-search-wrap">
            <input type="text" id="game-search-input" placeholder="Search games..." autocomplete="off" />
            <div id="game-search-list" class="game-search-list"></div>
          </div>
          <input type="hidden" id="game-search-selected" name="gameId" />
          <div style="margin-top:0.5rem">
            <button type="button" id="list-add-game-btn">Add to list</button>
          </div>
          <p id="list-add-status" class="status" aria-live="polite"></p>
        </section>
      ` : ""}
      ${!layoutOn ? "" : `<div class="list-layout${fandleSection ? " has-fandles" : ""}${suggestionsOn ? "" : " no-suggest"}"${fandleSection && fandleNotice ? ' data-default-tab="fandles"' : ""}>
      <div class="list-tabs" role="tablist" aria-label="List sections">
        <button type="button" role="tab" id="tab-list" data-tab="list" aria-selected="true">List <span class="tab-count" data-list-count>${items.results.length}</span></button>
        ${fandleSection ? `<button type="button" role="tab" id="tab-fandles" data-tab="fandles" aria-selected="false" tabindex="-1">Fan-dles <span class="tab-count">${fandleGames.length > 0 ? fandleGames.length : ""}</span></button>` : ""}
        ${suggestionsOn ? `<button type="button" role="tab" id="tab-suggest" data-tab="suggest" aria-selected="false" tabindex="-1">Suggestions <span class="tab-count" data-tab-count="suggest">${suggestions.length > 0 ? suggestions.length : ""}</span></button>` : ""}
      </div>
      <div class="list-main">`}
      ${isAdminEditor ? "" : `<div class="list-bar"><h2 class="list-bar-title">Games <span class="tab-count" id="list-count" data-list-count>${items.results.length}</span></h2><div id="list-sort-wrap"${items.results.length > 1 ? "" : " hidden"}>${renderListSortControl({ votes: true, stream: lastOnStream.size > 0 })}</div></div>`}
      <ol class="rotation-list" id="list-items"${canMarkPlayed ? ` data-can-mark-played data-list-id="${escapeHtml(list.id)}"` : ""}>
        ${items.results.map((item) => {
          const currentVote = userVotes.get(item.id) || 0;
          const currentFavorite = userFavorites.has(item.id);
          return `<li draggable="${isAdminEditor}" ${isAdminEditor ? "" : `class="card-click"`} data-game-id="${item.id}" ${isAdminEditor ? "" : `${showPlayed ? `data-last-played-at="${escapeHtml(item.last_played_at || "")}" ` : ""}${lastOnStream.has(item.id) ? `data-last-stream="${escapeHtml(lastOnStream.get(item.id)!)}" ` : ""}data-game-row="${item.id}" data-vote="${currentVote}" data-game-slug="${escapeHtml(item.slug)}" data-game-title="${escapeHtml(item.title)}"`} ${renderResetItemData(item.reset_basis, item.reset_time_minutes, item.reset_timezone).attrs}>
          ${isAdminEditor ? `<span class="drag">::</span>` : ""}
          <div class="item-main">
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="game-title${isAdminEditor ? "" : " card-link"}">${renderRowTitle(item.title, item.paywall, item.nsfw)}${isNewlyListed(item.added_at) ? renderNewHereBadge() : ""}${showPlayed ? `<span class="played-pill" hidden><span class="pp-check" aria-hidden="true">✓</span><span class="pp-text"> Played on stream</span></span>` : ""}</a>
            ${renderCategoryPills(categoriesByGameId.get(item.id), developersByGameId.get(item.id))}
            ${isAdminEditor
              ? renderGameMeta(0, 0, renderResetSpan(item.reset_basis, item.reset_time_minutes, item.reset_timezone))
              : renderGameMeta(item.vote_up_count, item.vote_down_count, renderResetSpan(item.reset_basis, item.reset_time_minutes, item.reset_timezone))}
            ${lastOnStream.has(item.id) ? `<p class="last-stream" hidden></p>` : ""}
          </div>
          <div class="card-actions">
            ${isAdminEditor ? "" : `
              <button type="button" data-list-vote="up" data-vote-button="up" class="${currentVote === 1 ? "active" : ""}" aria-pressed="${currentVote === 1 ? "true" : "false"}" aria-label="${escapeHtml(voteButtonLabel("up", item.title, item.vote_up_count))}" title="Vote up"><span aria-hidden="true">▲</span> <span data-up-count>${item.vote_up_count}</span></button>
              <button type="button" data-list-vote="down" data-vote-button="down" class="${currentVote === -1 ? "active" : ""}" aria-pressed="${currentVote === -1 ? "true" : "false"}" aria-label="${escapeHtml(voteButtonLabel("down", item.title, item.vote_down_count))}" title="Vote down"><span aria-hidden="true">▼</span> <span data-down-count>${item.vote_down_count}</span></button>
              ${user
                ? `<button type="button" data-list-favorite="${currentFavorite ? "yes" : "no"}">${currentFavorite ? "★" : "☆"}</button>`
                : `<button type="button" data-local-favorite="no">☆</button>`}
            `}
            ${isAdminEditor ? `
              <div class="reorder-controls">
                <button type="button" data-move="up">↑</button>
                <button type="button" data-move="down">↓</button>
              </div>
            ` : ""}
            ${canMarkPlayed ? `<button type="button" class="list-played-btn" data-played-toggle-list aria-pressed="false" hidden>Mark played</button>` : ""}
            ${renderDetailsLink(item.slug, item.title)}
            ${isAdminEditor ? `<button type="button" class="list-remove-game" data-game-id="${item.id}">X</button>` : ""}
          </div>
        </li>`;
        }).join("")}
      </ol>
      <p id="list-reorder-status" class="status" aria-live="polite"></p>
      ${!layoutOn ? "" : `</div>
      <aside class="list-sidebar" id="list-sidebar" aria-label="${fandleSection && suggestionsOn ? "Fan-dles and suggestions" : fandleSection ? "Fan-dles" : "Suggestions"}">
        <div class="side-head">
          <div class="side-tabs" role="tablist" aria-label="Sidebar sections">
            ${fandleSection ? `<button type="button" role="tab" id="stab-fandles" data-side="fandles" aria-selected="false" aria-controls="fandles" title="Fan-dles">${SIDE_ICON_FANDLES}<span class="side-label">Fan-dles</span><span class="tab-count">${fandleGames.length > 0 ? fandleGames.length : ""}</span></button>` : ""}
            ${suggestionsOn ? `<button type="button" role="tab" id="stab-suggest" data-side="suggest" aria-selected="false" aria-controls="suggest-panel" title="Suggestions">${SIDE_ICON_SUGGEST}<span class="side-label">Suggestions</span><span class="tab-count" data-tab-count="suggest">${suggestions.length > 0 ? suggestions.length : ""}</span></button>` : ""}
          </div>
          <button type="button" class="side-toggle" id="side-toggle" aria-expanded="true" aria-controls="list-sidebar" aria-label="Collapse sidebar" title="Collapse sidebar"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
        ${suggestPanelHtml}
        ${fandleSection}
      </aside></div>`}
      ${isAdminEditor ? "" : renderStreamBar(streamHost, list.slug, suggestionsOn, suggestions, !!fandleSection)}
      ${isAdminEditor ? "" : renderStreamSettings(canMarkPlayed, list.visibility === "public" ? { slug: list.slug, title: list.title, appUrl: c.env.APP_URL.replace(/\/$/, ""), shortUrl: (shortOrigin(c.env) ?? c.env.APP_URL).replace(/\/$/, "") } : null)}
      ${isAdminEditor ? "" : renderOverlayPanel(list.title, suggestionsOn, suggestions, showPlayed)}
      ${fandleNotice && !fandleSection ? `<p class="panel fandle-notice" role="status">${escapeHtml(fandleNotice)}</p>` : ""}
    </main>
    <script src="${ASSET.listPageJs}"></script>
    ${list.twitch_login ? `<script src="${ASSET.liveBadgesJs}"></script>` : ""}
    ${isAdminEditor || list.visibility !== "public" ? "" : `${renderEmbedDialog()}<script src="${ASSET.embedDialogJs}" data-origin="${escapeHtml(appOrigin(c.env))}" data-slug="${escapeHtml(list.slug)}" data-title="${escapeHtml(list.title)}"></script>`}
    ${isAdminEditor ? "" : `<link rel="stylesheet" href="${ASSET.npCss}" /><script type="application/json" id="data-now-playing">${scriptJson({ slug: list.slug, listId: list.id, canSet: canEdit, hasHistory })}</script><script src="${ASSET.npJs}"></script>`}
    ${layoutOn ? `<script src="${ASSET.page_list_layout}"></script>` : ""}
    ${!isAdminEditor ? `<script>
      (() => {
        const button = document.getElementById("add-all-btn");
        if (!button) return;
        button.addEventListener("click", async () => {
          const games = [...document.querySelectorAll("#list-items > li[data-game-id]")].map((row) => ({
            id: row.getAttribute("data-game-id") || "",
            slug: row.getAttribute("data-game-slug") || "",
            title: row.getAttribute("data-game-title") || ""
          }));
          if (games.length > 10 && !window.confirm("Add all " + games.length + " games to your rotation?")) return;
          button.disabled = true;
          await window.dglAddManyToRotation(games);
          button.disabled = false;
        });
      })();
    </script>
    <script type="application/json" id="data-list-suggestions">${scriptJson({ listId: list.id, signedIn: !!user, canModerate: canEdit, suggestions })}</script>
    <script src="${ASSET.page_list_suggestions}"></script>
    <script src="${ASSET.listSortJs}"></script>
    <script type="application/json" id="data-list-live">${scriptJson({ slug: list.slug, loggedOut: !user })}</script>
    <script src="${ASSET.page_list_live}"></script>` : ""}
    ${!isAdminEditor ? renderGameListInteractionScript({ includeImportPanel: false, promptFromQuery: false }) : ""}
    ${isAdminEditor ? `
    <script type="application/json" id="data-list-edit">${scriptJson({ listId: list.id, slug: list.slug, nextVisibility: list.visibility === "public" ? "private" : "public", allGames: adminGames.map(g => ({ id: g.id, title: g.title, slug: g.slug })), itemCount: items.results.length })}</script>
    <script src="${ASSET.page_list_edit}"></script>
    ` : ""}
  `, c.env, { headHtml: isAdminEditor ? "" : LIST_PAGE_HEAD_SCRIPT, path: `/lists/${list.slug}`, description: listMetaDescription(list, items.results), noindex: isAdminEditor || list.visibility !== "public" || items.results.length === 0, jsonLd: [breadcrumbLd([["Home", "/"], ["Lists", "/lists"], [list.title, `/lists/${list.slug}`]]), gameItemListLd(items.results)] }));
});

// Sibling 0x9.ca sites, cross-listed so Google discovers them via referring sitemaps.
const SIBLING_SITE_URLS = [
  "https://0x9.ca/",
  "https://pilldle.0x9.ca/",
  "https://gamba.0x9.ca/",
  "https://waffledle.0x9.ca/",
  "https://sherdle.0x9.ca/"
];

app.get("/sitemap.xml", async (c) => {
  const games = await c.env.DB.prepare(
    "SELECT slug, content_updated_at, approved_at, created_at FROM games WHERE status = 'approved' ORDER BY slug ASC"
  ).all<{ slug: string; content_updated_at: string | null; approved_at: string | null; created_at: string }>();
  const lists = await c.env.DB.prepare(
    `SELECT slug, MAX(updated_at, COALESCE((SELECT MAX(created_at) FROM curated_list_items WHERE curated_list_id = curated_lists.id), '')) AS changed_at
     FROM curated_lists
     WHERE visibility = 'public' AND EXISTS (SELECT 1 FROM curated_list_items WHERE curated_list_id = curated_lists.id)
     ORDER BY slug ASC`
  ).all<{ slug: string; changed_at: string }>();

  const categoriesWithGames = await c.env.DB.prepare(
    `SELECT categories.slug, MAX(COALESCE(games.content_updated_at, games.approved_at, games.created_at)) AS changed_at
     FROM categories
     JOIN game_categories ON game_categories.category_id = categories.id
     JOIN games ON games.id = game_categories.game_id
     WHERE categories.is_active = 1 AND games.status = 'approved'
     GROUP BY categories.id
     ORDER BY categories.slug ASC`
  ).all<{ slug: string; changed_at: string | null }>();

  // Rows hold "YYYY-MM-DD HH:MM:SS" (datetime()) or ISO strings (API inserts); both are UTC. Invalid values are dropped.
  const toLastmod = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const date = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
    return Number.isNaN(date.getTime()) ? null : date.toISOString().replace(/\.\d+Z$/, "Z");
  };
  // Real content changes only: updated_at moves on every daily score and link-check run, so it is not used.
  const gameLastmod = (game: { content_updated_at: string | null; approved_at: string | null; created_at: string }) =>
    [game.content_updated_at, game.approved_at, game.created_at].map(toLastmod).filter((v): v is string => !!v).sort().pop() ?? null;
  const newest = (values: Array<string | null>) => values.filter((v): v is string => !!v).sort().pop() ?? null;
  const gameEntries = games.results.map((game) => ({ loc: `/games/${game.slug}`, lastmod: gameLastmod(game) }));
  const listEntries = lists.results.map((list) => ({ loc: `/lists/${list.slug}`, lastmod: toLastmod(list.changed_at) }));
  const latestGame = newest(gameEntries.map((e) => e.lastmod));
  const latestList = newest(listEntries.map((e) => e.lastmod));
  // Static pages carry no lastmod (nothing to say when they changed); hubs get the newest content they link to.
  const urls = [
    { loc: "/", lastmod: newest([latestGame, latestList]) },
    { loc: "/games", lastmod: latestGame },
    { loc: "/lists", lastmod: latestList },
    { loc: "/mod-log", lastmod: null as string | null },
    { loc: "/changelog", lastmod: null as string | null },
    { loc: "/daily", lastmod: null as string | null },
    { loc: "/categories", lastmod: latestGame },
    { loc: "/new", lastmod: newest(games.results.map((g) => toLastmod(g.approved_at ?? g.created_at))) },
    ...categoriesWithGames.results.map((cat) => ({ loc: `/categories/${encodeURIComponent(cat.slug)}`, lastmod: toLastmod(cat.changed_at) })),
    ...SIBLING_SITE_URLS.map((loc) => ({ loc, lastmod: null as string | null })),
    ...gameEntries,
    ...listEntries
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${escapeHtml(u.loc.startsWith("http") ? u.loc : c.env.APP_URL + u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}
  </url>`
  )
  .join("\n")}
</urlset>`;

  return c.body(body, 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  });
});

// Atom feed of the newest approved games, same games and URLs as the sitemap (NSFW ones included, as there).
// ?category=<slug> limits it to one active category (same games as /games?category=).
app.get("/feed.xml", async (c) => {
  const base = c.env.APP_URL;
  const categoryParam = c.req.query("category");
  let category: { slug: string; name: string } | null = null;
  if (categoryParam !== undefined) {
    category = await c.env.DB.prepare("SELECT slug, name FROM categories WHERE slug = ?1 AND is_active = 1")
      .bind(categoryParam)
      .first<{ slug: string; name: string }>();
    if (!category) {
      return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<error>Unknown category</error>\n`, 404, { "Content-Type": "application/xml; charset=utf-8" });
    }
  }
  const categoryFilter = category
    ? " AND games.id IN (SELECT gc.game_id FROM game_categories gc JOIN categories cat ON cat.id = gc.category_id WHERE cat.slug = ?1)"
    : "";
  const games = await c.env.DB.prepare(
    `SELECT slug, title, description, COALESCE(approved_at, created_at) AS listed_at FROM games WHERE status = 'approved'${categoryFilter} ORDER BY COALESCE(approved_at, created_at) DESC LIMIT 50`
  )
    .bind(...(category ? [category.slug] : []))
    .all<{ slug: string; title: string; description: string | null; listed_at: string }>();
  const selfPath = category ? `/feed.xml?category=${encodeURIComponent(category.slug)}` : "/feed.xml";
  const htmlPath = category ? `/games?category=${encodeURIComponent(category.slug)}` : "/games";
  const isoTime = (value: string) => new Date(utcMillis(value)).toISOString();
  const entries = games.results.map((game) => {
    const url = escapeHtml(`${base}/games/${encodeURIComponent(game.slug)}`);
    return `  <entry>
    <title>${xmlText(game.title)}</title>
    <link rel="alternate" type="text/html" href="${url}" />
    <id>${url}</id>
    <updated>${isoTime(game.listed_at)}</updated>${game.description ? `\n    <summary>${xmlText(game.description)}</summary>` : ""}
  </entry>`;
  });
  const updated = games.results[0] ? isoTime(games.results[0].listed_at) : new Date().toISOString();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${category ? xmlText(`New games in ${category.name} on 0x9 dles`) : "New games on 0x9 dles"}</title>
  <subtitle>${category ? xmlText(`The newest ${category.name} daily games listed on 0x9 dles.`) : "The newest daily games listed on 0x9 dles."}</subtitle>
  <id>${escapeHtml(base)}${escapeHtml(selfPath)}</id>
  <link rel="self" type="application/atom+xml" href="${escapeHtml(base)}${escapeHtml(selfPath)}" />
  <link rel="alternate" type="text/html" href="${escapeHtml(base)}${escapeHtml(htmlPath)}" />
  <updated>${updated}</updated>
  <author><name>0x9 dles</name></author>
${entries.join("\n")}
</feed>
`;
  return c.body(body, 200, {
    "Content-Type": "application/atom+xml; charset=utf-8",
    "Cache-Control": "public, max-age=600"
  });
});

// Embeddable rating badge for game developers (the "Help players find your game" panel). Plain SVG, so it loads
// as an <img> on any site. Unknown or unapproved slugs get a generic 404 image, not HTML.
app.get("/badge/:file", async (c) => {
  const slug = c.req.param("file").replace(/\.svg$/, "");
  const game = await c.env.DB.prepare(
    "SELECT title, vote_up_count, vote_down_count FROM games WHERE slug = ?1 AND status = 'approved'"
  )
    .bind(slug)
    .first<{ title: string; vote_up_count: number; vote_down_count: number }>();
  const headers = {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"
  };
  if (!game) {
    return c.body(renderBadgeSvg(null), 404, { ...headers, "Cache-Control": "public, max-age=300" });
  }
  return c.body(renderBadgeSvg({ title: game.title, upVotes: game.vote_up_count, downVotes: game.vote_down_count }), 200, {
    ...headers,
    "Cache-Control": "public, max-age=3600"
  });
});

// Panel badge for a public list (Twitch panels, socials): list size and its short address. Same headers as the game badge.
app.get("/badge/c/:file", async (c) => {
  const slug = c.req.param("file").replace(/\.svg$/, "");
  const list = await c.env.DB.prepare(
    `SELECT curated_lists.title,
            (SELECT COUNT(*) FROM curated_list_items JOIN games ON games.id = curated_list_items.game_id
             WHERE curated_list_items.curated_list_id = curated_lists.id AND games.status = 'approved') AS games
     FROM curated_lists WHERE curated_lists.slug = ?1 AND curated_lists.visibility = 'public'`
  )
    .bind(slug)
    .first<{ title: string; games: number }>();
  const headers = {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"
  };
  if (!list || list.games === 0) {
    return c.body(renderListBadgeSvg(null, "", 0, ""), 404, { ...headers, "Cache-Control": "public, max-age=300" });
  }
  const host = new URL(shortOrigin(c.env) ?? c.env.APP_URL).host;
  return c.body(renderListBadgeSvg(list.title, slug, list.games, host), 200, { ...headers, "Cache-Control": "public, max-age=3600" });
});

const IMMUTABLE_ASSET_CACHE = "public, max-age=86400";
app.get("/og.png", (c) => c.body(OG_IMAGE_PNG, 200, { "Content-Type": "image/png", "Cache-Control": IMMUTABLE_ASSET_CACHE }));

// Per-game social image, drawn on first request and then served from the edge cache for a day. Game pages link it
// with ?v=<hash of what's drawn> so platforms refetch after an edit; any other query string is ignored.
app.get("/og/games/:file", async (c) => {
  const slug = c.req.param("file").replace(/\.png$/, "");
  const cacheKey = new Request(new URL(`/og/games/${encodeURIComponent(slug)}.png?v=${encodeURIComponent(c.req.query("v") ?? "")}`, c.req.url).toString());
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  const game = await c.env.DB.prepare(
    "SELECT id, title, description, paywall FROM games WHERE slug = ?1 AND status = 'approved'"
  )
    .bind(slug)
    .first<{ id: string; title: string; description: string | null; paywall: number }>();
  if (!game) return c.body(null, 404);
  const categories = (await getCategoriesForGames(c.env, [game.id])).get(game.id) ?? [];
  let png: Uint8Array;
  try {
    png = await renderGameOgPng({
      title: game.title,
      description: game.description,
      categories,
      paywall: !!game.paywall
    });
  } catch (error) {
    // Never leave a share without a picture: fall back to the site-wide image (not cached, so it's retried).
    console.error(JSON.stringify({ message: "og render failed", slug, error: String(error) }));
    return c.body(OG_IMAGE_PNG, 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" });
  }
  const response = new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  c.executionCtx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
});
app.get("/icon.png", (c) => c.body(ICON_512, 200, { "Content-Type": "image/png", "Cache-Control": IMMUTABLE_ASSET_CACHE }));
app.get("/icon-192.png", (c) => c.body(ICON_192, 200, { "Content-Type": "image/png", "Cache-Control": IMMUTABLE_ASSET_CACHE }));
app.get("/apple-touch-icon.png", (c) => c.body(ICON_180, 200, { "Content-Type": "image/png", "Cache-Control": IMMUTABLE_ASSET_CACHE }));
app.get("/favicon.ico", (c) => c.body(ICON_48, 200, { "Content-Type": "image/png", "Cache-Control": IMMUTABLE_ASSET_CACHE }));

app.get("/manifest.webmanifest", (c) =>
  c.body(
    JSON.stringify({
      name: "0x9 dles",
      short_name: "0x9 dles",
      description: "A hub for daily games: browse, vote on, and favorite the best dailies.",
      id: "/",
      start_url: "/me/rotation",
      scope: "/",
      display: "standalone",
      background_color: "#121212",
      theme_color: "#121212",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }
      ],
      shortcuts: [
        { name: "Today's rotation", url: "/me/rotation" },
        { name: "Monthly recap", url: "/me/recap" },
        { name: "New games", url: "/new" },
        { name: "Random game", url: "/random" }
      ]
    }),
    200,
    { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=3600" }
  )
);

app.get("/robots.txt", (c) => {
  // Staging and dev must stay out of search results entirely.
  const body = c.env.APP_ENV !== "production" ? "User-agent: *\nDisallow: /\n" : `User-agent: *
Disallow: /api/
Disallow: /admin
Disallow: /me
Disallow: /login
Disallow: /random

Sitemap: ${c.env.APP_URL}/sitemap.xml
`;
  return c.body(body, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=3600"
  });
});

// A Markdown overview for AI assistants and answer engines (llmstxt.org): what the site is, its categories and lists,
// and the most popular games, all linking to their pages here.
app.get("/llms.txt", async (c) => {
  const base = c.env.APP_URL;
  const categories = await c.env.DB.prepare(
    `SELECT categories.slug, categories.name, categories.description, COUNT(games.id) AS game_count
     FROM categories
     LEFT JOIN game_categories ON game_categories.category_id = categories.id
     LEFT JOIN games ON games.id = game_categories.game_id AND games.status = 'approved'
     WHERE categories.is_active = 1
     GROUP BY categories.id
     ORDER BY categories.name ASC`
  ).all<{ slug: string; name: string; description: string | null; game_count: number }>();
  const lists = await c.env.DB.prepare(
    `SELECT slug, title, description, twitch_login, (SELECT COUNT(*) FROM curated_list_items WHERE curated_list_id = curated_lists.id) AS game_count
     FROM curated_lists WHERE visibility = 'public' AND EXISTS (SELECT 1 FROM curated_list_items WHERE curated_list_id = curated_lists.id) ORDER BY title ASC`
  ).all<{ slug: string; title: string; description: string | null; twitch_login: string | null; game_count: number }>();
  const topGames = await listGames(c.env, { sort: "top", hideNsfw: true, limit: 30 });
  const total = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'approved'").first<{ n: number }>())?.n ?? 0;
  const oneLine = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const body = [
    "# 0x9 dles",
    "",
    `> A community-run directory of ${total} daily web games ("dles"): short puzzles like Wordle that reset once a day. Visitors browse by category, vote, favorite games and build a personal daily rotation. Games are ranked by community votes.`,
    "",
    "Each game has its own page with a description, category, community rating, reset time when known, and a link to play it on its own site. Games marked as requiring payment or containing NSFW content are labelled.",
    "",
    "## Browse",
    "",
    `- [All daily games](${base}/games): every game, sortable by rating, newest, trending, popular this week or resetting soonest`,
    `- [All categories](${base}/categories): every category with its games and related categories`,
    `- [New daily games](${base}/new): games added in the last 30 days, week by week`,
    `- [Curated lists](${base}/lists): lists of games picked by editors and Twitch streamers`,
    `- [Submit a game](${base}/submit): suggest a daily game that's missing`,
    "",
    "## Categories",
    "",
    ...categories.results
      .filter((cat) => cat.game_count > 0)
      .map((cat) => {
        const description = cat.description && !cat.description.startsWith("Imported from") ? `: ${oneLine(cat.description)}` : "";
        return `- [${cat.name}](${base}/categories/${encodeURIComponent(cat.slug)}) (${cat.game_count} game${cat.game_count === 1 ? "" : "s"})${description}`;
      }),
    "",
    ...(lists.results.length > 0
      ? [
          "## Curated lists",
          "",
          ...lists.results.map((list) => `- [${list.title}](${base}/lists/${encodeURIComponent(list.slug)}) (${list.game_count} game${list.game_count === 1 ? "" : "s"}${list.twitch_login ? `, picked by ${list.twitch_login} on Twitch` : ""})${list.description ? `: ${oneLine(list.description)}` : ""}`),
          ""
        ]
      : []),
    "## Most popular games",
    "",
    ...topGames.map((game) => `- [${game.title}](${base}/games/${encodeURIComponent(game.slug)})${game.description ? `: ${oneLine(game.description)}` : ""}`),
    "",
    "## Optional",
    "",
    `- [Sitemap](${base}/sitemap.xml): every game, category and list page`,
    `- [Moderation log](${base}/mod-log): public record of games added, removed and changed`,
    `- [Changelog](${base}/changelog): feature updates since launch`,
    ""
  ].join("\n");
  return c.body(body, 200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=3600" });
});

// Admin SSR pages.
// Staff opening the admin pages also restarts announcements that are queued without a timer (e.g. queued before the
// alarm existed, or an alarm lost to an outage), so they never wait for the daily backstop.
for (const path of ["/admin", "/admin/*"]) {
  app.use(path, async (c, next) => {
    const user = c.get("user");
    if (c.req.method === "GET" && user && (user.role === "admin" || user.role === "editor")) {
      c.executionCtx.waitUntil(resumeQueuedAnnouncements(c.env));
    }
    await next();
  });
}

app.get("/admin", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const errCount24 = auth.role === "admin"
    ? ((await c.env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM client_errors WHERE last_seen >= datetime('now', '-1 day')").first<{ n: number }>().catch(() => null))?.n ?? 0)
    : 0;
  return c.html(await layout("Admin", auth, `
    <main>
      <h1>Admin</h1>
      <div class="admin-grid">
        <a class="panel" href="/admin/submissions">Moderate submissions</a>
        <a class="panel" href="/admin/reports">Review reports</a>
        <a class="panel" href="/admin/claims">Developer claims</a>
        <a class="panel" href="/admin/resets">Reset suggestions</a>
        ${auth.role === "admin" ? `<a class="panel" href="/admin/creators">Verified creators</a>
        <a class="panel" href="/admin/stats">Stats</a>
        <a class="panel" href="/admin/health">Link health and data gaps</a>
        <a class="panel" href="/admin/settings">Site settings</a>` : ""}
        ${auth.role === "admin" ? `<a class="panel" href="/admin/errors">Client errors${errCount24 > 0 ? ` <strong>(${errCount24} client error${errCount24 === 1 ? "" : "s"} today)</strong>` : ""}</a>` : ""}
        <a class="panel" href="/admin/categories">Manage categories</a>
        <a class="panel" href="/admin/lists">Manage curated lists</a>
      </div>
    </main>
  `, c.env));
});

// Possible duplicates of pending submissions (normalized URL, title or near-identical title, see src/lib/duplicates.ts)
// against every non-rejected game. One query, compared in memory.
type DuplicateCandidate = { id: string; title: string; slug: string; status: string };
async function loadDuplicateIndex(env: Env, statuses: string): Promise<DuplicateIndex> {
  const games = await env.DB.prepare(`SELECT id, title, slug, url, status FROM games WHERE status IN (${statuses})`).all<DuplicateGame>();
  return new DuplicateIndex(games.results);
}
async function findPossibleDuplicates(env: Env, pending: Array<{ id: string; title: string; url: string }>): Promise<Map<string, DuplicateCandidate[]>> {
  const found = new Map<string, DuplicateCandidate[]>();
  if (pending.length === 0) return found;
  const index = await loadDuplicateIndex(env, "'approved','pending','disabled'");
  for (const row of pending) {
    const matches = index.find({ url: row.url, title: row.title }, row.id);
    if (matches.length > 0) found.set(row.id, matches.map((m) => m.game));
  }
  return found;
}

app.get("/admin/submissions", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const status = (c.req.query("status") || "pending") as "pending" | "rejected" | "disabled" | "approved";
  const q = (c.req.query("q") || "").trim();
  const rows = q
    ? await c.env.DB.prepare(
        `SELECT id, title, slug, url, description, status, moderation_note, how_to_play, created_at, reset_basis, reset_time_minutes, reset_timezone, paywall, nsfw
         FROM games
         WHERE status = ?1
           AND (title LIKE ?2 OR url LIKE ?2 OR description LIKE ?2)
         ORDER BY created_at DESC
         LIMIT 200`
      )
        .bind(status, `%${q}%`)
        .all<{ id: string; title: string; slug: string; url: string; description: string | null; status: string; moderation_note: string | null; how_to_play: string | null; created_at: string; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null; paywall: number; nsfw: number }>()
    : await c.env.DB.prepare(
        `SELECT id, title, slug, url, description, status, moderation_note, how_to_play, created_at, reset_basis, reset_time_minutes, reset_timezone, paywall, nsfw
         FROM games
         WHERE status = ?1
         ORDER BY created_at DESC
         LIMIT 200`
      )
        .bind(status)
        .all<{ id: string; title: string; slug: string; url: string; description: string | null; status: string; moderation_note: string | null; how_to_play: string | null; created_at: string; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null; paywall: number; nsfw: number }>();
  const duplicates = status === "pending" ? await findPossibleDuplicates(c.env, rows.results) : new Map<string, DuplicateCandidate[]>();

  return c.html(await layout("Admin Submissions", auth, `
    <main>
      <h1>Moderate Submissions</h1>
      <form method="GET" action="/admin/submissions" class="filter-form">
        <select name="status" aria-label="Status">
          ${["pending", "rejected", "disabled", "approved"]
            .map((option) => `<option value="${option}" ${option === status ? "selected" : ""}>${option}</option>`)
            .join("")}
        </select>
        <input name="q" value="${escapeHtml(q)}" placeholder="Search title, URL, description" aria-label="Search" />
        <button type="submit">Filter</button>
      </form>
      <div class="actions">
        <button type="button" data-select-all-games>Toggle all</button>
        <button type="button" data-bulk-game-action="approve">Bulk approve</button>
        <button type="button" data-bulk-game-action="reject">Bulk reject</button>
        <button type="button" data-bulk-game-action="disable">Bulk disable</button>
        <button type="button" data-bulk-game-action="restore">Bulk restore</button>
      </div>
      <div class="stack">
        ${rows.results
          .map(
            (row) => `<article class="panel">
              <h2>${escapeHtml(row.title)}${row.paywall ? ` <span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}${row.nsfw ? ` <span class="nsfw-badge" title="This game contains NSFW content">nsfw</span>` : ""}</h2>
              <p>${escapeHtml(row.description || "")}</p>
              ${row.how_to_play ? `<details><summary>How to play</summary><p style="white-space:pre-wrap">${escapeHtml(row.how_to_play)}</p></details>` : ""}
              <p><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">Visit game</a> · <a href="/games/${row.slug}">Detail page</a></p>
              <p>Status: <strong>${row.status}</strong>${row.moderation_note ? ` · Note: ${escapeHtml(row.moderation_note)}` : ""}</p>
              ${(duplicates.get(row.id) ?? []).map((match) => `<p class="duplicate-warning">Possible duplicate of <a href="/games/${escapeHtml(encodeURIComponent(match.slug))}">${escapeHtml(match.title)}</a> (${escapeHtml(match.status)})</p>`).join("")}
              ${(() => {
                const resetLabel = getResetMetaLabel(row.reset_basis, row.reset_time_minutes, row.reset_timezone);
                return resetLabel ? `<p>${escapeHtml(resetLabel)}</p>` : "";
              })()}
              <div class="actions">
                <span data-reset-group>
                <select data-reset-basis="${row.id}" data-basis-select>
                  <option value="" ${!row.reset_basis ? "selected" : ""}>Unknown</option>
                  <option value="local" ${row.reset_basis === "local" ? "selected" : ""}>Local</option>
                  <option value="server" ${row.reset_basis === "server" ? "selected" : ""}>Server</option>
                </select>
                <input type="time" data-reset-time="${row.id}" value="${row.reset_time_minutes === null ? "" : escapeHtml(formatResetTime(row.reset_time_minutes))}" />
                <span data-tz-wrap><select data-tz-input data-reset-timezone="${row.id}" aria-label="Time zone">${renderTimeZoneOptions(row.reset_timezone)}</select></span>
                </span>
                <button type="button" data-reset-save="${row.id}">Save reset</button>
              </div>
              <label class="check"><input type="checkbox" data-game-select value="${row.id}" /> Select</label>
              <div class="actions">
                <button type="button" data-action="approve" data-game-id="${row.id}">Approve</button>
                <button type="button" data-action="reject" data-game-id="${row.id}">Reject</button>
                <button type="button" data-action="disable" data-game-id="${row.id}">Disable</button>
                <button type="button" data-action="restore" data-game-id="${row.id}">Restore</button>
              </div>
            </article>`
          )
          .join("")}
      </div>
      <p id="admin-submissions-status" class="status" aria-live="polite"></p>
    </main>
    <script src="${ASSET.page_submit_reset_tz}"></script>
  `, c.env));
});

app.get("/admin/claims", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  // Manual claims waiting for a decision first, then the developers currently verified (so one can be removed).
  const rows = await c.env.DB.prepare(
    `SELECT game_claims.id, game_claims.status, game_claims.method, game_claims.evidence, game_claims.created_at,
            games.title, games.slug, games.url, users.display_name
     FROM game_claims
     JOIN games ON games.id = game_claims.game_id
     JOIN users ON users.id = game_claims.user_id
     WHERE game_claims.status IN ('review', 'verified')
     ORDER BY CASE game_claims.status WHEN 'review' THEN 0 ELSE 1 END, game_claims.created_at DESC
     LIMIT 200`
  ).all<{ id: string; status: string; method: string | null; evidence: string | null; created_at: string; title: string; slug: string; url: string; display_name: string | null }>();
  return c.html(await layout("Developer claims", auth, `
    <main>
      <h1>Developer claims</h1>
      <p>People who say they made a game. Tag-based claims verify themselves; the ones below as "review" asked an editor to confirm their evidence.</p>
      ${rows.results.length === 0 ? "<p>No claims to show.</p>" : `<div class="stack">
        ${rows.results.map((row) => `<article class="panel" data-claim-id="${escapeHtml(row.id)}">
          <h2><a href="/games/${escapeHtml(row.slug)}">${escapeHtml(row.title)}</a> <small>(${escapeHtml(row.status)}${row.method ? `, ${escapeHtml(row.method)}` : ""})</small></h2>
          <p>Claimed by ${escapeHtml(row.display_name || "(no name)")} on ${escapeHtml(row.created_at)} UTC. Game URL: <a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.url)}</a></p>
          ${row.evidence ? `<p><strong>Evidence:</strong> ${escapeHtml(row.evidence)}</p>` : ""}
          <div class="actions">
            ${row.status === "review"
              ? `<button type="button" data-claim-action="approve">Approve</button><button type="button" class="danger" data-claim-action="reject">Reject</button>`
              : `<button type="button" class="danger" data-claim-action="revoke">Remove verification</button>`}
          </div>
        </article>`).join("")}
      </div>`}
      <p id="claims-status" class="status" aria-live="polite"></p>
    </main>
    <script>
      document.querySelectorAll("[data-claim-action]").forEach((button) => {
        button.addEventListener("click", async () => {
          const card = button.closest("[data-claim-id]");
          const res = await fetch("/api/admin/claims/" + card.getAttribute("data-claim-id"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: button.getAttribute("data-claim-action") })
          });
          if (res.ok) {
            window.location.reload();
            return;
          }
          const data = await res.json().catch(() => ({}));
          const message = data.error || "Could not update the claim.";
          document.getElementById("claims-status").textContent = message;
          if (window.appToast) window.appToast(message, "error");
        });
      });
    </script>
  `, c.env));
});

/** Site settings (key/value, set at /admin/settings). A missing key means the default. */
async function getSiteSettings(env: Env, keys: string[]): Promise<Map<string, string>> {
  const rows = await env.DB.prepare(`SELECT key, value FROM site_settings WHERE key IN (${keys.map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  return new Map(rows.results.map((row) => [row.key, row.value]));
}

/** Fan-dles caps: null means no limit (the default). */
async function getFandleLimits(env: Env): Promise<{ perDeveloper: number | null; shown: number | null; membershipDays: number | null }> {
  const settings = await getSiteSettings(env, [FANDLE_SETTING_MAX_PER_DEVELOPER, FANDLE_SETTING_MAX_SHOWN, FANDLE_SETTING_MEMBERSHIP_DAYS]);
  const parse = (value: string | undefined) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 ? n : null;
  };
  return {
    perDeveloper: parse(settings.get(FANDLE_SETTING_MAX_PER_DEVELOPER)),
    shown: parse(settings.get(FANDLE_SETTING_MAX_SHOWN)),
    membershipDays: parse(settings.get(FANDLE_SETTING_MEMBERSHIP_DAYS))
  };
}

/** Played on stream: "on" shows it to everyone, "off" (the default) to admins only. */
const PLAYED_SETTING = "played_on_stream";
const PLAYED_SETTING_CACHE_KEY = "settings:played_on_stream:v1";
// An hour: the key is rewritten on every change, so this only bounds reads of a missing key (KV writes are metered).
const PLAYED_SETTING_CACHE_SECONDS = 3600;

async function getPlayedOnStreamSetting(env: Env): Promise<boolean> {
  const cached = await getCachedJson<{ on: boolean }>(env, PLAYED_SETTING_CACHE_KEY);
  if (cached) return cached.on;
  const on = (await getSiteSettings(env, [PLAYED_SETTING])).get(PLAYED_SETTING) === "on";
  await setCachedJson(env, PLAYED_SETTING_CACHE_KEY, { on }, PLAYED_SETTING_CACHE_SECONDS);
  return on;
}

/** Whether Played on stream applies to this request: the setting is on, or the viewer is an admin. */
async function playedOnStreamFor(env: Env, user: AppUser | null): Promise<boolean> {
  if (user?.role === "admin") return true;
  return getPlayedOnStreamSetting(env);
}

app.get("/admin/stats", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const [{ scalars: s, topClicked, topVoted, topFavorited, series }, act] = await Promise.all([loadStats(c.env.DB), loadActivity(c.env.DB)]);
  const num = (n: number) => n.toLocaleString("en-US");
  const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");
  const card = (label: string, value: number | string, note = "") =>
    `<div class="stat-card"><div class="stat-value">${typeof value === "number" ? num(value) : escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div>${note ? `<div class="stat-note">${escapeHtml(note)}</div>` : ""}</div>`;
  const section = (title: string, intro: string, cards: string) =>
    `<section class="panel"><h2>${escapeHtml(title)}</h2>${intro ? `<p class="muted">${escapeHtml(intro)}</p>` : ""}<div class="stat-grid">${cards}</div></section>`;
  const topTable = (title: string, rows: { slug: string; title: string; n: number }[], unit: string) =>
    `<div class="stat-top"><h3>${escapeHtml(title)}</h3>${rows.length ? `<ol>${rows.map((r) => `<li><a href="/games/${encodeURIComponent(r.slug)}">${escapeHtml(r.title)}</a> <span class="muted">${num(r.n)} ${unit}</span></li>`).join("")}</ol>` : `<p class="muted">Nothing yet.</p>`}</div>`;
  const maxOf = (key: "users" | "votes" | "games") => Math.max(1, ...series.map((d) => d[key]));
  const chart = (title: string, key: "users" | "votes" | "games") =>
    `<div class="stat-chart"><h3>${escapeHtml(title)} <span class="muted">(${num(series.reduce((t, d) => t + d[key], 0))} in 14 days)</span></h3><div class="bars" role="img" aria-label="${escapeHtml(title)}, last 14 days">${series
      .map((d) => `<span class="bar" title="${d.date}: ${d[key]}" style="height:${Math.max(d[key] > 0 ? 6 : 2, Math.round((d[key] / maxOf(key)) * 100))}%"></span>`)
      .join("")}</div><div class="bars-axis"><span>${series[0].date.slice(5)}</span><span>${series[series.length - 1].date.slice(5)}</span></div></div>`;

  const delta = (cur: number, prev: number) => (prev > 0 ? `${cur >= prev ? "▲" : "▼"} ${Math.abs(Math.round(((cur - prev) / prev) * 100))}%` : cur > 0 ? "▲ new" : "–");
  const actChart = (title: string, values: number[], note: string) =>
    `<div class="stat-chart"><h3>${escapeHtml(title)} <span class="muted">${escapeHtml(note)}</span></h3>${barChartSvg(title, act.days, values, escapeHtml)}</div>`;
  const sumA = (a: number[]) => a.reduce((t, v) => t + v, 0);
  const activitySection = `<section class="panel"><h2>Activity</h2><p class="muted">Last 30 days, US/Eastern dates (${escapeHtml(labelDay(act.days[0]))} to ${escapeHtml(labelDay(act.days[29]))}). Opens are game link clicks; players are signed-in accounts only.</p>
    <div class="stat-grid">${[
      card("Opens, 30 days", sumA(act.opens)),
      card("Opens, 7 days", act.opens7, `${delta(act.opens7, act.openPrev7)} vs prior 7 (${num(act.openPrev7)})`),
      card("Players today (DAU)", act.dau[29]),
      card("Players, 7 days (WAU)", act.wau),
      card("Players, 30 days (MAU)", act.mau),
      card("Stream sessions, 7 days", sumA(act.sessions.slice(-7)), "distinct list and day"),
      card("Rotation adds, 7 days", act.favs7),
      card("Rotation adds, 30 days", act.favs30)
    ].join("")}</div>
    <div class="stat-charts">${actChart("Opens per day", act.opens, `(${num(sumA(act.opens))} total)`)}${actChart("Signed-in players per day", act.dau, "(DAU)")}${actChart("Stream sessions per day", act.sessions, `(${num(sumA(act.sessions))} total)`)}</div>
    <div class="stat-tops"><div class="stat-top"><h3>Top games by opens this week</h3>${act.topOpened.length ? `<ol>${act.topOpened.map((r) => `<li><a href="/games/${encodeURIComponent(r.slug)}">${escapeHtml(r.title)}</a> <span class="muted">${num(r.n)} <span title="Prior 7 days: ${num(r.prev)}">${delta(r.n, r.prev)}</span></span></li>`).join("")}</ol>` : `<p class="muted">Nothing yet.</p>`}</div>
    <div class="stat-top"><h3>Most streamed this week</h3>${act.topStreamed.length ? `<ol>${act.topStreamed.map((r) => `<li><a href="/games/${encodeURIComponent(r.slug)}">${escapeHtml(r.title)}</a> <span class="muted">${num(r.n)} plays</span></li>`).join("")}</ol>` : `<p class="muted">Nothing yet.</p>`}</div></div></section>`;

  const accounts = s.usersTotal;
  const votesTotal = s.votesUser + s.votesAnon;
  const favTotal = s.favUser + s.favAnon;
  return c.html(await layout("Stats", auth, `
    <main>
      <h1>Stats</h1>
      <p class="muted">Counted live from the database. Page views and total visitors are not recorded, so "anonymous" means people who voted or kept a rotation without signing in.</p>
      ${section("People", "", [
        card("Accounts", accounts),
        card("New today", s.usersNew1),
        card("New in 7 days", s.usersNew7),
        card("New in 30 days", s.usersNew30),
        card("Signed in now", s.usersSignedIn, "with a live session"),
        card("Discord linked", s.usersDiscord),
        card("Twitch linked", s.usersTwitch),
        card("Both linked", s.usersBothProviders),
        card("Editors", s.usersEditors),
        card("Admins", s.usersAdmins),
        card("Public profiles", s.usersPublicProfile),
        card("Verified creators", s.usersCreators)
      ].join(""))}
      ${section("Signed in vs anonymous", "Anonymous voters are counted by hashed IP address and anonymous rotations by browser, so they are approximate.", [
        card("Signed-in voters", s.usersVoted, `${pct(s.usersVoted, accounts)} of accounts`),
        card("Anonymous voters", s.anonVoters),
        card("Signed-in rotations", s.usersWithFavorites, `${pct(s.usersWithFavorites, accounts)} of accounts`),
        card("Anonymous rotations", s.anonRotations),
        card("Votes by signed-in", s.votesUser, pct(s.votesUser, votesTotal)),
        card("Votes by anonymous", s.votesAnon, pct(s.votesAnon, votesTotal))
      ].join(""))}
      ${section("Votes, favorites and clicks", "", [
        card("Votes in total", votesTotal),
        card("Votes today", s.votes1),
        card("Votes in 7 days", s.votes7),
        card("Votes in 30 days", s.votes30),
        card("Upvote share", pct(s.votesUserUp + s.votesAnonUp, votesTotal)),
        card("Favorites in total", favTotal, `${num(s.favUser)} signed in, ${num(s.favAnon)} anonymous`),
        card("Favorites in 7 days", s.fav7),
        card("Game clicks", s.clicksTotal, "all time, no per-day history")
      ].join(""))}
      ${section("Games", "", [
        card("Listed games", s.gamesApproved),
        card("Awaiting review", s.gamesPending),
        card("Rejected", s.gamesRejected),
        card("Disabled", s.gamesDisabled),
        card("Submitted in 7 days", s.gamesNew7),
        card("Submitted in 30 days", s.gamesNew30),
        card("With a reset time", s.gamesWithReset, pct(s.gamesWithReset, s.gamesApproved)),
        card("Paywalled", s.gamesPaywall),
        card("NSFW", s.gamesNsfw),
        card("Failing link checks", s.gamesBroken),
        card("No votes yet", s.gamesNoVotes),
        card("Categories", s.categories)
      ].join(""))}
      ${section("Lists, Fan-dles and developers", "", [
        card("Public lists", s.listsPublic),
        card("Private lists", s.listsPrivate),
        card("Creator lists", s.listsCreator),
        card("Games on lists", s.listItems),
        card("Open suggestions", s.suggestions),
        card("Suggestion votes", s.suggestionVotes),
        card("Fan-dles members", s.fandleMembers, `${num(s.fandleManual)} added by hand`),
        card("Verified developers", s.claimDevelopers),
        card("Verified games", s.claimsVerified),
        card("Claims in progress", s.claimsOpen, `${num(s.claimsReview)} awaiting review`),
        card("Open reports", s.reportsOpen, `${num(s.reportsTotal)} in total`)
      ].join(""))}
      ${activitySection}
      <section class="panel">
        <h2>Last 14 days</h2>
        <div class="stat-charts">${chart("New accounts", "users")}${chart("Votes", "votes")}${chart("Games submitted", "games")}</div>
      </section>
      <section class="panel">
        <h2>Top games</h2>
        <div class="stat-tops">${topTable("Most clicked", topClicked, "clicks")}${topTable("Most voted on", topVoted, "votes")}${topTable("Most favorited", topFavorited, "rotations")}</div>
      </section>
    </main>
    <style>
      .stat-grid { display:grid; gap:0.6rem; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
      .stat-card { padding:0.7rem 0.8rem; border:1px solid var(--border); border-radius:10px; background:var(--bg-soft); min-width:0; }
      .stat-value { font-size:1.6rem; font-weight:800; line-height:1.1; color:var(--title-ink); font-variant-numeric: tabular-nums; }
      .stat-label { margin-top:0.2rem; font-size:0.85rem; color:var(--ink); }
      .stat-note { margin-top:0.1rem; font-size:0.75rem; color:var(--muted); }
      .stat-charts, .stat-tops { display:grid; gap:1rem; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
      .stat-chart h3, .stat-top h3 { margin:0 0 0.5rem; font-size:0.95rem; }
      .bars { display:flex; align-items:flex-end; gap:3px; height:90px; }
      .bar { flex:1; background:var(--primary); border-radius:3px 3px 0 0; min-width:0; }
      .bars-axis { display:flex; justify-content:space-between; font-size:0.72rem; color:var(--muted); margin-top:0.2rem; }
      .stat-top ol { margin:0; padding-left:1.3rem; display:flex; flex-direction:column; gap:0.25rem; }
      .stat-top li { overflow-wrap:anywhere; }
      .act-svg { display:block; width:100%; height:90px; }
      .stat-charts + .stat-tops { margin-top:1.2rem; }
    </style>
  `, c.env));
});

app.get("/admin/settings", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const limits = await getFandleLimits(c.env);
  const playedOn = await getPlayedOnStreamSetting(c.env);
  return c.html(await layout("Settings", auth, `
    <main class="narrow">
      <h1>Site settings</h1>
      <form id="settings-form" class="stack-form">
        <section class="panel">
          <h2>Played on stream</h2>
          <label class="check"><input type="checkbox" name="playedOnStream" id="played-on-stream"${playedOn ? " checked" : ""} /> Played on stream: Off (admins only) / On (everyone)</label>
          <p class="muted" id="played-on-stream-note">${playedOn ? "On: everyone sees and uses Played on stream on lists." : "Off: only admins see and use it on lists."}</p>
        </section>
        <section class="panel">
          <h2>Fan-dles limits</h2>
          <p>How many community games a streamer's Fan-dles section shows, and how long a Twitch check counts. Leave a box empty for no limit. Games are picked best-scoring first. With no total set, at most ${FANDLE_HARD_MAX_SHOWN} are shown.</p>
          <label>Most games per developer <small>(empty = no limit)</small>
            <input type="number" name="perDeveloper" min="1" max="${FANDLE_SETTING_LIMIT_MAX}" inputmode="numeric" value="${limits.perDeveloper ?? ""}" />
          </label>
          <label>Most games in total <small>(empty = no limit)</small>
            <input type="number" name="shown" min="1" max="${FANDLE_SETTING_LIMIT_MAX}" inputmode="numeric" value="${limits.shown ?? ""}" />
          </label>
          <label>Check again after (days) <small>(empty = a check never runs out; the developer can still leave)</small>
            <input type="number" name="membershipDays" min="1" max="3650" inputmode="numeric" value="${limits.membershipDays ?? ""}" />
          </label>
        </section>
        <button type="submit" class="btn">Save</button>
      </form>
      <p id="settings-status" class="status" aria-live="polite"></p>
    </main>
    <script src="${ASSET.page_admin_settings}"></script>
  `, c.env));
});

const siteSettingsSchema = z.object({
  fandleMaxPerDeveloper: z.number().int().min(1).max(FANDLE_SETTING_LIMIT_MAX).nullable(),
  fandleMaxShown: z.number().int().min(1).max(FANDLE_SETTING_LIMIT_MAX).nullable(),
  fandleMembershipDays: z.number().int().min(1).max(3650).nullable(),
  /** Optional, so the Fan-dles fields can be saved without it. */
  playedOnStream: z.enum(["on", "off"]).optional()
});

app.put("/api/admin/settings", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = siteSettingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: `Enter a whole number (up to ${FANDLE_SETTING_LIMIT_MAX} games, or 3650 days), or leave it empty for no limit` }, 400);
  }
  const entries: Array<[string, number | null]> = [
    [FANDLE_SETTING_MAX_PER_DEVELOPER, parsed.data.fandleMaxPerDeveloper],
    [FANDLE_SETTING_MAX_SHOWN, parsed.data.fandleMaxShown],
    [FANDLE_SETTING_MEMBERSHIP_DAYS, parsed.data.fandleMembershipDays]
  ];
  const upsert = (key: string, value: string) =>
    c.env.DB.prepare(
      `INSERT INTO site_settings (key, value, updated_by_user_id, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`
    ).bind(key, value, auth.id);
  const statements = entries.map(([key, value]) =>
    value === null
      ? c.env.DB.prepare("DELETE FROM site_settings WHERE key = ?1").bind(key)
      : upsert(key, String(value))
  );
  const playedBefore = await getPlayedOnStreamSetting(c.env);
  const playedValue = parsed.data.playedOnStream;
  if (playedValue) statements.push(upsert(PLAYED_SETTING, playedValue));
  await c.env.DB.batch(statements);
  const audit: Record<string, unknown> = Object.fromEntries(entries);
  if (playedValue) {
    audit[PLAYED_SETTING] = playedValue;
    // Rewrite the KV copy first (so reads see the new value), then drop the cached list pages built with the old one.
    await setCachedJson(c.env, PLAYED_SETTING_CACHE_KEY, { on: playedValue === "on" }, PLAYED_SETTING_CACHE_SECONDS);
    if ((playedValue === "on") !== playedBefore) await purgeAllListPageCaches(c);
  }
  await writeAudit(c.env, auth.id, "settings", "site", "update_settings", audit);
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.get("/admin/creators", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const q = (c.req.query("q") || "").trim().slice(0, 60);
  const creators = await c.env.DB.prepare(
    `SELECT users.id, users.display_name, users.creator_type, curated_lists.slug
     FROM users LEFT JOIN curated_lists ON curated_lists.owner_user_id = users.id AND curated_lists.kind = 'creator'
     WHERE users.creator_type IS NOT NULL
     ORDER BY users.creator_type, users.display_name LIMIT 200`
  ).all<{ id: string; display_name: string | null; creator_type: string; slug: string | null }>();
  const matches = q
    ? await c.env.DB.prepare(
        `SELECT id, display_name, created_at FROM users WHERE creator_type IS NULL AND display_name LIKE ?1 ORDER BY display_name LIMIT 20`
      )
        .bind(`%${q}%`)
        .all<{ id: string; display_name: string | null; created_at: string }>()
    : null;
  const allowlist = await c.env.DB.prepare(
    `SELECT creator_allowlist.twitch_user_id, creator_allowlist.twitch_login,
            EXISTS(SELECT 1 FROM oauth_accounts WHERE provider = 'twitch' AND provider_user_id = creator_allowlist.twitch_user_id) AS signed_up,
            (SELECT GROUP_CONCAT(title, ', ') FROM curated_lists WHERE twitch_user_id = creator_allowlist.twitch_user_id AND kind = 'curated' AND visibility = 'public') AS list_titles
     FROM creator_allowlist ORDER BY creator_allowlist.twitch_login`
  ).all<{ twitch_user_id: string; twitch_login: string; signed_up: number; list_titles: string | null }>();
  const typeLabel: Record<string, string> = { affiliate: "Twitch Affiliate", partner: "Twitch Partner", manual: "Granted by staff" };
  return c.html(await layout("Verified creators", auth, `
    <main>
      <h1>Verified creators</h1>
      <p>Twitch affiliates and partners become verified creators automatically when they sign in with Twitch. Use this page for anyone else, for example a YouTube creator.</p>
      <section class="panel">
        <h2>Grant creator status</h2>
        <form method="GET" action="/admin/creators" class="filter-form">
          <input name="q" value="${escapeHtml(q)}" placeholder="Search accounts by display name" aria-label="Search accounts" />
          <button type="submit">Search</button>
        </form>
        ${matches ? (matches.results.length === 0 ? "<p>No matching accounts without creator status.</p>" : `<ul class="stack">${matches.results
          .map((row) => `<li class="panel" data-user-id="${escapeHtml(row.id)}"><strong>${escapeHtml(row.display_name || "(no name)")}</strong> <small class="muted">joined ${escapeHtml(row.created_at)} UTC · id ${escapeHtml(row.id.slice(0, 8))}</small>
            <div class="actions"><button type="button" data-creator-action="grant">Make verified creator</button></div></li>`)
          .join("")}</ul>`) : ""}
      </section>
      <section class="panel">
        <h2>Verify a Twitch streamer by username</h2>
        <p>For a streamer who isn't an affiliate or partner, or who hasn't signed in yet. If they already have a public list tagged to their channel, it is verified (with the check and Fan-dles) straight away. They get a list of their own, and full creator tools, when they sign in with Twitch (at once if they already have an account).</p>
        <form id="allowlist-form" class="stack-form">
          <input name="login" placeholder="Twitch username" aria-label="Twitch username" maxlength="25" pattern="[A-Za-z0-9_]{4,25}" required />
          <button type="submit" class="btn">Verify streamer</button>
        </form>
        ${allowlist.results.length === 0 ? "" : `<ul class="stack">${allowlist.results
          .map((row) => `<li class="panel" data-twitch-id="${escapeHtml(row.twitch_user_id)}"><strong>${escapeHtml(row.twitch_login)}</strong> <small class="muted">${row.signed_up ? "has an account" : row.list_titles ? `verified now on their list (${escapeHtml(row.list_titles)}); gets their own list at first sign-in` : "waiting for their first sign-in"}</small>
            <div class="actions"><button type="button" class="danger" data-allowlist-remove>Remove</button></div></li>`)
          .join("")}</ul>`}
      </section>
      <section>
        <h2>Current creators (${creators.results.length})</h2>
        ${creators.results.length === 0 ? "<p>None yet.</p>" : `<ul class="stack">${creators.results
          .map((row) => `<li class="panel" data-user-id="${escapeHtml(row.id)}"><strong>${escapeHtml(row.display_name || "(no name)")}</strong> · ${escapeHtml(typeLabel[row.creator_type] || row.creator_type)}${row.slug ? ` · <a href="/lists/${encodeURIComponent(row.slug)}">their list</a>` : ""}
            ${row.creator_type === "manual" ? `<div class="actions"><button type="button" class="danger" data-creator-action="revoke">Remove status</button></div>` : ""}</li>`)
          .join("")}</ul>`}
      </section>
      <p id="creators-status" class="status" aria-live="polite"></p>
    </main>
    <script src="${ASSET.page_admin_creators}"></script>
  `, c.env));
});

app.post("/api/admin/creators/twitch", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = z.object({ login: z.string().regex(/^[A-Za-z0-9_]{4,25}$/) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Enter a valid Twitch username (4-25 letters, numbers or underscores)" }, 400);
  }
  let twitch: { id: string; login: string } | null;
  try {
    // Development only: "mock<digits>" stands in for a Twitch user, so this works without calling Twitch.
    const mock = isDevEnv(c.env) ? /^mock(\d+)$/i.exec(parsed.data.login) : null;
    twitch = mock ? { id: mock[1], login: parsed.data.login.toLowerCase() } : await lookupTwitchUser(c.env, parsed.data.login);
  } catch {
    return c.json({ error: "Could not reach Twitch to verify that username. Try again shortly." }, 502);
  }
  if (!twitch) {
    return c.json({ error: "No Twitch user with that username" }, 404);
  }
  await c.env.DB.prepare(
    `INSERT INTO creator_allowlist (twitch_user_id, twitch_login, added_by_user_id) VALUES (?1, ?2, ?3)
     ON CONFLICT (twitch_user_id) DO UPDATE SET twitch_login = excluded.twitch_login`
  )
    .bind(twitch.id, twitch.login, auth.id)
    .run();
  // Someone with that Twitch account already here becomes a creator now; otherwise it happens at their first sign-in.
  const account = await c.env.DB.prepare("SELECT user_id FROM oauth_accounts WHERE provider = 'twitch' AND provider_user_id = ?1").bind(twitch.id).first<{ user_id: string }>();
  if (account) {
    await c.env.DB.prepare("UPDATE users SET creator_type = COALESCE(creator_type, 'manual'), updated_at = datetime('now') WHERE id = ?1").bind(account.user_id).run();
    await ensureCreatorList(c.env, account.user_id, { twitchId: twitch.id, twitchLogin: twitch.login });
  }
  await writeAudit(c.env, auth.id, "user", account?.user_id ?? twitch.id, "verify_streamer", { twitchLogin: twitch.login, twitchUserId: twitch.id, hasAccount: !!account });
  await invalidateGameCaches(c.env);
  const taggedLists = await c.env.DB.prepare("SELECT title FROM curated_lists WHERE twitch_user_id = ?1 AND kind = 'curated' AND visibility = 'public'").bind(twitch.id).all<{ title: string }>();
  return c.json({ ok: true, login: twitch.login, hasAccount: !!account, verifiedLists: taggedLists.results.map((row) => row.title) });
});

app.delete("/api/admin/creators/twitch/:id", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const twitchId = c.req.param("id");
  await c.env.DB.batch([
    // Only a hand-granted status goes with it; an affiliate or partner keeps theirs.
    c.env.DB.prepare(
      `UPDATE users SET creator_type = NULL, updated_at = datetime('now')
       WHERE creator_type = 'manual' AND id IN (SELECT user_id FROM oauth_accounts WHERE provider = 'twitch' AND provider_user_id = ?1)`
    ).bind(twitchId),
    c.env.DB.prepare("DELETE FROM creator_allowlist WHERE twitch_user_id = ?1").bind(twitchId)
  ]);
  await writeAudit(c.env, auth.id, "user", twitchId, "unverify_streamer", {});
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.post("/api/admin/users/:id/creator", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = z.object({ grant: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const userId = c.req.param("id");
  const target = await c.env.DB.prepare("SELECT creator_type FROM users WHERE id = ?1").bind(userId).first<{ creator_type: string | null }>();
  if (!target) {
    return c.json({ error: "User not found" }, 404);
  }
  if (parsed.data.grant) {
    if (!target.creator_type) {
      await c.env.DB.prepare("UPDATE users SET creator_type = 'manual', updated_at = datetime('now') WHERE id = ?1").bind(userId).run();
    }
    const twitchId = await c.env.DB.prepare("SELECT provider_user_id FROM oauth_accounts WHERE user_id = ?1 AND provider = 'twitch'").bind(userId).first<{ provider_user_id: string }>();
    await ensureCreatorList(c.env, userId, twitchId ? { twitchId: twitchId.provider_user_id, twitchLogin: await getTwitchLoginById(c.env, twitchId.provider_user_id) } : undefined);
  } else {
    if (target.creator_type !== "manual") {
      return c.json({ error: "Only a status granted by staff can be removed. Twitch affiliates and partners follow their Twitch status." }, 409);
    }
    await c.env.DB.prepare("UPDATE users SET creator_type = NULL, updated_at = datetime('now') WHERE id = ?1").bind(userId).run();
  }
  await writeAudit(c.env, auth.id, "user", userId, parsed.data.grant ? "grant_creator" : "revoke_creator", {});
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

// Client JS error reports (sendBeacon from head.js / the embed page; anonymous, no CSRF). Aggregated by fingerprint.
app.post(CLIENT_ERRORS_PATH, async (c) => {
  const len = Number(c.req.header("content-length") || 0);
  if (len > 4096) return c.body(null, 204);
  const raw = await c.req.text().catch(() => "");
  if (raw.length > 4096) return c.body(null, 204);
  let json: unknown = null;
  try { json = JSON.parse(raw); } catch { /* ignore */ }
  const parsed = z.object({
    message: z.string().min(1).max(500),
    source: z.string().max(300).optional(),
    line: z.number().int().min(0).max(1e7).optional(),
    col: z.number().int().min(0).max(1e7).optional(),
    stack: z.string().max(1500).optional(),
    page: z.string().max(300).optional(),
    version: z.string().max(80).optional()
  }).safeParse(json);
  if (!parsed.success) return c.body(null, 204);
  const rate = await enforceRateLimit(c.env, `clienterr:${await getAnonymousVoteKey(c)}`, 30, 60 * 60);
  if (!rate.ok) return c.body(null, 204);
  const d = parsed.data;
  const source = (d.source ?? "").split(/[?#]/)[0];
  const fingerprint = await hashToken(c.env.SESSION_SECRET, `client-error:${d.message}|${source}|${d.line ?? 0}`);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO client_errors (fingerprint, message, source, line, col, stack, page, version, first_seen, last_seen, count)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), datetime('now'), 1)
       ON CONFLICT(fingerprint) DO UPDATE SET count = count + 1, last_seen = datetime('now'), page = excluded.page, version = excluded.version, stack = excluded.stack`
    ).bind(fingerprint, d.message, source, d.line ?? 0, d.col ?? 0, d.stack ?? "", d.page ?? "", d.version ?? ""),
    c.env.DB.prepare("DELETE FROM client_errors WHERE last_seen < datetime('now', '-30 days')")
  ]);
  return c.body(null, 204);
});

app.get("/admin/errors", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) return auth;
  const rows = await c.env.DB.prepare("SELECT fingerprint, message, source, line, stack, page, version, first_seen, last_seen, count FROM client_errors ORDER BY last_seen DESC LIMIT 500")
    .all<{ fingerprint: string; message: string; source: string | null; line: number | null; stack: string | null; page: string | null; version: string | null; first_seen: string; last_seen: string; count: number }>();
  const when = (iso: string) => new Date(iso.replace(" ", "T") + "Z").toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
  return c.html(await layout("Client errors", auth, `
    <main>
      <h1>Client errors</h1>
      <p class="muted">Uncaught JavaScript errors reported by browsers, grouped by message and location, kept 30 days. Times are US/Eastern.</p>
      ${rows.results.length ? `<p><button type="button" class="btn" id="clear-all-errors">Clear all</button></p>
      <div style="overflow-x:auto"><table>
        <thead><tr><th>Message</th><th>Page</th><th>Source</th><th>Count</th><th>First seen</th><th>Last seen</th><th>Version</th><th></th></tr></thead>
        <tbody>${rows.results.map((r) => `<tr>
          <td>${escapeHtml(r.message)}${r.stack ? `<details><summary>Stack</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(r.stack)}</pre></details>` : ""}</td>
          <td>${escapeHtml(r.page ?? "")}</td>
          <td>${escapeHtml(r.source ?? "")}:${r.line ?? 0}</td>
          <td>${r.count.toLocaleString("en-US")}</td>
          <td>${escapeHtml(when(r.first_seen))} ET</td>
          <td>${escapeHtml(when(r.last_seen))} ET</td>
          <td>${escapeHtml(r.version ?? "")}</td>
          <td><button type="button" class="btn" data-clear-error="${escapeHtml(r.fingerprint)}">Clear</button></td>
        </tr>`).join("")}</tbody></table></div>` : `<p class="muted">No client errors recorded.</p>`}
      <script>
        document.addEventListener("click", async (e) => {
          const one = e.target.closest("[data-clear-error]");
          const all = e.target.closest("#clear-all-errors");
          if (!one && !all) return;
          const res = await fetch(one ? "/api/admin/client-errors/" + encodeURIComponent(one.dataset.clearError) : "/api/admin/client-errors", { method: "DELETE" });
          if (res.ok) location.reload();
        });
      </script>
    </main>
  `, c.env));
});

app.delete("/api/admin/client-errors/:fingerprint", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) return auth;
  await c.env.DB.prepare("DELETE FROM client_errors WHERE fingerprint = ?1").bind(c.req.param("fingerprint")).run();
  return c.json({ ok: true });
});

app.delete("/api/admin/client-errors", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) return auth;
  await c.env.DB.prepare("DELETE FROM client_errors").run();
  return c.json({ ok: true });
});

app.get("/admin/health", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const h = await loadGameHealth(c.env.DB);
  const dupGroups = (await loadDuplicateIndex(c.env, "'approved'")).exactGroups();
  const when = (iso: string | null) =>
    iso ? new Date(iso.replace(" ", "T") + "Z").toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "never";
  const gapSection = (title: string, g: { count: number; rows: { slug: string; title: string; description_length: number }[] }, showLen: boolean) =>
    `<details class="panel"><summary><strong>${escapeHtml(title)}</strong> <span class="muted">${g.count.toLocaleString("en-US")} game${g.count === 1 ? "" : "s"}</span></summary>${
      g.rows.length
        ? `<ol>${g.rows.map((r) => `<li><a href="/games/${encodeURIComponent(r.slug)}">${escapeHtml(r.title)}</a>${showLen ? ` <span class="muted">${r.description_length} chars</span>` : ""}</li>`).join("")}</ol>${g.count > GAP_LIMIT ? `<p class="muted">Showing the top ${GAP_LIMIT} by score.</p>` : ""}`
        : `<p class="muted">None.</p>`
    }</details>`;
  return c.html(await layout("Link health", auth, `
    <main>
      <h1>Link health and data gaps</h1>
      <section>
        <h2>Possibly broken links <span class="muted">(${h.broken.length})</span></h2>
        <p class="muted">Approved games whose play URL failed the daily check ${BROKEN_THRESHOLD} or more times in a row (the point where an auto-report is filed). Only 404/410 and connection failures count; bot walls and timeouts do not.</p>
        <div class="stack">${
          h.broken.length
            ? h.broken.map((r) => `<article class="panel">
              <h3><a href="/games/${encodeURIComponent(r.slug)}">${escapeHtml(r.title)}</a></h3>
              <p style="overflow-wrap:anywhere"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.url)} ↗</a></p>
              <p>Failures: <strong>${r.link_fail_count}</strong> · Checked: ${escapeHtml(when(r.last_checked_at))} ET</p>
              <p><a href="/admin/reports?q=${encodeURIComponent(r.title)}">Reports</a> · <a href="/games/${encodeURIComponent(r.slug)}#admin-edit-form">Edit or disable</a></p>
            </article>`).join("")
            : `<p class="muted">No broken links found.</p>`
        }</div>
      </section>
      <section>
        <h2>Data gaps</h2>
        <p class="muted">Approved games, highest score first, up to ${GAP_LIMIT} each.</p>
        ${gapSection("Missing or short description (under 40 characters)", h.description, true)}
        ${gapSection("Missing reset schedule", h.reset, false)}
        ${gapSection("No categories", h.categories, false)}
      </section>
      <section>
        <h2>Possible duplicates <span class="muted">(${dupGroups.length})</span></h2>
        <p class="muted">Approved games sharing a normalized link (scheme, www, trailing slash and tracking parameters ignored) or title (case, punctuation, accents and a leading "the" ignored).</p>
        ${dupGroups.length
          ? `<div class="stack">${dupGroups.slice(0, 200).map((g) => `<article class="panel"><p><strong>Same ${g.reason === "url" ? "link" : "title"}:</strong> ${g.games.map((game) => `<a href="/games/${encodeURIComponent(game.slug)}">${escapeHtml(game.title)}</a>`).join(" · ")}</p>${g.reason === "url" ? `<p class="muted" style="overflow-wrap:anywhere">${escapeHtml(g.games[0].url)}</p>` : ""}</article>`).join("")}</div>${dupGroups.length > 200 ? `<p class="muted">Showing the first 200.</p>` : ""}`
          : `<p class="muted">None found.</p>`}
      </section>
    </main>
  `, c.env));
});

app.get("/admin/reports", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const status = (c.req.query("status") || "open") as "open" | "resolved" | "dismissed";
  const q = (c.req.query("q") || "").trim();
  const rows = q
    ? await c.env.DB.prepare(
        `SELECT reports.id, reports.reason, reports.status, reports.note, reports.created_at,
                games.id AS game_id, games.slug AS game_slug, games.title, games.url AS game_url, games.status AS game_status
         FROM reports
         JOIN games ON games.id = reports.game_id
         WHERE reports.status = ?1
           AND (games.title LIKE ?2 OR reports.reason LIKE ?2 OR reports.note LIKE ?2)
         ORDER BY reports.created_at DESC
         LIMIT 200`
      )
        .bind(status, `%${q}%`)
        .all<{ id: string; reason: string; status: string; note: string | null; created_at: string; game_id: string; game_slug: string; title: string; game_url: string; game_status: string }>()
    : await c.env.DB.prepare(
        `SELECT reports.id, reports.reason, reports.status, reports.note, reports.created_at,
                games.id AS game_id, games.slug AS game_slug, games.title, games.url AS game_url, games.status AS game_status
         FROM reports
         JOIN games ON games.id = reports.game_id
         WHERE reports.status = ?1
         ORDER BY reports.created_at DESC
         LIMIT 200`
      )
        .bind(status)
        .all<{ id: string; reason: string; status: string; note: string | null; created_at: string; game_id: string; game_slug: string; title: string; game_url: string; game_status: string }>();

  return c.html(await layout("Admin Reports", auth, `
    <main>
      <h1>Review Reports</h1>
      <form method="GET" action="/admin/reports" class="filter-form">
        <select name="status" aria-label="Status">
          ${["open", "resolved", "dismissed"]
            .map((option) => `<option value="${option}" ${option === status ? "selected" : ""}>${option}</option>`)
            .join("")}
        </select>
        <input name="q" value="${escapeHtml(q)}" placeholder="Search title, reason, note" aria-label="Search" />
        <button type="submit">Filter</button>
      </form>
      <div class="actions">
        <button type="button" data-select-all-reports>Toggle all</button>
        <button type="button" data-bulk-report-action="hide">Bulk hide games</button>
        ${auth.role === "admin" ? `<button type="button" class="danger" data-bulk-report-action="delete">Bulk delete games</button>` : ""}
        <button type="button" data-bulk-report-action="dismiss">Bulk dismiss</button>
      </div>
      <div class="stack">
        ${rows.results
          .map(
            (row) => `<article class="panel">
              <h2>${escapeHtml(row.title)}</h2>
              <p>Reason: <strong>${escapeHtml(row.reason)}</strong> · Report: <strong>${escapeHtml(row.status)}</strong> · Game: <strong>${escapeHtml(row.game_status)}</strong> · ${escapeHtml(row.created_at)}</p>
              <p>${escapeHtml(row.note || "No note provided")}</p>
              <p><a href="${escapeHtml(row.game_url)}" target="_blank" rel="noopener noreferrer">Visit game site ↗</a> · <a href="/games/${row.game_slug}">Open game context</a></p>
              <p style="color:var(--muted);overflow-wrap:anywhere"><small>${escapeHtml(row.game_url)}</small></p>
              <label class="check"><input type="checkbox" data-report-select value="${row.id}" /> Select</label>
              <div class="actions">
                <button type="button" data-report-action="hide" data-report-id="${row.id}"${row.game_status === "disabled" ? " disabled" : ""}>Hide game</button>
                ${auth.role === "admin" ? `<button type="button" class="danger" data-report-action="delete" data-report-id="${row.id}">Delete game</button>` : ""}
                <button type="button" data-report-action="dismiss" data-report-id="${row.id}">Dismiss</button>
              </div>
            </article>`
          )
          .join("")}
      </div>
      <p id="admin-reports-status" class="status" aria-live="polite"></p>
    </main>
    <script src="${ASSET.page_admin_reports}"></script>
  `, c.env));
});

app.get("/admin/categories", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const categories = await c.env.DB.prepare(
    "SELECT id, slug, name, description, is_active FROM categories ORDER BY name ASC"
  ).all<{ id: string; slug: string; name: string; description: string | null; is_active: number }>();

  return c.html(await layout("Admin Categories", auth, `
    <main>
      <h1>Manage Categories</h1>
      <section class="panel">
        <h2>Create category</h2>
        <form id="create-category-form" class="stack-form">
          <input name="slug" placeholder="slug" aria-label="Slug" required />
          <input name="name" placeholder="Name" aria-label="Name" required />
          <textarea name="description" rows="2" placeholder="Description" aria-label="Description"></textarea>
          <label class="check"><input type="checkbox" name="isActive" checked /> Active</label>
          <button type="submit">Create category</button>
        </form>
      </section>
      <div class="stack">
        ${categories.results
          .map(
            (cat) => `<article class="panel">
              <h2>${escapeHtml(cat.name)}</h2>
              <p><code>${escapeHtml(cat.slug)}</code> · ${cat.is_active ? "active" : "inactive"}</p>
              <p>${escapeHtml(cat.description || "")}</p>
              <div class="actions">
                <button type="button" data-category-toggle="${cat.id}" data-next-active="${cat.is_active ? "0" : "1"}">${
                  cat.is_active ? "Deactivate" : "Activate"
                }</button>
                <button type="button" data-category-delete="${cat.id}">Delete</button>
              </div>
            </article>`
          )
          .join("")}
      </div>
      <p id="admin-categories-status" class="status" aria-live="polite"></p>
    </main>
    <script src="${ASSET.page_admin_categories}"></script>
  `, c.env));
});

app.get("/admin/lists", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const lists = await c.env.DB.prepare(
    "SELECT id, slug, title, description, visibility FROM curated_lists ORDER BY updated_at DESC"
  ).all<{ id: string; slug: string; title: string; description: string | null; visibility: "public" | "private" }>();

  const games = await c.env.DB.prepare(
    "SELECT id, title, slug FROM games WHERE status = 'approved' ORDER BY title ASC"
  ).all<{ id: string; title: string; slug: string }>();

  const listItems = await c.env.DB.prepare(
    `SELECT curated_list_items.curated_list_id, curated_list_items.game_id, curated_list_items.position,
            games.title, games.slug
     FROM curated_list_items
     JOIN games ON games.id = curated_list_items.game_id
     ORDER BY curated_list_items.position ASC`
  ).all<{ curated_list_id: string; game_id: string; position: number; title: string; slug: string }>();

  const itemsByList = new Map<string, Array<{ game_id: string; position: number; title: string; slug: string }>>();
  for (const item of listItems.results) {
    const existing = itemsByList.get(item.curated_list_id) || [];
    existing.push({ game_id: item.game_id, position: item.position, title: item.title, slug: item.slug });
    itemsByList.set(item.curated_list_id, existing);
  }

  return c.html(await layout("Admin Lists", auth, `
    <main>
      <h1>Manage Curated Lists</h1>
      <section class="panel">
        <h2>Create list</h2>
        <form id="create-list-form" class="stack-form">
          <input name="title" placeholder="List title" aria-label="List title" required />
          <textarea name="description" rows="2" placeholder="Description" aria-label="Description"></textarea>
          <select name="visibility" aria-label="Visibility">
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
          <button type="submit">Create list</button>
        </form>
      </section>
      <div class="stack">
        ${lists.results
          .map((list) => {
            const itemOptions = games.results
              .map((game) => `<option value="${game.id}">${escapeHtml(game.title)} (${escapeHtml(game.slug)})</option>`)
              .join("");
            const existingItems = itemsByList.get(list.id) || [];
            return `<article class="panel">
              <h2>${escapeHtml(list.title)}</h2>
              <p><code>${escapeHtml(list.slug)}</code> · ${list.visibility}</p>
              <p>${escapeHtml(list.description || "")}</p>
              <details class="admin-fold">
              <summary>Edit this list and its ${existingItems.length} game${existingItems.length === 1 ? "" : "s"}</summary>
              <form class="stack-form" data-list-edit="${list.id}">
                <label>Edit list metadata</label>
                <input type="text" name="title" value="${escapeHtml(list.title)}" aria-label="List title" required />
                <input type="text" name="slug" value="${escapeHtml(list.slug)}" required pattern="[a-z0-9-]+" title="Lowercase alphanumeric with hyphens" />
                <textarea name="description" rows="2" placeholder="Description" aria-label="Description">${escapeHtml(list.description || "")}</textarea>
                <button type="submit">Save list details</button>
              </form>
              <div class="actions">
                <button type="button" data-list-visibility="${list.id}" data-next-visibility="${
                  list.visibility === "public" ? "private" : "public"
                }">Set ${list.visibility === "public" ? "private" : "public"}</button>
                <button type="button" data-list-delete="${list.id}">Delete list</button>
              </div>
              <form class="stack-form" data-list-add-item="${list.id}">
                <label>Add game to list</label>
                <select name="gameId" aria-label="Game">${itemOptions}</select>
                <input type="number" name="position" min="1" value="1" aria-label="Position in list" required />
                <button type="submit">Add item</button>
              </form>
              <div class="list-items" data-list-items="${list.id}">
                ${
                  existingItems.length > 0
                    ? `<ul class="stack sortable-list" data-sortable-list="${list.id}">
                        ${existingItems
                          .map(
                            (item) => `<li class="panel" draggable="true" data-game-id="${item.game_id}">
                              <span class="drag">::</span>
                              <span>#<span class="position-label">${item.position}</span> ${escapeHtml(item.title)}</span>
                              <div class="actions">
                                <button type="button" data-list-move="up" data-list-id="${list.id}" data-game-id="${item.game_id}" aria-label="Move item up">Up</button>
                                <button type="button" data-list-move="down" data-list-id="${list.id}" data-game-id="${item.game_id}" aria-label="Move item down">Down</button>
                                <button type="button" data-list-remove-item="${list.id}" data-game-id="${item.game_id}">Remove</button>
                              </div>
                            </li>`
                          )
                          .join("")}
                      </ul>`
                    : "<p>No items yet.</p>"
                }
              </div>
              ${
                existingItems.length > 0
                  ? `<div class="actions"><button type="button" data-save-list-order="${list.id}">Save item order</button></div>`
                  : ""
              }
              </details>
            </article>`;
          })
          .join("")}
      </div>
      <p id="admin-lists-status" class="status" aria-live="polite"></p>
    </main>
    <script src="${ASSET.page_admin_lists}"></script>
  `, c.env));
});

// JSON API routes.
// Be forgiving about input a browser may send: trim text, pad times, assume https:// when the scheme is missing.
const trimInput = (value: unknown) => (typeof value === "string" ? value.trim() : value);
const trimToUndefined = (value: unknown) => (typeof value === "string" ? value.trim() || undefined : value);
const MAX_SUBMISSION_CATEGORIES = 30;

const submissionSchema = z.object({
  title: z.preprocess(trimInput, z.string().min(2).max(120)),
  url: z.preprocess(normalizeUrlInput, z.string().url()),
  description: z.preprocess(trimToUndefined, z.string().max(500).optional()),
  categories: z.array(z.string()).max(MAX_SUBMISSION_CATEGORIES).optional(),
  resetBasis: z.enum(["local", "server"]).optional(),
  resetTime: z.preprocess(normalizeTimeInput, z.string().regex(/^\d{2}:\d{2}$/).optional()),
  resetTimezone: z.string().max(64).optional(),
  // Plain text, blank line = new paragraph (shown on the game's page once approved).
  howToPlay: z.preprocess(trimToUndefined, z.string().max(2000).optional()),
  paywall: z.boolean().optional().default(false),
  nsfw: z.boolean().optional().default(false),
  // "I made this game": for a signed-in submitter, starts a developer claim on the new game.
  isDeveloper: z.boolean().optional().default(false)
});

app.get("/api/games", async (c) => {
  const sort = (c.req.query("sort") || "top") as "top" | "new" | "trending" | "popular" | "reset";
  const category = c.req.query("category") || undefined;
  const q = c.req.query("q") || undefined;
  const hidePaywall = c.req.query("hidePaywall") === "1";
  const hideNsfw = c.req.query("hideNsfw") === "1";
  const page = Math.max(1, parsePositiveInt(c.req.query("page"), 1));
  const perPage = Math.min(100, Math.max(1, parsePositiveInt(c.req.query("perPage"), 25)));
  const offset = (page - 1) * perPage;
  const key = `games:${sort}:${category || "all"}:${q || "none"}:${hidePaywall ? 1 : 0}:${hideNsfw ? 1 : 0}:${page}:${perPage}`;
  const cached = await getCachedJson<unknown[]>(c.env, key);
  if (cached) {
    const results = Array.isArray(cached) ? cached : [];
    return c.json({
      results,
      page,
      perPage,
      hasMore: results.length === perPage,
      cached: true
    });
  }
  const withExtra = await listGames(c.env, { sort, category, q, hidePaywall, hideNsfw, limit: perPage + 1, offset });
  const hasMore = withExtra.length > perPage;
  const results = withExtra.slice(0, perPage);
  await setCachedJson(c.env, key, results);
  return c.json({ results, page, perPage, hasMore, cached: false });
});

app.get("/api/games/categories", async (c) => {
  const ids = (c.req.query("ids") || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(0, 100);
  const categoriesByGameId = await getCategoriesForGames(c.env, ids);
  const result: Record<string, Array<{ slug: string; name: string }>> = {};
  for (const id of ids) {
    result[id] = categoriesByGameId.get(id) ?? [];
  }
  // The logged-out rotation page also wants each game's public verified developer (the default shape stays a plain map).
  if (c.req.query("withDevelopers") === "1") {
    const developers = await getDevelopersForGames(c.env, ids);
    return c.json({ categories: result, developers: Object.fromEntries(developers) });
  }
  return c.json(result);
});

// Link and reset timing for a set of games, for the logged-out rotation page (its local favorites only store
// id, slug and title): the link lets a tap on a row open the game, the reset time sorts and labels it.
// Current up/down counts for the games on a page, polled by LIVE_VOTES in GAME_ACTIONS_SCRIPT so counts update
// without a reload. Visitors on the same page ask for the same ids, so answers are shared via the edge cache for a
// few seconds (one D1 read per page per colo, however many tabs are open).
const VOTE_COUNTS_CACHE_SECONDS = 10;
app.get("/api/games/vote-counts", async (c) => {
  const ids = [...new Set((c.req.query("ids") || "").split(",").map((id) => id.trim()).filter((id) => /^[0-9a-f-]{36}$/.test(id)))].sort().slice(0, 98);
  if (ids.length === 0) return c.json({ counts: {} });
  const cacheKey = new Request(new URL(`/api/games/vote-counts?ids=${ids.join(",")}`, c.req.url).toString());
  const useCache = !isDevEnv(c.env);
  if (useCache) {
    const cached = await caches.default.match(cacheKey);
    if (cached) return new Response(cached.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, vote_up_count, vote_down_count FROM games WHERE status = 'approved' AND id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`
  )
    .bind(...ids)
    .all<{ id: string; vote_up_count: number; vote_down_count: number }>();
  const counts: Record<string, [number, number]> = {};
  for (const row of rows.results) counts[row.id] = [row.vote_up_count, row.vote_down_count];
  const body = JSON.stringify({ counts });
  if (useCache) {
    c.executionCtx.waitUntil(caches.default.put(cacheKey, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${VOTE_COUNTS_CACHE_SECONDS}` } })));
  }
  return c.body(body, 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
});

// Games listed in the last N days in the given categories (up to 5), card-ready, for the home page's "New in your
// categories" row. NSFW games are left out. KV-cached for 5 minutes (the games: prefix is cleared on game changes).
app.get("/api/games/new", async (c) => {
  const days = Math.min(60, Math.max(1, parsePositiveInt(c.req.query("days"), 14)));
  const limit = Math.min(24, Math.max(1, parsePositiveInt(c.req.query("limit"), 12)));
  const slugs = [...new Set((c.req.query("categories") || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9-]{1,64}$/.test(s)))].sort().slice(0, 5);
  if (slugs.length === 0) return c.json({ games: [] });
  const key = `games:new:${days}:${limit}:${slugs.join(",")}`;
  const cached = await getCachedJson<unknown[]>(c.env, key);
  if (cached) return c.json({ games: cached }, 200, { "Cache-Control": "public, max-age=300" });
  const rows = await c.env.DB.prepare(
    `SELECT DISTINCT games.id, games.title, games.slug, games.url, games.paywall, COALESCE(games.approved_at, games.created_at) AS listed_at
     FROM games
     JOIN game_categories ON game_categories.game_id = games.id
     JOIN categories ON categories.id = game_categories.category_id
     WHERE games.status = 'approved' AND games.nsfw = 0 AND categories.slug IN (${slugs.map((_, i) => `?${i + 3}`).join(",")})
       AND COALESCE(games.approved_at, games.created_at) >= datetime('now', ?1)
     ORDER BY listed_at DESC LIMIT ?2`
  )
    .bind(`-${days} days`, limit, ...slugs)
    .all<{ id: string; title: string; slug: string; url: string; paywall: number; listed_at: string }>();
  const categoriesByGameId = await getCategoriesForGames(c.env, rows.results.map((row) => row.id));
  const games = rows.results.map((row) => ({
    id: row.id, slug: row.slug, title: row.title, url: row.url, paywall: !!row.paywall,
    categories: (categoriesByGameId.get(row.id) ?? []).slice(0, 2), listedAt: row.listed_at
  }));
  await setCachedJson(c.env, key, games, 300);
  return c.json({ games }, 200, { "Cache-Control": "public, max-age=300" });
});

// Every approved game's id, slug and title, for the list suggestion search. Shared through the edge cache for 5 minutes.
app.get("/api/games/titles", async (c) => {
  const cacheKey = new Request(new URL("/api/games/titles", c.req.url).toString());
  const useCache = !isDevEnv(c.env);
  if (useCache) {
    const cached = await caches.default.match(cacheKey);
    if (cached) return new Response(cached.body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const rows = await c.env.DB.prepare("SELECT id, slug, title FROM games WHERE status = 'approved' ORDER BY title COLLATE NOCASE ASC")
    .all<{ id: string; slug: string; title: string }>();
  const body = JSON.stringify({ games: rows.results });
  if (useCache) {
    c.executionCtx.waitUntil(caches.default.put(cacheKey, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } })));
  }
  return c.body(body, 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
});

app.get("/api/games/rotation-info", async (c) => {
  const ids = (c.req.query("ids") || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(0, 90);
  const result: Record<string, { url: string; reset: { kind: "utc" | "local"; min: number; label: string } | null }> = {};
  if (ids.length > 0) {
    const placeholders = ids.map((_id, index) => `?${index + 1}`).join(", ");
    const rows = await c.env.DB.prepare(
      `SELECT id, url, reset_basis, reset_time_minutes, reset_timezone FROM games WHERE status = 'approved' AND id IN (${placeholders})`
    )
      .bind(...ids)
      .all<{ id: string; url: string; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null }>();
    for (const row of rows.results) {
      const data = getResetSortData(row.reset_basis, row.reset_time_minutes, row.reset_timezone);
      result[row.id] = {
        url: row.url,
        reset: data ? { ...data, label: getResetMetaLabel(row.reset_basis, row.reset_time_minutes, row.reset_timezone) } : null
      };
    }
  }
  return c.json(result);
});

app.get("/api/categories", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, slug, name, description FROM categories WHERE is_active = 1 ORDER BY name").all();
  return c.json(rows);
});

// Random picks: optional filters from /games (category, hidePaywall) and the visitor's hidden games (exclude).
// NSFW games are never picked, so hideNsfw=1 changes nothing; it is accepted so /games can pass its filters on.
const RANDOM_EXCLUDE_MAX = 200;
app.get("/api/games/duplicate-check", async (c) => {
  const user = c.get("user");
  const key = user ? `dupcheck:${user.id}` : `dupcheck:anon:${await getAnonymousVoteKey(c)}`;
  const rate = await enforceRateLimit(c.env, key, 240, 60 * 60);
  c.header("Cache-Control", "no-store");
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const url = (c.req.query("url") || "").trim().slice(0, 2000);
  const title = (c.req.query("title") || "").trim().slice(0, 200);
  if (!url && !title) return c.json({ matches: [] });
  const index = await loadDuplicateIndex(c.env, "'approved','pending'");
  const matches: Array<{ id?: string; title?: string; slug?: string; status: "approved" | "pending"; reason: string }> = [];
  let pendingSeen = false;
  for (const m of index.find({ url, title }).slice(0, 10)) {
    if (m.game.status === "approved") {
      matches.push({ id: m.game.id, title: m.game.title, slug: m.game.slug, status: "approved", reason: m.reason });
    } else if (!pendingSeen) {
      // Pending games stay private: no id, title or slug.
      pendingSeen = true;
      matches.push({ status: "pending", reason: m.reason });
    }
  }
  return c.json({ matches });
});

app.get("/random", async (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/api/games/random";
  const response = await app.fetch(new Request(url, { headers: c.req.raw.headers }), c.env, c.executionCtx);
  const game = response.ok ? await response.json<{ slug: string }>() : null;
  c.header("Cache-Control", "no-store");
  return c.redirect(game ? `/games/${encodeURIComponent(game.slug)}` : "/games", 302);
});

app.get("/api/games/random", async (c) => {
  const category = c.req.query("category") || "";
  const hidePaywall = c.req.query("hidePaywall") === "1";
  const excludeParam = c.req.query("exclude") || "";
  const exclude = excludeParam ? excludeParam.split(",").map((id) => id.trim()).filter(Boolean) : [];
  if (exclude.length > RANDOM_EXCLUDE_MAX || exclude.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    return c.json({ error: `exclude takes up to ${RANDOM_EXCLUDE_MAX} comma-separated game ids` }, 400);
  }
  const where = ["games.status = 'approved'", "games.nsfw = 0"];
  const params: string[] = [];
  if (category) {
    where.push("EXISTS (SELECT 1 FROM game_categories JOIN categories ON categories.id = game_categories.category_id WHERE game_categories.game_id = games.id AND categories.slug = ?)");
    params.push(category);
  }
  if (hidePaywall) {
    where.push("games.paywall = 0");
  }
  if (exclude.length > 0) {
    where.push("games.id NOT IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(exclude));
  }
  const game = await c.env.DB.prepare(
    `SELECT games.id, games.slug, games.url FROM games WHERE ${where.join(" AND ")} ORDER BY RANDOM() LIMIT 1`
  )
    .bind(...params)
    .first<{ id: string; slug: string; url: string }>();
  c.header("Cache-Control", "no-store");
  if (!game) {
    return c.json({ error: "No games available" }, 404);
  }
  return c.json(game);
});

app.post("/api/games", async (c) => {
  const user = c.get("user");
  // Admins are trusted to add games in bulk, so only everyone else is limited (10 an hour).
  if (user?.role !== "admin") {
    const submitRateKey = user
      ? `submit:${user.id}`
      : `submit:anon:${await getAnonymousVoteKey(c)}`;
    const submitRate = await enforceRateLimit(c.env, submitRateKey, 10, 60 * 60);
    if (!submitRate.ok) {
      return c.json({ error: "Rate limit exceeded", retryAfterSeconds: submitRate.retryAfterSeconds }, 429);
    }
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  const parsed = submissionSchema.safeParse(body);
  if (!parsed.success) {
    console.warn("Submission rejected:", JSON.stringify(parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code }))));
    const describeIssue = (issue: z.ZodIssue): string => {
      const field = issue.path[0];
      switch (field) {
        case undefined:
          return "Submission must be a JSON object";
        case "title":
          return "Title must be 2-120 characters";
        case "url":
          return "Enter a valid game URL";
        case "description":
          return "Description must be 500 characters or fewer";
        case "categories":
          return issue.code === "too_big"
            ? `Select at most ${MAX_SUBMISSION_CATEGORIES} categories`
            : "Categories must be a list of category names";
        case "howToPlay":
          return "How to play must be 2000 characters or fewer";
        case "resetTime":
          return "Reset time must be HH:MM";
        case "resetBasis":
          return "Reset basis must be local or server";
        case "resetTimezone":
          return "Time zone is not valid";
        default:
          return `Invalid ${String(field)}`;
      }
    };
    const message = Array.from(new Set(parsed.error.issues.map(describeIssue))).join(". ");
    return c.json({ error: message || "Invalid submission", issues: parsed.error.flatten() }, 400);
  }
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(parsed.data.url);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }

  const duplicate = (await loadDuplicateIndex(c.env, "'approved','pending','disabled'")).find({ url: parsed.data.url }).find((m) => m.reason === "url")?.game
    ?? await c.env.DB.prepare("SELECT id, slug, status FROM games WHERE canonical_url = ?1 AND status != 'rejected'").bind(canonicalUrl).first<{ id: string; slug: string; status: string }>();
  if (duplicate) {
    // A listed game's page is where its developer can claim it.
    const listed = duplicate.status === "approved";
    return c.json({
      error: listed ? "This game is already on 0x9 dles. If you made it, open its page to claim it." : "A game with this link was already submitted and is waiting for review.",
      code: "duplicate",
      ...(listed ? { slug: duplicate.slug } : {})
    }, 409);
  }

  const resetBasis = parsed.data.resetBasis || null;
  const resetTimeMinutes = parseResetTimeToMinutes(parsed.data.resetTime);
  if (parsed.data.resetTime && resetTimeMinutes === null) {
    return c.json({ error: "Invalid reset time. Use HH:MM" }, 400);
  }
  const resetTimezone = normalizeResetTimeZone(resetBasis, parsed.data.resetTimezone);
  if (!resetTimezone.ok) {
    return c.json({ error: "Invalid time zone. Use an IANA name like America/New_York" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const slug = uniqueSlug(parsed.data.title, id);
  const bypassModeration = user && (user.role === "editor" || user.role === "admin");

  if (bypassModeration) {
    await c.env.DB.prepare(
      `INSERT INTO games
        (id, title, slug, url, canonical_url, description, submitted_by_user_id, status, approved_at, approved_by_user_id, created_at, updated_at, reset_basis, reset_time_minutes, paywall, nsfw, reset_timezone, how_to_play)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'approved', ?8, ?9, ?8, ?8, ?10, ?11, ?12, ?13, ?14, ?15)`
    )
      .bind(id, parsed.data.title, slug, parsed.data.url, canonicalUrl, parsed.data.description || null, user!.id, now, user!.id, resetBasis, resetTimeMinutes, parsed.data.paywall ? 1 : 0, parsed.data.nsfw ? 1 : 0, resetTimezone.value, parsed.data.howToPlay || null)
      .run();
    await writeAudit(c.env, user!.id, "game", id, "approve", { title: parsed.data.title, slug, via: "submission" });
  } else {
    await c.env.DB.prepare(
      `INSERT INTO games
        (id, title, slug, url, canonical_url, description, submitted_by_user_id, status, created_at, updated_at, reset_basis, reset_time_minutes, paywall, nsfw, reset_timezone, how_to_play)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    )
      .bind(id, parsed.data.title, slug, parsed.data.url, canonicalUrl, parsed.data.description || null, user?.id || null, now, resetBasis, resetTimeMinutes, parsed.data.paywall ? 1 : 0, parsed.data.nsfw ? 1 : 0, resetTimezone.value, parsed.data.howToPlay || null)
      .run();
  }

  const categorySlugs = Array.from(new Set(parsed.data.categories || []));
  if (categorySlugs.length > 0 && user) {
    const placeholders = categorySlugs.map((_, index) => `?${index + 1}`).join(", ");
    const categories = await c.env.DB.prepare(`SELECT id FROM categories WHERE is_active = 1 AND slug IN (${placeholders})`)
      .bind(...categorySlugs)
      .all<{ id: string }>();
    if (categories.results.length > 0) {
      const insertCategory = c.env.DB.prepare(
        "INSERT OR IGNORE INTO game_categories (game_id, category_id, assigned_by_user_id) VALUES (?1, ?2, ?3)"
      );
      await c.env.DB.batch(categories.results.map((category) => insertCategory.bind(id, category.id, user.id)));
    }
  }

  if (bypassModeration) {
    await updateGameScore(c.env, id);
  }

  // The submitter says they made it: start their claim, which they finish (tag on the page, or evidence) on the game's page.
  let claimStarted = false;
  if (parsed.data.isDeveloper && user) {
    await c.env.DB.prepare("INSERT INTO game_claims (id, game_id, user_id, token) VALUES (?1, ?2, ?3, ?4)")
      .bind(crypto.randomUUID(), id, user.id, newClaimToken())
      .run();
    claimStarted = true;
  }

  await invalidateGameCaches(c.env);
  c.executionCtx.waitUntil(
    notifyNewSubmission(c.env, {
      title: parsed.data.title,
      url: parsed.data.url,
      description: parsed.data.description || null,
      status: bypassModeration ? "approved" : "pending",
      submitter: user ? `${user.displayName || "(no name)"} (${user.role})` : "anonymous",
      slug
    })
  );
  if (bypassModeration) {
    c.executionCtx.waitUntil(queueNewGameAnnouncements(c.env, [id]));
  }
  return c.json({ id, slug, status: bypassModeration ? "approved" : "pending", claim: claimStarted }, 201);
});

const voteSchema = z.object({ value: z.union([z.literal(1), z.literal(-1)]) });

app.post("/api/games/:id/vote", async (c) => {
  const user = c.get("user");
  const anonymousVoteKey = user ? "" : await getAnonymousVoteKey(c);
  const voteKey = user ? `vote:user:${user.id}` : `vote:anon:${anonymousVoteKey}`;
  const voteRate = await enforceRateLimit(c.env, voteKey, 120, 60 * 60);
  if (!voteRate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: voteRate.retryAfterSeconds }, 429);
  }
  const parsed = voteSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const gameId = c.req.param("id");
  const game = await c.env.DB.prepare("SELECT id FROM games WHERE id = ?1 AND status = 'approved'").bind(gameId).first<{ id: string }>();
  if (!game) {
    return c.json({ error: "Not found" }, 404);
  }

  const voteUpsert = user
    ? c.env.DB.prepare(
        `INSERT INTO votes (user_id, game_id, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id, game_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      ).bind(user.id, gameId, parsed.data.value)
    : c.env.DB.prepare(
        `INSERT INTO anonymous_votes (anon_ip_hash, game_id, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(anon_ip_hash, game_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      ).bind(anonymousVoteKey, gameId, parsed.data.value);

  await c.env.DB.batch([voteUpsert, recountVotesStatement(c.env, gameId)]);
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.post("/api/games/:id/favorite", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  const game = await c.env.DB.prepare("SELECT id FROM games WHERE id = ?1 AND status = 'approved'").bind(gameId).first<{ id: string }>();
  if (!game) {
    return c.json({ error: "Not found" }, 404);
  }
  // Position is computed inside the INSERT so concurrent adds can't collide.
  const added = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO favorites (user_id, game_id, position)
     SELECT ?1, ?2, COALESCE(MAX(position), 0) + 1 FROM favorites WHERE user_id = ?1`
  )
    .bind(auth.id, gameId)
    .run();
  if (((added.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) {
    // Nothing inserted: fine if it is already a favorite, otherwise the write really failed.
    const present = await c.env.DB.prepare("SELECT 1 AS x FROM favorites WHERE user_id = ?1 AND game_id = ?2").bind(auth.id, gameId).first();
    if (!present) {
      return c.json({ error: "Could not add favorite" }, 500);
    }
  }
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.delete("/api/games/:id/favorite", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM favorites WHERE user_id = ?1 AND game_id = ?2").bind(auth.id, gameId).run();
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

const anonFavoriteSchema = z.object({ anonId: z.string().uuid() });

app.post("/api/games/:id/favorite-anon", async (c) => {
  const gameId = c.req.param("id");
  const favRate = await enforceRateLimit(c.env, `favanon:${await getAnonymousVoteKey(c)}`, 300, 60 * 60);
  if (!favRate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: favRate.retryAfterSeconds }, 429);
  }
  const parsed = anonFavoriteSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const game = await c.env.DB.prepare("SELECT id FROM games WHERE id = ?1 AND status = 'approved'").bind(gameId).first<{ id: string }>();
  if (!game) {
    return c.json({ error: "Not found" }, 404);
  }
  await c.env.DB.prepare("INSERT OR IGNORE INTO anonymous_favorites (anon_id, game_id) VALUES (?1, ?2)")
    .bind(parsed.data.anonId, gameId)
    .run();
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.delete("/api/games/:id/favorite-anon", async (c) => {
  const gameId = c.req.param("id");
  const favRate = await enforceRateLimit(c.env, `favanon:${await getAnonymousVoteKey(c)}`, 300, 60 * 60);
  if (!favRate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: favRate.retryAfterSeconds }, 429);
  }
  const parsed = anonFavoriteSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  await c.env.DB.prepare("DELETE FROM anonymous_favorites WHERE anon_id = ?1 AND game_id = ?2")
    .bind(parsed.data.anonId, gameId)
    .run();
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

const adminGameUpdateSchema = z.object({
  title: z.preprocess(trimInput, z.string().min(1).max(200)),
  url: z.preprocess(normalizeUrlInput, z.string().url()),
  description: z.preprocess(trimInput, z.string().max(1000).nullable()),
  status: z.enum(["pending", "approved", "rejected", "disabled"]),
  reset_basis: z.enum(["local", "server"]).nullable(),
  reset_time_minutes: z.number().int().min(0).max(1439).nullable(),
  reset_timezone: z.string().max(64).nullable().optional(),
  paywall: z.boolean().optional().default(false),
  nsfw: z.boolean().optional().default(false),
  // Omitted keeps the stored text; null or blank clears it.
  how_to_play: z.preprocess((value) => (typeof value === "string" ? value.trim() || null : value), z.string().max(2000).nullable().optional()),
  category_ids: z.array(z.string().uuid()).max(20)
});

app.put("/api/games/:id/admin-update", async (c) => {
  const auth = requireRole(c, ["admin", "editor"]);
  if (auth instanceof Response) {
    return auth;
  }

  const gameId = c.req.param("id");
  const parsed = adminGameUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }

  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(parsed.data.url);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }

  // Omitted time zone keeps the stored one (older clients); an explicit null clears it.
  const existingZone = parsed.data.reset_timezone === undefined
    ? (await c.env.DB.prepare("SELECT reset_timezone FROM games WHERE id = ?1").bind(gameId).first<{ reset_timezone: string | null }>())?.reset_timezone ?? null
    : parsed.data.reset_timezone;
  const resetTimezone = normalizeResetTimeZone(parsed.data.reset_basis, existingZone);
  if (!resetTimezone.ok) {
    return c.json({ error: "Invalid time zone. Use an IANA name like America/New_York" }, 400);
  }

  const before = await c.env.DB.prepare("SELECT title, slug, status, paywall, nsfw, canonical_url FROM games WHERE id = ?1")
    .bind(gameId)
    .first<{ title: string; slug: string; status: string; paywall: number; nsfw: number; canonical_url: string }>();
  let newlyApproved: string[] = [];
  if (before) {
    if (before.status !== parsed.data.status) {
      const statusAction = ({ approved: "approve", rejected: "reject", disabled: "disable" } as Record<string, "approve" | "reject" | "disable">)[parsed.data.status];
      if (statusAction) {
        newlyApproved = await logGameEvents(c.env, auth.id, [gameId], statusAction);
      }
    }
    const flagEvents: GameEventAction[] = [];
    if (!!before.nsfw !== parsed.data.nsfw) flagEvents.push(parsed.data.nsfw ? "nsfw_add" : "nsfw_remove");
    if (!!before.paywall !== parsed.data.paywall) flagEvents.push(parsed.data.paywall ? "paywall_add" : "paywall_remove");
    for (const flagAction of flagEvents) {
      await writeAudit(c.env, auth.id, "game", gameId, flagAction, { title: parsed.data.title, slug: before.slug });
    }
  }

  // Update game
  await c.env.DB.prepare(
    `UPDATE games
     SET title = ?1, url = ?2, canonical_url = ?3, description = ?4, status = ?5,
         reset_basis = ?6, reset_time_minutes = ?7, paywall = ?9, nsfw = ?10, reset_timezone = ?11,
         how_to_play = CASE WHEN ?12 = 1 THEN ?13 ELSE how_to_play END, updated_at = datetime('now'), content_updated_at = datetime('now')
     WHERE id = ?8`
  )
    .bind(
      parsed.data.title,
      parsed.data.url,
      canonicalUrl,
      parsed.data.description,
      parsed.data.status,
      parsed.data.reset_basis,
      parsed.data.reset_time_minutes,
      gameId,
      parsed.data.paywall ? 1 : 0,
      parsed.data.nsfw ? 1 : 0,
      resetTimezone.value,
      parsed.data.how_to_play === undefined ? 0 : 1,
      parsed.data.how_to_play ?? null
    )
    .run();

  // Update slug if title changed
  const game = await c.env.DB.prepare("SELECT slug FROM games WHERE id = ?1")
    .bind(gameId)
    .first<{ slug: string }>();
  let slug = game?.slug ?? "";
  if (game) {
    const newSlug = uniqueSlug(parsed.data.title, gameId);
    if (newSlug !== game.slug) {
      await c.env.DB.prepare("UPDATE games SET slug = ?1 WHERE id = ?2")
        .bind(newSlug, gameId)
        .run();
      slug = newSlug;
    }
  }

  // Update categories
  await c.env.DB.prepare("DELETE FROM game_categories WHERE game_id = ?1")
    .bind(gameId)
    .run();

  for (const categoryId of parsed.data.category_ids) {
    await c.env.DB.prepare("INSERT INTO game_categories (game_id, category_id, assigned_by_user_id) VALUES (?1, ?2, ?3)")
      .bind(gameId, categoryId, auth.id)
      .run();
  }

  await invalidateGameCaches(c.env);
  c.executionCtx.waitUntil(queueNewGameAnnouncements(c.env, newlyApproved));
  // A new address means the developer's proof has to hold there too.
  if (before && before.canonical_url !== canonicalUrl) {
    c.executionCtx.waitUntil(reverifyClaimsForGame(c.env, gameId));
  }
  return c.json({ ok: true, slug });
});

// ---- Developer claims (see src/lib/claims.ts and migrations/0025) ----

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

type ClaimStatus = "pending" | "review" | "verified" | "rejected" | "revoked";
type ClaimRow = {
  id: string;
  game_id: string;
  user_id: string;
  token: string;
  status: ClaimStatus;
  method: "meta" | "file" | "manual" | null;
  evidence: string | null;
};

const CLAIM_COLUMNS = "id, game_id, user_id, token, status, method, evidence";

async function getOwnClaim(env: Env, gameId: string, userId: string): Promise<ClaimRow | null> {
  return env.DB.prepare(`SELECT ${CLAIM_COLUMNS} FROM game_claims WHERE game_id = ?1 AND user_id = ?2`)
    .bind(gameId, userId)
    .first<ClaimRow>();
}

function claimView(claim: ClaimRow): { status: ClaimStatus; token: string; method: string | null } {
  return { status: claim.status, token: claim.token, method: claim.method };
}

/** True for a unique-constraint failure, i.e. the game already has a verified developer. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE|constraint/i.test(error.message);
}

app.post("/api/games/:id/claim", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const rate = await enforceRateLimit(c.env, `claim:${auth.id}`, 10, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const gameId = c.req.param("id");
  const game = await c.env.DB.prepare("SELECT status, submitted_by_user_id FROM games WHERE id = ?1")
    .bind(gameId)
    .first<{ status: string; submitted_by_user_id: string | null }>();
  // Anyone can claim a listed game; a game still awaiting review can only be claimed by whoever submitted it.
  if (!game || !(game.status === "approved" || (game.status === "pending" && game.submitted_by_user_id === auth.id))) {
    return c.json({ error: "Game not found" }, 404);
  }
  const verified = await c.env.DB.prepare("SELECT user_id FROM game_claims WHERE game_id = ?1 AND status = 'verified'")
    .bind(gameId)
    .first<{ user_id: string }>();
  if (verified && verified.user_id !== auth.id) {
    return c.json({ error: "This game already has a verified developer" }, 409);
  }

  const existing = await getOwnClaim(c.env, gameId, auth.id);
  if (existing?.status === "rejected") {
    return c.json({ error: "An editor declined your earlier claim on this game" }, 403);
  }
  if (existing && existing.status !== "revoked") {
    return c.json({ claim: claimView(existing) });
  }
  const token = newClaimToken();
  if (existing) {
    // A revoked claim starts over with a fresh token.
    await c.env.DB.prepare(
      "UPDATE game_claims SET status = 'pending', token = ?2, method = NULL, evidence = NULL, verified_url = NULL, verified_at = NULL, fail_count = 0, last_checked_at = NULL WHERE id = ?1"
    ).bind(existing.id, token).run();
    return c.json({ claim: { status: "pending", token, method: null } });
  }
  await c.env.DB.prepare("INSERT INTO game_claims (id, game_id, user_id, token) VALUES (?1, ?2, ?3, ?4)")
    .bind(crypto.randomUUID(), gameId, auth.id, token)
    .run();
  return c.json({ claim: { status: "pending", token, method: null } }, 201);
});

/** Marks a claim verified and logs it. Returns false when another user already holds the game's verified claim. */
async function markClaimVerified(
  env: Env,
  claim: ClaimRow,
  actorUserId: string,
  method: "meta" | "file" | "manual",
  gameUrl: string
): Promise<boolean> {
  try {
    await env.DB.prepare(
      `UPDATE game_claims
       SET status = 'verified', method = ?2, verified_url = ?3, verified_at = datetime('now'), last_checked_at = datetime('now'), fail_count = 0
       WHERE id = ?1`
    ).bind(claim.id, method, gameUrl).run();
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
  const game = await env.DB.prepare("SELECT title, slug FROM games WHERE id = ?1").bind(claim.game_id).first<{ title: string; slug: string }>();
  await env.DB.prepare("UPDATE games SET content_updated_at = datetime('now') WHERE id = ?1").bind(claim.game_id).run();
  await writeAudit(env, actorUserId, "game", claim.game_id, "developer_verified", { title: game?.title, slug: game?.slug, method });
  await invalidateGameCaches(env);
  // Gives them the Dle Developer role in our Discord server if they are in it (and keeps checking if not yet).
  await queueDeveloperRole(env, claim.user_id);
  return true;
}

app.post("/api/games/:id/claim/verify", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const rate = await enforceRateLimit(c.env, `claim-verify:${auth.id}`, 20, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const gameId = c.req.param("id");
  const claim = await getOwnClaim(c.env, gameId, auth.id);
  if (!claim) {
    return c.json({ error: "Start a claim first" }, 404);
  }
  if (claim.status !== "pending" && claim.status !== "review") {
    return c.json({ error: `This claim is ${claim.status}` }, 409);
  }
  const game = await c.env.DB.prepare("SELECT url FROM games WHERE id = ?1").bind(gameId).first<{ url: string }>();
  if (!game) {
    return c.json({ error: "Game not found" }, 404);
  }
  const check = await checkClaimToken(game.url, claim.token, c.env.APP_ENV);
  if (check === "unreachable") {
    return c.json({ error: "We couldn't reach the game's site just now. Try again in a minute." }, 502);
  }
  if (check === "absent") {
    return c.json({ error: `We couldn't find your token on ${game.url} or at ${new URL(game.url).origin}${claimNames(c.env.APP_ENV).filePath}. Check it has been deployed, then try again.` }, 422);
  }
  if (!(await markClaimVerified(c.env, claim, auth.id, check, game.url))) {
    return c.json({ error: "This game already has a verified developer" }, 409);
  }
  return c.json({ claim: { status: "verified", token: claim.token, method: check } });
});

const claimEvidenceSchema = z.object({ evidence: z.preprocess(trimInput, z.string().min(10).max(500)) });

// For sites where the developer can't add a tag (itch.io, Newgrounds, ...): an editor reviews the evidence.
app.post("/api/games/:id/claim/evidence", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = claimEvidenceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Tell us how to confirm it (10-500 characters), e.g. a link to your developer profile" }, 400);
  }
  const claim = await getOwnClaim(c.env, c.req.param("id"), auth.id);
  if (!claim) {
    return c.json({ error: "Start a claim first" }, 404);
  }
  if (claim.status !== "pending" && claim.status !== "review") {
    return c.json({ error: `This claim is ${claim.status}` }, 409);
  }
  await c.env.DB.prepare("UPDATE game_claims SET status = 'review', evidence = ?2 WHERE id = ?1").bind(claim.id, parsed.data.evidence).run();
  return c.json({ claim: { status: "review", token: claim.token, method: null } });
});

app.delete("/api/games/:id/claim", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  const claim = await getOwnClaim(c.env, gameId, auth.id);
  if (!claim) {
    return c.json({ ok: true });
  }
  // A declined claim stays so it can't simply be filed again.
  if (claim.status === "rejected") {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (claim.status === "verified") {
    const game = await c.env.DB.prepare("SELECT title, slug FROM games WHERE id = ?1").bind(gameId).first<{ title: string; slug: string }>();
    await writeAudit(c.env, auth.id, "game", gameId, "developer_removed", { title: game?.title, slug: game?.slug, via: "released" });
    await invalidateGameCaches(c.env);
  }
  await c.env.DB.prepare("DELETE FROM game_claims WHERE id = ?1").bind(claim.id).run();
  return c.json({ ok: true });
});

const claimDecisionSchema = z.object({ action: z.enum(["approve", "reject", "revoke"]) });

app.post("/api/admin/claims/:claimId", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = claimDecisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const claim = await c.env.DB.prepare(`SELECT ${CLAIM_COLUMNS} FROM game_claims WHERE id = ?1`).bind(c.req.param("claimId")).first<ClaimRow>();
  if (!claim) {
    return c.json({ error: "Claim not found" }, 404);
  }
  const game = await c.env.DB.prepare("SELECT title, slug, url FROM games WHERE id = ?1").bind(claim.game_id).first<{ title: string; slug: string; url: string }>();
  if (!game) {
    return c.json({ error: "Game not found" }, 404);
  }
  const open = claim.status === "pending" || claim.status === "review";
  if (parsed.data.action === "approve" && open) {
    if (!(await markClaimVerified(c.env, claim, auth.id, "manual", game.url))) {
      return c.json({ error: "This game already has a verified developer" }, 409);
    }
  } else if (parsed.data.action === "reject" && open) {
    await c.env.DB.prepare("UPDATE game_claims SET status = 'rejected' WHERE id = ?1").bind(claim.id).run();
  } else if (parsed.data.action === "revoke" && claim.status === "verified") {
    await c.env.DB.prepare("UPDATE game_claims SET status = 'revoked', verified_at = NULL WHERE id = ?1").bind(claim.id).run();
    await writeAudit(c.env, auth.id, "game", claim.game_id, "developer_removed", { title: game.title, slug: game.slug, via: "staff" });
    await invalidateGameCaches(c.env);
  } else {
    return c.json({ error: `Can't ${parsed.data.action} a ${claim.status} claim` }, 409);
  }
  return c.json({ ok: true });
});

/**
 * Re-checks a game's verified claims against its (new) URL. Fired whenever the URL changes: a claim stays
 * verified only if its token is on the new address; otherwise it drops back to pending and the developer
 * loses edit access until they prove it again.
 */
async function reverifyClaimsForGame(env: Env, gameId: string): Promise<void> {
  const game = await env.DB.prepare("SELECT title, slug, url FROM games WHERE id = ?1").bind(gameId).first<{ title: string; slug: string; url: string }>();
  const claims = await env.DB.prepare(`SELECT ${CLAIM_COLUMNS} FROM game_claims WHERE game_id = ?1 AND status = 'verified'`).bind(gameId).all<ClaimRow>();
  if (!game) return;
  for (const claim of claims.results) {
    const check = await checkClaimToken(game.url, claim.token, env.APP_ENV);
    if (check === "meta" || check === "file") {
      await env.DB.prepare(
        "UPDATE game_claims SET method = ?2, verified_url = ?3, last_checked_at = datetime('now'), fail_count = 0 WHERE id = ?1"
      ).bind(claim.id, check, game.url).run();
      continue;
    }
    await env.DB.prepare("UPDATE game_claims SET status = 'pending', method = NULL, verified_at = NULL, verified_url = NULL, last_checked_at = datetime('now') WHERE id = ?1").bind(claim.id).run();
    await writeAudit(env, SYSTEM_USER_ID, "game", gameId, "developer_removed", { title: game.title, slug: game.slug, via: "url_change" });
  }
  await invalidateGameCaches(env);
}

// Daily: a verified claim whose token has vanished from the site is revoked after three definite misses in a row.
// Unreachable sites don't count against it. Manual claims have no token to look for.
const CLAIM_RECHECK_BATCH_SIZE = 40;
async function runClaimRechecks(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT game_claims.id, game_claims.game_id, game_claims.token, game_claims.fail_count, games.url, games.title, games.slug
     FROM game_claims JOIN games ON games.id = game_claims.game_id
     WHERE game_claims.status = 'verified' AND game_claims.method IN ('meta', 'file')
     ORDER BY COALESCE(game_claims.last_checked_at, '1970-01-01') ASC
     LIMIT ?1`
  ).bind(CLAIM_RECHECK_BATCH_SIZE).all<{ id: string; game_id: string; token: string; fail_count: number; url: string; title: string; slug: string }>();
  let revoked = false;
  for (const row of rows.results) {
    const check = await checkClaimToken(row.url, row.token, env.APP_ENV);
    if (check === "meta" || check === "file") {
      await env.DB.prepare("UPDATE game_claims SET method = ?2, fail_count = 0, last_checked_at = datetime('now') WHERE id = ?1").bind(row.id, check).run();
    } else if (check === "unreachable") {
      await env.DB.prepare("UPDATE game_claims SET last_checked_at = datetime('now') WHERE id = ?1").bind(row.id).run();
    } else if (row.fail_count + 1 >= 3) {
      await env.DB.prepare("UPDATE game_claims SET status = 'revoked', verified_at = NULL, fail_count = 0, last_checked_at = datetime('now') WHERE id = ?1").bind(row.id).run();
      await writeAudit(env, SYSTEM_USER_ID, "game", row.game_id, "developer_removed", { title: row.title, slug: row.slug, via: "token_missing" });
      revoked = true;
    } else {
      await env.DB.prepare("UPDATE game_claims SET fail_count = fail_count + 1, last_checked_at = datetime('now') WHERE id = ?1").bind(row.id).run();
    }
  }
  if (revoked) await invalidateGameCaches(env);
}

// What a verified developer may change. Status, NSFW label and categories stay with the editors.
const developerGameUpdateSchema = adminGameUpdateSchema.pick({
  title: true,
  url: true,
  description: true,
  reset_basis: true,
  reset_time_minutes: true,
  reset_timezone: true,
  paywall: true,
  how_to_play: true
});

app.put("/api/games/:id/developer-update", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  const claim = await getOwnClaim(c.env, gameId, auth.id);
  if (!claim || claim.status !== "verified") {
    return c.json({ error: "Forbidden" }, 403);
  }
  const parsed = developerGameUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }
  const before = await c.env.DB.prepare("SELECT title, slug, status, canonical_url, paywall, reset_timezone FROM games WHERE id = ?1")
    .bind(gameId)
    .first<{ title: string; slug: string; status: string; canonical_url: string; paywall: number; reset_timezone: string | null }>();
  if (!before || (before.status !== "approved" && before.status !== "pending")) {
    return c.json({ error: "Forbidden" }, 403);
  }
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(parsed.data.url);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }
  const resetTimezone = normalizeResetTimeZone(parsed.data.reset_basis, parsed.data.reset_timezone === undefined ? before.reset_timezone : parsed.data.reset_timezone);
  if (!resetTimezone.ok) {
    return c.json({ error: "Invalid time zone. Use an IANA name like America/New_York" }, 400);
  }

  // Moving the game to a new address: it has to carry the same token, so the claim carries over instead of lapsing.
  let moved: "meta" | "file" | null = null;
  if (canonicalUrl !== before.canonical_url) {
    const duplicate = await c.env.DB.prepare("SELECT id FROM games WHERE canonical_url = ?1 AND id != ?2").bind(canonicalUrl, gameId).first();
    if (duplicate) {
      return c.json({ error: "Game URL already submitted" }, 409);
    }
    const check = await checkClaimToken(parsed.data.url, claim.token, c.env.APP_ENV);
    if (check === "unreachable") {
      return c.json({ error: "We couldn't reach the new URL just now. Try again in a minute." }, 502);
    }
    if (check === "absent") {
      return c.json({ error: `Put your verification token on the new URL first (the <meta> tag on the page, or ${claimNames(c.env.APP_ENV).filePath}), then save again. Otherwise the change would end your verification.` }, 422);
    }
    moved = check;
  }

  await c.env.DB.prepare(
    `UPDATE games
     SET title = ?1, url = ?2, canonical_url = ?3, description = ?4, reset_basis = ?5, reset_time_minutes = ?6,
         reset_timezone = ?7, paywall = ?8, how_to_play = CASE WHEN ?9 = 1 THEN ?10 ELSE how_to_play END, updated_at = datetime('now'), content_updated_at = datetime('now')
     WHERE id = ?11`
  )
    .bind(
      parsed.data.title,
      parsed.data.url,
      canonicalUrl,
      parsed.data.description,
      parsed.data.reset_basis,
      parsed.data.reset_time_minutes,
      resetTimezone.value,
      parsed.data.paywall ? 1 : 0,
      parsed.data.how_to_play === undefined ? 0 : 1,
      parsed.data.how_to_play ?? null,
      gameId
    )
    .run();
  if (moved) {
    await c.env.DB.prepare("UPDATE game_claims SET method = ?2, verified_url = ?3, last_checked_at = datetime('now'), fail_count = 0 WHERE id = ?1")
      .bind(claim.id, moved, parsed.data.url)
      .run();
  }
  if (!!before.paywall !== parsed.data.paywall) {
    await writeAudit(c.env, auth.id, "game", gameId, parsed.data.paywall ? "paywall_add" : "paywall_remove", { title: parsed.data.title, slug: before.slug, via: "developer" });
  }

  let slug = before.slug;
  const newSlug = uniqueSlug(parsed.data.title, gameId);
  if (newSlug !== before.slug) {
    await c.env.DB.prepare("UPDATE games SET slug = ?1 WHERE id = ?2").bind(newSlug, gameId).run();
    slug = newSlug;
  }
  await invalidateGameCaches(c.env);
  return c.json({ ok: true, slug });
});

const importLocalFavoritesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500)
});

app.post("/api/me/favorites/import-local", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }

  const parsed = importLocalFavoritesSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }

  const rate = await enforceRateLimit(c.env, `fav:import:${auth.id}`, 30, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const imported = await importFavoriteIds(c.env, auth.id, parsed.data.ids);

  return c.json({ ok: true, imported });
});

app.get("/api/me/recap", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const month = parseMonth(c.req.query("month"));
  const fmt = dayFormatter(c.req.query("tz") || "");
  if (!month || !fmt) {
    return c.json({ error: "Invalid month or tz" }, 400);
  }
  const rate = await enforceRateLimit(c.env, `recap:get:${auth.id}`, 300, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  return c.json(await loadRecap(c.env, auth.id, month, fmt), 200, { "Cache-Control": "no-store" });
});

// Private, per-visitor (never in PUBLIC_CACHE_PATHS): the shell is the same for everyone and the script fills it in.
app.get("/me/recap", async (c) => {
  const user = c.get("user");
  return c.html(await layout("Monthly recap", user, `
    <main class="narrow recap" id="main" tabindex="-1" data-signed-in="${user ? "1" : "0"}">
      <h1>Monthly recap</h1>
      <div class="recap-nav">
        <button type="button" class="secondary" id="recap-prev" aria-label="Previous month" disabled>&larr;</button>
        <h2 id="recap-month" aria-live="polite">&nbsp;</h2>
        <button type="button" class="secondary" id="recap-next" aria-label="Next month" disabled>&rarr;</button>
      </div>
      <p class="muted" id="recap-empty" hidden>Nothing played this month.</p>
      <div id="recap-body" hidden>
        <div class="stats-tiles" id="recap-tiles"></div>
        <section class="panel" id="recap-top-box"><h2>Top games</h2><ol id="recap-top"></ol></section>
        <section class="heatmap recap-cal" aria-labelledby="recap-cal-title">
          <h2 id="recap-cal-title">Calendar</h2>
          <div class="recap-cal-head" aria-hidden="true"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
          <div class="recap-cal-grid" id="recap-cal" role="list"></div>
          <div class="heatmap-legend" aria-hidden="true"><span>Less</span><span class="heat-cell" data-level="0"></span><span class="heat-cell" data-level="1"></span><span class="heat-cell" data-level="2"></span><span class="heat-cell" data-level="3"></span><span class="heat-cell" data-level="4"></span><span>More</span></div>
        </section>
        <button type="button" id="recap-copy">Copy recap</button>
      </div>
      <p class="muted"><small>${user ? "Recaps cover about the last 4 months." : "Saved on this device; sign in to keep it across devices."}</small></p>
      <p><a href="/me/rotation">Back to my rotation</a></p>
    </main>
    <script src="${ASSET.recapJs}"></script>
  `, c.env, { path: "/me/recap", noindex: true }));
});

app.get("/api/me/plays", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const rate = await enforceRateLimit(c.env, `plays:get:${auth.id}`, 600, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  return c.json(await loadPlays(c.env, auth.id, c.req.query("since")), 200, { "Cache-Control": "no-store" });
});

app.get("/api/me/plays/export", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const rate = await enforceRateLimit(c.env, `plays:export:${auth.id}`, 30, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const format = c.req.query("format") === "csv" ? "csv" : "json";
  const data = await loadPlays(c.env, auth.id, new Date(0).toISOString());
  const ids = [...new Set(data.plays.map((p) => p.gameId))];
  const games = new Map<string, { title: string; slug: string }>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await c.env.DB.prepare(`SELECT id, title, slug FROM games WHERE id IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})`)
      .bind(...chunk)
      .all<{ id: string; title: string; slug: string }>();
    for (const r of rows.results) games.set(r.id, { title: r.title, slug: r.slug });
  }
  const plays = data.plays.map((p) => ({
    gameId: p.gameId,
    title: games.get(p.gameId)?.title || "",
    slug: games.get(p.gameId)?.slug || "",
    playedAt: p.playedAt
  }));
  const exportedAt = new Date().toISOString();
  const headers = {
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="0x9-dles-plays-${exportedAt.slice(0, 10)}.${format}"`
  };
  if (format === "json") {
    return new Response(JSON.stringify({ exportedAt, plays, streak: data.streak, dayLog: data.log }, null, 2), {
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" }
    });
  }
  const cell = (v: string) => {
    // Neutralize spreadsheet formula injection, then quote.
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = ["played_at,game_title,game_slug,game_url"];
  for (const p of plays) {
    lines.push([p.playedAt, p.title, p.slug, p.slug ? `${c.env.APP_URL}/games/${encodeURIComponent(p.slug)}` : ""].map(cell).join(","));
  }
  return new Response(lines.join("\r\n") + "\r\n", { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
});

app.delete("/api/me/plays", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const rate = await enforceRateLimit(c.env, `plays:clear:${auth.id}`, 10, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const resetAt = await clearPlays(c.env, auth.id);
  return c.json({ ok: true, resetAt }, 200, { "Cache-Control": "no-store" });
});

app.post("/api/me/plays", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const rate = await enforceRateLimit(c.env, `plays:post:${auth.id}`, 600, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const parsed = playsBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  await savePlays(c.env, auth.id, parsed.data);
  return c.json({ ok: true });
});

app.get("/api/me/favorites/export", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const rows = await c.env.DB.prepare(
    `SELECT games.id, games.slug, games.title, favorites.position, favorites.weekday_mask
     FROM favorites
     JOIN games ON games.id = favorites.game_id
     WHERE favorites.user_id = ?1
     ORDER BY favorites.position ASC`
  )
    .bind(auth.id)
    .all<{ id: string; slug: string; title: string; position: number; weekday_mask: number }>();
  const playData = await loadPlays(c.env, auth.id, undefined);
  const exportData = {
    version: 1,
    plays: playData.plays,
    streak: playData.streak,
    items: rows.results.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      position: r.position,
      weekdayMask: r.weekday_mask
    }))
  };
  return c.json(exportData);
});

const importFavoritesSchema = z.object({
  version: z.literal(1),
  items: z.array(z.object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string()
  })).min(1).max(500)
});

app.post("/api/me/favorites/import", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = importFavoritesSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }
  const rate = await enforceRateLimit(c.env, `fav:import:${auth.id}`, 30, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const imported = await importFavoriteIds(c.env, auth.id, parsed.data.items.map((item) => item.id));
  return c.json({ ok: true, imported });
});

const reorderSchema = z.object({
  items: z.array(z.object({ gameId: z.string().uuid(), position: z.number().int().positive() })).min(1)
});

app.post("/api/me/favorites/reorder", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = reorderSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }
  // Two-phase update to avoid unique index conflict on (user_id, position).
  // Phase 1: move all to temporary out-of-range positions.
  // Phase 2: set final positions.
  const phase1 = parsed.data.items.map((item) =>
    c.env.DB.prepare("UPDATE favorites SET position = ?1 WHERE user_id = ?2 AND game_id = ?3").bind(
      item.position + 10000,
      auth.id,
      item.gameId
    )
  );
  const phase2 = parsed.data.items.map((item) =>
    c.env.DB.prepare("UPDATE favorites SET position = ?1, updated_at = datetime('now') WHERE user_id = ?2 AND game_id = ?3").bind(
      item.position,
      auth.id,
      item.gameId
    )
  );
  await c.env.DB.batch([...phase1, ...phase2]);
  return c.json({ ok: true });
});

app.post("/api/me/rotation/share", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  
  // Check if user already has a share token
  const existing = await c.env.DB.prepare("SELECT rotation_share_token, display_name FROM users WHERE id = ?1")
    .bind(auth.id)
    .first<{ rotation_share_token: string | null; display_name: string | null }>();

  if (existing?.rotation_share_token) {
    return c.json({ shareToken: existing.rotation_share_token });
  }

  // Prefer the bare display-name slug; only disambiguate if it's already taken.
  const nameSlug = existing?.display_name ? slugify(existing.display_name) : "";
  let token: string;
  if (nameSlug) {
    const taken = await c.env.DB.prepare("SELECT 1 FROM users WHERE rotation_share_token = ?1")
      .bind(nameSlug)
      .first();
    token = taken ? `${nameSlug}-${auth.id.slice(0, 6)}` : nameSlug;
  } else {
    token = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  }

  await c.env.DB.prepare("UPDATE users SET rotation_share_token = ?1 WHERE id = ?2")
    .bind(token, auth.id)
    .run();
  
  return c.json({ shareToken: token });
});

app.delete("/api/me/rotation/share", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  
  await c.env.DB.prepare("UPDATE users SET rotation_share_token = NULL WHERE id = ?1")
    .bind(auth.id)
    .run();
  
  return c.json({ ok: true });
});

const weekdaySchema = z.object({ weekdayMask: z.number().int().min(0).max(127) });

app.patch("/api/me/favorites/:gameId", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = weekdaySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  await c.env.DB.prepare("UPDATE favorites SET weekday_mask = ?1, updated_at = datetime('now') WHERE user_id = ?2 AND game_id = ?3")
    .bind(parsed.data.weekdayMask, auth.id, c.req.param("gameId"))
    .run();
  return c.json({ ok: true });
});

const profileSchema = z.object({
  displayName: z.string().max(80).optional()
});

app.patch("/api/me/profile", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = profileSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const trimmed = (parsed.data.displayName || "").trim();
  const displayName = trimmed.length > 0 ? trimmed : null;
  await c.env.DB.prepare("UPDATE users SET display_name = ?1, updated_at = datetime('now') WHERE id = ?2")
    .bind(displayName, auth.id)
    .run();
  await writeAudit(c.env, auth.id, "user", auth.id, "update_profile", { displayName });
  return c.json({ ok: true, displayName });
});

// Unlink a sign-in provider. The last one can't be removed (the account would be impossible to sign in to).
app.delete("/api/me/accounts/:provider", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const provider = c.req.param("provider");
  const accounts = await c.env.DB.prepare("SELECT provider FROM oauth_accounts WHERE user_id = ?1").bind(auth.id).all<{ provider: string }>();
  if (!accounts.results.some((row) => row.provider === provider)) {
    return c.json({ error: "Not linked" }, 404);
  }
  if (accounts.results.length <= 1) {
    return c.json({ error: "This is your only way to sign in, so it can't be unlinked." }, 400);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_accounts WHERE user_id = ?1 AND provider = ?2").bind(auth.id, provider),
    // Editor/admin roles come from Discord, so they go with it.
    ...(provider === "discord" ? [c.env.DB.prepare("UPDATE users SET role = 'user', updated_at = datetime('now') WHERE id = ?1").bind(auth.id)] : []),
    // A Twitch-derived creator status goes with the Twitch account (a manual grant stays), and so does the channel tag on the list.
    ...(provider === "twitch"
      ? [
          c.env.DB.prepare("UPDATE users SET creator_type = NULL WHERE id = ?1 AND creator_type IN ('affiliate', 'partner')").bind(auth.id),
          c.env.DB.prepare("UPDATE curated_lists SET twitch_login = NULL, twitch_user_id = NULL WHERE owner_user_id = ?1 AND kind = 'creator'").bind(auth.id)
        ]
      : []),
    // Anything on the public profile that came from that account goes with it.
    c.env.DB.prepare("UPDATE users SET profile_avatar_provider = CASE WHEN profile_avatar_provider = ?2 THEN NULL ELSE profile_avatar_provider END, profile_show_twitch = CASE WHEN ?2 = 'twitch' THEN 0 ELSE profile_show_twitch END WHERE id = ?1").bind(auth.id, provider)
  ]);
  await writeAudit(c.env, auth.id, "user", auth.id, "unlink_account", { provider });
  return c.json({ ok: true });
});

app.delete("/api/me/sessions/:id", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const sessionId = c.req.param("id");
  const owned = await c.env.DB.prepare("SELECT id FROM sessions WHERE id = ?1 AND user_id = ?2")
    .bind(sessionId, auth.id)
    .first<{ id: string }>();
  if (!owned) {
    return c.json({ error: "Not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(sessionId).run();

  const token = getCookie(c, c.env.SESSION_COOKIE_NAME) || "";
  if (token) {
    const currentSessionId = await hashToken(c.env.SESSION_SECRET, token);
    if (currentSessionId === sessionId) {
      deleteCookie(c, c.env.SESSION_COOKIE_NAME, { path: "/" });
    }
  }

  await writeAudit(c.env, auth.id, "session", sessionId, "revoke", {});
  return c.json({ ok: true });
});

const reportSchema = z.object({
  reason: z.enum(["broken", "not_daily", "spam", "other"]),
  note: z.string().max(400).optional()
});

// ---- Reset-time suggestions (migration 0035) ----

app.post("/api/games/:id/reset-suggestion", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  const parsed = resetSuggestionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const minutes = parseResetTimeToMinutes(parsed.data.reset_time);
  if (minutes === null) {
    return c.json({ error: "Invalid reset time. Use HH:MM" }, 400);
  }
  const zone = normalizeResetTimeZone(parsed.data.reset_basis, parsed.data.reset_timezone === "UTC" ? null : parsed.data.reset_timezone);
  if (!zone.ok) {
    return c.json({ error: "Invalid time zone. Use an IANA name like America/New_York" }, 400);
  }
  const game = await c.env.DB.prepare("SELECT reset_basis, reset_time_minutes, reset_timezone FROM games WHERE id = ?1 AND status = 'approved'")
    .bind(gameId)
    .first<{ reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null }>();
  if (!game) {
    return c.json({ error: "Not found" }, 404);
  }
  if (game.reset_basis === parsed.data.reset_basis && game.reset_time_minutes === minutes && (game.reset_timezone === "UTC" ? null : game.reset_timezone) === zone.value) {
    return c.json({ error: "That is already this game's reset time." }, 409);
  }
  // Staff and the game's verified developer set the reset directly.
  if (auth.role === "admin" || auth.role === "editor" || (await getOwnClaim(c.env, gameId, auth.id))?.status === "verified") {
    return c.json({ error: "You can edit this game's reset time directly." }, 403);
  }
  const rate = await enforceRateLimit(c.env, `reset-suggestion:${auth.id}`, RESET_SUGGESTION_DAILY_LIMIT, 24 * 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  // One open suggestion per user per game: a new one replaces the old.
  await c.env.DB.prepare(
    `INSERT INTO reset_suggestions (id, game_id, user_id, reset_basis, reset_time_minutes, reset_timezone, note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (game_id, user_id) WHERE status = 'open'
     DO UPDATE SET reset_basis = excluded.reset_basis, reset_time_minutes = excluded.reset_time_minutes,
                   reset_timezone = excluded.reset_timezone, note = excluded.note, created_at = datetime('now')`
  )
    .bind(crypto.randomUUID(), gameId, auth.id, parsed.data.reset_basis, minutes, zone.value, parsed.data.note || null)
    .run();
  return c.json({ ok: true });
});

app.get("/admin/resets", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.game_id, s.user_id, s.reset_basis, s.reset_time_minutes, s.reset_timezone, s.note, s.created_at, users.display_name
     FROM reset_suggestions s JOIN users ON users.id = s.user_id
     WHERE s.status = 'open'
     ORDER BY s.created_at DESC
     LIMIT 1000`
  ).all<OpenSuggestionRow>();
  const groups = groupSuggestions(rows.results);
  const gameIds = [...new Set(groups.map((group) => group.gameId))];
  const games = new Map<string, { title: string; slug: string; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null }>();
  for (let i = 0; i < gameIds.length; i += 90) {
    const chunk = gameIds.slice(i, i + 90);
    const found = await c.env.DB.prepare(`SELECT id, title, slug, reset_basis, reset_time_minutes, reset_timezone FROM games WHERE id IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})`)
      .bind(...chunk)
      .all<{ id: string; title: string; slug: string; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null }>();
    for (const game of found.results) games.set(game.id, game);
  }
  return c.html(await layout("Reset suggestions", auth, `
    <main>
      <h1>Reset suggestions</h1>
      <p>Reset times suggested by signed-in players. Identical suggestions from different people are grouped. Apply writes the game's reset and closes the matching suggestions.</p>
      ${groups.length === 0 ? "<p>No open suggestions.</p>" : `<div class="stack">
        ${groups.map((group) => {
          const game = games.get(group.gameId);
          if (!game) return "";
          const current = describeReset(game.reset_basis, game.reset_time_minutes, game.reset_timezone) ?? "No reset time set.";
          const suggested = describeReset(group.basis, group.minutes, group.timezone) ?? "";
          const notes = group.rows.filter((row) => row.note);
          return `<article class="panel" data-reset-suggestion-id="${escapeHtml(group.id)}">
            <h2><a href="/games/${escapeHtml(game.slug)}">${escapeHtml(game.title)}</a> <small>(${group.rows.length} ${group.rows.length === 1 ? "suggestion" : "suggestions"})</small></h2>
            <p><strong>Current:</strong> ${escapeHtml(current)}</p>
            <p><strong>Suggested:</strong> ${escapeHtml(suggested)}</p>
            ${notes.length > 0 ? `<ul>${notes.map((row) => `<li>${escapeHtml(row.note!)} <small>(${escapeHtml(row.display_name || "no name")})</small></li>`).join("")}</ul>` : ""}
            <p><small>From ${group.rows.map((row) => escapeHtml(row.display_name || "(no name)")).join(", ")}</small></p>
            <div class="actions">
              <button type="button" data-reset-action="apply">Apply</button>
              <button type="button" class="danger" data-reset-action="dismiss">Dismiss</button>
            </div>
          </article>`;
        }).join("")}
      </div>`}
      <p id="resets-status" class="status" aria-live="polite"></p>
    </main>
    <script src="${ASSET.page_admin_resets}"></script>
  `, c.env));
});

/** Closes a game's open suggestions identical to the given one. Returns the suggestion, or null when it isn't open. */
async function resolveResetSuggestions(env: Env, suggestionId: string, actorId: string, status: "applied" | "dismissed") {
  const suggestion = await env.DB.prepare(
    "SELECT game_id, reset_basis, reset_time_minutes, reset_timezone FROM reset_suggestions WHERE id = ?1 AND status = 'open'"
  ).bind(suggestionId).first<{ game_id: string; reset_basis: "local" | "server"; reset_time_minutes: number; reset_timezone: string | null }>();
  if (!suggestion) return null;
  const close = env.DB.prepare(
    `UPDATE reset_suggestions SET status = ?1, resolved_at = datetime('now'), resolved_by = ?2
     WHERE game_id = ?3 AND status = 'open' AND reset_basis = ?4 AND reset_time_minutes = ?5 AND COALESCE(reset_timezone, '') = COALESCE(?6, '')`
  ).bind(status, actorId, suggestion.game_id, suggestion.reset_basis, suggestion.reset_time_minutes, suggestion.reset_timezone);
  return { suggestion, close };
}

app.post("/api/admin/reset-suggestions/:id/apply", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const resolved = await resolveResetSuggestions(c.env, c.req.param("id"), auth.id, "applied");
  if (!resolved) {
    return c.json({ error: "Not found" }, 404);
  }
  const { suggestion, close } = resolved;
  const game = await c.env.DB.prepare("SELECT title, slug, reset_basis, reset_time_minutes, reset_timezone FROM games WHERE id = ?1")
    .bind(suggestion.game_id)
    .first<{ title: string; slug: string; reset_basis: string | null; reset_time_minutes: number | null; reset_timezone: string | null }>();
  if (!game) {
    return c.json({ error: "Not found" }, 404);
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE games SET reset_basis = ?1, reset_time_minutes = ?2, reset_timezone = ?3, updated_at = datetime('now'), content_updated_at = datetime('now') WHERE id = ?4"
    ).bind(suggestion.reset_basis, suggestion.reset_time_minutes, suggestion.reset_timezone, suggestion.game_id),
    close
  ]);
  await writeAudit(c.env, auth.id, "game", suggestion.game_id, "reset_update", {
    title: game.title,
    slug: game.slug,
    via: "suggestion",
    from: { basis: game.reset_basis, minutes: game.reset_time_minutes, timezone: game.reset_timezone },
    to: { basis: suggestion.reset_basis, minutes: suggestion.reset_time_minutes, timezone: suggestion.reset_timezone }
  });
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.post("/api/admin/reset-suggestions/:id/dismiss", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const resolved = await resolveResetSuggestions(c.env, c.req.param("id"), auth.id, "dismissed");
  if (!resolved) {
    return c.json({ error: "Not found" }, 404);
  }
  await resolved.close.run();
  return c.json({ ok: true });
});

app.post("/api/games/:id/report", async (c) => {
  const user = c.get("user");
  const gameId = c.req.param("id");

  const ipHash = user ? "" : await getAnonymousVoteKey(c);
  const rateLimitKey = user ? `report:${user.id}` : `report:anon:${ipHash}`;
  const reportRate = await enforceRateLimit(c.env, rateLimitKey, 20, 60 * 60);
  if (!reportRate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: reportRate.retryAfterSeconds }, 429);
  }
  const parsed = reportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const game = await c.env.DB.prepare("SELECT id FROM games WHERE id = ?1 AND status = 'approved'").bind(gameId).first<{ id: string }>();
  if (!game) {
    return c.json({ error: "Not found" }, 404);
  }

  let reporterId: string;
  if (user) {
    reporterId = user.id;
  } else {
    const anonEmail = `anon-${ipHash}@anonymous.local`;
    let anonUser = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(anonEmail).first<{ id: string }>();
    if (!anonUser) {
      const anonId = crypto.randomUUID();
      await c.env.DB.prepare("INSERT INTO users (id, email, role) VALUES (?1, ?2, 'user')").bind(anonId, anonEmail).run();
      anonUser = { id: anonId };
    }
    reporterId = anonUser.id;
  }

  const existing = await c.env.DB.prepare("SELECT 1 AS ok FROM reports WHERE game_id = ?1 AND reported_by_user_id = ?2 AND status = 'open' LIMIT 1")
    .bind(gameId, reporterId)
    .first();
  if (existing) {
    return c.json({ ok: true, alreadyReported: true });
  }
  const reportId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO reports (id, game_id, reported_by_user_id, reason, note)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(reportId, gameId, reporterId, parsed.data.reason, parsed.data.note || null),
    c.env.DB.prepare(
      "UPDATE games SET report_count = report_count + 1, updated_at = datetime('now') WHERE id = ?1"
    ).bind(gameId)
  ]);
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

// Stats for a game's verified developer (and admins). Never edge-cached: it needs a session.
app.get("/api/games/:id/developer-stats", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  if (auth.role !== "admin") {
    const claim = await c.env.DB.prepare("SELECT 1 AS ok FROM game_claims WHERE game_id = ?1 AND user_id = ?2 AND status = 'verified'").bind(gameId, auth.id).first();
    if (!claim) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }
  const stats = await loadDeveloperStats(c.env, gameId);
  if (!stats) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(stats, 200, { "Cache-Control": "private, no-store" });
});

app.post("/api/games/:id/click", (c) => recordGameClick(c, c.req.param("id")));

// Unauthenticated, no CSRF (see EMBED_CLICK_PREFIX); same per-IP-and-game rate limit and counters as the site's click.
app.post("/api/embed/click/:gameId", (c) => recordGameClick(c, c.req.param("gameId")));

async function recordGameClick(c: Context<{ Bindings: Bindings; Variables: AppVariables }>, gameId: string): Promise<Response> {
  // Clicks feed the score, so cap how many one visitor can contribute per game.
  const clickRate = await enforceRateLimit(c.env, `click:${await getAnonymousVoteKey(c)}:${gameId}`, 5, 60 * 60);
  if (!clickRate.ok) {
    return c.json({ ok: true });
  }
  // Daily plays are bucketed by US/Eastern date (same as developer stats).
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [update] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE games SET click_count = click_count + 1 WHERE id = ?1").bind(gameId),
    c.env.DB.prepare("INSERT INTO game_click_days (game_id, day, clicks) SELECT id, ?2, 1 FROM games WHERE id = ?1 ON CONFLICT(game_id, day) DO UPDATE SET clicks = clicks + 1").bind(gameId, day)
  ]);
  if (!update.meta.changes) {
    return c.json({ ok: true });
  }
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
}

// Web Push reset reminders (src/lib/push.ts). Subscribing is a 404 unless the VAPID vars/secret are set.
const pushSubscribeSchema = z.object({
  endpoint: z.string().min(10).max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).partial().optional(),
  leadMinutes: z.number().int().refine((n) => [30, 60, 120].includes(n)),
  tz: z.string().min(1).max(64),
  label: z.string().max(200).optional()
});

app.post("/api/me/push/subscribe", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  if (!pushEnabled(c.env)) return c.json({ error: "Push reminders are not enabled" }, 404);
  const rate = await enforceRateLimit(c.env, `push:sub:${auth.id}`, 60, 60 * 60);
  if (!rate.ok) return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  const parsed = pushSubscribeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !isAllowedEndpoint(c.env, parsed.data.endpoint) || !validTimeZone(parsed.data.tz)) return c.json({ error: "Invalid subscription" }, 400);
  const { endpoint, leadMinutes, tz } = parsed.data;
  const label = parsed.data.label?.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) || null;
  const existing = await c.env.DB.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?1").bind(endpoint).first<{ id: string }>();
  if (existing) {
    // Same browser, possibly a different account: the endpoint moves to the current user.
    await c.env.DB.prepare("UPDATE push_subscriptions SET user_id = ?2, lead_minutes = ?3, tz = ?4, label = COALESCE(?5, label) WHERE id = ?1").bind(existing.id, auth.id, leadMinutes, tz, label).run();
  } else {
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1").bind(auth.id).first<{ n: number }>();
    if ((count?.n ?? 0) >= PUSH_MAX_PER_USER) return c.json({ error: `You can have reminders on up to ${PUSH_MAX_PER_USER} devices.` }, 409);
    await c.env.DB.prepare("INSERT INTO push_subscriptions (id, user_id, endpoint, created_at, lead_minutes, tz, label) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(crypto.randomUUID(), auth.id, endpoint, new Date().toISOString(), leadMinutes, tz, label).run();
  }
  return c.json({ ok: true }, 200, { "Cache-Control": "no-store" });
});

app.post("/api/me/push/unsubscribe", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const body = z.object({ endpoint: z.string().min(1).max(1000) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Invalid payload" }, 400);
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2").bind(auth.id, body.data.endpoint).run();
  return c.json({ ok: true }, 200, { "Cache-Control": "no-store" });
});

app.get("/api/me/push/subscriptions", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const rows = await c.env.DB.prepare("SELECT id, label, created_at, last_sent_at, lead_minutes, tz FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at ASC")
    .bind(auth.id).all<{ id: string; label: string | null; created_at: string; last_sent_at: string | null; lead_minutes: number; tz: string }>();
  return c.json(
    rows.results.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastSentAt: r.last_sent_at, leadMinutes: r.lead_minutes, tz: r.tz, current: false })),
    200,
    { "Cache-Control": "no-store" }
  );
});

// Lets a browser find which of its user's devices it is: { endpoint } -> { id } (or null).
app.post("/api/me/push/subscriptions/current", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const body = z.object({ endpoint: z.string().min(1).max(1000) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Invalid payload" }, 400);
  const row = await c.env.DB.prepare("SELECT id FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2").bind(auth.id, body.data.endpoint).first<{ id: string }>();
  return c.json({ id: row?.id ?? null }, 200, { "Cache-Control": "no-store" });
});

app.delete("/api/me/push/subscriptions/:id", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const res = await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1 AND user_id = ?2").bind(c.req.param("id"), auth.id).run();
  if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true }, 200, { "Cache-Control": "no-store" });
});

// Tells the rotation page whether push reminders are available (signed in + VAPID configured).
app.get("/api/me/push/config", (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  return c.json({ publicKey: pushEnabled(c.env) ? c.env.VAPID_PUBLIC_KEY : null }, 200, { "Cache-Control": "no-store" });
});

// Read by the service worker after a push. Always 200 with { title, body, url } (generic text when nothing is due).
app.get("/api/me/reminders/pending", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) return auth;
  const found = pushEnabled(c.env) ? await pendingReminder(c.env, auth.id).catch(() => null) : null;
  return c.json(found ?? { title: "Games in your rotation reset soon", body: "Open 0x9 dles to see what's left today.", url: "/me/rotation" }, 200, { "Cache-Control": "no-store" });
});

// Whether this browser has a session. Always 200 (no 401 noise for logged-out visitors) and never cached, so
// edge-cached pages can ask it from the client.
app.get("/api/me/session", (c) => c.json({ signedIn: !!c.get("user") }, 200, { "Cache-Control": "no-store" }));

// Matches pasted game names/links to approved games for the rotation Import panel. Works logged out (rate limited by IP hash).
app.post("/api/me/rotation/import-preview", async (c) => {
  const user = c.get("user");
  const limitKey = user ? `rotation-import:${user.id}` : `rotation-import:anon:${await getAnonymousVoteKey(c)}`;
  const rate = await enforceRateLimit(c.env, limitKey, 30, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const body = await c.req.json().catch(() => null) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : null;
  if (text === null || text.trim() === "") {
    return c.json({ error: "Paste at least one game name or link." }, 400);
  }
  if (new TextEncoder().encode(text).length > IMPORT_MAX_BYTES) {
    return c.json({ error: "That is too much text (10 KB at most)." }, 400);
  }
  if (text.split(/\r?\n/).filter((line) => line.trim()).length > IMPORT_MAX_LINES) {
    return c.json({ error: `Too many lines (${IMPORT_MAX_LINES} at most).` }, 400);
  }
  const lines = parseImportText(text).slice(0, IMPORT_MAX_LINES);
  const games = await c.env.DB.prepare("SELECT id, slug, title, url FROM games WHERE status = 'approved'")
    .all<{ id: string; slug: string; title: string; url: string }>();
  const rows = matchImportLines(lines, games.results);
  let have = new Set<string>();
  if (user) {
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.match) ids.add(row.match.id);
      for (const alt of row.alternatives) ids.add(alt.id);
    }
    if (ids.size > 0) {
      const found = await c.env.DB.prepare("SELECT game_id FROM favorites WHERE user_id = ?1 AND game_id IN (SELECT value FROM json_each(?2))")
        .bind(user.id, JSON.stringify([...ids]))
        .all<{ game_id: string }>();
      have = new Set(found.results.map((r) => r.game_id));
    }
  }
  return c.json({
    rows: rows.map((row) => ({
      ...row,
      inRotation: row.match ? have.has(row.match.id) : false,
      alternatives: row.alternatives.map((alt) => ({ ...alt, inRotation: have.has(alt.id) }))
    }))
  }, 200, { "Cache-Control": "no-store" });
});

app.get("/api/me/rotation", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const weekday = Number(c.req.query("weekday") || "1");
  const bit = Math.pow(2, Math.max(0, Math.min(6, weekday - 1)));
  const rows = await c.env.DB.prepare(
    `SELECT games.id, games.slug, games.title, favorites.position, favorites.weekday_mask
     FROM favorites
     JOIN games ON games.id = favorites.game_id
     WHERE favorites.user_id = ?1 AND (favorites.weekday_mask & ?2) > 0
     ORDER BY favorites.position ASC`
  )
    .bind(auth.id, bit)
    .all();
  return c.json(rows);
});

app.get("/api/lists", async (c) => {
  const user = c.get("user");
  const rows = await c.env.DB.prepare(
    "SELECT id, slug, title, description, visibility, owner_user_id, twitch_login, twitch_user_id, updated_at FROM curated_lists ORDER BY updated_at DESC"
  ).all<{ id: string; slug: string; title: string; description: string | null; visibility: "public" | "private"; owner_user_id: string; twitch_login: string | null; twitch_user_id: string | null; updated_at: string }>();
  const userTwitchId = await getUserTwitchId(c.env, user);
  const visible = rows.results
    .filter((row) => canViewList(row.visibility, row.owner_user_id, user, { listTwitchUserId: row.twitch_user_id, userTwitchId }))
    .map(({ twitch_user_id: _twitchUserId, ...row }) => row);
  return c.json({ results: visible });
});

app.get("/api/lists/live", async (c) => {
  const headers = { "Cache-Control": "public, max-age=60" };
  try {
    // The answer is the same for everyone: a KV copy (with its own timestamp, KV's minimum TTL is 60s) serves polls for
    // 15s without touching D1, including the rate-limit write.
    const cachedLive = await getCachedJson<{ at: number; live: unknown }>(c.env, "lists-live:v1").catch(() => null);
    if (cachedLive && Date.now() - cachedLive.at < 15_000) return c.json({ live: cachedLive.live }, 200, headers);
    const rate = await enforceRateLimit(c.env, `lists-live:${await getAnonymousVoteKey(c)}`, 300, 60 * 60);
    if (!rate.ok) return c.json({ live: {} }, 429, { "Cache-Control": "no-store", "Retry-After": String(rate.retryAfterSeconds) });
    const rows = await c.env.DB.prepare(
      `SELECT l.slug, l.title, l.twitch_login, l.now_playing_game_id AS npId, l.now_playing_at AS npAt, g.title AS npTitle, g.slug AS npSlug
       FROM curated_lists l LEFT JOIN games g ON g.id = l.now_playing_game_id AND g.status = 'approved'
       WHERE l.visibility = 'public' AND l.twitch_login IS NOT NULL AND l.twitch_login != ''`
    ).all<{ slug: string; title: string; twitch_login: string; npId: string | null; npAt: string | null; npTitle: string | null; npSlug: string | null }>();
    const status = await getLiveStatus(c.env, rows.results.map((r) => r.twitch_login));
    const live: Record<string, { title: string; startedAt: string; viewerCount: number; listTitle: string; login: string; nowPlaying: { title: string; slug: string } | null }> = {};
    for (const row of rows.results) {
      const info = status[row.twitch_login.toLowerCase()];
      if (!info) continue;
      const np = resolveNowPlaying({ gameId: row.npId, title: row.npTitle, at: row.npAt });
      live[row.slug] = {
        title: info.title, startedAt: info.startedAt, viewerCount: info.viewerCount, listTitle: row.title, login: row.twitch_login.toLowerCase(),
        nowPlaying: np.gameId && row.npSlug ? { title: np.title, slug: row.npSlug } : null
      };
    }
    await setCachedJson(c.env, "lists-live:v1", { at: Date.now(), live }, 60).catch(() => undefined);
    return c.json({ live }, 200, headers);
  } catch (error) {
    console.error("lists/live failed:", error instanceof Error ? error.message : error);
    return c.json({ live: {} }, 200, { "Cache-Control": "public, max-age=30" });
  }
});

app.get("/api/lists/:slug", async (c) => {
  const user = c.get("user");
  const list = await c.env.DB.prepare(
    "SELECT id, slug, title, description, visibility, owner_user_id, twitch_login, twitch_user_id FROM curated_lists WHERE slug = ?1"
  )
    .bind(c.req.param("slug"))
    .first<{ id: string; slug: string; title: string; description: string | null; visibility: "public" | "private"; owner_user_id: string; twitch_login: string | null; twitch_user_id: string | null }>();
  if (!list || !canViewList(list.visibility, list.owner_user_id, user, { listTwitchUserId: list.twitch_user_id, userTwitchId: await getUserTwitchId(c.env, user) })) {
    return c.json({ error: "Not found" }, 404);
  }
  // lastPlayedAt only when Played on stream applies to this request (the same rule as the list page's data attributes).
  const playedOn = await playedOnStreamFor(c.env, user);
  const items = await c.env.DB.prepare(
    `SELECT games.id, games.slug, games.title, curated_list_items.position${playedOn ? ", curated_list_items.last_played_at AS lastPlayedAt" : ""}
     FROM curated_list_items
     JOIN games ON games.id = curated_list_items.game_id
     WHERE curated_list_items.curated_list_id = ?1
     ORDER BY curated_list_items.position ASC`
  )
    .bind(list.id)
    .all();
  const { twitch_user_id: _twitchUserId, ...publicList } = list;
  return c.json({ ...publicList, items: items.results });
});

const createListSchema = z.object({
  title: z.string().min(2).max(100),
  description: z.string().max(300).optional(),
  visibility: z.enum(["public", "private"]).default("private")
});

const updateListSchema = z.object({
  title: z.string().min(2).max(100).optional(),
  description: z.string().max(300).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens").optional(),
  suggestionsEnabled: z.boolean().optional(),
  fandlesEnabled: z.boolean().optional()
});

app.post("/api/lists", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = createListSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const id = crypto.randomUUID();
  const slug = uniqueSlug(parsed.data.title, id);
  await c.env.DB.prepare(
    `INSERT INTO curated_lists
      (id, slug, title, description, visibility, owner_user_id, created_by_user_id, updated_by_user_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)`
  )
    .bind(id, slug, parsed.data.title, parsed.data.description || null, parsed.data.visibility, auth.id)
    .run();
  await writeAudit(c.env, auth.id, "list", id, "create_list", { visibility: parsed.data.visibility });
  return c.json({ id, slug }, 201);
});

app.patch("/api/lists/:id/visibility", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  if (auth.role !== "editor" && auth.role !== "admin" && !(await isCreatorListOwner(c.env, c.req.param("id"), auth.id))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const visibility = z.enum(["public", "private"]).safeParse((await c.req.json()).visibility);
  if (!visibility.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  await c.env.DB.prepare("UPDATE curated_lists SET visibility = ?1, updated_by_user_id = ?2, updated_at = datetime('now') WHERE id = ?3")
    .bind(visibility.data, auth.id, c.req.param("id"))
    .run();
  await writeAudit(c.env, auth.id, "list", c.req.param("id"), "update_visibility", { visibility: visibility.data });
  await purgeListPageCache(c, c.req.param("id"));
  return c.json({ ok: true });
});

app.patch("/api/lists/:id", async (c) => {
  const listId = c.req.param("id");
  const auth = await requireListEditor(c, listId);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = updateListSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const isStaff = auth.role === "editor" || auth.role === "admin";
  const existing = await c.env.DB.prepare("SELECT title, description, slug, suggestions_enabled, fandles_enabled FROM curated_lists WHERE id = ?1")
    .bind(listId)
    .first<{ title: string; description: string | null; slug: string; suggestions_enabled: number; fandles_enabled: number }>();
  if (!existing) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!isStaff && parsed.data.slug !== undefined && parsed.data.slug !== existing.slug) {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (parsed.data.slug && parsed.data.slug !== existing.slug) {
    const slugExists = await c.env.DB.prepare("SELECT id FROM curated_lists WHERE slug = ?1 AND id != ?2")
      .bind(parsed.data.slug, listId)
      .first<{ id: string }>();
    if (slugExists) {
      return c.json({ error: "Slug already in use" }, 409);
    }
  }
  await c.env.DB.prepare(
    `UPDATE curated_lists
     SET title = ?1, description = ?2, slug = ?3, updated_by_user_id = ?4, updated_at = datetime('now'), suggestions_enabled = ?6, fandles_enabled = ?7
     WHERE id = ?5`
  )
    .bind(
      parsed.data.title ?? existing.title,
      parsed.data.description === undefined ? existing.description : parsed.data.description,
      parsed.data.slug ?? existing.slug,
      auth.id,
      listId,
      parsed.data.suggestionsEnabled === undefined ? existing.suggestions_enabled : parsed.data.suggestionsEnabled ? 1 : 0,
      parsed.data.fandlesEnabled === undefined ? existing.fandles_enabled : parsed.data.fandlesEnabled ? 1 : 0
    )
    .run();
  await writeAudit(c.env, auth.id, "list", listId, "update_list", parsed.data);
  await purgeListPageCache(c, listId);
  return c.json({ ok: true });
});

// Fan-dles moderation and membership.
app.put("/api/lists/:id/fandles/:gameId/hidden", async (c) => {
  const listId = c.req.param("id");
  const auth = await requireListEditor(c, listId);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = z.object({ hidden: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const gameId = c.req.param("gameId");
  if (parsed.data.hidden) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO fandle_hidden (list_id, game_id, hidden_by_user_id) VALUES (?1, ?2, ?3)").bind(listId, gameId, auth.id).run();
  } else {
    await c.env.DB.prepare("DELETE FROM fandle_hidden WHERE list_id = ?1 AND game_id = ?2").bind(listId, gameId).run();
  }
  await writeAudit(c.env, auth.id, "list", listId, parsed.data.hidden ? "fandle_hide" : "fandle_unhide", { gameId });
  await purgeListPageCache(c, listId);
  return c.json({ ok: true });
});

// Admins add or remove community members by hand, with no Twitch check.
app.get("/api/admin/developers", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const q = (c.req.query("q") || "").trim().slice(0, 60);
  if (q.length < 2) {
    return c.json({ results: [] });
  }
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const rows = await c.env.DB.prepare(
    `SELECT users.id, COALESCE(users.display_name, users.profile_handle, 'Developer') AS name,
            CASE WHEN users.profile_public = 1 THEN users.profile_handle END AS handle,
            (SELECT COUNT(*) FROM game_claims WHERE game_claims.user_id = users.id AND game_claims.status = 'verified') AS games
     FROM users
     WHERE (users.display_name LIKE ?1 OR users.profile_handle LIKE ?1)
       AND EXISTS (SELECT 1 FROM game_claims WHERE game_claims.user_id = users.id AND game_claims.status = 'verified')
     ORDER BY users.display_name LIMIT 10`
  )
    .bind(like)
    .all<{ id: string; name: string; handle: string | null; games: number }>();
  return c.json({ results: rows.results });
});

app.post("/api/lists/:id/fandle-members", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = z.object({ userId: z.string().uuid() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const listId = c.req.param("id");
  const list = await c.env.DB.prepare("SELECT slug FROM curated_lists WHERE id = ?1").bind(listId).first<{ slug: string }>();
  if (!list || !(await getFandleList(c.env, list.slug))) {
    return c.json({ error: "This list doesn't take Fan-dles (it needs to be a public verified creator list with Fan-dles on)" }, 409);
  }
  if (!(await hasVerifiedClaim(c.env, parsed.data.userId))) {
    return c.json({ error: "That person has no verified game yet" }, 409);
  }
  await c.env.DB.prepare(
    `INSERT INTO fandle_members (list_id, user_id, source, followed_at, verified_at, expires_at, added_by_user_id)
     VALUES (?1, ?2, 'manual', NULL, datetime('now'), ?3, ?4)
     ON CONFLICT (list_id, user_id) DO UPDATE SET source = 'manual', verified_at = datetime('now'), expires_at = excluded.expires_at, added_by_user_id = excluded.added_by_user_id`
  )
    .bind(listId, parsed.data.userId, FANDLE_NO_EXPIRY, auth.id)
    .run();
  await writeAudit(c.env, auth.id, "list", listId, "fandle_add_member", { userId: parsed.data.userId });
  await purgeListPageCache(c, listId);
  return c.json({ ok: true });
});

app.delete("/api/lists/:id/fandle-members/:userId", async (c) => {
  const auth = requireRole(c, ["admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  await c.env.DB.prepare("DELETE FROM fandle_members WHERE list_id = ?1 AND user_id = ?2").bind(c.req.param("id"), c.req.param("userId")).run();
  await writeAudit(c.env, auth.id, "list", c.req.param("id"), "fandle_remove_member", { userId: c.req.param("userId") });
  await purgeListPageCache(c, c.req.param("id"));
  return c.json({ ok: true });
});

// A developer leaves a streamer's Fan-dles (their games stop showing there).
app.delete("/api/lists/:id/fandle-membership", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  await c.env.DB.prepare("DELETE FROM fandle_members WHERE list_id = ?1 AND user_id = ?2").bind(c.req.param("id"), auth.id).run();
  await purgeListPageCache(c, c.req.param("id"));
  return c.json({ ok: true });
});

app.patch("/api/lists/:id/twitch", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = z.object({ login: z.string().regex(/^[A-Za-z0-9_]{4,25}$/).nullable() }).safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Enter a valid Twitch username (4-25 letters, numbers or underscores)" }, 400);
  }
  const listId = c.req.param("id");
  let twitch: { id: string; login: string } | null = null;
  if (parsed.data.login) {
    try {
      twitch = await lookupTwitchUser(c.env, parsed.data.login);
    } catch {
      return c.json({ error: "Could not reach Twitch to verify that username. Try again shortly." }, 502);
    }
    if (!twitch) {
      return c.json({ error: "No Twitch user with that username" }, 404);
    }
  }
  const result = await c.env.DB.prepare(
    "UPDATE curated_lists SET twitch_login = ?1, twitch_user_id = ?2, updated_by_user_id = ?3, updated_at = datetime('now') WHERE id = ?4"
  )
    .bind(twitch?.login ?? null, twitch?.id ?? null, auth.id, listId)
    .run();
  if (((result.meta as { changes?: number } | undefined)?.changes ?? 0) === 0) {
    return c.json({ error: "Not found" }, 404);
  }
  await writeAudit(c.env, auth.id, "list", listId, "set_twitch_owner", { twitchLogin: twitch?.login ?? null, twitchUserId: twitch?.id ?? null });
  return c.json({ ok: true, twitchLogin: twitch?.login ?? null });
});

app.delete("/api/lists/:id", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const listId = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM curated_lists WHERE id = ?1").bind(listId).run();
  await writeAudit(c.env, auth.id, "list", listId, "delete_list", {});
  return c.json({ ok: true });
});

const listItemSchema = z.object({ gameId: z.string().uuid(), position: z.number().int().positive() });
const reorderListItemsSchema = z.object({
  items: z.array(z.object({ gameId: z.string().uuid(), position: z.number().int().positive() })).min(1)
});

app.post("/api/lists/:id/items", async (c) => {
  const listId = c.req.param("id");
  const auth = await requireListEditor(c, listId);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = listItemSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  if (auth.role !== "editor" && auth.role !== "admin") {
    const approved = await c.env.DB.prepare("SELECT id FROM games WHERE id = ?1 AND status = 'approved'").bind(parsed.data.gameId).first();
    if (!approved) {
      return c.json({ error: "Game not found" }, 404);
    }
  }
  const inserted = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO curated_list_items (curated_list_id, game_id, position, added_by_user_id)
     SELECT ?1, ?2, COALESCE(MAX(position), 0) + 1, ?3 FROM curated_list_items WHERE curated_list_id = ?1
     RETURNING position`
  )
    .bind(listId, parsed.data.gameId, auth.id)
    .first<{ position: number }>();
  let nextPos = inserted?.position ?? null;
  if (nextPos === null) {
    // Nothing inserted: fine if the game is already on the list, otherwise the write really failed.
    const present = await c.env.DB.prepare("SELECT position FROM curated_list_items WHERE curated_list_id = ?1 AND game_id = ?2")
      .bind(listId, parsed.data.gameId)
      .first<{ position: number }>();
    if (!present) {
      return c.json({ error: "Could not add game" }, 500);
    }
    nextPos = present.position;
  }
  // Adding a game directly lifts any suggestion block and settles an open suggestion for it.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM list_blocked_games WHERE curated_list_id = ?1 AND game_id = ?2").bind(listId, parsed.data.gameId),
    ...deleteSuggestionStatements(c.env, listId, parsed.data.gameId)
  ]);
  await writeAudit(c.env, auth.id, "list", listId, "add_item", { gameId: parsed.data.gameId, position: nextPos });
  await purgeListPageCache(c, listId);
  return c.json({ ok: true });
});

app.delete("/api/lists/:id/items/:gameId", async (c) => {
  const auth = await requireListEditor(c, c.req.param("id"));
  if (auth instanceof Response) {
    return auth;
  }
  const removed = await c.env.DB.prepare("DELETE FROM curated_list_items WHERE curated_list_id = ?1 AND game_id = ?2")
    .bind(c.req.param("id"), c.req.param("gameId"))
    .run();
  // A game taken off a list can't be suggested for it again.
  if (((removed.meta as { changes?: number } | undefined)?.changes ?? 0) > 0) {
    await blockListGame(c.env, c.req.param("id"), c.req.param("gameId"), "removed", auth.id);
  }
  await writeAudit(c.env, auth.id, "list", c.req.param("id"), "remove_item", { gameId: c.req.param("gameId") });
  await purgeListPageCache(c, c.req.param("id"));
  return c.json({ ok: true });
});

app.patch("/api/lists/:id/items/reorder", async (c) => {
  const listId = c.req.param("id");
  const auth = await requireListEditor(c, listId);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = reorderListItemsSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }

  const clearPassStatements = parsed.data.items.map((item, index) =>
    c.env.DB.prepare("UPDATE curated_list_items SET position = ?1 WHERE curated_list_id = ?2 AND game_id = ?3").bind(
      -1000 - index,
      listId,
      item.gameId
    )
  );
  const finalPassStatements = parsed.data.items.map((item) =>
    c.env.DB.prepare("UPDATE curated_list_items SET position = ?1 WHERE curated_list_id = ?2 AND game_id = ?3").bind(
      item.position,
      listId,
      item.gameId
    )
  );
  await c.env.DB.batch([...clearPassStatements, ...finalPassStatements]);
  await writeAudit(c.env, auth.id, "list", listId, "reorder_items", { count: parsed.data.items.length });
  await purgeListPageCache(c, listId);
  return c.json({ ok: true });
});

// Suggestions: viewers suggest games for a curated list and agree with each other's suggestions (one vote each, the
// suggester's included). Logged-out visitors count by hashed IP, like anonymous game votes. Editors, admins and the list's Twitch owner move them onto the list or dismiss them.
type ListSuggestion = {
  gameId: string;
  slug: string;
  title: string;
  url: string;
  paywall: boolean;
  nsfw: boolean;
  categories: Array<{ slug: string; name: string; hue: number }>;
  developer: GameDeveloper | null;
  votes: number;
  voted: boolean;
};

async function getListSuggestions(env: Env, listId: string, voterKey: string | null): Promise<ListSuggestion[]> {
  const rows = await env.DB.prepare(
    `SELECT list_suggestions.game_id, games.slug, games.title, games.url, games.paywall, games.nsfw,
            (SELECT COUNT(*) FROM list_suggestion_votes v WHERE v.curated_list_id = list_suggestions.curated_list_id AND v.game_id = list_suggestions.game_id) AS votes,
            EXISTS(SELECT 1 FROM list_suggestion_votes v WHERE v.curated_list_id = list_suggestions.curated_list_id AND v.game_id = list_suggestions.game_id AND v.voter_key = ?2) AS voted
     FROM list_suggestions
     JOIN games ON games.id = list_suggestions.game_id AND games.status = 'approved'
     WHERE list_suggestions.curated_list_id = ?1
     ORDER BY votes DESC, list_suggestions.created_at ASC
     LIMIT 200`
  )
    .bind(listId, voterKey ?? "")
    .all<{ game_id: string; slug: string; title: string; url: string; paywall: number; nsfw: number; votes: number; voted: number }>();
  const categoriesByGameId = await getCategoriesForGames(env, rows.results.map((row) => row.game_id));
  const developersByGameId = await getDevelopersForGames(env, rows.results.map((row) => row.game_id));
  return rows.results.map((row) => ({
    gameId: row.game_id,
    slug: row.slug,
    title: row.title,
    url: row.url,
    paywall: row.paywall === 1,
    nsfw: row.nsfw === 1,
    categories: (categoriesByGameId.get(row.game_id) ?? []).map((cat) => ({ ...cat, hue: categoryHue(cat.slug) })),
    developer: developersByGameId.get(row.game_id) ?? null,
    votes: row.votes,
    voted: row.voted === 1
  }));
}

function deleteSuggestionStatements(env: Env, listId: string, gameId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare("DELETE FROM list_suggestion_votes WHERE curated_list_id = ?1 AND game_id = ?2").bind(listId, gameId),
    env.DB.prepare("DELETE FROM list_suggestions WHERE curated_list_id = ?1 AND game_id = ?2").bind(listId, gameId)
  ];
}

async function blockListGame(env: Env, listId: string, gameId: string, reason: "removed" | "dismissed", userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO list_blocked_games (curated_list_id, game_id, reason, blocked_by_user_id) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (curated_list_id, game_id) DO UPDATE SET reason = excluded.reason, blocked_by_user_id = excluded.blocked_by_user_id, created_at = datetime('now')`
    ).bind(listId, gameId, reason, userId),
    ...deleteSuggestionStatements(env, listId, gameId)
  ]);
}

/**
 * Drops this data centre's cached logged-out copy of a list page (and the lists index) after a change, so a visitor
 * nearby sees it on their next load. Other data centres catch up within PUBLIC_CACHE_SECONDS.
 */
// Marks a game on a list as played on stream (now) or clears it. Not in the mod log: it happens during every stream.
app.put("/api/lists/:id/items/:gameId/played", async (c) => {
  const listId = c.req.param("id");
  if (!(await playedOnStreamFor(c.env, c.get("user")))) {
    return c.json({ error: "Played on stream is off for everyone but admins.", code: "disabled" }, 403);
  }
  const auth = await requireListEditor(c, listId);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = z.object({ played: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const lastPlayedAt = parsed.data.played ? new Date().toISOString() : null;
  const result = await c.env.DB.prepare("UPDATE curated_list_items SET last_played_at = ?1 WHERE curated_list_id = ?2 AND game_id = ?3")
    .bind(lastPlayedAt, listId, c.req.param("gameId"))
    .run();
  if (!result.meta.changes) {
    return c.json({ error: "Game not on this list" }, 404);
  }
  await purgeListPageCache(c, listId);
  return c.json({ ok: true, lastPlayedAt });
});

// Now playing: the game a creator is on. Public read (no-store, ~10s KV cache inside), editor write.
app.get("/api/lists/:slug/now-playing", async (c) => {
  const user = c.get("user");
  const result = await readNowPlaying(c.env, c.req.param("slug"), async (list) =>
    canViewList(list.visibility as "public" | "private", list.owner_user_id, user, { listTwitchUserId: list.twitch_user_id, userTwitchId: await getUserTwitchId(c.env, user) })
  );
  if (!result) {
    return c.json({ error: "Not found" }, 404, { "Cache-Control": "no-store" });
  }
  return c.json(result, 200, { "Cache-Control": "no-store" });
});

app.put("/api/lists/:id/now-playing", async (c) => {
  const listId = c.req.param("id");
  const auth = await requireListEditor(c, listId);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = z.object({ gameId: z.string().min(1).max(64).nullable() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const rate = await enforceRateLimit(c.env, `now-playing:${auth.id}`, 300, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const list = await c.env.DB.prepare("SELECT slug FROM curated_lists WHERE id = ?1").bind(listId).first<{ slug: string }>();
  if (!list) {
    return c.json({ error: "Not found" }, 404);
  }
  const gameId = parsed.data.gameId;
  let title: string | null = null;
  if (gameId) {
    const fandleLimits = await getFandleLimits(c.env);
    if (!(await gameInList(c.env, listId, gameId, fandleActiveSql("fm", fandleLimits.membershipDays)))) {
      return c.json({ error: "Game is not on this list" }, 400);
    }
    title = (await c.env.DB.prepare("SELECT title FROM games WHERE id = ?1").bind(gameId).first<{ title: string }>())?.title ?? null;
    if (!title) {
      return c.json({ error: "Game is not on this list" }, 400);
    }
  }
  const at = gameId ? new Date().toISOString() : null;
  await c.env.DB.prepare("UPDATE curated_lists SET now_playing_game_id = ?1, now_playing_at = ?2 WHERE id = ?3").bind(gameId, at, listId).run();
  await c.env.CACHE.delete(nowPlayingKey(list.slug)).catch(() => undefined);
  if (gameId) await recordPlay(c.env, listId, gameId).catch(() => undefined);
  return c.json(resolveNowPlaying({ gameId, title, at }));
});

// Stream history: editors (owner, Twitch-tagged user, staff) remove one entry or all of them.
app.delete("/api/lists/:id/history/:entryId", async (c) => {
  const listId = c.req.param("id");
  const auth = await requireListEditor(c, listId);
  if (auth instanceof Response) return auth;
  const entryId = Number(c.req.param("entryId"));
  if (!Number.isSafeInteger(entryId) || entryId < 1) return c.json({ error: "Invalid id" }, 400);
  const result = await c.env.DB.prepare("DELETE FROM list_play_history WHERE id = ?1 AND list_id = ?2").bind(entryId, listId).run();
  if (!result.meta.changes) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/lists/:id/history", async (c) => {
  const listId = c.req.param("id");
  const auth = await requireListEditor(c, listId);
  if (auth instanceof Response) return auth;
  const result = await c.env.DB.prepare("DELETE FROM list_play_history WHERE list_id = ?1").bind(listId).run();
  return c.json({ ok: true, deleted: result.meta.changes ?? 0 });
});

async function purgeListPageCache(c: Context<{ Bindings: Env; Variables: AppVariables }>, listId: string): Promise<void> {
  if (isDevEnv(c.env)) return;
  const row = await c.env.DB.prepare("SELECT slug FROM curated_lists WHERE id = ?1").bind(listId).first<{ slug: string }>();
  for (const path of [row ? `/lists/${row.slug}` : null, "/lists"]) {
    if (!path) continue;
    const url = new URL(path, c.req.url);
    url.searchParams.set("__v", appVersion(c.env));
    c.executionCtx.waitUntil(caches.default.delete(new Request(url.toString())));
  }
}

/** purgeListPageCache for every public list, for site-wide changes (Played on stream). Only the bare list URLs are keyed. */
async function purgeAllListPageCaches(c: Context<{ Bindings: Env; Variables: AppVariables }>): Promise<void> {
  if (isDevEnv(c.env)) return;
  const rows = await c.env.DB.prepare("SELECT slug FROM curated_lists WHERE visibility = 'public'").all<{ slug: string }>();
  for (const path of ["/lists", ...rows.results.map((row) => `/lists/${row.slug}`)]) {
    const url = new URL(path, c.req.url);
    url.searchParams.set("__v", appVersion(c.env));
    c.executionCtx.waitUntil(caches.default.delete(new Request(url.toString())));
  }
}

/** 'user:<id>' for a signed-in visitor, otherwise 'anon:<hashed IP>' (the anonymous game-vote key). */
async function getSuggestionVoterKey(c: Context<{ Bindings: Env; Variables: AppVariables }>): Promise<string> {
  const user = c.get("user");
  return user ? `user:${user.id}` : `anon:${await getAnonymousVoteKey(c)}`;
}

/** The list when the current visitor may see it (and so read and make suggestions), otherwise null. */
async function getViewableList(c: Context<{ Bindings: Env; Variables: AppVariables }>, listId: string): Promise<{ id: string; suggestionsEnabled: boolean } | null> {
  const user = c.get("user");
  const list = await c.env.DB.prepare("SELECT id, visibility, owner_user_id, twitch_user_id, suggestions_enabled FROM curated_lists WHERE id = ?1")
    .bind(listId)
    .first<{ id: string; visibility: "public" | "private"; owner_user_id: string; twitch_user_id: string | null; suggestions_enabled: number }>();
  if (!list || !canViewList(list.visibility, list.owner_user_id, user, { listTwitchUserId: list.twitch_user_id, userTwitchId: await getUserTwitchId(c.env, user) })) {
    return null;
  }
  return { id: list.id, suggestionsEnabled: list.suggestions_enabled === 1 };
}

const SUGGESTIONS_OFF_ERROR = "Suggestions are turned off for this list";

app.get("/api/lists/:id/suggestions", async (c) => {
  const list = await getViewableList(c, c.req.param("id"));
  if (!list) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!list.suggestionsEnabled) {
    return c.json({ enabled: false, suggestions: [] }, 200, { "Cache-Control": "no-store" });
  }
  return c.json({ enabled: true, suggestions: await getListSuggestions(c.env, list.id, await getSuggestionVoterKey(c)) }, 200, { "Cache-Control": "no-store" });
});

/** Open suggestions one person (account or anonymous visitor) may have on a single list. */
const MAX_OPEN_SUGGESTIONS_PER_PERSON = 20;

app.post("/api/lists/:id/suggestions", async (c) => {
  const user = c.get("user");
  const voterKey = await getSuggestionVoterKey(c);
  const list = await getViewableList(c, c.req.param("id"));
  if (!list) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!list.suggestionsEnabled) {
    return c.json({ error: SUGGESTIONS_OFF_ERROR, code: "disabled" }, 403);
  }
  const parsed = z.object({ gameId: z.string().uuid() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const gameId = parsed.data.gameId;
  const rate = await enforceRateLimit(c.env, `list-suggest:${voterKey}`, 30, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Too many suggestions. Try again later.", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const state = await c.env.DB.prepare(
    `SELECT games.title,
            EXISTS(SELECT 1 FROM curated_list_items WHERE curated_list_id = ?1 AND game_id = games.id) AS on_list,
            EXISTS(SELECT 1 FROM list_blocked_games WHERE curated_list_id = ?1 AND game_id = games.id) AS blocked,
            EXISTS(SELECT 1 FROM list_suggestions WHERE curated_list_id = ?1 AND game_id = games.id) AS suggested
     FROM games WHERE games.id = ?2 AND games.status = 'approved'`
  )
    .bind(list.id, gameId)
    .first<{ title: string; on_list: number; blocked: number; suggested: number }>();
  if (!state) {
    return c.json({ error: "Game not found" }, 404);
  }
  if (state.on_list) {
    return c.json({ error: `${state.title} is already on this list`, code: "on_list" }, 409);
  }
  if (state.blocked) {
    return c.json({ error: `${state.title} was removed from this list and can't be suggested again`, code: "blocked" }, 409);
  }
  // One person can't fill a list with suggestions: a limited number of open ones per list (agreeing with others' is unlimited).
  if (!state.suggested) {
    const open = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM list_suggestions
       WHERE curated_list_id = ?1 AND ((?2 IS NOT NULL AND suggested_by_user_id = ?2) OR (?3 IS NOT NULL AND suggested_by_anon_hash = ?3))`
    )
      .bind(list.id, user?.id ?? null, user ? null : voterKey.slice("anon:".length))
      .first<{ n: number }>();
    if ((open?.n ?? 0) >= MAX_OPEN_SUGGESTIONS_PER_PERSON) {
      return c.json({ error: `You already have ${MAX_OPEN_SUGGESTIONS_PER_PERSON} open suggestions on this list. Wait until some are added or dismissed.`, code: "limit" }, 429);
    }
  }
  // Suggesting a game that's already suggested counts as agreeing with it.
  const statements = [
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO list_suggestions (curated_list_id, game_id, suggested_by_user_id, suggested_by_anon_hash) VALUES (?1, ?2, ?3, ?4)"
    ).bind(list.id, gameId, user?.id ?? null, user ? null : voterKey.slice("anon:".length)),
    c.env.DB.prepare("INSERT OR IGNORE INTO list_suggestion_votes (curated_list_id, game_id, voter_key) VALUES (?1, ?2, ?3)").bind(list.id, gameId, voterKey)
  ];
  const [, vote] = await c.env.DB.batch(statements);
  const voteAdded = ((vote.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
  const result = !state.suggested ? "suggested" : voteAdded ? "voted" : "already_voted";
  await purgeListPageCache(c, list.id);
  return c.json({ ok: true, result, title: state.title, suggestions: await getListSuggestions(c.env, list.id, voterKey) });
});

// Agree (PUT) or take back agreement (DELETE) with a suggestion. Taking back the last vote withdraws the suggestion;
// unlike a dismissal, that doesn't stop the game being suggested again.
const setSuggestionVote = async (c: Context<{ Bindings: Env; Variables: AppVariables }>, agree: boolean) => {
  const voterKey = await getSuggestionVoterKey(c);
  const list = await getViewableList(c, c.req.param("id") ?? "");
  if (!list) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!list.suggestionsEnabled) {
    return c.json({ error: SUGGESTIONS_OFF_ERROR, code: "disabled" }, 403);
  }
  const gameId = c.req.param("gameId") ?? "";
  const rate = await enforceRateLimit(c.env, `list-suggest-vote:${voterKey}`, 120, 60 * 60);
  if (!rate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }
  const exists = await c.env.DB.prepare("SELECT 1 AS ok FROM list_suggestions WHERE curated_list_id = ?1 AND game_id = ?2").bind(list.id, gameId).first();
  if (!exists) {
    return c.json({ error: "That suggestion is no longer open", suggestions: await getListSuggestions(c.env, list.id, voterKey) }, 404);
  }
  let withdrawn = false;
  if (agree) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO list_suggestion_votes (curated_list_id, game_id, voter_key) VALUES (?1, ?2, ?3)")
      .bind(list.id, gameId, voterKey)
      .run();
  } else {
    const [, withdraw] = await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM list_suggestion_votes WHERE curated_list_id = ?1 AND game_id = ?2 AND voter_key = ?3").bind(list.id, gameId, voterKey),
      c.env.DB.prepare(
        `DELETE FROM list_suggestions WHERE curated_list_id = ?1 AND game_id = ?2
           AND NOT EXISTS (SELECT 1 FROM list_suggestion_votes WHERE curated_list_id = ?1 AND game_id = ?2)`
      ).bind(list.id, gameId)
    ]);
    withdrawn = ((withdraw.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
  }
  await purgeListPageCache(c, list.id);
  return c.json({ ok: true, withdrawn, suggestions: await getListSuggestions(c.env, list.id, voterKey) });
};
app.put("/api/lists/:id/suggestions/:gameId/vote", (c) => setSuggestionVote(c, true));
app.delete("/api/lists/:id/suggestions/:gameId/vote", (c) => setSuggestionVote(c, false));

// Moves a suggestion to the end of the list.
app.post("/api/lists/:id/suggestions/:gameId/accept", async (c) => {
  const listId = c.req.param("id");
  const gameId = c.req.param("gameId");
  const auth = await requireListEditor(c, listId);
  if (auth instanceof Response) {
    return auth;
  }
  const exists = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM list_suggestions JOIN games ON games.id = list_suggestions.game_id AND games.status = 'approved'
     WHERE list_suggestions.curated_list_id = ?1 AND list_suggestions.game_id = ?2`
  )
    .bind(listId, gameId)
    .first();
  if (!exists) {
    return c.json({ error: "That suggestion is no longer open", suggestions: await getListSuggestions(c.env, listId, `user:${auth.id}`) }, 404);
  }
  // One transaction: the position is read inside the INSERT, so two quick accepts can't collide, and the suggestion
  // is only cleared once the game is really on the list.
  const [insert] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO curated_list_items (curated_list_id, game_id, position, added_by_user_id)
       SELECT ?1, ?2, COALESCE(MAX(position), 0) + 1, ?3 FROM curated_list_items WHERE curated_list_id = ?1`
    ).bind(listId, gameId, auth.id),
    c.env.DB.prepare(
      `DELETE FROM list_blocked_games WHERE curated_list_id = ?1 AND game_id = ?2
         AND EXISTS (SELECT 1 FROM curated_list_items WHERE curated_list_id = ?1 AND game_id = ?2)`
    ).bind(listId, gameId),
    c.env.DB.prepare(
      `DELETE FROM list_suggestion_votes WHERE curated_list_id = ?1 AND game_id = ?2
         AND EXISTS (SELECT 1 FROM curated_list_items WHERE curated_list_id = ?1 AND game_id = ?2)`
    ).bind(listId, gameId),
    c.env.DB.prepare(
      `DELETE FROM list_suggestions WHERE curated_list_id = ?1 AND game_id = ?2
         AND EXISTS (SELECT 1 FROM curated_list_items WHERE curated_list_id = ?1 AND game_id = ?2)`
    ).bind(listId, gameId)
  ]);
  const onList = await c.env.DB.prepare("SELECT position FROM curated_list_items WHERE curated_list_id = ?1 AND game_id = ?2")
    .bind(listId, gameId)
    .first<{ position: number }>();
  if (!onList) {
    return c.json({ error: "Could not add it to the list. Try again.", suggestions: await getListSuggestions(c.env, listId, `user:${auth.id}`) }, 500);
  }
  if (((insert.meta as { changes?: number } | undefined)?.changes ?? 0) > 0) {
    await writeAudit(c.env, auth.id, "list", listId, "accept_suggestion", { gameId, position: onList.position });
  }
  await purgeListPageCache(c, listId);
  return c.json({ ok: true, suggestions: await getListSuggestions(c.env, listId, `user:${auth.id}`) });
});

// Dismisses a suggestion; the game can't be suggested for this list again.
app.delete("/api/lists/:id/suggestions/:gameId", async (c) => {
  const listId = c.req.param("id");
  const gameId = c.req.param("gameId");
  const auth = await requireListEditor(c, listId);
  if (auth instanceof Response) {
    return auth;
  }
  const exists = await c.env.DB.prepare("SELECT 1 AS ok FROM list_suggestions WHERE curated_list_id = ?1 AND game_id = ?2").bind(listId, gameId).first();
  if (exists) {
    await blockListGame(c.env, listId, gameId, "dismissed", auth.id);
    await writeAudit(c.env, auth.id, "list", listId, "dismiss_suggestion", { gameId });
    await purgeListPageCache(c, listId);
  }
  return c.json({ ok: true, suggestions: await getListSuggestions(c.env, listId, `user:${auth.id}`) });
});

app.get("/api/admin/submissions", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const status = (c.req.query("status") || "pending") as "pending" | "rejected" | "disabled" | "approved";
  const q = (c.req.query("q") || "").trim();
  const rows = q
    ? await c.env.DB.prepare(
        `SELECT id, title, slug, url, status, moderation_note, created_at, reset_basis, reset_time_minutes, reset_timezone
         FROM games
         WHERE status = ?1
           AND (title LIKE ?2 OR url LIKE ?2 OR description LIKE ?2)
         ORDER BY created_at DESC
         LIMIT 200`
      )
        .bind(status, `%${q}%`)
        .all()
    : await c.env.DB.prepare(
        "SELECT id, title, slug, url, status, moderation_note, created_at, reset_basis, reset_time_minutes, reset_timezone FROM games WHERE status = ?1 ORDER BY created_at DESC LIMIT 200"
      )
        .bind(status)
        .all();
  return c.json(rows);
});

const adminResetSchema = z.object({
  resetBasis: z.union([z.literal("local"), z.literal("server"), z.null()]).optional(),
  resetTime: z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? null : normalizeTimeInput(value)),
    z.union([z.string().regex(/^\d{2}:\d{2}$/), z.null()]).optional()
  ),
  resetTimezone: z.union([z.string().max(64), z.null()]).optional()
});

app.patch("/api/admin/games/:id/reset", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = adminResetSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }

  const resetBasis = parsed.data.resetBasis === undefined ? undefined : parsed.data.resetBasis;
  const resetTimeMinutes = parsed.data.resetTime === undefined ? undefined : parseResetTimeToMinutes(parsed.data.resetTime || undefined);
  if (parsed.data.resetTime !== undefined && parsed.data.resetTime !== null && resetTimeMinutes === null) {
    return c.json({ error: "Invalid reset time. Use HH:MM" }, 400);
  }

  const gameId = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT reset_basis, reset_time_minutes, reset_timezone FROM games WHERE id = ?1")
    .bind(gameId)
    .first<{ reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null }>();
  if (!existing) {
    return c.json({ error: "Not found" }, 404);
  }

  const nextBasis = resetBasis === undefined ? existing.reset_basis : resetBasis;
  const nextResetTime = resetTimeMinutes === undefined ? existing.reset_time_minutes : resetTimeMinutes;
  const requestedZone = parsed.data.resetTimezone === undefined ? existing.reset_timezone : parsed.data.resetTimezone;
  const nextZone = normalizeResetTimeZone(nextBasis, requestedZone);
  if (!nextZone.ok) {
    return c.json({ error: "Invalid time zone. Use an IANA name like America/New_York" }, 400);
  }
  await c.env.DB.prepare(
    "UPDATE games SET reset_basis = ?1, reset_time_minutes = ?2, reset_timezone = ?4, updated_at = datetime('now'), content_updated_at = datetime('now') WHERE id = ?3"
  )
    .bind(nextBasis, nextResetTime, gameId, nextZone.value)
    .run();
  await writeAudit(c.env, auth.id, "game", gameId, "update_reset", { resetBasis: nextBasis, resetTimeMinutes: nextResetTime, resetTimezone: nextZone.value });
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

const bulkGamesSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["approve", "reject", "disable", "restore"]),
  note: z.string().max(400).optional()
});

app.post("/api/admin/games/bulk", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = bulkGamesSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }

  const newlyApproved = await logGameEvents(c.env, auth.id, parsed.data.ids, parsed.data.action, parsed.data.note ? { note: parsed.data.note } : {});
  const statements = parsed.data.ids.map((gameId) => {
    if (parsed.data.action === "approve") {
      return c.env.DB.prepare(
        "UPDATE games SET status = 'approved', approved_at = datetime('now'), approved_by_user_id = ?1, updated_at = datetime('now'), content_updated_at = datetime('now') WHERE id = ?2"
      ).bind(auth.id, gameId);
    }
    if (parsed.data.action === "reject") {
      return c.env.DB.prepare("UPDATE games SET status = 'rejected', moderation_note = ?1, updated_at = datetime('now') WHERE id = ?2").bind(
        parsed.data.note || null,
        gameId
      );
    }
    if (parsed.data.action === "disable") {
      return c.env.DB.prepare("UPDATE games SET status = 'disabled', updated_at = datetime('now') WHERE id = ?1").bind(gameId);
    }
    return c.env.DB.prepare("UPDATE games SET status = 'approved', updated_at = datetime('now'), content_updated_at = datetime('now') WHERE id = ?1").bind(gameId);
  });

  await c.env.DB.batch(statements);
  if (parsed.data.action === "approve" || parsed.data.action === "restore") {
    for (const gameId of parsed.data.ids) {
      await updateGameScore(c.env, gameId);
    }
  }

  await invalidateGameCaches(c.env);
  c.executionCtx.waitUntil(queueNewGameAnnouncements(c.env, newlyApproved));
  return c.json({ ok: true, count: parsed.data.ids.length });
});

app.post("/api/admin/games/:id/approve", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  const newlyApproved = await logGameEvents(c.env, auth.id, [gameId], "approve");
  await c.env.DB.prepare(
    `UPDATE games
     SET status = 'approved', approved_at = datetime('now'), approved_by_user_id = ?1, updated_at = datetime('now'), content_updated_at = datetime('now')
     WHERE id = ?2`
  )
    .bind(auth.id, gameId)
    .run();
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
  c.executionCtx.waitUntil(queueNewGameAnnouncements(c.env, newlyApproved));
  return c.json({ ok: true });
});

app.post("/api/admin/games/:id/reject", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const note = z.object({ note: z.string().max(400).optional() }).safeParse(await c.req.json());
  if (!note.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const gameId = c.req.param("id");
  await logGameEvents(c.env, auth.id, [gameId], "reject", note.data.note ? { note: note.data.note } : {});
  await c.env.DB.prepare(
    "UPDATE games SET status = 'rejected', moderation_note = ?1, updated_at = datetime('now') WHERE id = ?2"
  )
    .bind(note.data.note || null, gameId)
    .run();
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.post("/api/admin/games/:id/disable", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  await logGameEvents(c.env, auth.id, [gameId], "disable");
  await c.env.DB.prepare("UPDATE games SET status = 'disabled', updated_at = datetime('now') WHERE id = ?1").bind(gameId).run();
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.post("/api/admin/games/:id/restore", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  await logGameEvents(c.env, auth.id, [gameId], "restore");
  await c.env.DB.prepare("UPDATE games SET status = 'approved', updated_at = datetime('now'), content_updated_at = datetime('now') WHERE id = ?1").bind(gameId).run();
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.get("/api/admin/reports", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const status = (c.req.query("status") || "open") as "open" | "resolved" | "dismissed";
  const q = (c.req.query("q") || "").trim();
  const rows = q
    ? await c.env.DB.prepare(
        `SELECT reports.id, reports.reason, reports.status, reports.note, reports.created_at, games.title
         FROM reports
         JOIN games ON games.id = reports.game_id
         WHERE reports.status = ?1
           AND (games.title LIKE ?2 OR reports.reason LIKE ?2 OR reports.note LIKE ?2)
         ORDER BY reports.created_at DESC
         LIMIT 200`
      )
        .bind(status, `%${q}%`)
        .all()
    : await c.env.DB.prepare(
        `SELECT reports.id, reports.reason, reports.status, reports.note, reports.created_at, games.title
         FROM reports
         JOIN games ON games.id = reports.game_id
         WHERE reports.status = ?1
         ORDER BY reports.created_at DESC
         LIMIT 200`
      )
        .bind(status)
        .all();
  return c.json(rows);
});

// Closing a "broken link" report restarts the checker's failure streak, otherwise the next run re-files it immediately.
function resetLinkFailCountStatement(env: Env, reportId: string): D1PreparedStatement {
  return env.DB.prepare(
    "UPDATE games SET link_fail_count = 0 WHERE id IN (SELECT game_id FROM reports WHERE id = ?1 AND reason = 'broken')"
  ).bind(reportId);
}

const bulkReportsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["resolve", "dismiss", "hide", "delete"])
});

// Hide (disable) or delete the games behind the given reports. Hiding also resolves every open report for
// those games; deleting cascades the reports away with the game.
async function applyGameActionForReports(env: Env, userId: string, reportIds: string[], action: "hide" | "delete"): Promise<number> {
  const placeholders = reportIds.map((_, i) => `?${i + 1}`).join(",");
  const found = await env.DB.prepare(`SELECT DISTINCT game_id FROM reports WHERE id IN (${placeholders})`)
    .bind(...reportIds)
    .all<{ game_id: string }>();
  const gameIds = found.results.map((row) => row.game_id);
  if (gameIds.length === 0) {
    return 0;
  }
  await logGameEvents(env, userId, gameIds, action === "hide" ? "disable" : "delete", { via: "report" });
  const statements: D1PreparedStatement[] = [];
  for (const gameId of gameIds) {
    if (action === "hide") {
      statements.push(
        env.DB.prepare("UPDATE games SET status = 'disabled', updated_at = datetime('now') WHERE id = ?1").bind(gameId),
        env.DB.prepare(
          "UPDATE reports SET status = 'resolved', resolved_by_user_id = ?1, resolved_at = datetime('now') WHERE game_id = ?2 AND status = 'open'"
        ).bind(userId, gameId)
      );
    } else {
      statements.push(env.DB.prepare("DELETE FROM games WHERE id = ?1").bind(gameId));
    }
  }
  await env.DB.batch(statements);
  await invalidateGameCaches(env);
  return gameIds.length;
}

app.post("/api/admin/reports/bulk", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = bulkReportsSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }

  if (parsed.data.action === "delete" && auth.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  if (parsed.data.action === "hide" || parsed.data.action === "delete") {
    const count = await applyGameActionForReports(c.env, auth.id, parsed.data.ids, parsed.data.action);
    return c.json({ ok: true, count });
  }

  const nextStatus = parsed.data.action === "resolve" ? "resolved" : "dismissed";
  const statements = parsed.data.ids.map((reportId) =>
    c.env.DB.prepare(
      "UPDATE reports SET status = ?1, resolved_by_user_id = ?2, resolved_at = datetime('now') WHERE id = ?3"
    ).bind(nextStatus, auth.id, reportId)
  );
  statements.push(...parsed.data.ids.map((reportId) => resetLinkFailCountStatement(c.env, reportId)));
  await c.env.DB.batch(statements);
  await writeAudit(c.env, auth.id, "report", "bulk", parsed.data.action, { count: parsed.data.ids.length });
  return c.json({ ok: true, count: parsed.data.ids.length });
});

app.post("/api/admin/reports/:id/resolve", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE reports SET status = 'resolved', resolved_by_user_id = ?1, resolved_at = datetime('now') WHERE id = ?2"
    ).bind(auth.id, c.req.param("id")),
    resetLinkFailCountStatement(c.env, c.req.param("id"))
  ]);
  await writeAudit(c.env, auth.id, "report", c.req.param("id"), "resolve", {});
  return c.json({ ok: true });
});

app.post("/api/admin/reports/:id/hide", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const count = await applyGameActionForReports(c.env, auth.id, [c.req.param("id")], "hide");
  return count === 0 ? c.json({ error: "Not found" }, 404) : c.json({ ok: true });
});

app.post("/api/admin/reports/:id/delete", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  if (auth.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  const count = await applyGameActionForReports(c.env, auth.id, [c.req.param("id")], "delete");
  return count === 0 ? c.json({ error: "Not found" }, 404) : c.json({ ok: true });
});

app.post("/api/admin/reports/:id/dismiss", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE reports SET status = 'dismissed', resolved_by_user_id = ?1, resolved_at = datetime('now') WHERE id = ?2"
    ).bind(auth.id, c.req.param("id")),
    resetLinkFailCountStatement(c.env, c.req.param("id"))
  ]);
  await writeAudit(c.env, auth.id, "report", c.req.param("id"), "dismiss", {});
  return c.json({ ok: true });
});

app.get("/api/admin/categories", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const rows = await c.env.DB.prepare("SELECT id, slug, name, description, is_active FROM categories ORDER BY name ASC").all();
  return c.json(rows);
});

const categorySchema = z.object({
  slug: z.string().min(2).max(60),
  name: z.string().min(2).max(60),
  description: z.string().max(300).optional(),
  isActive: z.boolean().optional()
});

app.post("/api/admin/categories", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = categorySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO categories (id, slug, name, description, is_active, created_by_user_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  )
    .bind(id, parsed.data.slug, parsed.data.name, parsed.data.description || null, parsed.data.isActive === false ? 0 : 1, auth.id)
    .run();
  await writeAudit(c.env, auth.id, "category", id, "create", parsed.data);
  return c.json({ id }, 201);
});

app.patch("/api/admin/categories/:id", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = categorySchema.partial().safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const existing = await c.env.DB.prepare("SELECT id, slug, name, description, is_active FROM categories WHERE id = ?1")
    .bind(c.req.param("id"))
    .first<{ id: string; slug: string; name: string; description: string | null; is_active: number }>();
  if (!existing) {
    return c.json({ error: "Not found" }, 404);
  }
  await c.env.DB.prepare(
    `UPDATE categories
     SET slug = ?1, name = ?2, description = ?3, is_active = ?4, updated_at = datetime('now')
     WHERE id = ?5`
  )
    .bind(
      parsed.data.slug || existing.slug,
      parsed.data.name || existing.name,
      parsed.data.description === undefined ? existing.description : parsed.data.description,
      parsed.data.isActive === undefined ? existing.is_active : parsed.data.isActive ? 1 : 0,
      c.req.param("id")
    )
    .run();
  // The category's name and description show on its games' pages.
  await c.env.DB.prepare("UPDATE games SET content_updated_at = datetime('now') WHERE id IN (SELECT game_id FROM game_categories WHERE category_id = ?1)").bind(c.req.param("id")).run();
  await writeAudit(c.env, auth.id, "category", c.req.param("id"), "update", parsed.data);
  return c.json({ ok: true });
});

app.delete("/api/admin/categories/:id", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const categoryId = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE games SET content_updated_at = datetime('now') WHERE id IN (SELECT game_id FROM game_categories WHERE category_id = ?1)").bind(categoryId),
    c.env.DB.prepare("DELETE FROM game_categories WHERE category_id = ?1").bind(categoryId),
    c.env.DB.prepare("DELETE FROM categories WHERE id = ?1").bind(categoryId)
  ]);
  await writeAudit(c.env, auth.id, "category", categoryId, "delete", {});
  return c.json({ ok: true });
});

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : notFoundPage(c)));

app.onError((error, c) => {
  console.error(JSON.stringify({ message: error.message, stack: error.stack, requestId: c.get("requestId") }));
  return c.json({ error: "Internal server error", requestId: c.get("requestId") }, 500);
});

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
    if (!env.DB_TRACE) return app.fetch(req, env, ctx);
    const trace = withDbTrace(env, req);
    const res = await app.fetch(req, trace.env, ctx);
    trace.done(res.status);
    return res;
  },
  scheduled: async (event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    // Every 15 minutes: push reminders only. The daily cron (15 8 * * *) runs the maintenance jobs below.
    if (event.cron === "*/15 * * * *") {
      ctx.waitUntil(runPushReminders(env).then(
        (r) => { if (r.checked > 0) console.log(JSON.stringify({ message: "push run", ...r })); },
        (error) => console.error(JSON.stringify({ message: "push run failed", error: String(error) }))
      ));
      return;
    }
    ctx.waitUntil(runLinkChecks(env));
    ctx.waitUntil(recalculateAllScores(env));
    ctx.waitUntil(runClaimRechecks(env));
    ctx.waitUntil(runDeveloperRoleMaintenance(env));
    // Backstop: anything the announcement alarm somehow left in the queue goes out with the daily run.
    ctx.waitUntil(flushAnnouncementQueue(env));
  }
};

/**
 * Times new-game announcements (one instance, "new-games"). Every queued approval pushes the alarm back to
 * ANNOUNCEMENT_QUIET_MS from now, capped at ANNOUNCEMENT_MAX_WAIT_MS after the first game of the batch, so a run of
 * approvals goes out as one message a few minutes after the last one. The queue itself lives in D1
 * (announcement_queue); this object only holds the timer. (A per-minute cron was tried first and never fired.)
 */
export class AnnouncementScheduler extends DurableObject<Env> {
  async schedule(): Promise<void> {
    const now = Date.now();
    let batchStart = await this.ctx.storage.get<number>("batchStart");
    if (batchStart === undefined) {
      batchStart = now;
      await this.ctx.storage.put("batchStart", batchStart);
    }
    await this.ctx.storage.setAlarm(Math.min(now + ANNOUNCEMENT_QUIET_MS, batchStart + ANNOUNCEMENT_MAX_WAIT_MS));
  }

  /** Starts the timer only if none is pending, so it never delays a batch that is already counting down. */
  async ensureScheduled(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.schedule();
  }

  async alarm(): Promise<void> {
    const result = await flushAnnouncementQueue(this.env);
    if (result === "empty") {
      await this.ctx.storage.delete("batchStart");
    } else {
      // "more": the queue held over 90 games, send the rest shortly. "retry": Discord failed, try again in a minute.
      await this.ctx.storage.setAlarm(Date.now() + (result === "more" ? 5_000 : 60_000));
    }
  }
}

// Max games checked per scheduled run (oldest-checked first). Each check costs up to 2 fetches + 1 D1 call,
// so this keeps a run under the Worker subrequest limit instead of silently failing the tail of the list.
const LINK_CHECK_BATCH_SIZE = 300;
const LINK_CHECK_TIMEOUT_MS = 10_000;
const LINK_CHECK_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; DailyGameListLinkChecker/1.0; +https://dailies.0x9.ca)",
  Accept: "text/html,application/xhtml+xml,*/*;q=0.8"
};

type LinkCheckResult = "ok" | "broken" | "unknown";

// Only a definitive "gone" counts as broken. Bot walls (401/403/429), 5xx and timeouts say nothing
// about whether the game is actually down, so they are "unknown" and leave the fail count alone.
async function checkLink(url: string): Promise<LinkCheckResult> {
  const attempt = async (method: "HEAD" | "GET"): Promise<LinkCheckResult> => {
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        headers: LINK_CHECK_HEADERS,
        signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS)
      });
      if (res.ok) return "ok";
      if (res.status === 404 || res.status === 410) return "broken";
      return "unknown";
    } catch (error) {
      // Timeouts are inconclusive; DNS/connection failures mean the site is really unreachable.
      return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "unknown" : "broken";
    }
  };

  // Some servers reject HEAD, so anything but "ok" gets confirmed with a GET.
  const head = await attempt("HEAD");
  return head === "ok" ? head : attempt("GET");
}

async function runLinkChecks(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, url, link_fail_count
     FROM games
     WHERE status = 'approved'
     ORDER BY COALESCE(last_checked_at, '1970-01-01') ASC
     LIMIT ?1`
  ).bind(LINK_CHECK_BATCH_SIZE).all<{ id: string; url: string; link_fail_count: number }>();

  for (const row of rows.results) {
    const result = await checkLink(row.url);

    if (result === "unknown") {
      await env.DB.prepare("UPDATE games SET last_checked_at = datetime('now') WHERE id = ?1").bind(row.id).run();
      continue;
    }

    if (result === "ok") {
      await env.DB.prepare(
        "UPDATE games SET link_fail_count = 0, last_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1"
      ).bind(row.id).run();
      continue;
    }

    const nextFailCount = row.link_fail_count + 1;
    await env.DB.prepare(
      "UPDATE games SET link_fail_count = ?1, last_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?2"
    ).bind(nextFailCount, row.id).run();

    if (nextFailCount >= 3) {
      const existingOpen = await env.DB.prepare(
        "SELECT id FROM reports WHERE game_id = ?1 AND reason = 'broken' AND status = 'open'"
      ).bind(row.id).first();
      if (!existingOpen) {
        const systemUserId = "00000000-0000-0000-0000-000000000001";
        await env.DB.prepare(
          "INSERT INTO reports (id, game_id, reported_by_user_id, reason, note) VALUES (?1, ?2, ?3, 'broken', ?4)"
        ).bind(crypto.randomUUID(), row.id, systemUserId, "Auto-report: link checker failed 3 times").run();
      }
    }
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits WHERE updated_at < datetime('now', '-2 days')"),
    env.DB.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')")
  ]);
  await invalidateGameCaches(env);
}

/** For a missing /games/<slug> ending in "-<8 hex>": the current slug of the one visible game with that id prefix, if it differs. */
async function findRenamedGameSlug(env: Env, slug: string, privileged: boolean, userId: string | null): Promise<string | null> {
  const match = /-([0-9a-f]{8})$/.exec(slug);
  if (!match) return null;
  const rows = await env.DB.prepare(
    `SELECT slug FROM games
     WHERE id LIKE ?1 AND (?2 = 1 OR status = 'approved' OR (status = 'pending' AND submitted_by_user_id = ?3))
     LIMIT 2`
  )
    .bind(`${match[1]}%`, privileged ? 1 : 0, userId)
    .all<{ slug: string }>();
  if (rows.results.length !== 1 || rows.results[0].slug === slug) return null;
  return rows.results[0].slug;
}

function uniqueSlug(title: string, id: string): string {
  const base = slugify(title) || "game";
  return `${base}-${id.slice(0, 8)}`;
}

function canViewList(
  visibility: "public" | "private",
  ownerUserId: string,
  user: AppUser | null,
  twitch?: { listTwitchUserId: string | null; userTwitchId: string | null }
): boolean {
  if (visibility === "public") {
    return true;
  }
  if (!user) {
    return false;
  }
  if (twitch?.listTwitchUserId && twitch.listTwitchUserId === twitch.userTwitchId) {
    return true;
  }
  return user.id === ownerUserId || user.role === "editor" || user.role === "admin";
}

/** The numeric Twitch user id linked to this account, or null (also null for logged-out users). */
async function getUserTwitchId(env: Env, user: AppUser | null): Promise<string | null> {
  if (!user) {
    return null;
  }
  const row = await env.DB.prepare("SELECT provider_user_id FROM oauth_accounts WHERE user_id = ?1 AND provider = 'twitch'")
    .bind(user.id)
    .first<{ provider_user_id: string }>();
  return row?.provider_user_id ?? null;
}

/**
 * Staff can always edit a list. The Twitch user a list is tagged with (matched by stable Twitch id, not
 * username) can edit its games, title and description.
 */
async function requireListEditor(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  listId: string
): Promise<AppUser | Response> {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  if (auth.role === "editor" || auth.role === "admin") {
    return auth;
  }
  const owns = await c.env.DB.prepare(
    `SELECT 1 AS ok
     FROM curated_lists
     JOIN oauth_accounts ON oauth_accounts.provider = 'twitch' AND oauth_accounts.provider_user_id = curated_lists.twitch_user_id
     WHERE curated_lists.id = ?1 AND oauth_accounts.user_id = ?2`
  )
    .bind(listId, auth.id)
    .first();
  if (owns || (await isCreatorListOwner(c.env, listId, auth.id))) {
    return auth;
  }
  return c.json({ error: "Forbidden" }, 403);
}

/** True when the list is this user's own creator list and they still qualify as a creator. */
async function isCreatorListOwner(env: Env, listId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM curated_lists JOIN users ON users.id = curated_lists.owner_user_id
     WHERE curated_lists.id = ?1 AND curated_lists.kind = 'creator' AND curated_lists.owner_user_id = ?2 AND users.creator_type IS NOT NULL`
  )
    .bind(listId, userId)
    .first();
  return !!row;
}

/** Resolves a Twitch username to its stable id and canonical login. null = no such user; throws if Twitch is unreachable. */
async function lookupTwitchUser(env: Env, login: string): Promise<{ id: string; login: string } | null> {
  const token = await getTwitchAppToken(env);
  if (!token) {
    throw new Error("twitch-unavailable");
  }
  const res = await fetch(`${(env.TWITCH_API_BASE || "https://api.twitch.tv/helix").replace(/\/+$/, "")}/users?login=${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": env.OAUTH_TWITCH_CLIENT_ID! }
  });
  if (res.status === 401) {
    await env.CACHE.delete("twitch:app_token");
  }
  if (!res.ok) {
    throw new Error("twitch-unavailable");
  }
  const user = ((await res.json()) as { data?: Array<{ id: string; login: string }> }).data?.[0];
  return user ? { id: user.id, login: user.login } : null;
}

const DISCORD_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 127.14 96.36" fill="currentColor" aria-hidden="true" focusable="false"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"/></svg>`;
const TWITCH_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/></svg>`;

// The list's own description when it has one; otherwise who picked it, how many games, and the first few by name.
function listMetaDescription(list: { title: string; description: string | null; twitch_login: string | null }, items: Array<{ title: string }>): string {
  if (list.description) return list.description;
  const names = items.slice(0, 3).map((item) => item.title);
  const sample = names.length > 0 ? `, including ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}` : "";
  return `${list.title}: ${items.length} daily game${items.length === 1 ? "" : "s"}${list.twitch_login ? ` picked by ${list.twitch_login} on Twitch` : ""}${sample}.`;
}

function renderVerifiedBadge(twitchLogin: string | null | undefined): string {
  return twitchLogin ? renderCheckBadge(`Verified: curated by Twitch user ${twitchLogin}`) : "";
}

async function enforceRateLimit(
  env: Env,
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<{ ok: boolean; retryAfterSeconds: number }> {
  // Fixed-window rate limiting in D1 keeps behavior deterministic across instances.
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  // One atomic upsert (a new window resets the count to 1) instead of a read followed by a write.
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count, updated_at) VALUES (?1, ?2, 1, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2,
       updated_at = datetime('now')
     RETURNING count`
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 1) > maxRequests) {
    return { ok: false, retryAfterSeconds: Math.max(1, windowStart + windowSeconds - now) };
  }
  return { ok: true, retryAfterSeconds: 0 };
}

async function getCategoriesForGames(
  env: Env,
  gameIds: string[]
): Promise<Map<string, Array<{ slug: string; name: string }>>> {
  const map = new Map<string, Array<{ slug: string; name: string }>>();
  if (gameIds.length === 0) {
    return map;
  }
  const uniqueIds = [...new Set(gameIds)];
  // D1 allows 100 bind parameters per statement, so look up in chunks (sent together, merged in order).
  const chunks: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += 90) chunks.push(uniqueIds.slice(i, i + 90));
  const results = await Promise.all(chunks.map((chunk) => {
    const placeholders = chunk.map((_id, index) => `?${index + 1}`).join(", ");
    return env.DB.prepare(
      `SELECT game_categories.game_id, categories.slug, categories.name
       FROM game_categories
       JOIN categories ON categories.id = game_categories.category_id
       WHERE game_categories.game_id IN (${placeholders})
       ORDER BY categories.name ASC`
    )
      .bind(...chunk)
      .all<{ game_id: string; slug: string; name: string }>();
  }));
  for (const rows of results) {
    for (const row of rows.results) {
      const list = map.get(row.game_id) ?? [];
      list.push({ slug: row.slug, name: row.name });
      map.set(row.game_id, list);
    }
  }
  return map;
}


function renderCategoryPills(categories: Array<{ slug: string; name: string }> | undefined, developer?: GameDeveloper | null): string {
  if ((!categories || categories.length === 0) && !developer) {
    return "";
  }
  return `<div class="category-pills">${(categories ?? []).map((cat) => renderCategoryPill(cat)).join("")}${developer ? renderDeveloperChip(developer) : ""}</div>`;
}

/** A game's verified developer. `handle` is set only when their profile is public (the chip links to it). */
type GameDeveloper = { handle: string | null; name: string };

/** Verified developers for a page's worth of games (at most one per game); only those with a public profile get a handle. */
async function getDevelopersForGames(env: Env, gameIds: string[]): Promise<Map<string, GameDeveloper>> {
  const result = new Map<string, GameDeveloper>();
  const ids = [...new Set(gameIds)];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 90) chunks.push(ids.slice(i, i + 90));
  const results = await Promise.all(chunks.map((chunk) =>
    env.DB.prepare(
      `SELECT game_claims.game_id,
              CASE WHEN users.profile_public = 1 THEN users.profile_handle END AS handle,
              COALESCE(users.display_name, CASE WHEN users.profile_public = 1 THEN users.profile_handle END, 'Developer') AS name
       FROM game_claims JOIN users ON users.id = game_claims.user_id
       WHERE game_claims.status = 'verified'
         AND game_claims.game_id IN (${chunk.map((_, index) => `?${index + 1}`).join(",")})`
    )
      .bind(...chunk)
      .all<{ game_id: string; handle: string | null; name: string }>()
  ));
  for (const rows of results) {
    for (const row of rows.results) result.set(row.game_id, { handle: row.handle, name: row.name });
  }
  return result;
}

/** A pill after a game's category pills: a link to the developer's profile, or plain text when their profile isn't public. */
function renderDeveloperChip(dev: GameDeveloper): string {
  const inner = `${CHECK_SVG}<span class="dev-pill-name">${escapeHtml(dev.name)}</span>`;
  if (!dev.handle) {
    return `<span class="tag category-pill dev-pill dev-pill-static" title="Verified developer: ${escapeHtml(dev.name)}">${inner}</span>`;
  }
  return `<a href="/u/${encodeURIComponent(dev.handle)}" class="tag category-pill dev-pill" title="Verified developer: ${escapeHtml(dev.name)}" aria-label="Verified developer: ${escapeHtml(dev.name)}">${inner}</a>`;
}

/** One coloured category pill linking to that category; the hue comes from the slug. A count, when given, follows the name. */
function renderCategoryPill(cat: { slug: string; name: string }, count?: number): string {
  const hue = categoryHue(cat.slug);
  const style = `color:hsl(${hue}, 65%, 28%); background:hsl(${hue}, 65%, 90%); border-color:hsl(${hue}, 55%, 72%);`;
  return `<a href="/categories/${encodeURIComponent(cat.slug)}" class="tag category-pill" style="${style}">${escapeHtml(cat.name)}${count === undefined ? "" : ` <span class="pill-count">${count}</span>`}</a>`;
}

// Typo-tolerant search fallback (src/lib/search.ts): every approved title with its filter fields, cached in KV.
const FUZZY_TITLES_KEY = "games:fuzzy-titles:v1";
const FUZZY_MAX_RESULTS = 12;
type FuzzyTitleEntry = { id: string; title: string; paywall: boolean; nsfw: boolean; categories: string[] };

async function loadFuzzyTitleIndex(env: Env): Promise<FuzzyTitleEntry[]> {
  const cached = await getCachedJson<FuzzyTitleEntry[]>(env, FUZZY_TITLES_KEY);
  if (cached) return cached;
  const games = await env.DB.prepare("SELECT id, title, paywall, nsfw FROM games WHERE status = 'approved'").all<{
    id: string;
    title: string;
    paywall: number;
    nsfw: number;
  }>();
  const links = await env.DB.prepare(
    `SELECT game_categories.game_id AS game_id, categories.slug AS slug
     FROM game_categories
     JOIN categories ON categories.id = game_categories.category_id
     JOIN games ON games.id = game_categories.game_id
     WHERE games.status = 'approved'`
  ).all<{ game_id: string; slug: string }>();
  const slugsByGame = new Map<string, string[]>();
  for (const link of links.results) {
    const list = slugsByGame.get(link.game_id) ?? [];
    list.push(link.slug);
    slugsByGame.set(link.game_id, list);
  }
  const index = games.results.map((row) => ({
    id: row.id,
    title: row.title,
    paywall: !!row.paywall,
    nsfw: !!row.nsfw,
    categories: slugsByGame.get(row.id) ?? []
  }));
  await setCachedJson(env, FUZZY_TITLES_KEY, index, 600);
  return index;
}

/** Best fuzzy title matches for a search, skipping exact results and applying the same filters as the search. */
async function findSimilarGameIds(
  env: Env,
  query: string,
  filters: { category?: string; hidePaywall: boolean; hideNsfw: boolean },
  exactIds: Set<string>
): Promise<{ ids: string[]; strongest: boolean }> {
  const index = await loadFuzzyTitleIndex(env);
  const scored: Array<{ id: string; title: string; score: number; strong: boolean }> = [];
  for (const entry of index) {
    if (exactIds.has(entry.id)) continue;
    if (filters.category && !entry.categories.includes(filters.category)) continue;
    if (filters.hidePaywall && entry.paywall) continue;
    if (filters.hideNsfw && entry.nsfw) continue;
    const match = fuzzyTitleMatch(query, entry.title);
    if (match) scored.push({ id: entry.id, title: entry.title, score: match.score, strong: match.strong });
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const top = scored.slice(0, FUZZY_MAX_RESULTS);
  return { ids: top.map((match) => match.id), strongest: top[0]?.strong ?? false };
}

type ListGamesOpts = {
    sort: "top" | "new" | "trending" | "popular" | "reset";
    category?: string;
    q?: string;
    limit: number;
    offset?: number;
    /** With sort "popular": only games opened at least once in the last 7 days. */
    openedThisWeek?: boolean;
    hidePaywall?: boolean;
    hideNsfw?: boolean;
    /** Only games listed (approved) within this many days. */
    listedWithinDays?: number;
    /** Only games this user is the verified developer of. */
    developerUserId?: string;
    /** Only these games (at most ~50; used for the typo-tolerant search results). */
    ids?: string[];
    /** Only the Fan-dles of this creator list: games of its current members, a few per developer, minus hidden ones. */
    fandleListId?: string;
    /** With fandleListId: most games per developer (none = no limit). */
    fandlePerDeveloper?: number | null;
    /** With fandleListId: how many days a check counts (none = always). */
    fandleMembershipDays?: number | null;
};

type ListedGame = {
  id: string;
  title: string;
  slug: string;
  url: string;
  description: string | null;
  score: number;
  voteUpCount: number;
  voteDownCount: number;
  resetBasis: "local" | "server" | null;
  resetTimeMinutes: number | null;
  resetTimezone: string | null;
  paywall: boolean;
  nsfw: boolean;
  categories: Array<{ slug: string; name: string }>;
  developer: GameDeveloper | null;
  listedAt: string;
};

type ListGameRow = {
  id: string;
  title: string;
  slug: string;
  url: string;
  description: string | null;
  score: number;
  vote_up_count: number;
  vote_down_count: number;
  reset_basis: "local" | "server" | null;
  reset_time_minutes: number | null;
  reset_timezone: string | null;
  paywall: number;
  nsfw: number;
  listed_at: string;
};

async function listGames(env: Env, opts: ListGamesOpts): Promise<ListedGame[]> {
  const [games] = await listGamesMany(env, [opts]);
  return games;
}

/** Several listGames queries at once: the game rows run in parallel, then categories and developers are looked up once for all of them. */
async function listGamesMany(env: Env, optsList: ListGamesOpts[]): Promise<ListedGame[][]> {
  const rowSets = await Promise.all(optsList.map((opts) => listGameRows(env, opts)));
  const allIds = [...new Set(rowSets.flatMap((rows) => rows.map((row) => row.id)))];
  const [categoriesByGameId, developersByGameId] = await Promise.all([
    getCategoriesForGames(env, allIds),
    getDevelopersForGames(env, allIds)
  ]);
  return rowSets.map((rows) =>
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      url: row.url,
      description: row.description,
      score: row.score,
      voteUpCount: row.vote_up_count,
      voteDownCount: row.vote_down_count,
      resetBasis: row.reset_basis,
      resetTimeMinutes: row.reset_time_minutes,
      resetTimezone: row.reset_timezone,
      paywall: !!row.paywall,
      nsfw: !!row.nsfw,
      categories: categoriesByGameId.get(row.id) ?? [],
      developer: developersByGameId.get(row.id) ?? null,
      listedAt: row.listed_at
    }))
  );
}

async function listGameRows(env: Env, opts: ListGamesOpts): Promise<ListGameRow[]> {
  // Server-time resets are stored in their own time zone; convert to UTC using each zone's current offset.
  let resetOffsetSql = "0";
  const sortParams: Array<string | number> = [];
  if (opts.sort === "reset") {
    const zones = await env.DB.prepare(
      "SELECT DISTINCT reset_timezone AS tz FROM games WHERE reset_basis = 'server' AND reset_timezone IS NOT NULL LIMIT 50"
    ).all<{ tz: string }>();
    if (zones.results.length > 0) {
      const whens = zones.results.map((zone) => {
        sortParams.push(zone.tz);
        return `WHEN ? THEN ${Math.trunc(timeZoneOffsetMinutes(zone.tz))}`;
      });
      resetOffsetSql = `CASE WHEN games.reset_basis = 'server' THEN CASE games.reset_timezone ${whens.join(" ")} ELSE 0 END ELSE 0 END`;
    }
  }
  const sortSql =
    opts.sort === "new"
      ? "games.created_at DESC"
      : opts.sort === "trending"
      ? // 10+ opens in the last 7 days qualify and rank by (last7+5)/(prev7+5); the rest keep the old recency order.
        "CASE WHEN COALESCE(cd.last7, 0) >= 10 THEN 0 ELSE 1 END ASC, CASE WHEN COALESCE(cd.last7, 0) >= 10 THEN (cd.last7 + 5.0) / (COALESCE(cd.prev7, 0) + 5.0) END DESC, games.updated_at DESC, games.score DESC"
      : opts.sort === "popular"
      ? "COALESCE(cd.last7, 0) DESC, games.score DESC, games.vote_up_count DESC"
      : opts.sort === "reset"
      ? `CASE WHEN games.reset_time_minutes IS NULL THEN 1 ELSE 0 END ASC,
         CASE
           WHEN games.reset_time_minutes IS NULL THEN 9999
           ELSE ((((games.reset_time_minutes - (${resetOffsetSql}) - ((CAST(strftime('%H','now') AS INTEGER) * 60) + CAST(strftime('%M','now') AS INTEGER))) % 1440) + 1440) % 1440)
         END ASC,
         games.title ASC`
      : "games.score DESC, games.vote_up_count DESC";

  // One aggregate over game_click_days (US/Eastern day buckets, like the recorder): last 7 days and the 7 before.
  const usesClicks = opts.sort === "trending" || opts.sort === "popular";
  const params: Array<string | number> = [];
  let clicksJoinSql = "";
  if (usesClicks) {
    const easternDay = (offset: number) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - offset * 86400000));
    const start7 = easternDay(6);
    clicksJoinSql = `LEFT JOIN (
      SELECT game_id, SUM(CASE WHEN day >= ? THEN clicks ELSE 0 END) AS last7, SUM(CASE WHEN day < ? THEN clicks ELSE 0 END) AS prev7
      FROM game_click_days INDEXED BY idx_game_click_days_day WHERE day >= ? GROUP BY game_id
    ) cd ON cd.game_id = games.id`;
    params.push(start7, start7, opts.sort === "popular" ? start7 : easternDay(13));
  }
  let whereSql = "WHERE games.status = 'approved'";

  if (opts.category) {
    whereSql += " AND categories.slug = ?";
    params.push(opts.category);
  }
  if (opts.q) {
    whereSql += " AND (games.title LIKE ? OR games.description LIKE ?)";
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  if (opts.hidePaywall) {
    whereSql += " AND games.paywall = 0";
  }
  if (opts.hideNsfw) {
    whereSql += " AND games.nsfw = 0";
  }
  if (opts.openedThisWeek && opts.sort === "popular") {
    whereSql += " AND COALESCE(cd.last7, 0) > 0";
  }
  if (opts.listedWithinDays) {
    whereSql += ` AND datetime(COALESCE(games.approved_at, games.created_at)) >= datetime('now', '-${Math.trunc(opts.listedWithinDays)} days')`;
  }
  if (opts.developerUserId) {
    whereSql += " AND games.id IN (SELECT game_id FROM game_claims WHERE user_id = ? AND status = 'verified')";
    params.push(opts.developerUserId);
  }
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    whereSql += ` AND games.id IN (${opts.ids.map(() => "?").join(", ")})`;
    params.push(...opts.ids);
  }
  if (opts.fandleListId) {
    whereSql += ` AND games.id IN (
      SELECT game_id FROM (
        SELECT gc.game_id AS game_id, ROW_NUMBER() OVER (PARTITION BY fm.user_id ORDER BY g2.score DESC) AS rn
        FROM fandle_members fm
        JOIN game_claims gc ON gc.user_id = fm.user_id AND gc.status = 'verified'
        JOIN games g2 ON g2.id = gc.game_id AND g2.status = 'approved'
        WHERE fm.list_id = ? AND ${fandleActiveSql("fm", opts.fandleMembershipDays ?? null)}
          AND gc.game_id NOT IN (SELECT game_id FROM fandle_hidden WHERE list_id = ?)
      )${opts.fandlePerDeveloper && Number.isInteger(opts.fandlePerDeveloper) ? ` WHERE rn <= ${opts.fandlePerDeveloper}` : ""}
    )`;
    params.push(opts.fandleListId, opts.fandleListId);
  }

  params.push(...sortParams, opts.limit, opts.offset || 0);

  const sql = `
    SELECT DISTINCT games.id, games.title, games.slug, games.url, games.description,
           games.score, games.vote_up_count, games.vote_down_count,
           games.reset_basis, games.reset_time_minutes, games.reset_timezone, games.paywall, games.nsfw,
           COALESCE(games.approved_at, games.created_at) AS listed_at
    FROM games
    LEFT JOIN game_categories ON games.id = game_categories.game_id
    LEFT JOIN categories ON categories.id = game_categories.category_id
    ${clicksJoinSql}
    ${whereSql}
    ORDER BY ${sortSql}, games.id ASC
    LIMIT ?
    OFFSET ?
  `;

  const rows = await env.DB.prepare(sql)
    .bind(...params)
    .all<ListGameRow>();
  return rows.results;
}

// Adds approved games to a user's favorites in a fixed number of queries (ids travel as one JSON
// array, so D1's bound-parameter limit doesn't apply). Already-favorited and unknown ids are skipped.
async function importFavoriteIds(env: Env, userId: string, ids: string[]): Promise<number> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const fresh = await env.DB.prepare(
    `SELECT g.id AS id FROM games g
     WHERE g.status = 'approved' AND g.id IN (SELECT value FROM json_each(?1))
       AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.user_id = ?2 AND f.game_id = g.id)`
  )
    .bind(JSON.stringify(unique), userId)
    .all<{ id: string }>();
  const order = new Map(unique.map((id, i) => [id, i]));
  const toAdd = fresh.results.map((r) => r.id).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  if (toAdd.length === 0) return 0;
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO favorites (user_id, game_id, position)
     SELECT ?1, j.value, (SELECT COALESCE(MAX(position), 0) FROM favorites WHERE user_id = ?1) + j.key + 1
     FROM json_each(?2) j`
  )
    .bind(userId, JSON.stringify(toAdd))
    .run();
  const imported = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (imported > 0) {
    await updateGameScores(env, toAdd);
    await invalidateGameCaches(env);
  }
  return imported;
}

// Same formula as updateGameScore, for many games in 2 queries.
async function updateGameScores(env: Env, gameIds: string[]): Promise<void> {
  if (gameIds.length === 0) return;
  const rows = await env.DB.prepare(
    `SELECT games.id, games.vote_up_count, games.vote_down_count, games.report_count, games.created_at, games.click_count,
            (SELECT COUNT(*) FROM favorites WHERE game_id = games.id) AS favorite_count_user,
            (SELECT COUNT(*) FROM anonymous_favorites WHERE game_id = games.id) AS favorite_count_anon,
            (SELECT COUNT(*) FROM curated_list_items WHERE game_id = games.id) AS list_count
     FROM games WHERE games.id IN (SELECT value FROM json_each(?1))`
  )
    .bind(JSON.stringify(gameIds))
    .all<{
      id: string; vote_up_count: number; vote_down_count: number; report_count: number; created_at: string;
      click_count: number; favorite_count_user: number; favorite_count_anon: number; list_count: number;
    }>();
  const scores = rows.results.map((row) => ({
    id: row.id,
    s: computeGameScore({
      upVotes: row.vote_up_count,
      downVotes: row.vote_down_count,
      reportCount: row.report_count,
      favoriteCount: (row.favorite_count_user || 0) + (row.favorite_count_anon || 0),
      clickCount: row.click_count || 0,
      listCount: row.list_count || 0,
      createdAtIso: row.created_at
    })
  }));
  if (scores.length === 0) return;
  await env.DB.prepare(
    `UPDATE games SET score = j.s, updated_at = datetime('now')
     FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.s') AS s FROM json_each(?1)) j
     WHERE games.id = j.id`
  )
    .bind(JSON.stringify(scores))
    .run();
}

async function updateGameScore(env: Env, gameId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT games.vote_up_count, games.vote_down_count, games.report_count, games.created_at, games.click_count,
            (SELECT COUNT(*) FROM favorites WHERE game_id = games.id) AS favorite_count_user,
            (SELECT COUNT(*) FROM anonymous_favorites WHERE game_id = games.id) AS favorite_count_anon,
            (SELECT COUNT(*) FROM curated_list_items WHERE game_id = games.id) AS list_count
     FROM games
     WHERE games.id = ?1`
  )
    .bind(gameId)
    .first<{
      vote_up_count: number;
      vote_down_count: number;
      report_count: number;
      created_at: string;
      click_count: number;
      favorite_count_user: number;
      favorite_count_anon: number;
      list_count: number;
    }>();
  if (!row) {
    return;
  }
  const score = computeGameScore({
    upVotes: row.vote_up_count,
    downVotes: row.vote_down_count,
    reportCount: row.report_count,
    favoriteCount: (row.favorite_count_user || 0) + (row.favorite_count_anon || 0),
    clickCount: row.click_count || 0,
    listCount: row.list_count || 0,
    createdAtIso: row.created_at
  });
  await env.DB.prepare("UPDATE games SET score = ?1, updated_at = datetime('now') WHERE id = ?2").bind(score, gameId).run();
}

async function recalculateAllScores(env: Env): Promise<void> {
  const games = await env.DB.prepare("SELECT id FROM games WHERE status = 'approved'").all<{ id: string }>();
  for (const game of games.results) {
    await updateGameScore(env, game.id);
  }
}

type GameEventAction =
  | "approve" | "reject" | "disable" | "restore" | "delete"
  | "nsfw_add" | "nsfw_remove" | "paywall_add" | "paywall_remove";

const GAME_STATUS_FOR_ACTION: Record<string, string> = { approve: "approved", restore: "approved", reject: "rejected", disable: "disabled" };

/**
 * Writes per-game moderation events to audit_log (the source for the public /mod-log page).
 * Status actions must be logged BEFORE the change is applied: current rows are read to skip no-ops,
 * snapshot the title (so deleted games stay named), and label an approval of a hidden game as "restore".
 */
async function logGameEvents(
  env: Env,
  actorUserId: string,
  gameIds: string[],
  action: "approve" | "reject" | "disable" | "restore" | "delete",
  extra: Record<string, unknown> = {}
): Promise<string[]> {
  const ids = [...new Set(gameIds)];
  // Games going public for the first time (pending or rejected -> approved), not restores of disabled ones.
  const newlyApproved: string[] = [];
  const target = GAME_STATUS_FOR_ACTION[action];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(",");
    const rows = await env.DB.prepare(`SELECT id, title, slug, status FROM games WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string; title: string; slug: string; status: string }>();
    for (const row of rows.results) {
      if (target && row.status === target) {
        continue;
      }
      const label = target === "approved" ? (row.status === "disabled" ? "restore" : "approve") : action;
      if (label === "approve") newlyApproved.push(row.id);
      statements.push(
        env.DB.prepare(
          "INSERT INTO audit_log (id, actor_user_id, entity_type, entity_id, action, metadata_json) VALUES (?1, ?2, 'game', ?3, ?4, ?5)"
        ).bind(crypto.randomUUID(), actorUserId, row.id, label, JSON.stringify({ title: row.title, slug: row.slug, ...extra }))
      );
    }
  }
  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
  return newlyApproved;
}

// New-game announcements are batched: approvals queue the game and set the AnnouncementScheduler alarm, which posts
// the whole queue as one message 3 minutes after the last approval (at most 15 minutes after the first).
const ANNOUNCEMENT_QUIET_MS = 3 * 60 * 1000;
const ANNOUNCEMENT_MAX_WAIT_MS = 15 * 60 * 1000;

async function queueNewGameAnnouncements(env: Env, gameIds: string[]): Promise<void> {
  // Without a webhook (staging, dev) nothing would ever send them, so don't let the queue grow.
  if (!env.DISCORD_NEW_GAME_WEBHOOK_URL || !env.DISCORD_ROLE_DLE_ENJOYER || gameIds.length === 0) return;
  const insert = env.DB.prepare("INSERT OR IGNORE INTO announcement_queue (game_id) VALUES (?1)");
  await env.DB.batch([...new Set(gameIds)].map((id) => insert.bind(id)));
  await env.ANNOUNCER.get(env.ANNOUNCER.idFromName("new-games")).schedule();
}

async function resumeQueuedAnnouncements(env: Env): Promise<void> {
  if (!env.DISCORD_NEW_GAME_WEBHOOK_URL || !env.DISCORD_ROLE_DLE_ENJOYER) return;
  try {
    const queued = await env.DB.prepare("SELECT 1 FROM announcement_queue LIMIT 1").first();
    if (queued) await env.ANNOUNCER.get(env.ANNOUNCER.idFromName("new-games")).ensureScheduled();
  } catch (error) {
    console.error(JSON.stringify({ message: "resume announcements failed", error: String(error) }));
  }
}

/** Sends up to 90 queued games (D1's bind limit) as one announcement. */
async function flushAnnouncementQueue(env: Env): Promise<"empty" | "more" | "retry"> {
  const queued = await env.DB.prepare("SELECT game_id FROM announcement_queue ORDER BY queued_at LIMIT 91").all<{ game_id: string }>();
  if (queued.results.length === 0) return "empty";
  const ids = queued.results.slice(0, 90).map((row) => row.game_id);
  const sent = await announceNewGames(env, ids);
  if (!sent) {
    // Keep them for a retry, but give up on anything Discord has refused for an hour.
    const dropped = await env.DB.prepare("DELETE FROM announcement_queue WHERE queued_at < datetime('now', '-60 minutes')").run();
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM announcement_queue").first<{ n: number }>();
    if (dropped.meta.changes > 0) console.error(JSON.stringify({ message: "discord announcements dropped after an hour", count: dropped.meta.changes }));
    return (remaining?.n ?? 0) > 0 ? "retry" : "empty";
  }
  await env.DB.prepare(`DELETE FROM announcement_queue WHERE game_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`).bind(...ids).run();
  return queued.results.length > 90 ? "more" : "empty";
}

/**
 * Posts games to the Discord #dailies channel through its webhook, pinging @Dle Enjoyer (called by
 * flushAnnouncementQueue). Never throws; returns false when nothing was sent, so the caller can retry. Does nothing
 * unless DISCORD_NEW_GAME_WEBHOOK_URL and DISCORD_ROLE_DLE_ENJOYER are set (only production has the webhook). All the
 * games go in one message, split at Discord's length limit.
 */
async function announceNewGames(env: Env, gameIds: string[]): Promise<boolean> {
  const webhookUrl = env.DISCORD_NEW_GAME_WEBHOOK_URL;
  const roleId = env.DISCORD_ROLE_DLE_ENJOYER;
  if (!webhookUrl || !roleId || gameIds.length === 0) return true;
  try {
    // Read after the status update, so titles and slugs are final and only games still approved are announced.
    const ids = [...new Set(gameIds)].slice(0, 90);
    const rows = await env.DB.prepare(
      `SELECT title, slug, nsfw FROM games WHERE status = 'approved' AND id IN (${ids.map((_, i) => `?${i + 1}`).join(",")}) ORDER BY title`
    )
      .bind(...ids)
      .all<{ title: string; slug: string; nsfw: number }>();
    if (rows.results.length === 0) return true;
    // Game titles are user-submitted: escape Discord markdown so they render literally.
    const name = (game: { title: string; nsfw: number }) =>
      `**${game.title.replace(/[\\*_~`|>]/g, "\\$&").replace(/\s+/g, " ").trim()}**${game.nsfw ? " (NSFW)" : ""}`;
    const link = (game: { slug: string }) => `${env.APP_URL}/games/${encodeURIComponent(game.slug)}`;
    const ping = `<@&${roleId}>`;
    const messages: string[] = [];
    if (rows.results.length === 1) {
      const game = rows.results[0];
      messages.push(`${ping} New game: ${name(game)}\n${link(game)}`);
    } else {
      let current = `${ping} New games:`;
      for (const game of rows.results) {
        const line = `\n- ${name(game)}: ${link(game)}`;
        if (current.length + line.length > 1900) {
          messages.push(current);
          current = "More new games:";
        }
        current += line;
      }
      messages.push(current);
    }
    let sentCount = 0;
    for (const content of messages) {
      let ok = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Only the Dle Enjoyer role may be pinged, whatever a title contains.
          body: JSON.stringify({ content, allowed_mentions: { parse: [], roles: [roleId] } }),
          signal: AbortSignal.timeout(5000)
        });
        if (response.status === 429 && attempt === 0) {
          const retryAfter = Number(((await response.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1);
          await new Promise((resolve) => setTimeout(resolve, Math.min(5, Math.max(0.5, retryAfter)) * 1000));
          continue;
        }
        ok = response.ok;
        if (!ok) {
          console.error(JSON.stringify({ message: "discord announcement failed", status: response.status }));
        }
        break;
      }
      if (!ok) break;
      sentCount++;
    }
    // Nothing went out: worth retrying. Part of a multi-message batch went out: retrying would repeat it, so don't.
    return sentCount > 0;
  } catch (error) {
    console.error(JSON.stringify({ message: "discord announcement failed", error: String(error) }));
    return false;
  }
}

/** Emails the site owner about a new submission. Best-effort: failures are logged and never affect the submission. */
async function notifyNewSubmission(
  env: Env,
  game: { title: string; url: string; description: string | null; status: "approved" | "pending"; submitter: string; slug: string }
): Promise<void> {
  if (!env.EMAIL || !env.NOTIFY_EMAIL_TO || !env.NOTIFY_EMAIL_FROM) {
    return;
  }
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  const prefix = env.APP_ENV === "production" ? "" : `[${env.APP_ENV}] `;
  const moderateUrl = `${env.APP_URL}/admin/submissions`;
  const lines = [
    `Title: ${oneLine(game.title)}`,
    `URL: ${game.url}`,
    `Description: ${game.description ? oneLine(game.description) : "(none)"}`,
    `Status: ${game.status}`,
    `Submitted by: ${oneLine(game.submitter)}`,
    "",
    game.status === "pending" ? `Review it: ${moderateUrl}` : `Auto-approved: ${env.APP_URL}/games/${game.slug}`
  ];
  const html = `<p><strong>${escapeHtml(oneLine(game.title))}</strong></p>
<p><a href="${escapeHtml(game.url)}">${escapeHtml(game.url)}</a></p>
<p>${escapeHtml(game.description ? oneLine(game.description) : "(no description)")}</p>
<p>Status: ${game.status}<br>Submitted by: ${escapeHtml(oneLine(game.submitter))}</p>
<p>${game.status === "pending"
    ? `<a href="${escapeHtml(moderateUrl)}">Review it</a>`
    : `<a href="${escapeHtml(`${env.APP_URL}/games/${game.slug}`)}">Auto-approved: view game</a>`}</p>`;
  try {
    await env.EMAIL.send({
      to: env.NOTIFY_EMAIL_TO,
      from: { email: env.NOTIFY_EMAIL_FROM, name: "0x9 dles" },
      subject: `${prefix}New game submitted: ${oneLine(game.title).slice(0, 120)}`,
      text: lines.join("\n"),
      html
    });
  } catch (error) {
    console.error("Submission notification email failed:", error);
  }
}

async function writeAudit(
  env: Env,
  actorUserId: string,
  entityType: string,
  entityId: string,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_log (id, actor_user_id, entity_type, entity_id, action, metadata_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  )
    .bind(crypto.randomUUID(), actorUserId, entityType, entityId, action, JSON.stringify(metadata))
    .run();
}

/**
 * The viewer's votes and (when signed in) account favorites among gameIds. Logged-out views headed for the edge
 * cache get neither, since the page will be shown to other visitors too.
 */
async function getViewerGameState(
  c: Context<{ Bindings: Bindings; Variables: AppVariables }>,
  gameIds: string[]
): Promise<{ votes: Map<string, -1 | 1>; favorites: Set<string> }> {
  const votes = new Map<string, -1 | 1>();
  const favorites = new Set<string>();
  const user = c.get("user");
  if (gameIds.length === 0 || (!user && c.get("publicCache"))) {
    return { votes, favorites };
  }
  const viewerKey = user ? user.id : await getAnonymousVoteKey(c);
  // D1 allows 100 bound parameters per query: 1 for the viewer plus up to 98 game ids. Votes and favorites go out together.
  const queries: Array<Promise<void>> = [];
  for (let i = 0; i < gameIds.length; i += 98) {
    const ids = gameIds.slice(i, i + 98);
    const placeholders = ids.map((_id, index) => `?${index + 2}`).join(", ");
    queries.push(
      c.env.DB.prepare(
        user
          ? `SELECT game_id, value FROM votes WHERE user_id = ?1 AND game_id IN (${placeholders})`
          : `SELECT game_id, value FROM anonymous_votes WHERE anon_ip_hash = ?1 AND game_id IN (${placeholders})`
      )
        .bind(viewerKey, ...ids)
        .all<{ game_id: string; value: -1 | 1 }>()
        .then((voteRows) => { for (const row of voteRows.results) votes.set(row.game_id, row.value); })
    );
    if (user) {
      queries.push(
        c.env.DB.prepare(`SELECT game_id FROM favorites WHERE user_id = ?1 AND game_id IN (${placeholders})`)
          .bind(user.id, ...ids)
          .all<{ game_id: string }>()
          .then((favoriteRows) => { for (const row of favoriteRows.results) favorites.add(row.game_id); })
      );
    }
  }
  await Promise.all(queries);
  return { votes, favorites };
}

// A real link (not a scripted button) so crawlers can follow it to the game's page.
// A list/rotation row's game name plus its paywall/NSFW badges (the name wraps on narrow screens; see .rotation-list CSS).
function renderRowTitle(title: string, paywall: number | boolean, nsfw: number | boolean): string {
  return `<span class="title-text">${escapeHtml(title)}</span>${paywall ? `<span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}${nsfw ? `<span class="nsfw-badge" title="This game contains NSFW content">nsfw</span>` : ""}`;
}

function renderDetailsLink(slug: string, title: string): string {
  return `<a class="btn-details" href="/games/${encodeURIComponent(slug)}" aria-label="${escapeHtml(`${title} details`)}" title="Details">…</a>`;
}

// Share of votes that are upvotes, e.g. "88% liked". Hidden (but present, so live vote updates can fill it in)
// when nobody has voted yet. Keep in step with likedText in GAME_ACTIONS_SCRIPT.
function renderLikedLabel(upVotes: number, downVotes: number): string {
  const total = upVotes + downVotes;
  if (total === 0) {
    return `<span data-liked hidden></span>`;
  }
  return `<span data-liked title="${upVotes} up, ${downVotes} down">${Math.round((upVotes / total) * 100)}% liked</span>`;
}

// "Score and reset" line under a game card's title. The " · " between visible parts comes from CSS (.meta), so a
// part can appear or disappear without leaving a stray separator.
function renderGameMeta(upVotes: number, downVotes: number, resetSpan: string): string {
  return `<div class="meta">${renderLikedLabel(upVotes, downVotes)}${resetSpan}</div>`;
}

function gameAriaLabel(game: { title: string; description: string | null; voteUpCount: number; voteDownCount: number }): string {
  const description = (game.description || "").trim();
  const intro = description ? `${game.title}: ${description}` : game.title;
  const sentence = /[.!?]$/.test(intro) ? intro : `${intro}.`;
  const total = game.voteUpCount + game.voteDownCount;
  return total === 0 ? `${sentence} No votes yet.` : `${sentence} ${Math.round((game.voteUpCount / total) * 100)}% of ${total} vote${total === 1 ? "" : "s"} are upvotes.`;
}

const DAILY_PROGRESS_MARKUP = `<section class="daily-progress" id="daily-progress" aria-label="Today's progress" hidden>
  <div class="daily-progress-head"><span id="daily-progress-text"></span><span id="daily-progress-streak" class="daily-streak" hidden></span></div>
  <div class="daily-progress-bar" id="daily-progress-bar" role="progressbar" aria-valuemin="0" aria-label="Games played today"><span id="daily-progress-fill"></span></div>
  <button type="button" class="btn" id="daily-play-next" hidden>Play next</button>
  <span class="daily-done" id="daily-done" hidden>All done for today</span>
  <button type="button" class="secondary" id="daily-share" hidden></button>
</section>
<section class="heatmap" id="play-heatmap" aria-labelledby="play-heatmap-title" hidden>
  <h2 id="play-heatmap-title">Play history</h2>
  <div class="heatmap-grid" id="play-heatmap-grid" role="img"></div>
  <div class="heatmap-legend" aria-hidden="true"><span>Less</span><span class="heat-cell" data-level="0"></span><span class="heat-cell" data-level="1"></span><span class="heat-cell" data-level="2"></span><span class="heat-cell" data-level="3"></span><span class="heat-cell" data-level="4"></span><span>More</span></div>
</section>
<details class="stats-card" id="play-stats" open hidden>
  <summary>Your stats</summary>
  <div class="stats-tiles" id="play-stats-tiles"></div>
  <p class="stats-link"><a href="/me/recap">Monthly recap &rarr;</a></p>
</details>
<div class="reminder-opt" id="reminder-opt" hidden>
  <label><input type="checkbox" id="reminder-toggle"> Remind me before resets</label>
  <select id="reminder-minutes" aria-label="Minutes before reset"><option value="30">30 min before</option><option value="60">1 hour before</option><option value="120">2 hours before</option></select>
</div>
`;

// Home page strip: same widget, filled client-side for everyone (the page is edge-cached).
const HOME_ROTATION_MARKUP = `<section class="daily-progress daily-strip" id="daily-progress" aria-label="Today's rotation" hidden>
  <div class="daily-progress-head"><span id="daily-progress-text"></span><span id="daily-progress-streak" class="daily-streak" hidden></span><a class="daily-strip-link" href="/me/rotation">Your rotation</a></div>
  <div class="daily-progress-bar" id="daily-progress-bar" role="progressbar" aria-valuemin="0" aria-label="Games played today"><span id="daily-progress-fill"></span></div>
  <p class="daily-soon" id="daily-soon" hidden><span>Resetting soon: <b id="daily-soon-title"></b> in <span id="daily-soon-in"></span></span> <a class="daily-soon-play" id="daily-soon-play" href="#" target="_blank" rel="noopener noreferrer">Play</a></p>
  <button type="button" class="btn" id="daily-play-next" hidden>Play next</button>
  <span class="daily-done" id="daily-done" hidden>All done for today</span>
  <button type="button" class="secondary" id="daily-share" hidden></button>
</section>`;

// "Not interested" control on browse-grid cards (see HIDDEN_GAMES_SCRIPT); the eye swaps when hidden cards are shown.
const HIDE_BUTTON = `<button type="button" class="hide-btn" aria-label="Hide this game" title="Hide this game"><svg class="i-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 8.5 4 9.5 6a14 14 0 0 1-2.6 3.3M6.6 6.7C4.4 8.1 2.9 10.3 2.5 12c1 2 4.5 6 9.5 6 1.4 0 2.6-.3 3.7-.8"/></svg><svg class="i-show" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12C3.5 10 7 6 12 6s8.5 4 9.5 6c-1 2-4.5 6-9.5 6s-8.5-4-9.5-6z"/><circle cx="12" cy="12" r="2.8"/></svg></button>`;
// SQLite's datetime() gives "YYYY-MM-DD HH:MM:SS" in UTC; rows written by the API are ISO strings.
function utcMillis(value: string): number {
  return Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
}

// Games listed in the last week get a "New" pill. Depends on the clock, not the visitor, so it is cache-safe.
const NEW_GAME_MS = 7 * 24 * 60 * 60 * 1000;
function isNewlyListed(listedAt: string): boolean {
  const time = utcMillis(listedAt);
  return !Number.isNaN(time) && Date.now() - time < NEW_GAME_MS;
}

function renderNewHereBadge(): string {
  return `<span class="new-badge" title="Added to this list in the last 7 days">New here</span>`;
}

// 320x60 list badge: brand block on the left, game count and short address on the right. A null title is the 404 image.
function renderListBadgeSvg(title: string | null, slug: string, games: number, host: string): string {
  const count = `${games} ${games === 1 ? "daily" : "dailies"}`;
  const label = title ? escapeHtml(`${title} on 0x9 dles: ${count}`) : "0x9 dles";
  const address = `${host}/c/${slug}`;
  const right = title
    ? `<text x="124" y="27" fill="#04121c" font-size="18" text-anchor="start">${escapeHtml(count)}</text>
    <text x="124" y="46" fill="#04121c" font-size="11" font-weight="normal" text-anchor="start"${address.length > 30 ? ` textLength="184" lengthAdjust="spacingAndGlyphs"` : ""}>${escapeHtml(address)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="60" viewBox="0 0 320 60" role="img">
  <title>${label}</title>
  <clipPath id="b"><rect width="320" height="60" rx="8" /></clipPath>
  <g clip-path="url(#b)" font-family="Verdana,DejaVu Sans,sans-serif" font-weight="bold">
    <rect width="${title ? 112 : 320}" height="60" fill="#1e1e1e" />
    ${title ? `<rect x="112" width="208" height="60" fill="#00a4fc" />` : ""}
    <text x="${title ? 56 : 160}" y="36" fill="#f2f2f2" font-size="16" text-anchor="middle">0x9 dles</text>
    ${right}
  </g>
</svg>
`;
}

function renderNewBadge(): string {
  return `<span class="new-badge" title="Listed in the last 7 days">New</span>`;
}

// Text for XML: drops the characters XML 1.0 forbids, then escapes.
function xmlText(value: string): string {
  return escapeHtml(value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ""));
}

// Badge SVG: the brand on the left, the upvote share (or "Play daily" before any votes) on the brand blue.
function renderBadgeSvg(game: { title: string; upVotes: number; downVotes: number } | null): string {
  const total = game ? game.upVotes + game.downVotes : 0;
  const value = !game || total === 0 ? "Play daily" : `${Math.round((game.upVotes / total) * 100)}% liked`;
  const title = game ? `<title>${escapeHtml(`${game.title} on 0x9 dles: ${value}`)}</title>` : "<title>0x9 dles</title>";
  const brandText = `<text x="${game ? 48 : 110}" y="25" fill="#f2f2f2">0x9 dles</text>`;
  const valueSegment = game
    ? `<rect x="96" width="124" height="40" fill="#00a4fc" /><text x="158" y="25" fill="#04121c">${escapeHtml(value)}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="40" viewBox="0 0 220 40" role="img">
  ${title}
  <clipPath id="b"><rect width="220" height="40" rx="6" /></clipPath>
  <g clip-path="url(#b)" font-family="Verdana,DejaVu Sans,sans-serif" font-size="14" font-weight="bold" text-anchor="middle">
    <rect width="${game ? 96 : 220}" height="40" fill="#1e1e1e" />
    ${valueSegment}
    ${brandText}
  </g>
</svg>
`;
}

function renderCompactGameList(
  games: Array<{
    id: string;
    title: string;
    slug: string;
    url: string;
    description: string | null;
    score: number;
    voteUpCount: number;
    voteDownCount: number;
    resetBasis: "local" | "server" | null;
    resetTimeMinutes: number | null;
    resetTimezone: string | null;
    paywall: boolean;
    nsfw: boolean;
    categories: Array<{ slug: string; name: string }>;
    developer?: GameDeveloper | null;
    listedAt: string;
  }>,
  user: AppUser | null,
  userVotes: Map<string, -1 | 1>,
  userFavorites: Set<string>,
  opts: { showVotes?: boolean; hideable?: boolean; extraActions?: (game: { id: string; title: string; slug: string }) => string } = {}
): string {
  if (games.length === 0) {
    return "<p>No games found.</p>";
  }
  const showVotes = opts.showVotes !== false;

  return `<ul class="games compact">
    ${games
      .map((game) => {
        const currentVote = userVotes.get(game.id) || 0;
        const currentFavorite = userFavorites.has(game.id);
        return `<li class="card-click"${opts.hideable ? ` data-hide-id="${escapeHtml(game.id)}"` : ""}>
          <div class="game-row" data-game-row="${game.id}" data-vote="${currentVote}" data-game-slug="${escapeHtml(game.slug)}" data-game-title="${escapeHtml(game.title)}">
            <div class="game-top">
              <div class="game-name">
                <a class="game-title card-link" href="${escapeHtml(game.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(gameAriaLabel(game))}">${escapeHtml(game.title)}</a>
                ${isNewlyListed(game.listedAt) ? renderNewBadge() : ""}
                ${game.paywall ? `<span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}
                ${game.nsfw ? `<span class="nsfw-badge" title="This game contains NSFW content">nsfw</span>` : ""}
              </div>
              <div class="compact-actions">
                ${showVotes ? `                <button type="button" data-list-vote="up" data-vote-button="up" class="${currentVote === 1 ? "active" : ""}" aria-pressed="${currentVote === 1 ? "true" : "false"}" aria-label="${escapeHtml(voteButtonLabel("up", game.title, game.voteUpCount))}" title="Vote up"><span aria-hidden="true">▲</span> <span data-up-count>${game.voteUpCount}</span></button>
                <button type="button" data-list-vote="down" data-vote-button="down" class="${currentVote === -1 ? "active" : ""}" aria-pressed="${currentVote === -1 ? "true" : "false"}" aria-label="${escapeHtml(voteButtonLabel("down", game.title, game.voteDownCount))}" title="Vote down"><span aria-hidden="true">▼</span> <span data-down-count>${game.voteDownCount}</span></button>
                ` : ""}
                ${opts.extraActions ? opts.extraActions(game) : ""}
                ${
                  user
                    ? `<button type="button" data-list-favorite="${currentFavorite ? "yes" : "no"}" aria-label="Favorite">${currentFavorite ? "★" : "☆"}</button>`
                    : `<button type="button" data-local-favorite="no" aria-label="Favorite">☆</button>`
                }
                ${renderDetailsLink(game.slug, game.title)}
                ${opts.hideable ? HIDE_BUTTON : ""}
              </div>
            </div>
            <div class="game-sub">
              ${renderCategoryPills(game.categories, game.developer)}
              ${renderGameMeta(game.voteUpCount, game.voteDownCount, renderResetSpan(game.resetBasis, game.resetTimeMinutes, game.resetTimezone))}
            </div>
          </div>
        </li>`;
      })
      .join("")}
  </ul>`;
}

function renderGameListInteractionScript(opts: { includeImportPanel: boolean; promptFromQuery: boolean }): string {
  return `<script src="${ASSET.page_game_list}" data-prompt-from-query="${opts.promptFromQuery ? 1 : 0}" data-include-import-panel="${opts.includeImportPanel ? 1 : 0}"></script>`;
}

// IPv4 stays whole; IPv6 collapses to its /64 prefix (a household owns a whole /64, so per-address keys are free to rotate).
// IPv4-mapped IPv6 (::ffff:1.2.3.4) is the IPv4 address. Unparseable values are returned as-is.
function normalizeIpForKey(raw: string): string {
  let ip = raw.trim().toLowerCase();
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (!ip.includes(":")) return ip;
  const mapped = /^(?:0{1,4}:){0,5}:?(?:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip) || /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return mapped[1];
  let head = ip;
  let tail = "";
  const dbl = ip.indexOf("::");
  if (dbl >= 0) {
    if (ip.indexOf("::", dbl + 1) >= 0) return ip;
    head = ip.slice(0, dbl);
    tail = ip.slice(dbl + 2);
  }
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const hex = /^[0-9a-f]{1,4}$/;
  if (![...headParts, ...tailParts].every((part) => hex.test(part))) return ip;
  const total = headParts.length + tailParts.length;
  if (dbl >= 0 ? total > 7 : total !== 8) return ip;
  const groups = dbl >= 0 ? [...headParts, ...Array(8 - total).fill("0"), ...tailParts] : headParts;
  return groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":") + "::/64";
}

function getClientIp(c: Context<{ Bindings: Bindings; Variables: AppVariables }>): string {
  const cfIp = (c.req.header("cf-connecting-ip") || "").trim();
  if (cfIp) {
    return normalizeIpForKey(cfIp);
  }
  const forwarded = c.req.header("x-forwarded-for") || "";
  const first = forwarded.split(",")[0]?.trim() || "";
  return first ? normalizeIpForKey(first) : "unknown";
}

async function getAnonymousVoteKey(c: Context<{ Bindings: Bindings; Variables: AppVariables }>): Promise<string> {
  const ip = getClientIp(c);
  return hashToken(c.env.SESSION_SECRET, `anon-vote:${ip}`);
}

function parsePositiveInt(value: string | undefined, fallbackValue: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return parsed;
}

function parseResetTimeToMinutes(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

// "A", "A and B", "A, B and C".
function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// "9:00 AM" from minutes after midnight (en-US clock for prose).
function formatClock12(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

// The reset in plain words for game page copy. `short` is the meta-description form.
function describeReset(basis: "local" | "server" | null, minutes: number | null, timezone: string | null, short = false): string | null {
  if (!basis || minutes === null || minutes < 0 || minutes > 1439) return null;
  const clock = formatClock12(minutes);
  if (basis === "local") {
    return short ? `Resets daily at ${clock} local time.` : `It resets every day at ${clock} in your own time zone, so the new puzzle arrives at the same clock time wherever you are.`;
  }
  const zone = friendlyZoneName(timezone ?? "UTC");
  return short ? `Resets daily at ${clock} ${zone}.` : `It resets every day at ${clock} ${zone}, the same moment for everyone.`;
}

// "Eastern Time", "UK time", "Berlin time" for an IANA zone; UTC stays "UTC".
function friendlyZoneName(zone: string): string {
  const known: Record<string, string> = {
    UTC: "UTC", "America/New_York": "Eastern Time", "America/Chicago": "Central Time", "America/Denver": "Mountain Time",
    "America/Los_Angeles": "Pacific Time", "Europe/London": "UK time"
  };
  return known[zone] ?? `${zone.split("/").pop()!.replace(/_/g, " ")} time`;
}

function formatResetTime(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0 || minutes > 1439) {
    return "Unknown";
  }
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const COMMON_TIME_ZONES = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage",
  "America/Toronto", "America/Mexico_City", "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin",
  "Europe/Moscow", "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Shanghai",
  "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland"
];

function listTimeZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    if (supported && supported.length > 0) {
      return supported.includes("UTC") ? supported : ["UTC", ...supported];
    }
  } catch {
    // fall through to the common list
  }
  return COMMON_TIME_ZONES;
}

function isValidTimeZone(value: string): boolean {
  if (!/^[A-Za-z0-9_+\-\/]{1,64}$/.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Returns the zone to store: null unless the basis is "server" and a zone was given. */
function normalizeResetTimeZone(
  basis: "local" | "server" | null | undefined,
  value: string | null | undefined
): { ok: true; value: string | null } | { ok: false } {
  const trimmed = (value || "").trim();
  if (basis !== "server" || !trimmed) {
    return { ok: true, value: null };
  }
  return isValidTimeZone(trimmed) ? { ok: true, value: trimmed } : { ok: false };
}

function timeZoneOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  } catch {
    return 0;
  }
}

function timeZoneAbbreviation(timeZone: string, at: Date = new Date()): string | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? null;
  } catch {
    return null;
  }
}

/** Zones most games reset in, shown first with friendly names: the US (including Alaska and Hawaii) and the main European ones. */
const TIME_ZONE_SHORTLIST: Array<[string, string]> = [
  ["America/New_York", "US Eastern (New York)"],
  ["America/Chicago", "US Central (Chicago)"],
  ["America/Denver", "US Mountain (Denver)"],
  ["America/Phoenix", "US Mountain, no DST (Phoenix)"],
  ["America/Los_Angeles", "US Pacific (Los Angeles)"],
  ["America/Anchorage", "US Alaska (Anchorage)"],
  ["Pacific/Honolulu", "US Hawaii (Honolulu)"],
  ["Europe/London", "UK (London)"],
  ["Europe/Paris", "Central Europe (Paris)"],
  ["Europe/Berlin", "Central Europe (Berlin)"]
];

/**
 * A native <select> of IANA time zones: "Most common" first (UTC, US and main European zones), then every other zone
 * grouped by region. (A text field with a <datalist> opens its suggestions over the on-screen keyboard on phones; a
 * select opens the system picker instead.) Blank means UTC.
 */
function renderTimeZoneOptions(selected: string | null | undefined): string {
  const current = selected && selected !== "UTC" ? selected : "";
  const available = listTimeZones().filter((zone) => zone !== "UTC");
  const common = new Set(TIME_ZONE_SHORTLIST.map(([zone]) => zone));
  const groups = new Map<string, string[]>();
  for (const zone of available) {
    if (common.has(zone)) continue;
    const region = zone.includes("/") ? zone.split("/")[0] : "Other";
    groups.set(region, [...(groups.get(region) ?? []), zone]);
  }
  const option = (zone: string, label = zone.replace(/_/g, " ")) => `<option value="${escapeHtml(zone)}"${zone === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
  // A saved zone that isn't in the browser's list still shows (and is kept) rather than silently resetting to UTC.
  const extra = current && !available.includes(current) && !common.has(current) ? option(current) : "";
  const mostCommon = [`<option value=""${current ? "" : " selected"}>UTC (default)</option>`, ...TIME_ZONE_SHORTLIST.map(([zone, label]) => option(zone, label))].join("");
  return `<optgroup label="Most common">${mostCommon}</optgroup>${extra}${[...groups.entries()]
    .map(([region, list]) => `<optgroup label="${escapeHtml(region)}">${list.map((zone) => option(zone)).join("")}</optgroup>`)
    .join("")}`;
}

// Shows the time zone input only while the reset basis is "server".
const RESET_TIMEZONE_TOGGLE_SCRIPT = `
  document.querySelectorAll("[data-reset-group]").forEach((group) => {
    const basis = group.querySelector("[data-basis-select]");
    const zoneWrap = group.querySelector("[data-tz-wrap]");
    const zoneInput = group.querySelector("[data-tz-input]");
    if (!basis || !zoneWrap) return;
    const sync = () => {
      const isServer = basis.value === "server";
      zoneWrap.hidden = !isServer;
      if (!isServer && zoneInput) zoneInput.value = "";
    };
    basis.addEventListener("change", sync);
    sync();
  });
`;

function renderTimeZoneField(inputName: string, value: string | null | undefined, extraAttrs = ""): string {
  return `<label data-tz-wrap>Time zone (server time)
    <select name="${inputName}" data-tz-input ${extraAttrs}>${renderTimeZoneOptions(value)}</select>
  </label>`;
}

/**
 * "Know the reset time?" link and its hidden form on the game page. Static markup (the same for every visitor, so
 * edge-cache safe); the script decides client-side, via /api/me/session, whether to show the form or a sign-in link.
 * Staff and the game's verified developer (signed in, so never cached) are pointed at the forms they can edit with.
 */
function renderResetSuggest(game: { slug: string; reset_basis: "local" | "server" | null }, user: AppUser | null, isVerifiedDeveloper: boolean): string {
  const isStaff = !!user && (user.role === "admin" || user.role === "editor");
  if (isVerifiedDeveloper || isStaff) {
    return `<p class="game-actions-note">${isVerifiedDeveloper ? "You can set the reset time in the developer form below." : "Edit the reset time in the admin form below."}</p>`;
  }
  const loginHref = `/login?next=${encodeURIComponent(`/games/${game.slug}`)}`;
  const shortlist = TIME_ZONE_SHORTLIST.map(([zone, label]) => `<option value="${escapeHtml(zone)}">${escapeHtml(label)}</option>`).join("");
  return `<div class="reset-suggest">
    <p class="game-actions-note"><a href="${escapeHtml(loginHref)}" data-reset-suggest-open>${game.reset_basis ? "Wrong reset time?" : "Know the reset time?"}</a></p>
    <form class="panel stack-form" data-reset-suggest-form hidden>
      <p data-reset-suggest-signin hidden><a href="${escapeHtml(loginHref)}">Sign in</a> to suggest a reset time.</p>
      <div data-reset-suggest-fields>
        <label>Resets at
          <select name="reset_basis">
            <option value="local">Midnight in the player's own time zone</option>
            <option value="server">A fixed time for everyone</option>
          </select>
        </label>
        <label>Time
          <input type="time" name="reset_time" value="00:00" required />
        </label>
        <label data-rs-zone hidden>Time zone
          <select name="reset_timezone"><optgroup label="Most common"><option value="">UTC</option>${shortlist}</optgroup></select>
        </label>
        <label>Note <small>(optional)</small>
          <input type="text" name="note" maxlength="200" />
        </label>
        <button type="submit">Send suggestion</button>
      </div>
      <p class="status" data-reset-suggest-status aria-live="polite"></p>
    </form>
  </div>`;
}

/** The blue check used for verified Twitch curators and verified developers (static markup, safe to inject). */
const CHECK_SVG = `<svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polygon points="12.00,1.80 15.14,4.42 19.21,4.79 19.58,8.86 22.20,12.00 19.58,15.14 19.21,19.21 15.14,19.58 12.00,22.20 8.86,19.58 4.79,19.21 4.42,15.14 1.80,12.00 4.42,8.86 4.79,4.79 8.86,4.42" fill="#1d9bf0" stroke="#1d9bf0" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 12.5l3.2 3.2L17 8.8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function renderCheckBadge(title: string): string {
  return `<span class="verified-badge" title="${escapeHtml(title)}" aria-label="Verified">${CHECK_SVG}</span>`;
}

/**
 * Game page sections for developer claims: the claim flow for a signed-in visitor, or the edit form for the
 * game's verified developer. Staff can claim too, but edit through the admin form, so a verified staff
 * developer only gets a release button.
 */
function renderDeveloperSections(
  game: { id: string; title: string; slug: string; url: string; description: string | null; how_to_play: string | null; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null; paywall: number },
  user: AppUser | null,
  claim: ClaimRow | null,
  hasDeveloper: boolean,
  appEnv: string,
  appUrl: string,
  shareOrigin: string
): string {
  const isStaff = !!user && (user.role === "admin" || user.role === "editor");
  if (isStaff && claim?.status === "verified") {
    return `<section class="panel">
      <p class="game-actions-note">You're the verified developer of this game. Edit it with the admin form below.</p>
      <p><button type="button" class="secondary" data-claim-cancel data-claim-confirm="Stop being the verified developer of this game?">Release this game</button></p>
      <p data-claim-status class="status" aria-live="polite"></p>
    </section>
    ${renderDeveloperStatsPanel(game.id, ASSET.dev_stats_css, ASSET.dev_stats_js)}`;
  }
  if (!user) {
    return hasDeveloper ? "" : `<p class="game-actions-note">Made this game? <a href="/login">Sign in</a> to claim it.</p>`;
  }
  if (claim?.status === "verified") {
    const base = appUrl.replace(/\/$/, "");
    const gamePageUrl = `${shareOrigin.replace(/\/$/, "")}/g/${encodeURIComponent(game.slug)}`;
    const badgeUrl = `${base}/badge/${encodeURIComponent(game.slug)}.svg`;
    const badgeAlt = `${escapeHtml(game.title)} on 0x9 dles`;
    const linkSnippet = `<a href="${gamePageUrl}">${escapeHtml(game.title)} on 0x9 dles</a>`;
    const badgeSnippet = `<a href="${gamePageUrl}"><img src="${badgeUrl}" alt="${badgeAlt}" width="220" height="40"></a>`;
    const addSnippet = `<a href="${gamePageUrl}?add=1" style="display:inline-block;padding:8px 14px;border-radius:6px;background:#2f6fed;color:#fff;font:600 14px/1.2 sans-serif;text-decoration:none">Add ${escapeHtml(game.title)} to my rotation</a>`;
    return `${renderDeveloperStatsPanel(game.id, ASSET.dev_stats_css, ASSET.dev_stats_js)}
    <section class="panel" id="linkback">
      <h2>Help players find ${escapeHtml(game.title)}</h2>
      <p>If you like, link to this page from your game and from your social accounts. It's entirely optional, but links from the places people already find you help players, and search engines, discover the game.</p>
      <p><code>${escapeHtml(gamePageUrl)}</code></p>
      <p><button type="button" class="secondary" data-copy="${escapeHtml(gamePageUrl)}">Copy link</button> <button type="button" class="secondary" data-copy="${escapeHtml(linkSnippet)}">Copy HTML link</button></p>
      <h3>Badge</h3>
      <p>A small badge with the game's rating, for your site or README. It links back to this page.</p>
      <p><img src="${escapeHtml(badgeUrl)}" width="220" height="40" alt="${badgeAlt}" /></p>
      <p><input type="text" readonly value="${escapeHtml(badgeSnippet)}" aria-label="Badge HTML" /></p>
      <p><button type="button" class="secondary" data-copy="${escapeHtml(badgeSnippet)}">Copy badge HTML</button></p>
      <h3>Add to rotation button</h3>
      <p>A link button that adds ${escapeHtml(game.title)} to the visitor's rotation in one click, signed in or not.</p>
      <p><input type="text" readonly value="${escapeHtml(addSnippet)}" aria-label="Add to rotation button HTML" /></p>
      <p><button type="button" class="secondary" data-copy="${escapeHtml(addSnippet)}">Copy button HTML</button></p>
    </section>
    <section class="panel">
      <h2>Edit your game</h2>
      <p class="game-actions-note">You're the verified developer. Keep the verification tag on the game's page (or the file on its site): if it goes missing, your verification is removed. Moving the game to a new URL needs the tag on the new address first.</p>
      <form id="developer-edit-form" class="stack-form">
        <label>Title
          <input type="text" name="title" value="${escapeHtml(game.title)}" required />
        </label>
        <label>URL
          <input type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" name="url" value="${escapeHtml(game.url)}" required />
        </label>
        <label>Description
          <textarea name="description" rows="3" maxlength="1000">${escapeHtml(game.description || "")}</textarea>
        </label>
        <label>How to play <small>(optional; blank line between paragraphs)</small>
          <textarea name="how_to_play" rows="5" maxlength="2000">${escapeHtml(game.how_to_play || "")}</textarea>
        </label>
        <div data-reset-group>
          <label>Reset Basis
            <select name="reset_basis" data-basis-select>
              <option value="" ${!game.reset_basis ? "selected" : ""}>None</option>
              <option value="local" ${game.reset_basis === "local" ? "selected" : ""}>Local</option>
              <option value="server" ${game.reset_basis === "server" ? "selected" : ""}>Server</option>
            </select>
          </label>
          <label>Reset Time (in the zone below for Server, otherwise the viewer's local time)
            <input type="time" name="reset_time" value="${game.reset_time_minutes === null ? "" : escapeHtml(formatResetTime(game.reset_time_minutes))}" />
          </label>
          ${renderTimeZoneField("reset_timezone", game.reset_timezone)}
        </div>
        <label style="display:block;"><input type="checkbox" name="paywall" value="1" ${game.paywall ? "checked" : ""} /> Paywall</label>
        <button type="submit">Save changes</button>
      </form>
      <p id="developer-edit-status" class="status" aria-live="polite"></p>
      <p><button type="button" class="secondary" data-claim-cancel data-claim-confirm="Stop being the verified developer of this game?">Release this game</button></p>
      <p data-claim-status class="status" aria-live="polite"></p>
    </section>`;
  }
  if (hasDeveloper || claim?.status === "rejected") {
    return claim?.status === "rejected" ? `<p class="game-actions-note">An editor declined your claim on this game.</p>` : "";
  }

  const origin = (() => {
    try {
      return new URL(game.url).origin;
    } catch {
      return game.url;
    }
  })();
  let body: string;
  if (!claim || claim.status === "revoked") {
    body = `<p>Verify that you made this game to get a verified-developer mark and edit its details yourself.</p>
      <button type="button" class="btn" data-claim-start>Claim this game</button>`;
  } else if (claim.status === "review") {
    body = `<p>Your evidence is with the editors. Once they confirm it, you'll be able to edit this game.</p>
      <button type="button" class="secondary" data-claim-cancel>Withdraw claim</button>`;
  } else {
    body = `<p>Do <strong>one</strong> of these, then press Verify. We check the game's address as it is listed here: <code>${escapeHtml(game.url)}</code></p>
      <ol>
        <li>Add this tag inside the <code>&lt;head&gt;</code> of that page:
          <pre><code>${escapeHtml(claimMetaSnippet(claim.token, appEnv))}</code></pre>
          <button type="button" class="secondary" data-copy="${escapeHtml(claimMetaSnippet(claim.token, appEnv))}">Copy tag</button></li>
        <li>Or serve a plain text file at <code>${escapeHtml(origin + claimNames(appEnv).filePath)}</code> containing just:
          <pre><code>${escapeHtml(claim.token)}</code></pre>
          <button type="button" class="secondary" data-copy="${escapeHtml(claim.token)}">Copy file contents</button></li>
      </ol>
      <p><button type="button" class="btn" data-claim-verify>Verify now</button> <button type="button" class="secondary" data-claim-cancel>Cancel</button></p>
      <details>
        <summary>Can't change the page? (itch.io, Newgrounds, and similar sites)</summary>
        <p>Tell the editors how to confirm it, e.g. a link to your developer profile that lists this game. They'll review it.</p>
        <textarea data-claim-evidence-text rows="3" maxlength="500" placeholder="https://yourname.itch.io/ ..."></textarea>
        <p><button type="button" data-claim-evidence>Send for review</button></p>
      </details>`;
  }
  return `<details class="panel claim-panel" ${claim ? "open" : ""}>
    <summary>Are you the developer?</summary>
    ${body}
    <p data-claim-status class="status" aria-live="polite"></p>
  </details>`;
}

const DEVELOPER_SCRIPT = `
  const claimStatusNode = document.querySelector("[data-claim-status]");
  const claimSay = (text, level) => {
    if (claimStatusNode) claimStatusNode.textContent = text;
    if (window.appToast) window.appToast(text, level);
  };
  const claimCall = async (method, path, body) => {
    const res = await fetch("/api/games/" + gameId + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  };
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = button.getAttribute("data-copy") || "";
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        // Clipboard API unavailable (insecure context or denied): fall back to selecting a hidden textarea.
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        try { copied = document.execCommand("copy"); } catch { copied = false; }
        area.remove();
      }
      const label = button.dataset.label || button.textContent;
      button.dataset.label = label;
      button.textContent = copied ? "Copied!" : "Select and copy manually";
      setTimeout(() => { button.textContent = label; }, 2000);
    });
  });
  document.querySelector("[data-claim-start]")?.addEventListener("click", async () => {
    const r = await claimCall("POST", "/claim");
    if (r.ok) window.location.reload();
    else claimSay(r.data.error || "Could not start the claim.", "error");
  });
  document.querySelector("[data-claim-verify]")?.addEventListener("click", async () => {
    claimSay("Checking...", "info");
    const r = await claimCall("POST", "/claim/verify");
    if (r.ok) {
      claimSay("Verified! You're now the game's verified developer.", "success");
      setTimeout(() => { window.location.href = window.location.pathname + "#linkback"; window.location.reload(); }, 900);
    } else {
      claimSay(r.data.error || "Could not verify.", "error");
    }
  });
  document.querySelector("[data-claim-evidence]")?.addEventListener("click", async () => {
    const field = document.querySelector("[data-claim-evidence-text]");
    const r = await claimCall("POST", "/claim/evidence", { evidence: field ? field.value : "" });
    if (r.ok) window.location.reload();
    else claimSay(r.data.error || "Could not send it.", "error");
  });
  document.querySelector("[data-claim-cancel]")?.addEventListener("click", async (event) => {
    const confirmText = event.currentTarget.getAttribute("data-claim-confirm");
    if (confirmText && !window.confirm(confirmText)) return;
    const r = await claimCall("DELETE", "/claim");
    if (r.ok) window.location.reload();
    else claimSay(r.data.error || "Could not cancel.", "error");
  });

  const developerForm = document.getElementById("developer-edit-form");
  if (developerForm) {
    ${RESET_TIMEZONE_TOGGLE_SCRIPT}
    const developerStatus = document.getElementById("developer-edit-status");
    const setDeveloperStatus = (text) => {
      if (developerStatus) developerStatus.textContent = text;
    };
    developerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(developerForm);
      const resetBasis = formData.get("reset_basis");
      const resetTimeParts = /^(\\d{1,2}):(\\d{2})/.exec(String(formData.get("reset_time") || "").trim());
      const resetTimezone = String(formData.get("reset_timezone") || "").trim();
      const payload = {
        title: String(formData.get("title") || ""),
        url: String(formData.get("url") || ""),
        description: String(formData.get("description") || "").trim() || null,
        reset_basis: resetBasis ? String(resetBasis) : null,
        reset_time_minutes: resetTimeParts ? Number(resetTimeParts[1]) * 60 + Number(resetTimeParts[2]) : null,
        reset_timezone: resetBasis === "server" && resetTimezone ? resetTimezone : null,
        paywall: formData.has("paywall"),
        how_to_play: String(formData.get("how_to_play") || "")
      };
      setDeveloperStatus("Saving changes...");
      const response = await fetch("/api/games/" + gameId + "/developer-update", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok) {
        setDeveloperStatus("Changes saved.");
        if (window.appToast) window.appToast("Game updated.", "success");
        setTimeout(() => { window.location.href = "/games/" + (result.slug || ""); }, 800);
      } else {
        const message = result.error || "Could not save changes.";
        setDeveloperStatus(message);
        if (window.appToast) window.appToast(message, "error");
      }
    });
  }
`;

type ResetSortData = { kind: "utc" | "local"; min: number };

/**
 * Where a game's daily reset falls on a 24h clock, for client-side "resetting soonest" sorting.
 * Server-time resets are converted to a UTC minute-of-day using the zone's current offset (DST-aware);
 * local-time resets stay in the viewer's own clock.
 */
function getResetSortData(
  basis: "local" | "server" | null | undefined,
  minutes: number | null | undefined,
  timeZone?: string | null
): ResetSortData | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0 || minutes > 1439) {
    return null;
  }
  if (basis === "local") {
    return { kind: "local", min: minutes };
  }
  const offset = basis === "server" && timeZone ? timeZoneOffsetMinutes(timeZone) : 0;
  return { kind: "utc", min: (((minutes - offset) % 1440) + 1440) % 1440 };
}

function renderResetItemData(
  basis: "local" | "server" | null | undefined,
  minutes: number | null | undefined,
  timeZone?: string | null
): { attrs: string; label: string; span: string } {
  const data = getResetSortData(basis, minutes, timeZone);
  return {
    attrs: data ? `data-reset-kind="${data.kind}" data-reset-min="${data.min}"` : "",
    label: getResetMetaLabel(basis, minutes, timeZone),
    span: renderResetSpan(basis, minutes, timeZone)
  };
}

/** Accessible name of a vote button. Keep in step with voteLabels in GAME_ACTIONS_SCRIPT. */
function voteButtonLabel(direction: "up" | "down", title: string, count: number): string {
  const noun = direction === "up" ? "upvote" : "downvote";
  return `${count} ${count === 1 ? noun : `${noun}s`}: ${direction === "up" ? "Upvote" : "Downvote"} ${title}`;
}

/**
 * A reset label the browser rewrites in the viewer's local time (see RESET_LOCALIZE_SCRIPT).
 * The text content is the server-rendered fallback for no-JS clients.
 */
function renderResetSpan(
  basis: "local" | "server" | null | undefined,
  minutes: number | null | undefined,
  timeZone?: string | null,
  format: "short" | "long" = "short"
): string {
  const data = getResetSortData(basis, minutes, timeZone);
  const label = getResetMetaLabel(basis, minutes, timeZone);
  if (!data || !label) {
    return "";
  }
  const text = format === "long" ? label.replace(/^Reset /, "Resets daily at ") : label;
  return `<span data-reset-at-kind="${data.kind}" data-reset-at="${data.min}" data-reset-format="${format}">${escapeHtml(text)}</span>`;
}

// Rewrites reset labels for the viewer as a countdown ("Resets in 3h 12m"; data-reset-format="long" gives
// "Resets daily at 4:00 AM · next in 3h 12m"), refreshed every minute. "utc" minutes are a UTC time of day,
// "local" ones are already in the viewer's own clock. The server-rendered text is the no-JS fallback.
/**
 * Keeps each group of category pills to two lines. When a group would take more, the trailing category pills are
 * hidden behind a "+N" chip that expands them (and a "Show less" chip folds them again). The verified-developer pill
 * is never hidden. Groups are refitted when their width changes (resize, an opened panel) and when pills are added
 * by other scripts (the signed-out rotation, list suggestions).
 */
const PILL_FIT_SCRIPT = `
  (() => {
    const MAX_ROWS = 2;
    const rowsOf = (box) => new Set([...box.children].filter((el) => !el.hidden).map((el) => el.offsetTop)).size;
    const makeChip = (text, label, expanded) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag pill-more";
      chip.textContent = text;
      chip.setAttribute("aria-label", label);
      chip.setAttribute("aria-expanded", expanded ? "true" : "false");
      return chip;
    };
    const fit = (box) => {
      box.querySelectorAll(".pill-more").forEach((el) => el.remove());
      const cats = [...box.querySelectorAll(".category-pill:not(.dev-pill)")];
      cats.forEach((el) => { el.hidden = false; });
      if (!box.offsetWidth || cats.length < 2) return;
      const dev = box.querySelector(".dev-pill");
      if (box.dataset.expanded === "1") {
        box.insertBefore(makeChip("Show less", "Show fewer categories", true), dev);
        return;
      }
      if (rowsOf(box) <= MAX_ROWS) return;
      const more = makeChip("+1", "Show 1 more category", false);
      box.insertBefore(more, dev);
      let hidden = 0;
      for (let i = cats.length - 1; i >= 1; i--) {
        cats[i].hidden = true;
        hidden++;
        more.textContent = "+" + hidden;
        more.setAttribute("aria-label", "Show " + hidden + " more categor" + (hidden === 1 ? "y" : "ies"));
        if (rowsOf(box) <= MAX_ROWS) break;
      }
    };
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.target;
        // Only a change of width matters; hiding pills changes the height.
        if (box.__pillWidth !== entry.contentRect.width) {
          box.__pillWidth = entry.contentRect.width;
          fit(box);
        }
      }
    });
    const watch = (box) => {
      if (box.__pillWatched) return;
      box.__pillWatched = true;
      resizeObserver.observe(box);
    };
    const pending = new Set();
    const schedule = (box) => {
      pending.add(box);
      if (pending.size === 1) requestAnimationFrame(() => { const boxes = [...pending]; pending.clear(); boxes.forEach((b) => { watch(b); fit(b); }); });
    };
    document.querySelectorAll(".category-pills").forEach(watch);
    new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (node.nodeType !== 1 || node.matches(".pill-more")) return;
          const own = node.closest(".category-pills");
          if (own) schedule(own);
          node.querySelectorAll?.(".category-pills").forEach(schedule);
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", (event) => {
      const chip = event.target.closest?.(".pill-more");
      if (!chip) return;
      event.preventDefault();
      event.stopPropagation();
      const box = chip.closest(".category-pills");
      box.dataset.expanded = box.dataset.expanded === "1" ? "0" : "1";
      fit(box);
    });
  })();
`;

// Per-browser "not interested" list (localStorage dgl_hidden_v1, game ids). Runs in <head>: a generated stylesheet hides
// every [data-hide-id] card (browse grids only) before first paint. html.dgl-show-hidden reveals them with an unhide eye.
const HIDDEN_GAMES_SCRIPT = `
  window.dglHidden = (() => {
    const KEY = "dgl_hidden_v1";
    const read = () => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && /^[\\w-]{1,64}$/.test(id)) : [];
      } catch {
        return [];
      }
    };
    const style = document.createElement("style");
    document.head.appendChild(style);
    const paint = () => {
      style.textContent = read().map((id) => {
        const card = 'html.dgl-show-hidden [data-hide-id="' + id + '"]';
        return 'html:not(.dgl-show-hidden) [data-hide-id="' + id + '"]{display:none}'
          + card + '{opacity:.55}' + card + ' .hide-btn .i-hide{display:none}' + card + ' .hide-btn .i-show{display:inline}';
      }).join("");
      window.dispatchEvent(new Event("dglhiddenchange"));
    };
    const write = (ids) => {
      try { window.localStorage.setItem(KEY, JSON.stringify(ids.slice(-2000))); } catch {}
      paint();
    };
    const hide = (id) => { const ids = read(); if (!ids.includes(id)) write(ids.concat([id])); };
    const unhide = (id) => write(read().filter((x) => x !== id));
    window.addEventListener("storage", (event) => { if (event.key === KEY) paint(); });
    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest(".hide-btn") : null;
      const card = button ? button.closest("[data-hide-id]") : null;
      const id = card ? card.getAttribute("data-hide-id") : "";
      if (!button || !card || !id) return;
      event.preventDefault();
      if (read().includes(id)) { unhide(id); return; }
      card.classList.add("hiding");
      window.setTimeout(() => {
        hide(id);
        card.classList.remove("hiding");
        if (window.appToast) window.appToast("Game hidden", "success", 6000, { label: "Undo", onClick: () => unhide(id) });
      }, 250);
    });
    paint();
    return { read, hide, unhide, clear: () => write([]) };
  })();
`;

// Shared client helpers (loaded in <head> on every page). dglProgressWidget draws "N of M played today" with Play
// next and the streak (localStorage dgl_streak_v1, { last: "YYYY-MM-DD", count }) for a box shaped like
// DAILY_PROGRESS_MARKUP; getRows() gives today's games as { id, url, kind, min } (kind/min = reset, optional).
// dglTodayRotation.get(maxAgeMs) fetches today's rotation for signed-in (GET /api/me/rotation) and logged-out
// (local favorites) visitors alike plus links and resets from GET /api/games/rotation-info; the signed-in check is
// GET /api/me/session, so it works on edge-cached pages. Reset reminders (dgl_reminders_v1) run from
// dglPlayedHooks on every page, but only fetch while on.
const ROTATION_TODAY_SCRIPT = `
  window.dglDateKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  // Skip today (localStorage dgl_skipped_v1, { "YYYY-MM-DD": [gameIds] }, viewer-local day; only today and yesterday are kept).
  // Signed-in skips sync through window.dglPlaySync (skipped / unskipped). A skipped game that has been played counts as played.
  const SKIP_KEY = "dgl_skipped_v1";
  const readSkipped = () => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(SKIP_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  const writeSkipped = (map) => {
    const now = new Date();
    const keep = [window.dglDateKey(now), window.dglDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))];
    const out = {};
    keep.forEach((key) => { if (Array.isArray(map[key]) && map[key].length > 0) out[key] = map[key]; });
    try { window.localStorage.setItem(SKIP_KEY, JSON.stringify(out)); } catch {}
    (window.dglPlayedHooks || []).forEach((hook) => { try { hook(); } catch {} });
  };
  window.dglSkippedToday = () => {
    const list = readSkipped()[window.dglDateKey(new Date())];
    return new Set(Array.isArray(list) ? list.filter((id) => typeof id === "string") : []);
  };
  window.dglSkip = (id) => {
    if (!id) return;
    const map = readSkipped();
    const set = window.dglSkippedToday();
    set.add(id);
    map[window.dglDateKey(new Date())] = Array.from(set);
    writeSkipped(map);
    if (window.dglPlaySync && window.dglPlaySync.skipped) window.dglPlaySync.skipped(id, window.dglDateKey(new Date()));
  };
  window.dglUnskip = (id) => {
    const map = readSkipped();
    const set = window.dglSkippedToday();
    set.delete(id);
    map[window.dglDateKey(new Date())] = Array.from(set);
    writeSkipped(map);
    if (window.dglPlaySync && window.dglPlaySync.unskipped) window.dglPlaySync.unskipped(id, window.dglDateKey(new Date()));
  };
  // Skipped today and not played since: the game drops out of today's counts, Play next, reminders and the streak.
  window.dglIsSkipped = (id, kind, min, skipped) => (skipped || window.dglSkippedToday()).has(id) && !(window.dglIsPlayed && window.dglIsPlayed(id, kind, min));
  window.dglProgressWidget = (box, getRows) => {
    const text = box.querySelector("#daily-progress-text");
    const streakNode = box.querySelector("#daily-progress-streak");
    const fill = box.querySelector("#daily-progress-fill");
    const bar = box.querySelector("#daily-progress-bar");
    const next = box.querySelector("#daily-play-next");
    const done = box.querySelector("#daily-done");
    const STREAK_KEY = "dgl_streak_v1";
    let memStreak = null;
    const readStreak = () => {
      if (memStreak) return { last: memStreak.last, count: memStreak.count };
      try {
        const parsed = JSON.parse(window.localStorage.getItem(STREAK_KEY) || "{}");
        return parsed && typeof parsed.last === "string" && Number(parsed.count) > 0 ? { last: parsed.last, count: Math.floor(Number(parsed.count)) } : { last: "", count: 0 };
      } catch {
        return { last: "", count: 0 };
      }
    };
    let nextRow = null;
    const update = () => {
      if (!window.dglIsPlayed) return;
      const all = getRows();
      box.hidden = all.length === 0;
      if (all.length === 0) return;
      const skippedSet = window.dglSkippedToday();
      const rows = all.filter((row) => !window.dglIsSkipped(row.id, row.kind, row.min, skippedSet));
      const unplayed = rows.filter((row) => !window.dglIsPlayed(row.id, row.kind, row.min));
      const played = rows.length - unplayed.length;
      text.textContent = rows.length === 0 ? "All skipped today" : played + " of " + rows.length + " played today";
      fill.style.width = rows.length === 0 ? "0%" : Math.round((played / rows.length) * 100) + "%";
      bar.setAttribute("aria-valuenow", String(played));
      bar.setAttribute("aria-valuemax", String(Math.max(rows.length, 1)));
      nextRow = unplayed[0] || null;
      // Home strip only (has #daily-soon): the unplayed game that resets within two hours, soonest first.
      const soonBox = box.querySelector("#daily-soon");
      if (soonBox) {
        let soon = null;
        unplayed.forEach((row) => {
          const reset = row.kind && row.min !== "" ? window.dglResetCountdown(row.kind, row.min) : null;
          if (reset && reset.minutesLeft <= 120 && (!soon || reset.minutesLeft < soon.reset.minutesLeft)) soon = { row, reset };
        });
        soonBox.hidden = !soon;
        if (soon) {
          box.querySelector("#daily-soon-title").textContent = soon.row.title || "";
          box.querySelector("#daily-soon-in").textContent = soon.reset.in;
          const play = box.querySelector("#daily-soon-play");
          play.setAttribute("href", soon.row.url || "#");
          play.setAttribute("data-play-id", soon.row.id);
          play.setAttribute("aria-label", "Play " + (soon.row.title || "game"));
        }
      }
      next.hidden = !nextRow;
      done.hidden = !!nextRow || played === 0;
      if (shareBtn) {
        shareBtn.hidden = played === 0;
        shareBtn.textContent = nextRow ? "Share progress" : "Share today";
      }
      try {
        const now = new Date();
        const today = window.dglDateKey(now);
        const yesterdayKey = window.dglDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
        const streak = readStreak();
        if (!nextRow && played > 0 && streak.last !== today) {
          streak.count = streak.last === yesterdayKey ? streak.count + 1 : 1;
          streak.last = today;
          try { window.localStorage.setItem(STREAK_KEY, JSON.stringify(streak)); memStreak = null; } catch { memStreak = { last: streak.last, count: streak.count }; }
        }
        const live = streak.count >= 2 && (streak.last === today || streak.last === yesterdayKey);
        streakNode.hidden = !live;
        if (live) streakNode.textContent = streak.count + "-day streak";
      } catch {
        streakNode.hidden = true;
      }
    };
    // Share today: "0x9 dles · Nov 2 / ✅ 5/8 games · 🔥 12-day streak / d.0x9.ca" via the share sheet, else the clipboard.
    const shareBtn = box.querySelector("#daily-share");
    if (shareBtn) {
      shareBtn.addEventListener("click", async () => {
        const skippedSet = window.dglSkippedToday();
        const rows = getRows().filter((row) => !window.dglIsSkipped(row.id, row.kind, row.min, skippedSet));
        if (rows.length === 0) return;
        const played = rows.filter((row) => window.dglIsPlayed(row.id, row.kind, row.min)).length;
        const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date());
        const streak = readStreak();
        const live = played === rows.length && streak.count >= 2 && streak.last === window.dglDateKey(new Date());
        const host = (window.DGL_SHORT_ORIGIN || window.location.origin).replace(/^https?:\\/\\//, "");
        const text = "0x9 dles · " + day + "\\n✅ " + played + "/" + rows.length + " games" + (live ? " · 🔥 " + streak.count + "-day streak" : "") + "\\n" + host;
        if (navigator.share) {
          try {
            await navigator.share({ text });
            return;
          } catch (error) {
            if (error && error.name === "AbortError") return;
          }
        }
        let ok = false;
        try {
          await navigator.clipboard.writeText(text);
          ok = true;
        } catch {
          const area = document.createElement("textarea");
          area.value = text;
          area.setAttribute("readonly", "");
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          try { ok = document.execCommand("copy"); } catch {}
          area.remove();
        }
        if (ok) window.appToast?.("Copied");
        else window.appToast?.("Could not copy. Try again.", "error");
      });
    }
    next.addEventListener("click", () => {
      if (!nextRow || !nextRow.url) return;
      window.open(nextRow.url, "_blank", "noopener");
      // Only a game's own site counts; the details page (shown until the address loads) doesn't.
      if (new URL(nextRow.url, window.location.href).origin !== window.location.origin) window.dglMarkPlayed(nextRow.id);
    });
    (window.dglPlayedHooks = window.dglPlayedHooks || []).push(update);
    return { update };
  };

  window.dglTodayRotation = (() => {
    let cache = null;
    let pending = null;
    const load = async () => {
      const weekday = ((new Date().getDay() + 6) % 7) + 1;
      let base = [];
      const session = await fetch("/api/me/session").then((r) => (r.ok ? r.json() : null), () => null);
      if (!session) return null;
      if (session.signedIn) {
        const r = await fetch("/api/me/rotation?weekday=" + weekday);
        if (!r.ok) return null;
        base = (await r.json()).results || [];
      } else {
        base = window.dglGames.readLocalFavorites();
      }
      const ids = [...new Set(base.map((g) => g.id))];
      const info = {};
      for (let i = 0; i < ids.length; i += 50) {
        const r = await fetch("/api/games/rotation-info?ids=" + ids.slice(i, i + 50).map(encodeURIComponent).join(","));
        if (r.ok) Object.assign(info, await r.json());
      }
      // Games without info are no longer listed.
      return base.filter((g) => info[g.id]).map((g) => ({
        id: g.id, slug: g.slug, title: g.title, url: info[g.id].url,
        kind: info[g.id].reset ? info[g.id].reset.kind : "", min: info[g.id].reset ? info[g.id].reset.min : ""
      }));
    };
    // Resolves to today's games ([] when none, null when the request failed). Reuses the last answer if it is
    // younger than maxAgeMs and from the same day.
    const get = (maxAgeMs) => {
      const day = window.dglDateKey(new Date());
      if (cache && cache.day === day && Date.now() - cache.at < maxAgeMs) return Promise.resolve(cache.items);
      if (!pending) {
        pending = load().then((items) => { if (items) cache = { at: Date.now(), day, items }; return items; }, () => null).finally(() => { pending = null; });
      }
      return pending;
    };
    return { get };
  })();

  // Reset reminders: one browser notification per game per reset, from one open tab at a time.
  window.dglReminders = (() => {
    const KEY = "dgl_reminders_v1";
    const REMINDED_KEY = "dgl_reminded_v1";
    const LOCK_KEY = "dgl_reminder_lock_v1";
    const tabId = Math.random().toString(36).slice(2);
    const supported = () => "Notification" in window;
    const read = () => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(KEY) || "{}");
        const minutes = [30, 60, 120].includes(Number(parsed && parsed.minutes)) ? Number(parsed.minutes) : 60;
        return { on: !!(parsed && parsed.on), minutes };
      } catch {
        return { on: false, minutes: 60 };
      }
    };
    const write = (value) => { try { window.localStorage.setItem(KEY, JSON.stringify(value)); } catch {} };
    const readJson = (key) => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    };
    // Simple lock: the tab that wrote it last, within the past 2.5 minutes, is the one that notifies.
    const holdsLock = () => {
      try {
        const lock = readJson(LOCK_KEY);
        if (lock.id && lock.id !== tabId && Date.now() - Number(lock.at) < 150000) return false;
        window.localStorage.setItem(LOCK_KEY, JSON.stringify({ id: tabId, at: Date.now() }));
        return readJson(LOCK_KEY).id === tabId;
      } catch {
        return false;
      }
    };
    let busy = false;
    const check = async () => {
      const settings = read();
      if (!settings.on || !supported() || Notification.permission !== "granted" || !window.dglIsPlayed || busy || window.dglReminders.pushActive() || !holdsLock()) return;
      busy = true;
      try {
        const items = await window.dglTodayRotation.get(10 * 60 * 1000);
        const reminded = readJson(REMINDED_KEY);
        const skippedNow = window.dglSkippedToday();
        const now = Date.now();
        Object.keys(reminded).forEach((id) => { if (!(Number(reminded[id]) > now - 2 * 24 * 60 * 60 * 1000)) delete reminded[id]; });
        (items || []).forEach((game) => {
          if (game.kind === "" || game.min === "" || window.dglIsPlayed(game.id, game.kind, game.min) || skippedNow.has(game.id)) return;
          const reset = window.dglResetCountdown(game.kind, game.min);
          if (!reset || reset.minutesLeft > settings.minutes) return;
          const resetAt = reset.lastResetAt + 24 * 60 * 60 * 1000;
          if (reminded[game.id] === resetAt) return;
          reminded[game.id] = resetAt;
          try {
            const note = new Notification(game.title + " resets in " + reset.minutesLeft + " min", { body: "You haven't played it yet.", tag: "dgl-" + game.id });
            note.onclick = () => { note.close(); window.focus(); window.location.href = "/games/" + encodeURIComponent(game.slug); };
          } catch {}
        });
        try { window.localStorage.setItem(REMINDED_KEY, JSON.stringify(reminded)); } catch {}
      } finally {
        busy = false;
      }
    };
    (window.dglPlayedHooks = window.dglPlayedHooks || []).push(check);
    // Web Push (signed in, server has VAPID keys): while this browser has a push subscription the server sends the
    // reminders, so the in-tab ones above are skipped to avoid doubles. dgl_push_v1 = "1" is set by the rotation page.
    const PUSH_KEY = "dgl_push_v1";
    const pushActive = () => { try { return window.localStorage.getItem(PUSH_KEY) === "1"; } catch { return false; } };
    const setPushActive = (on) => { try { if (on) window.localStorage.setItem(PUSH_KEY, "1"); else window.localStorage.removeItem(PUSH_KEY); } catch {} };
    return { supported, read, write, check, pushActive, setPushActive };
  })();
`;

// Rotation page: wires the shared widget to the rows of the list with the given id, and draws the play history
// heatmap (localStorage dgl_play_log_v1, { "YYYY-MM-DD": games played }) and the reminder toggle. Recomputed through
// dglPlayedHooks (minute tick, focus, other tabs, dglMarkPlayed).
const DAILY_PROGRESS_SCRIPT = `
  window.dglDailyProgress = (listId) => {
    const list = document.getElementById(listId);
    const box = document.getElementById("daily-progress");
    if (!list || !box) return;
    // Today's rows: Monday is bit 0 of a favorite's weekday mask; rows without a mask (local favorites) run every day.
    const todayItems = () => {
      const bit = 1 << ((new Date().getDay() + 6) % 7);
      return Array.from(list.querySelectorAll("li[data-game-id]")).filter((li) => {
        const mask = li.getAttribute("data-weekday-mask");
        return mask == null || mask === "" || (Number(mask) & bit) !== 0;
      });
    };
    const getRows = () => todayItems().map((li) => {
      const link = li.querySelector("a.card-link");
      return { id: li.getAttribute("data-game-id"), url: link ? link.href : "", kind: li.dataset.resetKind, min: li.dataset.resetMin };
    });
    const widget = window.dglProgressWidget(box, getRows);
    // Skip today: a button in each of today's rows (both render paths; the anonymous list is built by script, so rows are
    // decorated here and on every list change). Skipped rows dim and sort last (CSS order, so the saved order is untouched).
    const syncSkipUi = () => {
      const todaySet = new Set(todayItems());
      const skippedSet = window.dglSkippedToday();
      list.querySelectorAll("li[data-game-id]").forEach((li) => {
        const actions = li.querySelector(".card-actions");
        if (!actions) return;
        let btn = actions.querySelector("[data-skip-toggle]");
        if (!btn) {
          btn = document.createElement("button");
          btn.type = "button";
          btn.className = "skip-btn";
          btn.setAttribute("data-skip-toggle", "1");
          actions.insertBefore(btn, actions.firstChild);
        }
        const played = !!window.dglIsPlayed && window.dglIsPlayed(li.getAttribute("data-game-id"), li.dataset.resetKind, li.dataset.resetMin);
        const skipped = skippedSet.has(li.getAttribute("data-game-id")) && !played;
        li.classList.toggle("skipped", skipped && todaySet.has(li));
        btn.hidden = played || !todaySet.has(li);
        btn.textContent = skipped ? "Skipped today · Undo" : "Skip today";
      });
    };
    list.addEventListener("click", (event) => {
      const btn = event.target instanceof Element ? event.target.closest("[data-skip-toggle]") : null;
      const li = btn && btn.closest("li[data-game-id]");
      if (!li) return;
      event.preventDefault();
      event.stopPropagation();
      const id = li.getAttribute("data-game-id");
      if (window.dglSkippedToday().has(id)) window.dglUnskip(id);
      else window.dglSkip(id);
    });
    new MutationObserver(() => { syncSkipUi(); widget.update(); }).observe(list, { childList: true });
    window.dglPlayedHooks.push(syncSkipUi);
    syncSkipUi();
    widget.update();

    // Copy as text: today's games as a plain list for chat. Links go to this site's game pages; a check marks games
    // played since their last reset. Falls back to a hidden textarea where the async clipboard API is missing.
    document.getElementById("copy-text-btn")?.addEventListener("click", async () => {
      const skippedSet = window.dglSkippedToday();
      const rows = todayItems().filter((li) => !window.dglIsSkipped(li.getAttribute("data-game-id"), li.dataset.resetKind, li.dataset.resetMin, skippedSet));
      if (rows.length === 0) { window.appToast?.("No games are scheduled for today.", "error"); return; }
      const day = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date());
      const lines = rows.map((li, index) => {
        const played = window.dglIsPlayed ? window.dglIsPlayed(li.getAttribute("data-game-id"), li.dataset.resetKind, li.dataset.resetMin) : false;
        const url = (window.DGL_SHORT_ORIGIN || window.location.origin) + "/g/" + encodeURIComponent(li.getAttribute("data-game-slug") || "");
        return (index + 1) + ". " + (li.getAttribute("data-game-title") || "") + (played ? " ✓" : "") + " — " + url;
      });
      const text = ["My dailies for " + day + ":"].concat(lines).join("\\n");
      const fallbackCopy = () => {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, text.length);
        let ok = false;
        try { ok = document.execCommand("copy"); } catch {}
        area.remove();
        return ok;
      };
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = fallbackCopy();
      }
      if (ok) window.appToast?.("Copied");
      else window.appToast?.("Could not copy. Try again.", "error");
    });

    // Play history: 12 week columns (Monday on top) ending with this week.
    const heat = document.getElementById("play-heatmap");
    const grid = document.getElementById("play-heatmap-grid");
    const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
    const renderHeat = () => {
      let log = {};
      try { log = JSON.parse(window.localStorage.getItem("dgl_play_log_v1") || "{}") || {}; } catch {}
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) - 77);
      const cells = [];
      let playedDays = 0;
      let totalDays = 0;
      for (let i = 0; i < 84; i++) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const cell = document.createElement("span");
        cell.className = "heat-cell";
        if (day > now) {
          cell.classList.add("heat-future");
        } else {
          const count = Math.max(0, Math.floor(Number(log[window.dglDateKey(day)]) || 0));
          totalDays++;
          if (count > 0) playedDays++;
          cell.dataset.level = String(count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 5 ? 3 : 4);
          cell.title = fmt.format(day) + ": " + count + (count === 1 ? " game" : " games");
        }
        cells.push(cell);
      }
      heat.hidden = playedDays === 0;
      grid.setAttribute("aria-label", "Played on " + playedDays + " of the last " + totalDays + " days");
      grid.replaceChildren(...cells);
    };
    if (heat && grid) {
      renderHeat();
      window.dglPlayedHooks.push(renderHeat);
    }

    // Stats card: streaks, recent plays, most-played game and full days, from the local play log. The longest streak
    // is kept in dgl_streak_best_v1 (the streak itself in dgl_streak_v1 resets when it breaks).
    const statsBox = document.getElementById("play-stats");
    const statsTiles = document.getElementById("play-stats-tiles");
    let titleMap = null;
    const num = new Intl.NumberFormat("en-US");
    const renderStats = () => {
      let log = {};
      let byDay = {};
      let streak = { last: "", count: 0 };
      let best = 0;
      try { log = JSON.parse(window.localStorage.getItem("dgl_play_log_v1") || "{}") || {}; } catch {}
      try { byDay = JSON.parse(window.localStorage.getItem("dgl_play_games_v1") || "{}") || {}; } catch {}
      try { const parsed = JSON.parse(window.localStorage.getItem("dgl_streak_v1") || "{}"); if (parsed && typeof parsed.last === "string") streak = { last: parsed.last, count: Math.floor(Number(parsed.count)) || 0 }; } catch {}
      try { best = Math.floor(Number(JSON.parse(window.localStorage.getItem("dgl_streak_best_v1") || "0"))) || 0; } catch {}
      const now = new Date();
      const today = window.dglDateKey(now);
      const yesterday = window.dglDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
      const current = streak.last === today || streak.last === yesterday ? streak.count : 0;
      if (current > best) {
        best = current;
        try { window.localStorage.setItem("dgl_streak_best_v1", String(best)); } catch {}
      }
      const skippedSet = window.dglSkippedToday();
      const rotationSize = todayItems().length;
      const activeSize = todayItems().filter((li) => !window.dglIsSkipped(li.getAttribute("data-game-id"), li.dataset.resetKind, li.dataset.resetMin, skippedSet)).length;
      let week = 0;
      let month = 0;
      let full = 0;
      const tally = {};
      for (let i = 0; i < 30; i++) {
        const key = window.dglDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
        const count = Math.max(0, Math.floor(Number(log[key]) || 0));
        month += count;
        if (i < 7) week += count;
        const size = i === 0 ? activeSize : rotationSize;
        if (size > 0 && count >= size) full++;
        if (Array.isArray(byDay[key])) byDay[key].forEach((id) => { tally[id] = (tally[id] || 0) + 1; });
      }
      if (month === 0 && current === 0 && best === 0) { statsBox.hidden = true; return; }
      statsBox.hidden = false;
      let topId = "";
      Object.keys(tally).forEach((id) => { if (!topId || tally[id] > tally[topId]) topId = id; });
      const nameOf = (id) => {
        const li = Array.from(list.querySelectorAll("li[data-game-id]")).find((row) => row.getAttribute("data-game-id") === id);
        if (li) return li.getAttribute("data-game-title") || "";
        return titleMap && titleMap[id] ? titleMap[id] : "";
      };
      if (topId && !nameOf(topId) && !titleMap) {
        titleMap = {};
        fetch("/api/games/titles").then((r) => (r.ok ? r.json() : null)).then((data) => {
          ((data && data.games) || []).forEach((g) => { titleMap[g.id] = g.title; });
          renderStats();
        }).catch(() => {});
      }
      const tiles = [
        ["Current streak", num.format(current) + (current === 1 ? " day" : " days")],
        ["Longest streak", num.format(best) + (best === 1 ? " day" : " days")],
        ["Plays, last 7 days", num.format(week)],
        ["Plays, last 30 days", num.format(month)]
      ];
      if (topId && nameOf(topId)) tiles.push(["Most played, 30 days", nameOf(topId) + " (" + num.format(tally[topId]) + "x)"]);
      tiles.push(["Full rotation days, 30 days", num.format(full)]);
      statsTiles.replaceChildren(...tiles.map(([label, value]) => {
        const tile = document.createElement("div");
        tile.className = "stat-tile";
        const v = document.createElement("strong");
        v.textContent = value;
        const l = document.createElement("span");
        l.textContent = label;
        tile.append(v, l);
        return tile;
      }));
    };
    if (statsBox && statsTiles) {
      renderStats();
      window.dglPlayedHooks.push(renderStats);
      new MutationObserver(renderStats).observe(list, { childList: true });
    }

    // Reminder toggle (hidden where browser notifications don't exist).
    const opt = document.getElementById("reminder-opt");
    const toggle = document.getElementById("reminder-toggle");
    const minutes = document.getElementById("reminder-minutes");
    if (opt && toggle && minutes && window.dglReminders.supported()) {
      opt.hidden = false;
      const settings = window.dglReminders.read();
      toggle.checked = settings.on && Notification.permission === "granted";
      minutes.value = String(settings.minutes);
      // Push: only when signed in, the server has VAPID keys and the browser has PushManager. Resolves to the
      // application server key (base64url) or null. Also syncs dgl_push_v1 with the real subscription.
      const pushKey = (async () => {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
        try {
          const session = await fetch("/api/me/session").then((r) => (r.ok ? r.json() : null), () => null);
          if (!session || !session.signedIn) { window.dglReminders.setPushActive(false); return null; }
          const cfg = await fetch("/api/me/push/config").then((r) => (r.ok ? r.json() : null), () => null);
          if (!cfg || !cfg.publicKey) return null;
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          window.dglReminders.setPushActive(!!sub && Notification.permission === "granted");
          return cfg.publicKey;
        } catch { return null; }
      })();
      const keyBytes = (s) => {
        const padded = (s + "=".repeat((4 - (s.length % 4)) % 4)).split("-").join("+").split("_").join("/");
        return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
      };
      const deviceLabel = () => {
        const ua = navigator.userAgent || "";
        const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
        const br = /Edg\\//.test(ua) ? "Edge" : /OPR\\/|Opera/.test(ua) ? "Opera" : /Firefox\\/|FxiOS/.test(ua) ? "Firefox" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Chrome\\/|CriOS/.test(ua) ? "Chrome" : /Safari\\//.test(ua) ? "Safari" : "Browser";
        return (os ? br + " on " + os : br).slice(0, 60);
      };
      const sendSub = async (sub) => {
        const res = await fetch("/api/me/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.toJSON().keys || {}, leadMinutes: Number(minutes.value), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, label: deviceLabel() })
        });
        if (!res.ok) { const err = await res.json().catch(() => null); throw new Error((err && err.error) || "Could not turn on background reminders."); }
      };
      const pushOn = async () => {
        const key = await pushKey;
        if (!key) return;
        try {
          const reg = await navigator.serviceWorker.ready;
          let sub = await reg.pushManager.getSubscription();
          if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
          await sendSub(sub);
          window.dglReminders.setPushActive(true);
        } catch (err) {
          if (window.appToast) window.appToast((err && err.message) || "Could not turn on background reminders. Reminders will only show while 0x9 dles is open.", "error", 6000);
        }
      };
      const pushOff = async () => {
        window.dglReminders.setPushActive(false);
        if (!(await pushKey)) return;
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (!sub) return;
          await fetch("/api/me/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
          await sub.unsubscribe();
        } catch {}
      };
      const pushUpdate = async () => {
        if (!window.dglReminders.pushActive()) return;
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (sub) await sendSub(sub);
        } catch {}
      };
      const save = () => { window.dglReminders.write({ on: toggle.checked, minutes: Number(minutes.value) }); if (toggle.checked) window.dglReminders.check(); };
      toggle.addEventListener("change", async () => {
        if (toggle.checked && Notification.permission !== "granted") {
          let result = Notification.permission;
          if (result === "default") {
            try { result = await Notification.requestPermission(); } catch { result = "denied"; }
          }
          if (result !== "granted") {
            toggle.checked = false;
            if (window.appToast) window.appToast("Notifications are blocked. Allow them for this site in your browser settings to get reminders.", "error", 6000);
          }
        }
        save();
        if (toggle.checked) await pushOn(); else await pushOff();
      });
      minutes.addEventListener("change", () => { save(); pushUpdate(); });
    }
  };
`;

// /me/recap: month summary from local play data (signed out) or GET /api/me/recap (signed in).
const RECAP_SCRIPT = `
(() => {
  const root = document.getElementById("main");
  if (!root) return;
  const signedIn = root.getAttribute("data-signed-in") === "1";
  const $ = (id) => document.getElementById(id);
  const num = new Intl.NumberFormat("en-US");
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
  const key2 = (y, m) => y + "-" + String(m).padStart(2, "0");
  const now = new Date();
  const thisMonth = key2(now.getFullYear(), now.getMonth() + 1);
  const shift = (key, delta) => { const [y, m] = key.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + delta, 1)); return key2(d.getUTCFullYear(), d.getUTCMonth() + 1); };
  const monthName = (key) => { const [y, m] = key.split("-").map(Number); return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1))); };
  const monthTitle = (key) => monthName(key) + " " + key.split("-")[0];
  const daysIn = (key) => { const [y, m] = key.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const plural = (n, one, many) => num.format(n) + " " + (n === 1 ? one : many);
  const readLocal = (name) => { try { return JSON.parse(window.localStorage.getItem(name) || "{}") || {}; } catch { return {}; } };

  let month = thisMonth;
  let availableFrom = thisMonth;
  const cache = {};
  const titles = {};
  let titlesLoaded = false;
  const loadTitles = async () => {
    if (titlesLoaded) return;
    titlesLoaded = true;
    try {
      const r = await fetch("/api/games/titles");
      const data = r.ok ? await r.json() : null;
      ((data && data.games) || []).forEach((g) => { titles[g.id] = { title: g.title, slug: g.slug }; });
    } catch {}
  };

  // Normalized: { counts: { "YYYY-MM-DD": n }, tally: { gameId: n }, games: { id: { title, slug } } }
  const localMonth = (key) => {
    const log = readLocal("dgl_play_log_v1");
    const byDay = readLocal("dgl_play_games_v1");
    const counts = {};
    const tally = {};
    for (let d = 1; d <= daysIn(key); d++) {
      const day = key + "-" + String(d).padStart(2, "0");
      const list = Array.isArray(byDay[day]) ? byDay[day] : null;
      const n = list ? list.length : Math.max(0, Math.floor(Number(log[day]) || 0));
      if (n > 0) counts[day] = n;
      if (list) list.forEach((id) => { tally[id] = (tally[id] || 0) + 1; });
    }
    return { counts, tally, games: {} };
  };
  const localFrom = () => {
    const keys = Object.keys(readLocal("dgl_play_log_v1")).concat(Object.keys(readLocal("dgl_play_games_v1"))).filter((k) => k.length === 10 && k[4] === "-").sort();
    return keys.length ? keys[0].slice(0, 7) : thisMonth;
  };
  const serverMonth = async (key) => {
    const r = await fetch("/api/me/recap?month=" + key + "&tz=" + encodeURIComponent(tz), { credentials: "same-origin" });
    if (!r.ok) throw new Error("recap " + r.status);
    const data = await r.json();
    const counts = {};
    Object.keys(data.days).forEach((d) => { if (data.days[d].length) counts[d] = data.days[d].length; });
    const tally = {};
    const games = {};
    data.games.forEach((g) => { tally[g.id] = g.plays; games[g.id] = { title: g.title, slug: g.slug }; });
    if (data.available && data.available.from) availableFrom = data.available.from;
    return { counts, tally, games };
  };
  const get = async (key) => {
    if (!cache[key]) cache[key] = signedIn ? await serverMonth(key) : localMonth(key);
    return cache[key];
  };

  const summarize = (data, key) => {
    const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
    let best = 0;
    let run = 0;
    for (let d = 1; d <= daysIn(key); d++) {
      if (data.counts[key + "-" + String(d).padStart(2, "0")]) { run++; if (run > best) best = run; } else run = 0;
    }
    return { days: Object.keys(data.counts).length, total, distinct: Object.keys(data.tally).length, best };
  };
  const delta = (cur, prev, unit, prevName) => (cur >= prev ? "+" : "-") + num.format(Math.abs(cur - prev)) + " " + unit + " vs " + prevName;

  let current = null;
  const render = async (key) => {
    month = key;
    $("recap-month").textContent = monthTitle(key);
    $("recap-prev").disabled = key <= availableFrom;
    $("recap-next").disabled = key >= thisMonth;
    let data;
    try { data = await get(key); } catch { $("recap-empty").textContent = "Could not load your recap. Try again later."; $("recap-empty").hidden = false; $("recap-body").hidden = true; return; }
    if (key !== month) return;
    const stats = summarize(data, key);
    $("recap-empty").textContent = "Nothing played in " + monthName(key) + ".";
    $("recap-empty").hidden = stats.total > 0;
    $("recap-body").hidden = stats.total === 0;
    if (stats.total === 0) { current = null; return; }
    if (!signedIn && Object.keys(data.tally).length) await loadTitles();
    if (key !== month) return;
    const info = (id) => (data.games[id] && data.games[id].title ? data.games[id] : titles[id] || { title: "", slug: "" });

    const prevKey = shift(key, -1);
    let prev = null;
    if (prevKey >= availableFrom) {
      try { const p = summarize(await get(prevKey), prevKey); if (p.total > 0) prev = p; } catch {}
    }
    if (key !== month) return;
    const prevName = monthName(prevKey);
    const tiles = [
      ["Days played", num.format(stats.days), prev ? delta(stats.days, prev.days, Math.abs(stats.days - prev.days) === 1 ? "day" : "days", prevName) : ""],
      ["Total plays", num.format(stats.total), prev ? delta(stats.total, prev.total, Math.abs(stats.total - prev.total) === 1 ? "play" : "plays", prevName) : ""],
      ["Best run", plural(stats.best, "day", "days"), ""]
    ];
    if (stats.distinct > 0) tiles.splice(2, 0, ["Different games", num.format(stats.distinct), ""]);
    $("recap-tiles").replaceChildren(...tiles.map(([label, value, note]) => {
      const tile = document.createElement("div");
      tile.className = "stat-tile";
      const v = document.createElement("strong");
      v.textContent = value;
      const l = document.createElement("span");
      l.textContent = label;
      tile.append(v, l);
      if (note) { const n = document.createElement("span"); n.className = "recap-delta"; n.textContent = note; tile.append(n); }
      return tile;
    }));

    const top = Object.keys(data.tally).sort((a, b) => data.tally[b] - data.tally[a] || info(a).title.localeCompare(info(b).title)).slice(0, 5).filter((id) => info(id).title);
    $("recap-top-box").hidden = top.length === 0;
    $("recap-top").replaceChildren(...top.map((id) => {
      const li = document.createElement("li");
      const g = info(id);
      if (g.slug) { const a = document.createElement("a"); a.href = "/games/" + encodeURIComponent(g.slug); a.textContent = g.title; li.append(a); } else li.append(g.title);
      li.append(" (" + num.format(data.tally[id]) + ")");
      return li;
    }));

    const cells = [];
    const first = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5)) - 1, 1)).getUTCDay();
    for (let i = 0; i < first; i++) { const b = document.createElement("span"); b.setAttribute("aria-hidden", "true"); cells.push(b); }
    for (let d = 1; d <= daysIn(key); d++) {
      const n = data.counts[key + "-" + String(d).padStart(2, "0")] || 0;
      const cell = document.createElement("span");
      cell.className = "heat-cell recap-day";
      cell.setAttribute("role", "listitem");
      cell.dataset.level = String(n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 5 ? 3 : 4);
      cell.setAttribute("aria-label", monthName(key) + " " + d + ": " + plural(n, "play", "plays"));
      cell.textContent = String(d);
      cells.push(cell);
    }
    $("recap-cal").replaceChildren(...cells);

    const topText = top.map((id) => info(id).title + " (" + data.tally[id] + ")").join(", ");
    current = "My " + monthName(key) + " on 0x9 dles: " + plural(stats.days, "day", "days") + " played, " + plural(stats.total, "play", "plays") +
      (stats.distinct ? ", " + plural(stats.distinct, "game", "games") : "") + "." + (topText ? " Top: " + topText + "." : "") + " " + window.location.origin;
  };

  $("recap-prev").addEventListener("click", () => render(shift(month, -1)));
  $("recap-next").addEventListener("click", () => render(shift(month, 1)));
  $("recap-copy").addEventListener("click", async () => {
    if (!current) return;
    let ok = false;
    try { await navigator.clipboard.writeText(current); ok = true; } catch {
      const area = document.createElement("textarea");
      area.value = current; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
      document.body.appendChild(area); area.select();
      try { ok = document.execCommand("copy"); } catch {}
      area.remove();
    }
    if (ok) window.appToast?.("Copied"); else window.appToast?.("Could not copy. Try again.", "error");
  });

  (async () => {
    if (signedIn) { try { await get(thisMonth); } catch {} } else availableFrom = localFrom();
    render(thisMonth);
  })();
})();
`;

const RESET_LOCALIZE_SCRIPT = `
  window.dglResetCountdown = (kind, min) => {
    const m = Number(min);
    if (!Number.isFinite(m)) return null;
    const now = new Date();
    const next = new Date(now);
    if (kind === "utc") next.setUTCHours(Math.floor(m / 60), m % 60, 0, 0);
    else next.setHours(Math.floor(m / 60), m % 60, 0, 0);
    if (next <= now) next.setTime(next.getTime() + 24 * 60 * 60 * 1000);
    const minutesLeft = Math.ceil((next.getTime() - now.getTime()) / 60000);
    const hours = Math.floor(minutesLeft / 60);
    return {
      at: next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      in: (hours > 0 ? hours + "h " : "") + (minutesLeft % 60) + "m",
      minutesLeft,
      lastResetAt: next.getTime() - 24 * 60 * 60 * 1000
    };
  };
  // When this browser last opened each game ({ gameId: epoch ms }), so cards played since the last reset can be
  // faded. Kept for 3 days; only the latest reset matters.
  const PLAYED_KEY = "dgl_played_v1";
  const PLAY_LOG_KEY = "dgl_play_log_v1";
  const readPlayed = () => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(PLAYED_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  window.dglMarkPlayed = (gameId) => {
    if (!gameId) return;
    const played = readPlayed();
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    Object.keys(played).forEach((id) => { if (!(played[id] > cutoff)) delete played[id]; });
    const prev = Number(played[gameId]) || 0;
    const now = new Date();
    played[gameId] = now.getTime();
    try { window.localStorage.setItem(PLAYED_KEY, JSON.stringify(played)); } catch {}
    // Play history (dgl_play_log_v1, { "YYYY-MM-DD": games }): a game counts once per local day.
    if (!prev || window.dglDateKey(new Date(prev)) !== window.dglDateKey(now)) {
      try {
        const log = JSON.parse(window.localStorage.getItem(PLAY_LOG_KEY) || "{}");
        const days = log && typeof log === "object" && !Array.isArray(log) ? log : {};
        const oldest = window.dglDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 365));
        Object.keys(days).forEach((day) => { if (day < oldest || !(Number(days[day]) > 0)) delete days[day]; });
        const today = window.dglDateKey(now);
        days[today] = (Number(days[today]) || 0) + 1;
        window.localStorage.setItem(PLAY_LOG_KEY, JSON.stringify(days));
      } catch {}
      // Which games, per day (dgl_play_games_v1, { "YYYY-MM-DD": [game ids] }, 35 days): for the rotation stats.
      try {
        const raw = JSON.parse(window.localStorage.getItem("dgl_play_games_v1") || "{}");
        const byDay = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        const oldestDay = window.dglDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 35));
        Object.keys(byDay).forEach((day) => { if (day < oldestDay || !Array.isArray(byDay[day])) delete byDay[day]; });
        const todayKey = window.dglDateKey(now);
        const ids = byDay[todayKey] || [];
        if (!ids.includes(gameId)) ids.push(gameId);
        byDay[todayKey] = ids;
        window.localStorage.setItem("dgl_play_games_v1", JSON.stringify(byDay));
      } catch {}
    }
    window.dglLocalizeResets();
    if (window.dglPlaySync) window.dglPlaySync.marked(gameId, now.getTime());
  };
  // Undoes a play for today (dgl_played_v1 only; the play log keeps the day's count).
  // kind/min = the game's reset data (none: since local midnight); the synced undo deletes plays since that reset.
  window.dglUnmarkPlayed = (gameId, kind, min) => {
    if (!gameId) return;
    const played = readPlayed();
    delete played[gameId];
    try { window.localStorage.setItem(PLAYED_KEY, JSON.stringify(played)); } catch {}
    window.dglLocalizeResets();
    if (window.dglPlaySync) {
      const reset = kind && min != null && min !== "" ? window.dglResetCountdown(kind, min) : null;
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      window.dglPlaySync.unmarked(gameId, reset ? reset.lastResetAt : midnight.getTime());
    }
  };
  // "Mark as played" buttons ([data-played-toggle] = game id, data-played-kind/min = reset, game pages). Hidden
  // until their state is known, so a no-JS visitor never sees one.
  const isPlayedFor = (button) => window.dglIsPlayed(
    button.getAttribute("data-played-toggle") || "",
    button.getAttribute("data-played-kind") || "",
    button.getAttribute("data-played-min") || ""
  );
  const syncPlayedToggles = () => {
    document.querySelectorAll("[data-played-toggle]").forEach((button) => {
      const played = isPlayedFor(button);
      button.textContent = played ? "Played today ✓ · Undo" : "Mark as played";
      button.classList.toggle("is-played", played);
      button.hidden = false;
    });
  };
  (window.dglPlayedHooks = window.dglPlayedHooks || []).push(syncPlayedToggles);
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-played-toggle]") : null;
    if (!button) return;
    const id = button.getAttribute("data-played-toggle") || "";
    if (isPlayedFor(button)) window.dglUnmarkPlayed(id, button.getAttribute("data-played-kind") || "", button.getAttribute("data-played-min") || "");
    else window.dglMarkPlayed(id);
  });
  const cardGameId = (card) =>
    card.getAttribute("data-game-id") || card.querySelector("[data-game-row]")?.getAttribute("data-game-row") || "";
  // Played since the game's last reset (no reset time: since local midnight). Same rule as the .played card class.
  // True when epoch ms "at" is after the game's most recent reset (kind/min = its reset data; none = viewer's local midnight).
  window.dglPlayedSince = (kind, min, at) => {
    const reset = kind && min != null && min !== "" ? window.dglResetCountdown(kind, min) : null;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    return (Number(at) || 0) > (reset ? reset.lastResetAt : since.getTime());
  };
  window.dglIsPlayed = (gameId, kind, min) => window.dglPlayedSince(kind, min, readPlayed()[gameId]);
  window.dglLocalizeResets = (root) => {
    (window.dglPlayedHooks || []).forEach((hook) => { try { hook(); } catch {} });
    const played = readPlayed();
    (root || document).querySelectorAll("[data-reset-at]").forEach((el) => {
      const reset = window.dglResetCountdown(el.getAttribute("data-reset-at-kind"), el.getAttribute("data-reset-at"));
      if (!reset) return;
      const long = el.getAttribute("data-reset-format") === "long";
      el.textContent = long ? "Resets daily at " + reset.at + " · next in " + reset.in : "Resets in " + reset.in;
      el.title = "Resets daily at " + reset.at + " (your time)";
      // The card's bottom line shows the share of the day left before this game resets (12h left = half width).
      const card = el.closest("li");
      if (card) {
        card.classList.add("reset-bar");
        card.style.setProperty("--reset-left", String(Math.min(1, reset.minutesLeft / 1440)));
        // Played since the last reset: fade the card. Not played and under two hours left: red bar.
        const playedAt = Number(played[cardGameId(card)]) || 0;
        const isPlayed = playedAt > reset.lastResetAt;
        card.classList.toggle("played", isPlayed);
        card.classList.toggle("reset-soon", !isPlayed && reset.minutesLeft <= 120);
        if (isPlayed) card.title = "Played since the last reset";
        else if (card.title === "Played since the last reset") card.removeAttribute("title");
      }
    });
  };
  // Opening a game (its card link or Play button, to another site) counts as playing it.
  const onGameOpen = (event) => {
    if (event.type === "auxclick" && event.button !== 1) return;
    const link = event.target instanceof Element ? event.target.closest("a.card-link, a[data-play-id]") : null;
    if (!link || !/^https?:/.test(link.href) || new URL(link.href).origin === window.location.origin) return;
    const card = link.closest("li");
    const id = link.getAttribute("data-play-id") || (card ? cardGameId(card) : "");
    window.dglMarkPlayed(id);
    if (id) document.dispatchEvent(new CustomEvent("dgl:game-opened", { detail: { id, title: link.getAttribute("data-play-title") || (link.closest("[data-game-title]") || card || link).getAttribute("data-game-title") || (link.classList.contains("card-link") ? (link.textContent || "").trim() : "") } }));
    // The one place a play click is counted (feeds the ranking score). keepalive lets it outlive the navigation.
    if (id) fetch("/api/games/" + encodeURIComponent(id) + "/click", { method: "POST", keepalive: true }).catch(() => {});
  };
  document.addEventListener("click", onGameOpen, true);
  document.addEventListener("auxclick", onGameOpen, true);
  window.addEventListener("storage", (event) => { if (event.key === PLAYED_KEY || event.key === PLAY_LOG_KEY) window.dglLocalizeResets(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") window.dglLocalizeResets(); });
  window.dglLocalizeResets();
  window.setInterval(() => window.dglLocalizeResets(), 60 * 1000);
`;

// window.dglRandomGame(filters): a random approved game from GET /api/games/random, skipping the visitor's hidden games
// (sent as exclude). Resolves to null when none match. Keyboard shortcuts (listed in the "?" dialog in layout()):
// ignored while typing or with Ctrl/Meta/Alt. "/" is handled by layout()'s search script.
const SHORTCUTS_SCRIPT = `
  window.dglRandomGame = async (filters = {}) => {
    const params = new URLSearchParams();
    if (filters.category) params.set("category", filters.category);
    if (filters.hidePaywall) params.set("hidePaywall", "1");
    if (filters.hideNsfw) params.set("hideNsfw", "1");
    const hidden = window.dglHidden ? window.dglHidden.read().slice(-200) : [];
    if (hidden.length > 0) params.set("exclude", hidden.join(","));
    const query = params.toString();
    try {
      const response = await fetch("/api/games/random" + (query ? "?" + query : ""));
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };
  (() => {
    const dialog = document.getElementById("shortcuts-dialog");
    if (!dialog) return;
    const isTyping = (node) => node instanceof HTMLElement && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));
    const openDialog = () => { if (!dialog.open) dialog.showModal(); };
    document.querySelectorAll("[data-shortcuts-open]").forEach((button) => button.addEventListener("click", openDialog));
    // Keep Tab inside the modal: a browser can move focus out to its own UI past the last control, which leaves the page.
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll("button, [href], input, select, textarea")].filter((el) => !el.disabled);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    });
    const go = (path) => { window.location.href = path; };
    const randomGame = async () => {
      const game = await window.dglRandomGame();
      if (game) go("/games/" + encodeURIComponent(game.slug));
      else window.appToast?.("No games available.", "error");
    };
    // The first unplayed game of today's rotation opens in a new tab and counts as played (like its Play next button).
    const playNext = async () => {
      const rows = await window.dglTodayRotation.get(60 * 1000);
      if (rows === null) { window.appToast?.("Could not load today's rotation.", "error"); return; }
      if (rows.length === 0) { window.appToast?.("No rotation games today.", "success"); return; }
      const skippedNow = window.dglSkippedToday();
      const next = rows.find((row) => !window.dglIsPlayed(row.id, row.kind, row.min) && !skippedNow.has(row.id));
      if (!next) { window.appToast?.("Nothing left to play today.", "success"); return; }
      window.open(next.url, "_blank", "noopener");
      if (new URL(next.url, window.location.href).origin !== window.location.origin) window.dglMarkPlayed(next.id);
    };
    const DESTINATIONS = { h: "/", b: "/games", r: "/me/rotation" };
    let gPressedAt = 0;
    document.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return;
      if (dialog.open || isTyping(event.target)) return;
      const pendingG = gPressedAt > 0 && Date.now() - gPressedAt < 1000;
      gPressedAt = 0;
      if (pendingG && Object.prototype.hasOwnProperty.call(DESTINATIONS, event.key)) {
        event.preventDefault();
        go(DESTINATIONS[event.key]);
      } else if (event.key === "?") {
        event.preventDefault();
        openDialog();
      } else if (event.key === "r") {
        event.preventDefault();
        randomGame();
      } else if (event.key === "n") {
        event.preventDefault();
        playNext();
      } else if (event.key === "g") {
        gPressedAt = Date.now();
      }
    });
  })();
`;

// Shared client-side vote/favorite actions, loaded on every page by layout(). Logged-out favorites live in
// localStorage (key dgl_local_favorites_v1) and are mirrored to /favorite-anon so they count toward scoring.
const GAME_ACTIONS_SCRIPT = `
  window.dglGames = (() => {
    const FAVORITES_KEY = "dgl_local_favorites_v1";
    const ANON_ID_KEY = "dgl_anon_favorites_id_v1";
    // In-memory copies for browsers where localStorage throws (blocked storage, full quota): they last for the page.
    let memFavorites = null;
    let memAnonId = "";
    const readLocalFavorites = () => {
      if (memFavorites) return memFavorites.slice();
      try {
        const parsed = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row.id === "string" && row.id.length > 0) : [];
      } catch {
        return [];
      }
    };
    const writeLocalFavorites = (items) => {
      try {
        window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(items));
        memFavorites = null;
      } catch {
        memFavorites = items.slice();
      }
    };
    // The API only accepts a UUID. randomUUID is missing outside secure contexts (e.g. the LAN dev URL), and older
    // clients stored non-UUID ids, so those are replaced.
    const getAnonId = () => {
      let value = memAnonId;
      if (!value) { try { value = window.localStorage.getItem(ANON_ID_KEY) || ""; } catch {} }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        value = crypto.randomUUID
          ? crypto.randomUUID()
          : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
        try { window.localStorage.setItem(ANON_ID_KEY, value); } catch {}
      }
      memAnonId = value;
      return value;
    };
    const isLocalFavorite = (gameId) => readLocalFavorites().some((row) => row.id === gameId);
    // Adds or removes a game ({ id, slug, title }) from the local rotation. Returns true if it is now a favorite.
    const toggleLocalFavorite = async (game) => {
      const items = readLocalFavorites();
      const exists = items.some((row) => row.id === game.id);
      writeLocalFavorites(exists ? items.filter((row) => row.id !== game.id) : items.concat([{ id: game.id, slug: game.slug, title: game.title }]));
      await fetch("/api/games/" + encodeURIComponent(game.id) + "/favorite-anon", {
        method: exists ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonId: getAnonId() })
      }).catch(() => undefined);
      return !exists;
    };
    const succeeded = (request) => request.then((response) => response.ok, () => false);
    const setAccountFavorite = (gameId, favorite) =>
      succeeded(fetch("/api/games/" + encodeURIComponent(gameId) + "/favorite", { method: favorite ? "POST" : "DELETE" }));
    // dgl_voted makes the server render pages fresh (skipping the logged-out edge cache) so this visitor sees their votes.
    const hasVoted = () => document.cookie.split(";").some((part) => part.trim().startsWith("dgl_voted="));
    // When this visitor last voted on each game. Live updates leave those games alone for a while, so a poll answered
    // from before the vote (the counts endpoint is edge-cached for 10s) can't undo what they just did.
    const recentVotes = new Map();
    const OWN_VOTE_GRACE_MS = 30000;
    const saveVote = async (gameId, value) => {
      recentVotes.set(gameId, Date.now());
      const ok = await succeeded(fetch("/api/games/" + encodeURIComponent(gameId) + "/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value })
      }));
      if (ok && !hasVoted()) document.cookie = "dgl_voted=1; path=/; max-age=31536000; samesite=lax";
      return ok;
    };
    const isReturningVisitor = () => hasVoted() || readLocalFavorites().length > 0;
    // Same wording as renderLikedLabel and the game page's "Community rating" on the server.
    const likedText = (up, down) => (up + down > 0 ? Math.round((up / (up + down)) * 100) + "% liked" : "");
    const ratingText = (up, down) => {
      const total = up + down;
      return total > 0
        ? Math.round((up / total) * 100) + "% upvoted, from " + total + " community vote" + (total === 1 ? "" : "s")
        : "No votes yet. Played it? Vote above.";
    };
    // One subtle pulse on an element whose value just changed (see .count-bump in layout()).
    const bumpTimers = new WeakMap();
    const bump = (el, tone) => {
      el.classList.remove("count-bump", "count-up", "count-down");
      void el.offsetWidth;
      el.classList.add("count-bump");
      if (tone) el.classList.add(tone);
      // Clears on animationend, or after the 0.7s animation's time if it never fires (reduced motion, see layout()).
      const clear = () => {
        window.clearTimeout(bumpTimers.get(el));
        bumpTimers.delete(el);
        el.classList.remove("count-bump", "count-up", "count-down");
      };
      window.clearTimeout(bumpTimers.get(el));
      bumpTimers.set(el, window.setTimeout(clear, 800));
      el.addEventListener("animationend", clear, { once: true });
    };
    // A game's card or row ([data-game-row]) or the game page ([data-vote-counts]).
    const voteContainer = (node) => (node instanceof Element ? node.closest("[data-game-row], [data-vote-counts]") : null);
    // Accessible names for the vote buttons ("12 upvotes: Upvote <title>"). Same wording as voteButtonLabel() on the server.
    const voteLabels = (container, up, down) => {
      const title = container.getAttribute("data-game-title");
      if (!title) return;
      container.querySelectorAll("[data-vote-button]").forEach((button) => {
        const isUp = button.getAttribute("data-vote-button") === "up";
        const count = isUp ? up : down;
        button.setAttribute("aria-label", count + " " + (isUp ? "upvote" : "downvote") + (count === 1 ? "" : "s") + ": " + (isUp ? "Upvote " : "Downvote ") + title);
      });
    };
    // Shows up/down counts in one container (the counts, "% liked" and rating text), pulsing whatever changed.
    const showCounts = (container, up, down) => {
      voteLabels(container, up, down);
      const upNode = container.querySelector("[data-up-count]");
      const downNode = container.querySelector("[data-down-count]");
      if (upNode && upNode.textContent !== String(up)) { upNode.textContent = String(up); bump(upNode, "count-up"); }
      if (downNode && downNode.textContent !== String(down)) { downNode.textContent = String(down); bump(downNode, "count-down"); }
      const liked = container.querySelector("[data-liked]");
      if (liked instanceof HTMLElement && liked.textContent !== likedText(up, down)) {
        liked.textContent = likedText(up, down);
        liked.hidden = !liked.textContent;
        liked.title = up + " up, " + down + " down";
        if (liked.textContent) bump(liked);
      }
      const rating = container.querySelector("[data-rating]");
      if (rating instanceof HTMLElement && rating.textContent !== ratingText(up, down)) {
        rating.textContent = ratingText(up, down);
        bump(rating);
      }
    };
    // Moves one vote from fromValue to toValue (1, -1 or 0) in the displayed up/down counts.
    const shiftVoteCounts = (upNode, downNode, fromValue, toValue) => {
      if (!(upNode instanceof HTMLElement) || !(downNode instanceof HTMLElement)) return;
      const up = Math.max(0, Number(upNode.textContent || "0") - (fromValue === 1 ? 1 : 0) + (toValue === 1 ? 1 : 0));
      const down = Math.max(0, Number(downNode.textContent || "0") - (fromValue === -1 ? 1 : 0) + (toValue === -1 ? 1 : 0));
      const container = voteContainer(upNode);
      if (container) {
        showCounts(container, up, down);
      } else {
        upNode.textContent = String(up);
        downNode.textContent = String(down);
      }
    };
    // Live vote counts: every 20s while the tab is visible (and straight away when it becomes visible again), fetch
    // the current counts for every game shown and update them in place.
    const LIVE_VOTES_POLL_MS = 20000;
    let livePolling = false;
    const refreshVoteCounts = async () => {
      if (document.visibilityState !== "visible" || livePolling) return;
      const byId = new Map();
      document.querySelectorAll("[data-game-row], [data-vote-counts]").forEach((container) => {
        const id = container.getAttribute("data-game-row") || container.getAttribute("data-vote-counts");
        if (!id || !container.querySelector("[data-up-count], [data-liked], [data-rating]")) return;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(container);
      });
      if (byId.size === 0) return;
      livePolling = true;
      try {
        const ids = [...byId.keys()].sort();
        for (let i = 0; i < ids.length; i += 98) {
          const response = await fetch("/api/games/vote-counts?ids=" + ids.slice(i, i + 98).join(","));
          if (!response.ok) return;
          const counts = (await response.json()).counts || {};
          for (const [id, pair] of Object.entries(counts)) {
            if (Date.now() - (recentVotes.get(id) || 0) < OWN_VOTE_GRACE_MS) continue;
            for (const container of byId.get(id) || []) showCounts(container, Number(pair[0]), Number(pair[1]));
          }
        }
      } catch {
        // Offline or the request failed: try again next time.
      } finally {
        livePolling = false;
      }
    };
    document.addEventListener("DOMContentLoaded", () => window.setInterval(refreshVoteCounts, LIVE_VOTES_POLL_MS));
    document.addEventListener("visibilitychange", refreshVoteCounts);
    // Copies local favorites into the signed-in account and clears them locally. Returns "empty", "failed" or "imported".
    const importLocalFavorites = async () => {
      const ids = [...new Set(readLocalFavorites().map((row) => row.id))];
      if (ids.length === 0) return "empty";
      const ok = await succeeded(fetch("/api/me/favorites/import-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids })
      }));
      if (!ok) return "failed";
      window.localStorage.removeItem(FAVORITES_KEY);
      return "imported";
    };
    // Adds games ({ id, slug, title }) to the visitor's rotation: the account when signed in (additive import,
    // duplicates skipped), else local favorites mirrored to /favorite-anon. Toasts the result. Resolves { ok, added }.
    const addManyToRotation = async (games) => {
      const seen = new Set();
      const list = (games || [])
        .filter((g) => g && typeof g.id === "string" && g.id && !seen.has(g.id) && seen.add(g.id))
        .map((g) => ({ id: g.id, slug: String(g.slug || ""), title: String(g.title || "") }));
      const toast = (message, level) => {
        if (!window.appToast) return;
        window.appToast(message, level, level === "error" ? 3500 : 6000, level === "error" ? undefined : { label: "My rotation", onClick: () => { window.location.href = "/me/rotation"; } });
      };
      if (list.length === 0) return { ok: true, added: 0 };
      const session = await fetch("/api/me/session").then((r) => (r.ok ? r.json() : null), () => null);
      let added = 0;
      if (!session) {
        toast("Could not add the games. Try again.", "error");
        return { ok: false, added: 0 };
      }
      if (session.signedIn) {
        for (let i = 0; i < list.length; i += 500) {
          const response = await fetch("/api/me/favorites/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: 1, items: list.slice(i, i + 500) })
          }).catch(() => null);
          const body = response && response.ok ? await response.json().catch(() => null) : null;
          if (!body) {
            toast("Could not add the games. Try again.", "error");
            return { ok: false, added };
          }
          added += Number(body.imported) || 0;
        }
      } else {
        const current = readLocalFavorites();
        const have = new Set(current.map((row) => row.id));
        const fresh = list.filter((g) => !have.has(g.id));
        if (fresh.length > 0) {
          try {
            writeLocalFavorites(current.concat(fresh));
          } catch {
            toast("Could not save to this browser.", "error");
            return { ok: false, added: 0 };
          }
          const anonId = getAnonId();
          fresh.forEach((g) => {
            fetch("/api/games/" + encodeURIComponent(g.id) + "/favorite-anon", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ anonId })
            }).catch(() => undefined);
          });
        }
        added = fresh.length;
      }
      toast(added > 0 ? "Added " + added + (added === 1 ? " game" : " games") + " to your rotation." : "Those games are already in your rotation.");
      return { ok: true, added };
    };
    window.dglAddManyToRotation = addManyToRotation;
    return { readLocalFavorites, writeLocalFavorites, isLocalFavorite, toggleLocalFavorite, setAccountFavorite, saveVote, shiftVoteCounts, refreshVoteCounts, importLocalFavorites, addManyToRotation, isReturningVisitor };
  })();
`;

// Reloads open pages after a deploy. Every page carries the version that rendered it (<meta name="app-version">);
// this checks /api/version once a minute while the tab is visible, and when it becomes visible again. On a new
// version it reloads, but never while someone is in a text field or has typed into a form (that would lose their
// work): then it waits for them to leave the field, and if a form has unsaved input it only shows a notice.
const VOTE_PROMPT_SCRIPT = `
(() => {
  const KEY = "dgl_vote_prompt_v1";
  const MONTH = 30 * 24 * 60 * 60 * 1000;
  const MIN_AWAY = 20000;
  const root = document.documentElement;
  if (root.classList.contains("dgl-stream") || root.classList.contains("dgl-overlay") || /^\\/admin(\\/|$)/.test(location.pathname)) return;
  let pending = null;
  let shown = false;
  let prompt = null;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { return {}; } };
  const remember = (id) => {
    try {
      const data = read();
      const now = Date.now();
      for (const k of Object.keys(data)) if (now - data[k] > MONTH) delete data[k];
      data[id] = now;
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {}
  };
  const rowFor = (id) => {
    for (const el of document.querySelectorAll("[data-game-row], [data-vote-counts]")) {
      if ((el.getAttribute("data-game-row") || el.getAttribute("data-vote-counts")) === id) return el;
    }
    return null;
  };
  const close = () => {
    if (!prompt) return;
    document.removeEventListener("keydown", onKey);
    prompt.remove();
    prompt = null;
  };
  const onKey = (event) => {
    if (event.key === "Escape" && prompt) { remember(prompt.dataset.gameId); close(); }
  };
  const show = (id, title) => {
    shown = true;
    const row = rowFor(id);
    const box = document.createElement("div");
    box.className = "vote-prompt" + (row ? " inline" : "");
    box.dataset.gameId = id;
    box.setAttribute("role", "status");
    const text = document.createElement("span");
    text.className = "vote-prompt-text";
    text.textContent = "How was " + title + "?";
    const mk = (cls, label, content) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.setAttribute("aria-label", label);
      b.textContent = content;
      return b;
    };
    const up = mk("vote-prompt-btn", "Thumbs up: I liked " + title, "\\u{1F44D}");
    const down = mk("vote-prompt-btn", "Thumbs down: I did not like " + title, "\\u{1F44E}");
    const skip = mk("vote-prompt-skip", "Not now: dismiss rating prompt for " + title, "Not now");
    box.append(text, up, down, skip);
    const vote = async (value) => {
      up.disabled = down.disabled = skip.disabled = true;
      const container = row;
      const previous = container ? Number(container.getAttribute("data-vote")) || 0 : 0;
      const upNode = container && container.querySelector("[data-up-count]");
      const downNode = container && container.querySelector("[data-down-count]");
      if (upNode && downNode && previous !== value) window.dglGames.shiftVoteCounts(upNode, downNode, previous, value);
      const ok = await window.dglGames.saveVote(id, value);
      if (!ok) {
        if (upNode && downNode && previous !== value) window.dglGames.shiftVoteCounts(upNode, downNode, value, previous);
        up.disabled = down.disabled = skip.disabled = false;
        text.textContent = "Could not save your vote.";
        return;
      }
      remember(id);
      if (container) {
        container.setAttribute("data-vote", String(value));
        const ub = container.querySelector('[data-vote-button="up"]');
        const db = container.querySelector('[data-vote-button="down"]');
        ub && ub.classList.toggle("active", value === 1);
        db && db.classList.toggle("active", value === -1);
        ub && ub.setAttribute("aria-pressed", value === 1 ? "true" : "false");
        db && db.setAttribute("aria-pressed", value === -1 ? "true" : "false");
      }
      box.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Thanks for rating " + title + "!" }));
      window.setTimeout(close, 2500);
    };
    up.addEventListener("click", () => vote(1));
    down.addEventListener("click", () => vote(-1));
    skip.addEventListener("click", () => { remember(id); close(); });
    if (row) row.after(box);
    else document.body.appendChild(box);
    prompt = box;
    document.addEventListener("keydown", onKey);
  };
  document.addEventListener("dgl:game-opened", (event) => {
    const d = event.detail || {};
    if (d.id) pending = { id: String(d.id), title: d.title || "", at: Date.now() };
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !pending || shown) return;
    const p = pending;
    if (Date.now() - p.at < MIN_AWAY) return;
    pending = null;
    const row = rowFor(p.id);
    if (row && Number(row.getAttribute("data-vote")) !== 0 && row.hasAttribute("data-vote")) { if (Number(row.getAttribute("data-vote"))) return; }
    const last = read()[p.id];
    if (last && Date.now() - last < MONTH) return;
    const title = p.title || (row && row.getAttribute("data-game-title")) || "";
    if (!title || !window.dglGames) return;
    show(p.id, title);
  });
})();
`;

const APP_UPDATE_SCRIPT = `
  (() => {
    const current = document.querySelector('meta[name="app-version"]')?.getAttribute("content");
    if (!current || current === "dev") return;
    const RELOADED_KEY = "dgl_reloaded_for_version";
    let newVersion = null;
    let unsavedInput = false;
    let noticeShown = false;
    document.addEventListener("input", (event) => {
      const field = event.target;
      // Typing into a form counts as unsaved work, except the search box (its text survives in the URL).
      if (field instanceof Element && field.closest("form") && !field.matches("input[type=search]")) unsavedInput = true;
    }, true);
    document.addEventListener("submit", () => { unsavedInput = false; }, true);
    const editing = () => {
      const active = document.activeElement;
      return !!active && active.matches("input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]");
    };
    const reloadIfSafe = () => {
      if (!newVersion) return;
      try { if (window.sessionStorage.getItem(RELOADED_KEY) === newVersion) return; } catch {}
      if (unsavedInput || document.querySelector("dialog[open]")) {
        if (!noticeShown && window.appToast) {
          noticeShown = true;
          window.appToast("0x9 dles was just updated. Refresh the page when you're done to get the latest version.", "success", 10000);
        }
        return;
      }
      if (editing()) return;
      try { window.sessionStorage.setItem(RELOADED_KEY, newVersion); } catch {}
      window.location.reload();
    };
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/version", { cache: "no-store" });
        if (!response.ok) return;
        const { version } = await response.json();
        if (version && version !== current) newVersion = version;
      } catch {
        return;
      }
      reloadIfSafe();
    };
    window.setInterval(check, 60000);
    document.addEventListener("visibilitychange", check);
    // Someone who was typing when the update arrived gets the reload once they leave the field.
    document.addEventListener("focusout", () => window.setTimeout(reloadIfSafe, 1500));
  })();
`;

// Client helper: toggles a list between its manual order and "resetting soonest" order.
const LIST_SORT_SCRIPT = `
  window.dglListSort = (() => {
    const KEY = "dgl_list_sort_v1";
    // The saved choice is shared by every list; a page without that option (rotations have no vote counts) uses default.
    const readMode = () => {
      try { return window.localStorage.getItem(KEY) || "default"; } catch { return "default"; }
    };
    const writeMode = (mode) => {
      try { window.localStorage.setItem(KEY, mode); } catch {}
    };
    const minutesUntilReset = (li, now) => {
      const kind = li.dataset.resetKind;
      const min = Number(li.dataset.resetMin);
      if (!kind || li.dataset.resetMin === undefined || !Number.isFinite(min)) return Infinity;
      const current = kind === "utc" ? now.getUTCHours() * 60 + now.getUTCMinutes() : now.getHours() * 60 + now.getMinutes();
      return (((min - current) % 1440) + 1440) % 1440;
    };
    // Vote counts as currently shown in the row (live updates included).
    const votes = (li) => ({
      up: Number(li.querySelector("[data-up-count]")?.textContent || "0"),
      down: Number(li.querySelector("[data-down-count]")?.textContent || "0")
    });
    // Share of upvotes; games nobody has voted on go last.
    const upvoteShare = (v) => (v.up + v.down > 0 ? v.up / (v.up + v.down) : -1);
    const init = (list, select) => {
      if (!list || !select) return { refresh() {}, apply() {} };
      const items = () => Array.from(list.children).filter((el) => el.tagName === "LI" && el.hasAttribute("data-game-id"));
      const apply = () => {
        const mode = select.value;
        const now = new Date();
        list.classList.toggle("sorted-by-reset", mode === "reset");
        const isRotation = list.classList.contains("rotation-list") && !!window.dglIsPlayed;
        const playedToday = (li) => isRotation && window.dglIsPlayed(li.dataset.gameId || "", li.dataset.resetKind || "", li.dataset.resetMin ?? "");
        const sorted = items().sort((a, b) => {
          const indexDiff = Number(a.dataset.defaultIndex) - Number(b.dataset.defaultIndex);
          if (mode === "reset") {
            // Rotations: games already played since their reset go last.
            const pa = playedToday(a) ? 1 : 0;
            const pb = playedToday(b) ? 1 : 0;
            if (pa !== pb) return pa - pb;
            const ua = minutesUntilReset(a, now);
            const ub = minutesUntilReset(b, now);
            return ua === ub ? indexDiff : ua < ub ? -1 : 1;
          }
          if (mode === "stream") {
            // Never-played games first, then the longest ago; ties keep the list's own order.
            const ta = a.dataset.lastStream ? Date.parse(a.dataset.lastStream) : -Infinity;
            const tb = b.dataset.lastStream ? Date.parse(b.dataset.lastStream) : -Infinity;
            return ta === tb ? indexDiff : ta < tb ? -1 : 1;
          }
          if (mode === "liked" || mode === "upvotes") {
            const va = votes(a);
            const vb = votes(b);
            // % upvoted, then more votes first; or most upvotes, then higher %. Ties keep the list's own order.
            const primary = mode === "liked" ? upvoteShare(vb) - upvoteShare(va) : vb.up - va.up;
            const secondary = mode === "liked" ? vb.up + vb.down - (va.up + va.down) : upvoteShare(vb) - upvoteShare(va);
            return primary || secondary || indexDiff;
          }
          return indexDiff;
        });
        sorted.forEach((li) => list.appendChild(li));
      };
      // Re-capture the manual order from the DOM (call after the list is rebuilt in its manual order).
      const refresh = () => {
        items().forEach((li, index) => { li.dataset.defaultIndex = String(index); });
        apply();
      };
      const saved = readMode();
      select.value = Array.from(select.options).some((option) => option.value === saved) ? saved : "default";
      select.addEventListener("change", () => { writeMode(select.value); apply(); });
      // Played state and countdowns change over time: re-sort rotations in "resets soonest" (no animation).
      if (list.classList.contains("rotation-list")) (window.dglPlayedHooks = window.dglPlayedHooks || []).push(() => { if (select.value === "reset") apply(); });
      refresh();
      return { refresh, apply };
    };
    return { init };
  })();
`;

// The vote orders need [data-up-count]/[data-down-count] in each row, so only curated lists offer them.
function renderListSortControl(options: { votes?: boolean; rotation?: boolean; stream?: boolean } = {}): string {
  return `<label class="list-sort">Sort
    <select id="list-sort-select" aria-label="Sort order">
      <option value="default">${options.rotation ? "Your order" : "Default order"}</option>
      <option value="reset">${options.rotation ? "Resets soonest" : "Resetting soonest"}</option>
      ${options.votes ? `<option value="liked">Highest % upvoted</option>
      <option value="upvotes">Most upvotes</option>` : ""}
      ${options.stream ? `<option value="stream">Least recently on stream</option>` : ""}
    </select>
  </label>`;
}

// Curated list pages: set before first paint (no layout jump). The sidebar collapse is remembered per browser
// (dgl_list_sidebar_v1); stream mode comes from ?view=stream (never remembered) or the remembered toggle (dgl_list_stream_v1).
// Also parses the stream/overlay params (fit, scroll, top, cols, theme, pos, pane, cycle) into window.DGL_STREAM.
// Handled client-side because the edge-cached HTML is the same for every query string.
const LIST_PAGE_HEAD_SCRIPT = `<script>(function(){var h=document.documentElement,P={view:"",fit:1,scroll:1,top:-1,cols:0,theme:"",pos:"bl",pane:"",cycle:0};try{if(localStorage.getItem("dgl_list_sidebar_v1")==="collapsed")h.classList.add("dgl-sb-collapsed")}catch(e){}try{var q=new URLSearchParams(location.search),v=q.get("view"),n=function(k,lo,hi){var x=parseInt(q.get(k),10);return isNaN(x)?-1:Math.max(lo,Math.min(hi,x))};P.fit=q.get("fit")==="0"?0:1;P.scroll=q.get("scroll")==="0"?0:1;P.top=n("top",0,10);P.cols=Math.max(0,n("cols",1,4));var t=q.get("theme");P.theme=t==="dark"||t==="light"?t:"";var ps=q.get("pos");P.pos=/^(br|bl|tr|tl)$/.test(ps)?ps:"bl";var pn=q.get("pane");P.pane=/^(list|suggestions|fandles)$/.test(pn)?pn:"";var cy=parseInt(q.get("cycle"),10);P.cycle=cy>0?Math.max(10,Math.min(600,cy)):0;if(v==="stream"){P.view="stream";h.classList.add("dgl-stream","dgl-stream-forced")}else if(v==="overlay"){P.view="overlay";h.classList.add("dgl-overlay","dgl-pos-"+P.pos)}else if(localStorage.getItem("dgl_list_stream_v1")==="1")h.classList.add("dgl-stream");if(P.theme&&P.view){if(P.theme==="light")h.dataset.theme="light";else delete h.dataset.theme}}catch(e){}window.DGL_STREAM=P})()</script>`;

const SIDE_ICON_FANDLES = `<svg class="side-ico" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="7.5" cy="6.5" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M2 16c0-3 2.4-5 5.5-5s5.5 2 5.5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="14.5" cy="7.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15 11.3c2 .2 3.6 1.7 3.6 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
const SIDE_ICON_SUGGEST = `<svg class="side-ico" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M3 4.5h14v9H9l-4 3v-3H3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 7v4M8 9h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;

// Stream mode footer: where to suggest, and the three leading suggestions (the suggestions script keeps them current).
function renderStreamBar(host: string, slug: string, suggestionsOn: boolean, suggestions: Array<{ title: string; votes: number }>, fandlesOn = false): string {
  const address = `${host}/c/${slug}`;
  // Pane switcher: invisible until the mouse moves (stream CSS); the list script hides the panes that have nothing to show.
  const paneControl = suggestionsOn || fandlesOn
    ? `<div class="stream-panes" id="stream-panes" role="group" aria-label="Stream pane" hidden>
    <button type="button" data-pane="list" aria-pressed="true">List</button>
    ${suggestionsOn ? `<button type="button" data-pane="suggestions" aria-pressed="false" hidden>Suggestions</button>` : ""}
    ${fandlesOn ? `<button type="button" data-pane="fandles" aria-pressed="false" hidden>Fan-dles</button>` : ""}
  </div>`
    : "";
  return `${paneControl}<div class="stream-bar" id="stream-bar">
    <p class="stream-cta">${suggestionsOn ? "Suggest games at " : ""}<strong>${escapeHtml(address)}</strong></p>
    ${suggestionsOn ? `<ol class="stream-top" id="stream-top" aria-label="Top suggestions">${suggestions.slice(0, 3).map((item) => `<li><span class="st-title">${escapeHtml(item.title)}</span><span class="st-votes">▲ ${item.votes}</span></li>`).join("")}</ol>` : ""}
  </div>
  <button type="button" class="stream-exit" id="stream-exit">Exit stream mode</button>`;
}

// OBS overlay (?view=overlay): a compact panel over a transparent page. The address is copied from the stream bar by
// the list script, so it always matches; the suggestions are filled in by the suggestions script.
function renderOverlayPanel(title: string, suggestionsOn: boolean, suggestions: Array<{ title: string; votes: number }>, showPlayed: boolean): string {
  return `<div class="overlay-panel" id="overlay-panel">
    <p class="ov-title">${escapeHtml(title)}</p>
    ${showPlayed ? `<p class="ov-played" id="ov-played" hidden></p>` : ""}
    <p class="ov-cta"><span id="ov-label">${suggestionsOn ? "Suggest a game: " : ""}</span><strong id="ov-addr"></strong></p>
    ${suggestionsOn ? `<ol class="ov-top" id="ov-top" aria-label="Top suggestions">${suggestions.slice(0, 5).map((item) => `<li><span class="st-title">${escapeHtml(item.title)}</span><span class="st-votes">▲ ${item.votes}</span></li>`).join("")}</ol>` : ""}
    <p class="ov-new" id="ov-new" role="status" hidden></p>
  </div>`;
}

// Stream settings popover (stream mode only): picks the URL params and builds copyable OBS links.
function renderStreamSettings(canMark: boolean, badge: { slug: string; title: string; appUrl: string; shortUrl: string } | null): string {
  let badgeSection = "";
  if (badge) {
    const link = `${badge.shortUrl}/c/${badge.slug}`;
    const img = `${badge.appUrl}/badge/c/${badge.slug}.svg`;
    const html = `<a href="${escapeHtml(link)}"><img src="${escapeHtml(img)}" alt="${escapeHtml(`${badge.title} on 0x9 dles`)}"></a>`;
    const markdown = `[![${badge.title.replace(/[\[\]\\]/g, "")} on 0x9 dles](${img})](${link})`;
    badgeSection = `<h3>Panel badge <span>(Twitch panel or socials)</span></h3>
    <img class="ss-badge-preview" src="/badge/c/${encodeURIComponent(badge.slug)}.svg" width="320" height="60" alt="Panel badge preview">
    <div class="ss-url"><textarea id="ss-badge-md" rows="2" readonly aria-label="Markdown snippet">${escapeHtml(markdown)}</textarea><button type="button" class="ss-copy" data-copy="ss-badge-md">Copy</button></div>
    <div class="ss-url"><textarea id="ss-badge-html" rows="2" readonly aria-label="HTML snippet">${escapeHtml(html)}</textarea><button type="button" class="ss-copy" data-copy="ss-badge-html">Copy</button></div>`;
  }
  return `<button type="button" class="stream-exit stream-settings-btn" id="stream-settings-btn" aria-expanded="false" aria-controls="stream-settings">Stream settings</button>
  <div class="stream-settings" id="stream-settings" role="dialog" aria-label="Stream settings" hidden>
    <h2>Stream settings</h2>
    ${canMark ? `<p class="ss-note">Click a row, or press its number (1-9), to mark it played on stream. Click again to undo.</p>` : ""}
    <p class="ss-note">Pick options, then copy the link into an OBS browser source. Link params: <code>fit=0</code> <code>scroll=0</code> <code>top=N</code> <code>cols=N</code> <code>theme=dark|light</code> <code>pane=list|suggestions|fandles</code> <code>cycle=SECONDS</code></p>
    <label class="ss-check"><input type="checkbox" id="ss-fit" checked> Fit all rows to the screen</label>
    <label class="ss-check"><input type="checkbox" id="ss-scroll" checked> Auto-scroll if they still don't fit</label>
    <label>Columns <select id="ss-cols"><option value="">Auto</option><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
    <label>Suggestions shown <input type="number" id="ss-top" min="0" max="10" value="3"></label>
    <label>Pane <select id="ss-pane"><option value="list">List</option><option value="suggestions">Suggestions</option><option value="fandles">Fan-dles</option></select></label>
    <label>Auto-rotate panes every N seconds (0 = off) <input type="number" id="ss-cycle" min="0" max="600" value="0"></label>
    <label>Theme <select id="ss-theme"><option value="">Your setting</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
    <div class="ss-url"><input type="text" id="ss-stream-url" readonly aria-label="Stream mode link"><button type="button" class="ss-copy" data-copy="ss-stream-url">Copy</button></div>
    <h3>Overlay <span>(transparent, over gameplay)</span></h3>
    <label>Position <select id="ss-pos"><option value="bl">Bottom left</option><option value="br">Bottom right</option><option value="tl">Top left</option><option value="tr">Top right</option></select></label>
    <label>Suggestions shown <input type="number" id="ss-otop" min="0" max="10" value="5"></label>
    <div class="ss-url"><input type="text" id="ss-overlay-url" readonly aria-label="Overlay link"><button type="button" class="ss-copy" data-copy="ss-overlay-url">Copy</button></div>
    ${badgeSection}
  </div>`;
}

// Curated list header and modes: "⋯" overflow menu, clamped description, stream mode.
const LIST_PAGE_SCRIPT = `
  (() => {
    // "Last on stream: Oct 30" labels, in the viewer's own time zone (the HTML is cached and identical for everyone).
    const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
    const dayNum = (d) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    document.querySelectorAll("li[data-last-stream]").forEach((li) => {
      const label = li.querySelector(".last-stream");
      const at = new Date(li.dataset.lastStream);
      if (!label || Number.isNaN(at.getTime())) return;
      const diff = dayNum(new Date()) - dayNum(at);
      label.textContent = "Last on stream: " + (diff <= 0 ? "today" : diff === 1 ? "yesterday" : monthDay.format(at));
      label.hidden = false;
    });
    const root = document.documentElement;
    const wide = window.matchMedia("(min-width: 900px)");
    const head = document.querySelector(".list-head");
    const actions = document.getElementById("head-actions");
    const more = document.getElementById("head-more");
    const moreBtn = document.getElementById("head-more-btn");
    const menu = document.getElementById("head-more-menu");
    const items = actions ? Array.from(actions.querySelectorAll("[data-head-item]")) : [];
    const menuItems = () => Array.from(menu.children);
    const closeMenu = (focusBtn) => {
      if (!menu || menu.hidden) return;
      menu.hidden = true;
      moreBtn.setAttribute("aria-expanded", "false");
      if (focusBtn) moreBtn.focus();
    };
    const openMenu = () => {
      menu.hidden = false;
      moreBtn.setAttribute("aria-expanded", "true");
      menuItems()[0]?.focus();
    };
    const place = (item, inMenu) => {
      if (inMenu) { menu.appendChild(item); item.setAttribute("role", "menuitem"); item.tabIndex = -1; }
      else { actions.insertBefore(item, more); item.removeAttribute("role"); item.removeAttribute("tabindex"); }
    };
    // Actions other than the first (Share) and Edit move into the menu, last first, until the row fits on one line.
    const fit = () => {
      if (!actions || !head || !more) return;
      closeMenu();
      items.forEach((item) => place(item, false));
      more.hidden = true;
      const title = head.querySelector("h1");
      const wrapped = () => actions.getBoundingClientRect().top - title.getBoundingClientRect().top > title.getBoundingClientRect().height * 0.6;
      for (let i = items.length - 1; i > 0; i -= 1) {
        if (wide.matches && !wrapped()) break;
        if (items[i].hasAttribute("data-head-keep")) continue;
        // The item moved last goes first in the menu, so the menu keeps the buttons' own order.
        if (menu.firstChild) menu.insertBefore(items[i], menu.firstChild); else place(items[i], true);
        items[i].setAttribute("role", "menuitem");
        items[i].tabIndex = -1;
        more.hidden = false;
      }
    };
    let fitTimer = 0;
    const scheduleFit = () => { window.cancelAnimationFrame(fitTimer); fitTimer = window.requestAnimationFrame(fit); };
    if (moreBtn) {
      moreBtn.addEventListener("click", () => { if (menu.hidden) openMenu(); else closeMenu(); });
      moreBtn.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" && menu.hidden) { event.preventDefault(); openMenu(); }
      });
      menu.addEventListener("keydown", (event) => {
        const list = menuItems();
        const index = list.indexOf(document.activeElement);
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
        else if (event.key === "ArrowDown") { event.preventDefault(); list[(index + 1) % list.length]?.focus(); }
        else if (event.key === "ArrowUp") { event.preventDefault(); list[(index - 1 + list.length) % list.length]?.focus(); }
        else if (event.key === "Home") { event.preventDefault(); list[0]?.focus(); }
        else if (event.key === "End") { event.preventDefault(); list[list.length - 1]?.focus(); }
        else if (event.key === "Tab") closeMenu();
      });
      menu.addEventListener("click", () => window.setTimeout(() => closeMenu(), 0));
      document.addEventListener("click", (event) => { if (!more.contains(event.target)) closeMenu(); });
    }
    window.addEventListener("resize", scheduleFit);
    fit();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleFit);

    // Description: three lines, then "More".
    const desc = document.getElementById("list-desc");
    const descMore = document.getElementById("list-desc-more");
    const checkDesc = () => {
      if (!desc || !descMore || desc.classList.contains("expanded")) return;
      descMore.hidden = desc.scrollHeight <= desc.clientHeight + 1;
    };
    if (descMore) {
      descMore.addEventListener("click", () => {
        const open = desc.classList.toggle("expanded");
        descMore.textContent = open ? "Less" : "More";
        descMore.setAttribute("aria-expanded", open ? "true" : "false");
      });
      window.addEventListener("resize", checkDesc);
      checkDesc();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(checkDesc);
    }

    // Stream mode: large type, no site chrome or sidebar. ?view=stream forces it for this load only.
    const toggle = document.getElementById("stream-toggle");
    const exit = document.getElementById("stream-exit");
    const setStream = (on) => {
      const wasForced = root.classList.contains("dgl-stream-forced");
      root.classList.toggle("dgl-stream", on);
      if (toggle) toggle.setAttribute("aria-pressed", on ? "true" : "false");
      if (!on && wasForced) {
        root.classList.remove("dgl-stream-forced");
        try { const url = new URL(window.location.href); url.searchParams.delete("view"); window.history.replaceState(null, "", url); } catch {}
      }
      if (!wasForced) { try { window.localStorage.setItem("dgl_list_stream_v1", on ? "1" : "0"); } catch {} }
      if (on) window.scrollTo(0, 0);
      scheduleFit();
      window.setTimeout(checkDesc, 50);
    };
    if (toggle) {
      toggle.setAttribute("aria-pressed", root.classList.contains("dgl-stream") ? "true" : "false");
      toggle.addEventListener("click", () => setStream(!root.classList.contains("dgl-stream")));
    }
    if (exit) exit.addEventListener("click", () => setStream(false));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && root.classList.contains("dgl-stream") && !event.defaultPrevented) setStream(false);
    });

    // Stream mode layout: fit every row above the bottom bar (columns + scale), auto-scroll what still overflows,
    // highlight rows that join while the page is open, and the settings popover. Params: window.DGL_STREAM.
    (() => {
      const P = window.DGL_STREAM || { fit: 1, scroll: 1, top: -1, cols: 0, pos: "bl", theme: "", pane: "", cycle: 0 };
      const list = document.getElementById("list-items");
      const bar = document.getElementById("stream-bar");
      if (!list) return;
      // Suggestions and Fan-dles panes render into a second rows container next to the list; "box" is the visible one.
      const pane = document.createElement("ol");
      pane.className = "rotation-list";
      pane.id = "stream-pane";
      list.after(pane);
      let box = list;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
      const isStream = () => root.classList.contains("dgl-stream");
      const rowsOf = () => Array.from(list.children).filter((li) => li.hasAttribute("data-game-id") && !li.classList.contains("row-leave"));
      const MIN_COL = 400, SPEED = 35, HOLD = 4000, FADE = 400, PAGE_MS = 8000;

      // Auto-scroll of the rows container (never the page).
      let hovered = false, sc = null;
      [list, pane].forEach((el) => {
        el.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse") hovered = true; });
        el.addEventListener("pointerleave", () => { hovered = false; });
      });
      const stopScroll = () => { if (sc) window.cancelAnimationFrame(sc.raf); sc = null; list.style.opacity = ""; pane.style.opacity = ""; };
      const startScroll = () => {
        const list = box;
        const over = isStream() && P.scroll !== 0 && list.scrollHeight > list.clientHeight + 2;
        if (!over) { stopScroll(); if (list.scrollTop) list.scrollTop = 0; return; }
        if (sc) return;
        const st = { phase: "top", t: 0, pos: list.scrollTop, last: performance.now(), raf: 0 };
        sc = st;
        const tick = (now) => {
          st.raf = window.requestAnimationFrame(tick);
          const dt = Math.min(100, now - st.last);
          st.last = now;
          if (hovered || document.hidden) { st.pos = list.scrollTop; return; }
          const max = list.scrollHeight - list.clientHeight;
          if (max <= 2) return;
          if (Math.abs(list.scrollTop - st.pos) > 3) st.pos = list.scrollTop;
          st.t += dt;
          if (reduce.matches) {
            if (st.t >= PAGE_MS) { st.t = 0; st.pos = st.pos >= max - 1 ? 0 : Math.min(max, st.pos + list.clientHeight); list.scrollTop = st.pos; }
            return;
          }
          if (st.phase === "top") { if (st.t >= HOLD) { st.phase = "scroll"; st.t = 0; } }
          else if (st.phase === "scroll") {
            st.pos = Math.min(max, st.pos + SPEED * dt / 1000);
            list.scrollTop = st.pos;
            if (st.pos >= max - 0.5) { st.phase = "bottom"; st.t = 0; }
          } else if (st.phase === "bottom") { if (st.t >= HOLD) { st.phase = "out"; st.t = 0; } }
          else if (st.phase === "out") {
            list.style.opacity = String(Math.max(0, 1 - st.t / FADE));
            if (st.t >= FADE) { st.pos = 0; list.scrollTop = 0; st.phase = "in"; st.t = 0; }
          } else {
            list.style.opacity = String(Math.min(1, st.t / FADE));
            if (st.t >= FADE) { list.style.opacity = ""; st.phase = "top"; st.t = 0; }
          }
        };
        st.raf = window.requestAnimationFrame(tick);
      };

      // One pass: pick columns and a scale so all rows fit above the bar. One read per column count at scale 1,
      // then a short verify loop.
      let raf = 0, timer = 0;
      const pass = () => {
        const list = box;
        if (!isStream()) {
          if (root.classList.contains("dgl-lock")) root.classList.remove("dgl-grid", "dgl-lock");
          box.style.removeProperty("max-height");
          stopScroll();
          return;
        }
        const n = Array.from(list.children).filter((li) => li.hasAttribute("data-game-id") && !li.classList.contains("row-leave")).length;
        if (n === 0) return;
        // Only touch the class when needed: classList.add on a present class still fires the class observer below.
        if (!root.classList.contains("dgl-lock")) { window.scrollTo(0, 0); root.classList.add("dgl-grid", "dgl-lock"); }
        const setCols = (c) => { list.style.setProperty("--stream-cols", String(c)); list.style.setProperty("--stream-rows", String(Math.ceil(n / c))); };
        const setScale = (v) => list.style.setProperty("--stream-scale", String(Math.round(v * 1000) / 1000));
        list.style.maxHeight = "none";
        setScale(1);
        const width = list.getBoundingClientRect().width || window.innerWidth;
        const avail = Math.max(120, Math.floor((bar ? bar.getBoundingClientRect().top : window.innerHeight) - list.getBoundingClientRect().top - 10));
        list.style.setProperty("--stream-avail", avail + "px");
        let cols = P.cols ? Math.min(P.cols, n) : (n >= 7 && width >= 1000 ? 2 : 1);
        let scale = 1;
        if (P.fit !== 0) {
          const maxCols = Math.max(1, Math.min(4, Math.floor(width / MIN_COL), n));
          const basePx = parseFloat(getComputedStyle(list).fontSize) || 32;
          const minScale = Math.min(1, Math.max(14, 22 * window.innerHeight / 1080) / basePx);
          const maxScale = 1.15;
          const options = P.cols ? [cols] : Array.from({ length: maxCols }, (_, i) => i + 1);
          let best = null;
          for (const c of options) {
            setCols(c);
            const s = Math.min(maxScale, avail / list.scrollHeight);
            if (!best || s > best.s + 0.001) best = { c, s };
            if (!P.cols && s >= 0.85) { best = { c, s }; break; }
          }
          cols = best.c;
          setCols(cols);
          scale = Math.max(minScale, best.s);
          // Verify (wrapping isn't linear): shrink until it fits, or grow a little when it fits with room to spare.
          let fitted = 0;
          for (let i = 0; i < 6; i += 1) {
            setScale(scale);
            const h = list.scrollHeight;
            if (h <= avail + 1) {
              fitted = scale;
              if (h >= avail * 0.93 || scale >= maxScale - 0.001) break;
              scale = Math.min(maxScale, scale * avail / h * 0.985);
            } else {
              if (scale <= minScale + 0.001) break;
              scale = Math.max(minScale, scale * avail / h * 0.985);
              if (fitted && scale <= fitted) { scale = fitted; break; }
            }
          }
          if (fitted) scale = fitted;
        } else setCols(cols);
        setScale(scale);
        list.style.maxHeight = avail + "px";
        startScroll();
      };
      const schedule = () => { window.cancelAnimationFrame(raf); raf = window.requestAnimationFrame(pass); };
      const debounced = () => { window.clearTimeout(timer); timer = window.setTimeout(schedule, 120); };
      window.addEventListener("resize", debounced);
      window.addEventListener("load", schedule);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
      if (window.ResizeObserver && bar) new ResizeObserver(debounced).observe(bar);
      new MutationObserver(schedule).observe(root, { attributes: true, attributeFilter: ["class"] });
      if (reduce.addEventListener) reduce.addEventListener("change", () => { stopScroll(); schedule(); });

      // Panes: List (default), Suggestions, Fan-dles. ?pane= pins one, ?cycle=N rotates through the non-empty ones; otherwise
      // the last pane picked is remembered (dgl_stream_pane_v1). Keys: 1/2/3 (not for editors, whose digits mark rows), arrows, [ ].
      {
        const NAMES = ["list", "suggestions", "fandles"];
        const LABELS = { list: "List", suggestions: "Suggestions", fandles: "Fan-dles" };
        const PANE_KEY = "dgl_stream_pane_v1";
        const ctl = document.getElementById("stream-panes");
        const title = document.getElementById("stream-pane-title");
        let sugg = [];
        let want = P.pane || "";
        if (!want) { try { want = window.localStorage.getItem(PANE_KEY) || ""; } catch {} }
        if (NAMES.indexOf(want) < 0) want = "list";
        let eff = "list", sig = "", cycleTimer = 0, hideTimer = 0;
        const fandleRows = () => Array.from(document.querySelectorAll("#fandles ul.games > li")).map((li) => {
          const link = li.querySelector("a.game-title");
          const reset = li.querySelector("[data-reset-at]");
          return {
            id: (li.querySelector("[data-game-row]") || li).getAttribute("data-game-row") || "",
            title: link ? (link.textContent || "").trim() : "",
            url: link ? link.getAttribute("href") || "#" : "#",
            paywall: !!li.querySelector(".paywall-badge"),
            nsfw: !!li.querySelector(".nsfw-badge"),
            dev: (li.querySelector(".dev-pill-name") || {}).textContent || "",
            reset: reset ? { kind: reset.getAttribute("data-reset-at-kind"), at: reset.getAttribute("data-reset-at"), text: reset.textContent } : null
          };
        }).filter((row) => row.title);
        const avail = (name) => name === "list" || (name === "suggestions" && sugg.length > 0) || (name === "fandles" && fandleRows().length > 0);
        const availNames = () => NAMES.filter(avail);
        const mkRow = (row) => {
          const li = document.createElement("li");
          li.setAttribute("data-game-id", row.id);
          const main = document.createElement("div");
          main.className = "item-main";
          const link = document.createElement("a");
          link.className = "game-title";
          link.href = row.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          const text = document.createElement("span");
          text.className = "title-text";
          text.textContent = row.title;
          link.appendChild(text);
          if (row.paywall) { const b = document.createElement("span"); b.className = "paywall-badge"; b.textContent = "$"; link.appendChild(b); }
          if (row.nsfw) { const b = document.createElement("span"); b.className = "nsfw-badge"; b.textContent = "nsfw"; link.appendChild(b); }
          main.appendChild(link);
          if (row.dev || row.reset) {
            const meta = document.createElement("div");
            meta.className = "meta";
            if (row.dev) { const d = document.createElement("span"); d.className = "sp-dev"; d.textContent = (row.kind === "sugg" ? "by " : "✓ ") + row.dev; meta.appendChild(d); }
            if (row.reset) {
              const r = document.createElement("span");
              r.setAttribute("data-reset-at-kind", row.reset.kind || "");
              r.setAttribute("data-reset-at", row.reset.at || "");
              r.setAttribute("data-reset-format", "short");
              r.textContent = row.reset.text;
              meta.appendChild(r);
            }
            main.appendChild(meta);
          }
          li.appendChild(main);
          if (row.votes != null) { const v = document.createElement("span"); v.className = "sp-votes"; v.textContent = "▲ " + row.votes; li.appendChild(v); }
          return li;
        };
        const rowsFor = (name) => name === "suggestions"
          ? sugg.map((s) => ({ id: s.gameId, title: s.title, url: s.url, paywall: !!s.paywall, nsfw: !!s.nsfw, votes: s.votes, kind: "sugg", dev: s.developer ? s.developer.name : "" }))
          : fandleRows();
        const sync = () => {
          eff = avail(want) ? want : "list";
          const names = availNames();
          if (ctl) {
            ctl.hidden = names.length < 2;
            ctl.querySelectorAll("[data-pane]").forEach((btn) => {
              const name = btn.getAttribute("data-pane");
              btn.hidden = !avail(name);
              btn.setAttribute("aria-pressed", name === eff ? "true" : "false");
            });
          }
          if (title) title.textContent = eff === "list" ? "" : " · " + LABELS[eff];
          root.classList.toggle("dgl-pane-alt", eff !== "list");
          root.classList.toggle("dgl-pane-suggestions", eff === "suggestions");
          let changed = false;
          if (eff !== "list") {
            const rows = rowsFor(eff);
            const next = eff + "|" + rows.map((r) => r.id + ":" + r.votes + ":" + r.title).join(",");
            if (next !== sig) {
              sig = next;
              pane.replaceChildren(...rows.map(mkRow));
              if (window.dglLocalizeResets) window.dglLocalizeResets(pane);
              changed = true;
            }
          }
          const nextBox = eff === "list" ? list : pane;
          if (nextBox !== box || changed) {
            stopScroll();
            list.style.removeProperty("max-height");
            pane.style.removeProperty("max-height");
            box = nextBox;
          }
          schedule();
        };
        const startCycle = () => {
          window.clearTimeout(cycleTimer);
          if (!P.cycle) return;
          cycleTimer = window.setTimeout(() => {
            const names = availNames();
            if (isStream() && names.length > 1) { want = names[(names.indexOf(eff) + 1) % names.length]; sync(); }
            startCycle();
          }, P.cycle * 1000);
        };
        const pick = (name) => {
          want = name;
          try { window.localStorage.setItem(PANE_KEY, name); } catch {}
          sync();
          startCycle();
        };
        const step = (dir) => {
          const names = availNames();
          if (names.length > 1) pick(names[(names.indexOf(eff) + dir + names.length) % names.length]);
        };
        window.dglStreamPanes = {
          suggestions: (rows) => { sugg = Array.isArray(rows) ? rows : []; sync(); }
        };
        if (ctl) ctl.addEventListener("click", (event) => {
          const btn = event.target instanceof Element ? event.target.closest("[data-pane]") : null;
          if (btn) pick(btn.getAttribute("data-pane"));
        });
        document.addEventListener("keydown", (event) => {
          if (!isStream() || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
          const target = event.target;
          if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]")) return;
          if (document.querySelector("dialog[open]")) return;
          const k = event.key;
          if (/^[1-3]$/.test(k) && !list.hasAttribute("data-can-mark-played")) {
            if (avail(NAMES[Number(k) - 1])) { event.preventDefault(); pick(NAMES[Number(k) - 1]); }
          } else if (k === "ArrowRight" || k === "]") { event.preventDefault(); step(1); }
          else if (k === "ArrowLeft" || k === "[") { event.preventDefault(); step(-1); }
        });
        // The switcher shows on mouse movement or focus anywhere, and fades out after 3 seconds of stillness.
        const reveal = () => {
          if (!ctl || !isStream()) return;
          ctl.classList.add("show");
          window.clearTimeout(hideTimer);
          hideTimer = window.setTimeout(() => ctl.classList.remove("show"), 3000);
        };
        // Zero-movement events are the browser re-hit-testing after a layout change, not a person.
        document.addEventListener("mousemove", (event) => { if (event.movementX || event.movementY) reveal(); });
        document.addEventListener("focusin", reveal);
        // The "?" dialog is parsed after this script; list its stream keys while stream mode is on.
        const dialogRows = () => document.querySelectorAll("[data-stream-shortcut]").forEach((row) => { row.hidden = !isStream(); });
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", dialogRows); else dialogRows();
        new MutationObserver(dialogRows).observe(root, { attributes: true, attributeFilter: ["class"] });
        sync();
        startCycle();
      }

      // Rows that join while the page is open (live refresh) glow briefly; the overlay shows a one-line notice.
      const seen = new Set(rowsOf().map((li) => li.getAttribute("data-game-id")));
      let sig = Array.from(seen).join(",");
      const ovNew = document.getElementById("ov-new");
      let ovTimer = 0;
      new MutationObserver(() => {
        const rows = rowsOf();
        rows.forEach((li) => {
          const id = li.getAttribute("data-game-id");
          if (seen.has(id)) return;
          seen.add(id);
          li.classList.add("row-new");
          window.setTimeout(() => li.classList.remove("row-new"), reduce.matches ? 10000 : 3000);
          if (ovNew) {
            ovNew.textContent = "New on the list: " + (li.getAttribute("data-game-title") || "");
            ovNew.hidden = false;
            window.clearTimeout(ovTimer);
            ovTimer = window.setTimeout(() => { ovNew.hidden = true; }, reduce.matches ? 10000 : 6000);
          }
        });
        const next = rows.map((li) => li.getAttribute("data-game-id")).join(",");
        if (next !== sig) { sig = next; stopScroll(); schedule(); }
      }).observe(list, { childList: true });

      // Overlay: the address is the stream bar's (same value).
      const addr = document.getElementById("ov-addr");
      const barAddr = document.querySelector("#stream-bar .stream-cta strong");
      if (addr && barAddr) addr.textContent = barAddr.textContent;

      // Settings popover: builds the OBS links from the chosen params.
      const pop = document.getElementById("stream-settings");
      const btn = document.getElementById("stream-settings-btn");
      if (pop && btn) {
        const $ = (id) => document.getElementById(id);
        const num = (el, def) => { const v = parseInt(el.value, 10); return isNaN(v) ? def : Math.max(0, Math.min(10, v)); };
        $("ss-fit").checked = P.fit !== 0;
        $("ss-scroll").checked = P.scroll !== 0;
        $("ss-cols").value = P.cols ? String(P.cols) : "";
        $("ss-theme").value = P.theme || "";
        $("ss-pos").value = P.pos || "bl";
        $("ss-pane").value = P.pane || "list";
        $("ss-cycle").value = String(P.cycle || 0);
        if (P.top >= 0) { $("ss-top").value = String(P.top); $("ss-otop").value = String(P.top); }
        const build = () => {
          const base = (window.DGL_SHORT_ORIGIN || window.location.origin) + window.location.pathname;
          const a = ["view=stream"];
          if (!$("ss-fit").checked) a.push("fit=0");
          if (!$("ss-scroll").checked) a.push("scroll=0");
          if ($("ss-cols").value) a.push("cols=" + $("ss-cols").value);
          if (num($("ss-top"), 3) !== 3) a.push("top=" + num($("ss-top"), 3));
          if ($("ss-theme").value) a.push("theme=" + $("ss-theme").value);
          if ($("ss-pane").value !== "list") a.push("pane=" + $("ss-pane").value);
          const cy = parseInt($("ss-cycle").value, 10);
          if (cy > 0) a.push("cycle=" + Math.max(10, Math.min(600, cy)));
          const o = ["view=overlay"];
          if ($("ss-pos").value !== "bl") o.push("pos=" + $("ss-pos").value);
          if (num($("ss-otop"), 5) !== 5) o.push("top=" + num($("ss-otop"), 5));
          $("ss-stream-url").value = base + "?" + a.join("&");
          $("ss-overlay-url").value = base + "?" + o.join("&");
        };
        pop.addEventListener("input", build);
        pop.addEventListener("change", build);
        build();
        const setOpen = (open) => { pop.hidden = !open; btn.setAttribute("aria-expanded", open ? "true" : "false"); };
        btn.addEventListener("click", () => setOpen(pop.hidden));
        pop.querySelectorAll(".ss-copy").forEach((copy) => copy.addEventListener("click", async () => {
          const input = $(copy.getAttribute("data-copy"));
          try { await navigator.clipboard.writeText(input.value); }
          catch { input.select(); try { document.execCommand("copy"); } catch {} }
          const label = copy.textContent;
          copy.textContent = "Copied";
          window.setTimeout(() => { copy.textContent = label; }, 1500);
        }));
        pop.querySelectorAll(".ss-url input, .ss-url textarea").forEach((input) => input.addEventListener("focus", () => input.select()));
        // Capture phase so Esc closes the popover before the stream-mode Esc handler sees it.
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && !pop.hidden) { event.preventDefault(); setOpen(false); btn.focus(); }
        }, true);
      }
      // Played on stream: rows carry data-last-played-at (UTC ISO). Played = after the game's last reset, or, for games
      // without a reset time, since the viewer's local midnight (window.dglPlayedSince, same rule as dglIsPlayed).
      const counter = document.getElementById("played-count");
      const ovPlayed = document.getElementById("ov-played");
      const canMark = list.hasAttribute("data-can-mark-played");
      const isPlayedRow = (li) => {
        const at = Date.parse(li.getAttribute("data-last-played-at") || "");
        return !isNaN(at) && !!window.dglPlayedSince && window.dglPlayedSince(li.dataset.resetKind || "", li.dataset.resetMin, at);
      };
      let playedSig = "";
      const applyPlayed = () => {
        let done = 0, total = 0;
        rowsOf().forEach((li) => {
          total += 1;
          const played = isPlayedRow(li);
          if (played) done += 1;
          li.classList.toggle("stream-played", played);
          if (canMark) li.classList.add("can-mark");
          const pill = li.querySelector(".played-pill");
          if (pill) pill.hidden = !played;
          const btn = li.querySelector("[data-played-toggle-list]");
          if (btn) {
            btn.hidden = false;
            btn.textContent = played ? "Played ✓" : "Mark played";
            btn.setAttribute("aria-pressed", played ? "true" : "false");
            btn.classList.toggle("is-played", played);
          }
        });
        const text = done + " / " + total + " played today";
        const show = total > 0 && (done > 0 || canMark);
        if (counter) { counter.textContent = text; counter.hidden = !show; }
        if (ovPlayed) { ovPlayed.textContent = text; ovPlayed.hidden = !(total > 0 && done > 0); }
        const sig = done + "/" + total;
        if (sig !== playedSig) { playedSig = sig; schedule(); }
      };
      (window.dglPlayedHooks = window.dglPlayedHooks || []).push(applyPlayed);
      window.dglApplyPlayed = applyPlayed;
      let marking = 0;
      window.dglPlayedBusy = () => marking > 0;
      const markToast = (message) => { if (window.appToast) window.appToast(message, "error", 3500); };
      const togglePlayed = async (li) => {
        if (!canMark || li.dataset.busy) return;
        const prev = li.getAttribute("data-last-played-at") || "";
        const next = isPlayedRow(li) ? "" : new Date().toISOString();
        li.dataset.busy = "1";
        marking += 1;
        li.setAttribute("data-last-played-at", next);
        applyPlayed();
        try {
          const res = await fetch("/api/lists/" + encodeURIComponent(list.getAttribute("data-list-id")) + "/items/" + encodeURIComponent(li.getAttribute("data-game-id")) + "/played", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ played: !!next })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "Could not save that.");
          li.setAttribute("data-last-played-at", data.lastPlayedAt || "");
        } catch (error) {
          li.setAttribute("data-last-played-at", prev);
          markToast(error && error.message ? error.message : "Could not save that.");
        } finally {
          delete li.dataset.busy;
          marking -= 1;
          applyPlayed();
        }
      };
      if (canMark) {
        list.addEventListener("click", (event) => {
          if (!isStream() || event.button) return;
          const li = event.target instanceof Element ? event.target.closest("li[data-game-id]") : null;
          if (!li) return;
          event.preventDefault();
          event.stopPropagation();
          void togglePlayed(li);
        }, true);
        list.addEventListener("click", (event) => {
          const btn = event.target instanceof Element ? event.target.closest("[data-played-toggle-list]") : null;
          const li = btn ? btn.closest("li[data-game-id]") : null;
          if (li) void togglePlayed(li);
        });
        document.addEventListener("keydown", (event) => {
          if (!isStream() || event.ctrlKey || event.metaKey || event.altKey || !/^[1-9]$/.test(event.key)) return;
          const target = event.target;
          if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]")) return;
          const li = rowsOf()[Number(event.key) - 1];
          if (li) { event.preventDefault(); void togglePlayed(li); }
        });
      }
      applyPlayed();
      schedule();
    })();
  })();
`;

function getResetMetaLabel(
  resetBasis: "local" | "server" | null | undefined,
  resetTimeMinutes: number | null | undefined,
  resetTimeZone?: string | null
): string {
  const time = formatResetTime(resetTimeMinutes);
  if (time === "Unknown") {
    return "";
  }
  if (resetBasis === "server" && resetTimeZone) {
    return `Reset ${time} ${timeZoneAbbreviation(resetTimeZone) ?? resetTimeZone}`;
  }
  if (resetBasis === "local" || resetBasis === "server") {
    return `Reset ${time} (${resetBasis.toUpperCase()})`;
  }
  return `Reset ${time}`;
}

// Cloudflare's id for the running Worker version: changes with every deploy (and every secret or config change).
function appVersion(env: Env): string {
  return env.CF_VERSION_METADATA?.id || "dev";
}

function isDevEnv(env: Env): boolean {
  const appEnv = (env.APP_ENV || "").trim().toLowerCase();
  return appEnv === "dev" || appEnv === "development";
}

// A real page for missing games, lists, categories and URLs, so visitors (and crawlers) get somewhere to go next.
async function notFoundPage(c: Context<{ Bindings: Bindings; Variables: AppVariables }>): Promise<Response> {
  return c.html(await layout("Page not found", c.get("user"), `
    <main class="narrow">
      <h1>Page not found</h1>
      <p>We couldn't find that page. The game or list may have been removed, or the link may be mistyped.</p>
      <div class="actions">
        <a class="btn" href="/games">Browse games</a>
        <a class="btn" href="/">Go to the home page</a>
      </div>
    </main>
  `, c.env, { path: c.req.path, noindex: true }), 404);
}

/** Previous / numbered / Next links (first, last and a window around this page keep every page within a few clicks). */
function renderPagination(page: number, totalPages: number, hasMore: boolean, buildPageUrl: (page: number) => string): string {
  if (page <= 1 && !hasMore) return "";
  let markup = `<div class="pagination">`;
  if (page > 1) {
    markup += `<a href="${escapeHtml(buildPageUrl(page - 1))}">&larr; Previous</a>`;
  }
  const pageNumbers = new Set([1, totalPages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= Math.max(totalPages, page)));
  let previousNumber = 0;
  for (const n of [...pageNumbers].sort((a, b) => a - b)) {
    if (n - previousNumber > 1) markup += `<span aria-hidden="true">…</span>`;
    markup += n === page ? `<span aria-current="page">${n}</span>` : `<a href="${escapeHtml(buildPageUrl(n))}" aria-label="Page ${n}">${n}</a>`;
    previousNumber = n;
  }
  if (hasMore) {
    markup += `<a href="${escapeHtml(buildPageUrl(page + 1))}">Next &rarr;</a>`;
  }
  return markup + `</div>`;
}

/** The "Hidden games (N) · Show" toggle under a game grid (cards are hidden before paint by HIDDEN_GAMES_SCRIPT). */
const HIDDEN_TOGGLE_MARKUP = `<p class="hidden-toggle" id="hidden-toggle" hidden><button type="button" id="hidden-toggle-btn" aria-pressed="false"></button></p>
      <script>
        (() => {
          const root = document.documentElement;
          const box = document.getElementById("hidden-toggle");
          const button = document.getElementById("hidden-toggle-btn");
          if (!box || !button || !window.dglHidden) return;
          const refresh = () => {
            const count = window.dglHidden.read().length;
            if (count === 0) root.classList.remove("dgl-show-hidden");
            const showing = root.classList.contains("dgl-show-hidden");
            box.hidden = count === 0;
            button.textContent = "Hidden games (" + count + ") · " + (showing ? "Hide" : "Show");
            button.setAttribute("aria-pressed", showing ? "true" : "false");
          };
          button.addEventListener("click", () => { root.classList.toggle("dgl-show-hidden"); refresh(); });
          window.addEventListener("dglhiddenchange", refresh);
          refresh();
        })();
      </script>`;

// "Music" -> "Music Games", but "Logic Games" stays as is (category names are editor-chosen).
function categoryGamesLabel(name: string): string {
  return /\bgames$/i.test(name) ? name : `${name} Games`;
}

// "Music" -> "Music Game", "Logic Games" -> "Logic Game".
function categoryGameLabel(name: string): string {
  return /\bgames$/i.test(name) ? name.replace(/s$/i, "") : `${name} Game`;
}

// The games on a listing page, in order, linking to their pages on this site.
function gameItemListLd(games: Array<{ slug: string; title: string }>, offset = 0) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: games.map((game, index) => ({
      "@type": "ListItem",
      position: offset + index + 1,
      name: game.title,
      url: `https://dailies.0x9.ca/games/${game.slug}`
    }))
  };
}

// Short, stable, non-cryptographic hash (FNV-1a) for cache-busting query strings.
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function breadcrumbLd(items: Array<[string, string]>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": items.map(([name, path], index) => ({
      "@type": "ListItem",
      position: index + 1,
      name,
      item: `https://dailies.0x9.ca${path}`
    }))
  };
}

let hasListsCache: { value: boolean; until: number } | null = null;
async function hasAnyCuratedLists(env: Env): Promise<boolean> {
  const now = Date.now();
  if (hasListsCache && hasListsCache.until > now) return hasListsCache.value;
  const row = await env.DB.prepare("SELECT EXISTS(SELECT 1 FROM curated_lists) AS ok").first<{ ok: number }>();
  const value = (row?.ok ?? 0) > 0;
  hasListsCache = { value, until: now + 30_000 };
  return value;
}

async function layout(title: string, user: AppUser | null, body: string, env: Env, opts?: { description?: string; path?: string; jsonLd?: unknown[]; noindex?: boolean; image?: { path: string; alt: string }; feed?: { href: string; title: string }; headHtml?: string }): Promise<string> {
  const isAdminEditor = !!user && (user.role === "editor" || user.role === "admin");
  // The lists link only needs to know whether any list exists: remembered per isolate for 30s instead of a query per page.
  const hasListsPromise = hasAnyCuratedLists(env);
  let pendingSubmissionCount = 0;
  let openReportCount = 0;
  if (isAdminEditor) {
    const [pendingSubmissions, openReports] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) as cnt FROM games WHERE status = 'pending'").first<{ cnt: number }>(),
      env.DB.prepare("SELECT COUNT(*) as cnt FROM reports WHERE status = 'open'").first<{ cnt: number }>()
    ]);
    pendingSubmissionCount = pendingSubmissions?.cnt ?? 0;
    openReportCount = openReports?.cnt ?? 0;
  }
  const hasLists = await hasListsPromise;
  const description = opts?.description || "Find the best daily games. Browse, vote, favorite, and explore curated lists.";
  const pagePath = opts?.path || "/";
  // Marks the header link for the page being viewed (screen readers announce it; CSS underlines it).
  const current = (prefix: string) => (pagePath === prefix || pagePath.startsWith(`${prefix}/`) ? ` aria-current="page"` : "");
  const fullTitle = title.includes("0x9 dles") ? title : `${title} | 0x9 dles`;
  const image = opts?.image ?? { path: "/og.png?v=2", alt: "0x9 dles: the best daily games, all in one place" };
  // Links that fit in the header on desktop but move into the ☰ menu on phones.
  const secondaryLinks = [
    hasLists || isAdminEditor ? `<a href="/lists"${current("/lists")}>Lists</a>` : "",
    user ? `<a href="/me/settings"${current("/me/settings")}>Settings</a>` : "",
    isAdminEditor
      ? `<a href="/admin"${current("/admin")}>Admin${openReportCount > 0 ? `<span class="moderation-badge moderation-badge-reports" title="Open reports">${openReportCount}</span>` : ""}${pendingSubmissionCount > 0 ? `<span class="moderation-badge moderation-badge-submissions" title="Pending submissions">${pendingSubmissionCount}</span>` : ""}</a>`
      : "",
    user ? "" : `<a href="/login">Login</a>`
  ].join("");
  const accountMarkup = user
    ? `Signed in as ${escapeHtml(user.displayName || "your account")} (${user.role}) <form method="post" action="/auth/logout" class="logout-form"><button type="submit">Logout</button></form>`
    : isDevEnv(env)
      ? `Dev: <a href="/auth/mock-login/user">User</a> <a href="/auth/mock-login/editor">Editor</a> <a href="/auth/mock-login/admin">Admin</a>`
      : "";
  const themeToggle = `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle light/dark mode" title="Toggle light/dark mode"></button>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <script>try{if(localStorage.getItem("dgl_theme")==="light")document.documentElement.dataset.theme="light"}catch(e){}</script>
    ${opts?.headHtml ?? ""}
    <script>window.DGL_VERSION = ${scriptJson(appVersion(env))};</script>
    <script>window.DGL_SHORT_ORIGIN = ${scriptJson(shortOrigin(env))} || window.location.origin;</script>
    <script>${HIDDEN_GAMES_SCRIPT}</script>
    <script src="${ASSET.headJs}"></script>
    <title>${escapeHtml(fullTitle)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="https://dailies.0x9.ca${pagePath}" />
    <meta property="og:title" content="${escapeHtml(fullTitle)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    ${opts?.noindex ? `<meta name="robots" content="noindex,follow" />` : ""}
    <link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192" />
    <link rel="icon" href="/favicon.ico" type="image/png" sizes="48x48" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="alternate" type="application/atom+xml" title="New games on 0x9 dles" href="/feed.xml" />
    ${opts?.feed ? `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(opts.feed.title)}" href="${escapeHtml(opts.feed.href)}" />` : ""}
    <meta name="theme-color" content="#121212" />
    <meta name="apple-mobile-web-app-title" content="0x9 dles" />
    <meta name="app-version" content="${escapeHtml(appVersion(env))}" />
    <meta property="og:site_name" content="0x9 dles" />
    <meta property="og:image" content="https://dailies.0x9.ca${escapeHtml(image.path)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${escapeHtml(image.alt)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://dailies.0x9.ca${pagePath}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="https://dailies.0x9.ca${escapeHtml(image.path)}" />
    <meta name="twitter:image:alt" content="${escapeHtml(image.alt)}" />
    <meta name="twitter:title" content="${escapeHtml(fullTitle)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <script type="application/ld+json">${scriptJson({
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "0x9 dles",
      "url": "https://dailies.0x9.ca/",
      "description": "A comprehensive directory and hub for discovering, voting on, and tracking daily web games.",
      "potentialAction": {
        "@type": "SearchAction",
        "target": "https://dailies.0x9.ca/games?q={search_term_string}",
        "query-input": "required name=search_term_string"
      }
    })}</script>
    <script type="application/ld+json">${scriptJson({
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": "0x9 dles",
      "url": "https://dailies.0x9.ca/",
      "logo": "https://dailies.0x9.ca/icon.png",
      "sameAs": ["https://github.com/0x9-ca/dailies", "https://discord.gg/uRApjQJ4vh"]
    })}</script>
    ${(opts?.jsonLd ?? []).map((block) => `<script type="application/ld+json">${scriptJson(block)}</script>`).join("\n    ")}
    <link rel="stylesheet" href="${ASSET.appCss}" />
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header">
      <a class="brand" href="/">0<span class="brand-x">x</span>9 dles</a>
      <nav class="site-nav" aria-label="Main">
        <a href="/games"${current("/games")}>Games</a>
        <a href="/me/rotation"${current("/me/rotation")}><span class="label-long">My </span>Rotation</a>
        <a href="/submit"${current("/submit")}>Submit</a>
        <span class="nav-extra">${secondaryLinks}</span>
      </nav>
      <form class="header-search" id="header-search" role="search" action="/games" method="get">
        <input type="search" name="q" id="header-search-input" placeholder="Search games" aria-label="Search games" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="header-search-list" enterkeyhint="search" maxlength="100" />
        <button type="submit" class="header-search-go" aria-label="Search">${SEARCH_ICON}</button>
        <button type="button" class="header-search-close" id="header-search-close" aria-label="Close search">\u2715</button>
        <div class="search-suggest" id="header-search-list" role="listbox" aria-label="Game suggestions"></div>
      </form>
      <div class="header-tools">
        <button type="button" class="search-toggle" id="search-toggle" aria-label="Search games" aria-expanded="false" aria-controls="header-search">${SEARCH_ICON}</button>
        ${accountMarkup ? `<span class="account-desktop">${accountMarkup}</span>` : ""}
        ${themeToggle}
        <details class="nav-menu" id="nav-menu">
          <summary aria-label="Menu">☰${openReportCount + pendingSubmissionCount > 0 ? `<span class="menu-dot"></span>` : ""}</summary>
          <div class="nav-menu-panel">
            <a href="/submit" class="menu-narrow-only">Submit</a>
            ${secondaryLinks}
            <div class="nav-menu-theme">Theme ${themeToggle}</div>
            ${accountMarkup ? `<div class="nav-menu-account">${accountMarkup}</div>` : ""}
          </div>
        </details>
      </div>
    </header>
    ${body.replace(/<main(?![^>]*\sid=)/, '<main id="main" tabindex="-1"')}
    <footer style="text-align: center; padding: 2rem 1rem; margin-top: 4rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.9rem;">
      <p>
        <a href="https://github.com/0x9-ca/dailies" target="_blank" rel="noopener noreferrer">github</a>
        |
        <a href="https://discord.gg/uRApjQJ4vh" target="_blank" rel="noopener noreferrer">discord</a>
        |
        <a href="/mod-log">modlog</a>
        |
        <a href="/changelog">changelog</a>
        |
        <a href="/categories">categories</a>
        |
        <a href="/new">new games</a>
        |
        <a href="/feed.xml">new games feed</a>
        |
        <button type="button" class="footer-button" data-shortcuts-open>Keyboard shortcuts</button>
      </p>
    </footer>
    <dialog id="shortcuts-dialog" class="shortcuts-dialog" aria-labelledby="shortcuts-title">
      <form method="dialog">
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <dl class="shortcut-list">
          <div><dt><kbd>?</kbd></dt><dd>Show this list</dd></div>
          <div><dt><kbd>/</kbd></dt><dd>Search games</dd></div>
          <div><dt><kbd>r</kbd></dt><dd>Open a random game</dd></div>
          <div><dt><kbd>n</kbd></dt><dd>Play the next unplayed game in today's rotation</dd></div>
          <div><dt><kbd>g</kbd> then <kbd>h</kbd></dt><dd>Go to Home</dd></div>
          <div><dt><kbd>g</kbd> then <kbd>b</kbd></dt><dd>Go to Browse</dd></div>
          <div><dt><kbd>g</kbd> then <kbd>r</kbd></dt><dd>Go to Rotation</dd></div>
          <div data-stream-shortcut hidden><dt><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></dt><dd>Stream mode: show the list, suggestions or Fan-dles (editors use the arrows)</dd></div>
          <div data-stream-shortcut hidden><dt><kbd>p</kbd> / <kbd>Shift</kbd>+<kbd>P</kbd></dt><dd>Stream mode: mark the hovered or focused game as now playing / clear it (editors)</dd></div>
          <div data-stream-shortcut hidden><dt><kbd>Esc</kbd></dt><dd>Stream mode: leave stream mode</dd></div>
          <div data-stream-shortcut hidden><dt><kbd>←</kbd> <kbd>→</kbd> or <kbd>[</kbd> <kbd>]</kbd></dt><dd>Stream mode: previous or next pane</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Close this list</dd></div>
        </dl>
        <p class="shortcut-note">Shortcuts are off while you type in a field.</p>
        <div class="actions"><button type="submit" class="btn">Close</button></div>
      </form>
    </dialog>
    <div id="toast-stack" aria-live="polite" aria-atomic="true"></div>
    <script src="${ASSET.appJs}"></script>
  </body>
</html>`;
}

// JSON for an inline <script>: escaping "<" stops a value such as a game title from closing the tag.
const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>`;

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type OAuthProvider = "discord" | "twitch";

// Sent to the provider and again at the token exchange; always APP_URL's host.
function oauthRedirectUri(env: Env, _requestUrl: string, provider: OAuthProvider): string {
  return `${appOrigin(env)}/auth/${provider}/callback`;
}

const OAUTH_AUTHORIZE: Record<OAuthProvider, { url: string; scope: string }> = {
  // identify: user id + name; guilds.members.read: roles in our guild (editor/admin). Twitch: no scopes, so no email.
  discord: { url: "https://discord.com/api/oauth2/authorize", scope: "identify guilds.members.read" },
  twitch: { url: "https://id.twitch.tv/oauth2/authorize", scope: "" }
};

function oauthClientId(env: Env, provider: OAuthProvider): string | undefined {
  return provider === "discord" ? env.OAUTH_DISCORD_CLIENT_ID : env.OAUTH_TWITCH_CLIENT_ID;
}

/** A same-site path to return to after signing in (never an absolute or protocol-relative URL). */
function safeNextPath(value: string | undefined | null): string | null {
  return value && value.length <= 200 && /^\/[^/\\]/.test(value) && !/[\r\n]/.test(value) ? value : null;
}

function beginOAuth(c: Context<{ Bindings: Bindings; Variables: AppVariables }>, provider: OAuthProvider, intent: "login" | "link" | "fandle", scope?: string): Response {
  // The state cookie ties the callback to this browser, so nobody can log someone else into an attacker's account.
  // It also carries the intent (login, or link to the signed-in account), which the callback trusts only via this cookie.
  const state = randomToken();
  setCookie(c, `oauth_state_${provider}`, `${state}.${intent}`, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: wantsSecureCookies(c.env),
    maxAge: 600
  });
  const next = intent === "login" ? safeNextPath(c.req.query("next")) : null;
  if (next) {
    setCookie(c, "login_next", next, { path: "/", httpOnly: true, sameSite: "Lax", secure: wantsSecureCookies(c.env), maxAge: 600 });
  }
  const url = new URL(OAUTH_AUTHORIZE[provider].url);
  url.searchParams.set("client_id", oauthClientId(c.env, provider) ?? "");
  url.searchParams.set("redirect_uri", oauthRedirectUri(c.env, c.req.url, provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope ?? OAUTH_AUTHORIZE[provider].scope);
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

/** The authorization code and intent from a provider callback, or the Response to send instead. */
function readOAuthCallback(
  c: Context<{ Bindings: Bindings; Variables: AppVariables }>,
  provider: OAuthProvider
): { code: string; link: boolean; fandle: boolean } | Response {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const [storedState, intent] = (getCookie(c, `oauth_state_${provider}`) ?? "").split(".");
  deleteCookie(c, `oauth_state_${provider}`, { path: "/" });
  if (c.req.query("error")) {
    // The user pressed cancel on the provider's consent screen.
    if (intent === "fandle") {
      const slug = getCookie(c, "fandle_list");
      deleteCookie(c, "fandle_list", { path: "/" });
      return c.redirect(slug ? `/lists/${encodeURIComponent(slug)}?fandle=cancelled` : "/");
    }
    return c.redirect(intent === "link" ? "/me/settings" : "/login");
  }
  if (!state || !code || !storedState || state !== storedState) {
    return c.text("Invalid OAuth state", 400);
  }
  return { code, link: intent === "link", fandle: intent === "fandle" };
}

type OAuthProfile = {
  provider: OAuthProvider;
  providerUserId: string;
  displayName: string | null;
  role?: AppUser["role"];
  avatarUrl?: string | null;
  /** Twitch only: the channel name and Twitch's broadcaster_type ("affiliate" / "partner", or null for neither). */
  twitchLogin?: string | null;
  creatorType?: "affiliate" | "partner" | null;
};

/**
 * Finishes a provider sign-in. A login signs in to (or creates) the account for that provider account. A link
 * (started from Settings) attaches it to the signed-in user instead, merging its existing account if it has one.
 */
async function completeOAuth(c: Context<{ Bindings: Bindings; Variables: AppVariables }>, profile: OAuthProfile, link: boolean, nextOverride?: string): Promise<Response> {
  if (!link) {
    const userId = await upsertOAuthUser(c.env, profile);
    await saveOAuthAvatar(c.env, profile);
    await syncCreatorStatus(c.env, userId, profile);
    // Someone who has just joined the server and signed in gets the Dle Developer role at once, not at the next check.
    await queueDeveloperRole(c.env, userId);
    await createSession(c, userId);
    const next = safeNextPath(nextOverride) ?? safeNextPath(getCookie(c, "login_next"));
    deleteCookie(c, "login_next", { path: "/" });
    return c.redirect(next ?? "/?importLocal=1");
  }
  const user = c.get("user");
  if (!user) {
    return c.redirect("/login");
  }
  const result = await linkOAuthAccount(c.env, user.id, profile);
  if (result !== "conflict") {
    await saveOAuthAvatar(c.env, profile);
    await syncCreatorStatus(c.env, user.id, profile);
    await queueDeveloperRole(c.env, user.id);
  }
  return c.redirect(`/me/settings?link=${result}&provider=${profile.provider}`);
}

/**
 * Attaches a provider account to userId. If that provider account already belongs to another user, that user is
 * merged into userId (the person has just proven they control both). Refused when it would leave the account with
 * two accounts from the same provider.
 */
async function linkOAuthAccount(env: Env, userId: string, profile: OAuthProfile): Promise<"linked" | "merged" | "already" | "conflict"> {
  const owner = await env.DB.prepare("SELECT user_id FROM oauth_accounts WHERE provider = ?1 AND provider_user_id = ?2")
    .bind(profile.provider, profile.providerUserId)
    .first<{ user_id: string }>();
  let result: "linked" | "merged" | "already";
  if (owner?.user_id === userId) {
    result = "already";
  } else {
    const providersOf = async (id: string) =>
      new Set(
        (await env.DB.prepare("SELECT provider FROM oauth_accounts WHERE user_id = ?1").bind(id).all<{ provider: string }>()).results.map((r) => r.provider)
      );
    const mine = await providersOf(userId);
    const incoming = owner ? await providersOf(owner.user_id) : new Set([profile.provider]);
    if ([...incoming].some((provider) => mine.has(provider))) {
      return "conflict";
    }
    if (owner) {
      await mergeUsers(env, owner.user_id, userId);
      result = "merged";
    } else {
      await env.DB.prepare("INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id) VALUES (?1, ?2, ?3, ?4)")
        .bind(crypto.randomUUID(), userId, profile.provider, profile.providerUserId)
        .run();
      result = "linked";
    }
  }
  if (profile.role) {
    // Discord: the account's role follows its guild roles, as on a Discord login.
    await env.DB.prepare("UPDATE users SET role = ?1, updated_at = datetime('now') WHERE id = ?2").bind(profile.role, userId).run();
  }
  if (result !== "already") {
    await writeAudit(env, userId, "user", userId, "link_account", { provider: profile.provider, merged: result === "merged" });
  }
  return result;
}

/**
 * Moves everything owned by fromId onto intoId and deletes fromId, in one D1 batch (a transaction). Duplicate
 * favorites and votes keep intoId's copy; fromId's rotation is appended after intoId's.
 */
async function mergeUsers(env: Env, fromId: string, intoId: string): Promise<void> {
  const affected = await env.DB.prepare("SELECT game_id FROM votes WHERE user_id = ?1 UNION SELECT game_id FROM favorites WHERE user_id = ?1")
    .bind(fromId)
    .all<{ game_id: string }>();
  const fromShareToken = (await env.DB.prepare("SELECT rotation_share_token FROM users WHERE id = ?1").bind(fromId).first<{ rotation_share_token: string | null }>())
    ?.rotation_share_token ?? null;
  const reassign = (table: string, column: string) =>
    env.DB.prepare(`UPDATE ${table} SET ${column} = ?2 WHERE ${column} = ?1`).bind(fromId, intoId);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO favorites (user_id, game_id, position, weekday_mask, created_at, updated_at)
       SELECT ?2, game_id, position + (SELECT COALESCE(MAX(position), 0) FROM favorites WHERE user_id = ?2), weekday_mask, created_at, updated_at
       FROM favorites WHERE user_id = ?1`
    ).bind(fromId, intoId),
    env.DB.prepare("DELETE FROM favorites WHERE user_id = ?1").bind(fromId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO votes (user_id, game_id, value, created_at, updated_at)
       SELECT ?2, game_id, value, created_at, updated_at FROM votes WHERE user_id = ?1`
    ).bind(fromId, intoId),
    env.DB.prepare("DELETE FROM votes WHERE user_id = ?1").bind(fromId),
    env.DB.prepare("INSERT OR IGNORE INTO user_plays (user_id, game_id, played_at) SELECT ?2, game_id, played_at FROM user_plays WHERE user_id = ?1").bind(fromId, intoId),
    env.DB.prepare(
      `INSERT INTO user_streaks (user_id, last, count, best, day_log) SELECT ?2, last, count, best, day_log FROM user_streaks WHERE user_id = ?1
       ON CONFLICT(user_id) DO UPDATE SET
         last = CASE WHEN excluded.last > user_streaks.last OR (excluded.last = user_streaks.last AND excluded.count > user_streaks.count) THEN excluded.last ELSE user_streaks.last END,
         count = CASE WHEN excluded.last > user_streaks.last OR (excluded.last = user_streaks.last AND excluded.count > user_streaks.count) THEN excluded.count ELSE user_streaks.count END,
         best = MAX(user_streaks.best, excluded.best)`
    ).bind(fromId, intoId),
    reassign("oauth_accounts", "user_id"),
    reassign("reports", "reported_by_user_id"),
    reassign("reports", "resolved_by_user_id"),
    reassign("audit_log", "actor_user_id"),
    reassign("games", "submitted_by_user_id"),
    reassign("games", "approved_by_user_id"),
    reassign("categories", "created_by_user_id"),
    reassign("game_categories", "assigned_by_user_id"),
    // Only one creator list per owner: if both accounts have one, the merged-away one becomes a plain list.
    env.DB.prepare(
      `UPDATE curated_lists SET kind = 'curated'
       WHERE owner_user_id = ?1 AND kind = 'creator' AND EXISTS (SELECT 1 FROM curated_lists WHERE owner_user_id = ?2 AND kind = 'creator')`
    ).bind(fromId, intoId),
    env.DB.prepare("UPDATE users SET creator_type = COALESCE(creator_type, (SELECT creator_type FROM users WHERE id = ?1)) WHERE id = ?2").bind(fromId, intoId),
    reassign("curated_lists", "owner_user_id"),
    reassign("curated_lists", "created_by_user_id"),
    reassign("curated_lists", "updated_by_user_id"),
    reassign("curated_list_items", "added_by_user_id"),
    env.DB.prepare(
      `INSERT OR IGNORE INTO list_suggestion_votes (curated_list_id, game_id, voter_key, created_at)
       SELECT curated_list_id, game_id, 'user:' || ?2, created_at FROM list_suggestion_votes WHERE voter_key = 'user:' || ?1`
    ).bind(fromId, intoId),
    env.DB.prepare("DELETE FROM list_suggestion_votes WHERE voter_key = 'user:' || ?1").bind(fromId),
    reassign("list_suggestions", "suggested_by_user_id"),
    reassign("list_blocked_games", "blocked_by_user_id"),
    env.DB.prepare("UPDATE OR IGNORE fandle_members SET user_id = ?2 WHERE user_id = ?1").bind(fromId, intoId),
    // A claim the target account already has for the same game stays; the other is dropped with the user row.
    env.DB.prepare("UPDATE OR IGNORE game_claims SET user_id = ?2 WHERE user_id = ?1").bind(fromId, intoId),
    // Keep a shared-rotation link if only the merged-away account had one (cleared first: the token is unique).
    env.DB.prepare("UPDATE users SET rotation_share_token = NULL WHERE id = ?1").bind(fromId),
    env.DB.prepare("UPDATE users SET rotation_share_token = ?2 WHERE id = ?1 AND rotation_share_token IS NULL").bind(intoId, fromShareToken),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(fromId),
    env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(fromId)
  ]);
  // Dropped duplicate votes change the totals; favorites feed the score.
  for (const { game_id: gameId } of affected.results) {
    await env.DB.batch([recountVotesStatement(env, gameId)]);
    await updateGameScore(env, gameId);
  }
  if (affected.results.length > 0) {
    await invalidateGameCaches(env);
  }
}

/** Recomputes a game's up/down vote totals from the account and anonymous vote tables. */
function recountVotesStatement(env: Env, gameId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE games
     SET vote_up_count =
           (SELECT COUNT(*) FROM votes WHERE game_id = ?1 AND value = 1) +
           (SELECT COUNT(*) FROM anonymous_votes WHERE game_id = ?1 AND value = 1),
         vote_down_count =
           (SELECT COUNT(*) FROM votes WHERE game_id = ?1 AND value = -1) +
           (SELECT COUNT(*) FROM anonymous_votes WHERE game_id = ?1 AND value = -1),
         updated_at = datetime('now')
     WHERE id = ?1`
  ).bind(gameId);
}

/** Exchanges an authorization code for an access token, or returns the error Response to send. */
async function exchangeOAuthCode(
  c: Context<{ Bindings: Bindings; Variables: AppVariables }>,
  provider: OAuthProvider,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  code: string
): Promise<string | Response> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUri(c.env, c.req.url, provider)
    })
  });
  if (!res.ok) {
    console.error(`${provider} token exchange failed:`, res.status, await res.text());
    return res.status === 429
      ? c.text("Login is rate limited right now. Please try again in a few minutes.", 429)
      : c.text("OAuth token exchange failed", 400);
  }
  const json = (await res.json()) as { access_token?: string };
  return json.access_token || c.text("OAuth token missing", 400);
}

// The access token is only needed to read the profile once; revoking it means we never hold access to the account.
function revokeOAuthToken(c: Context<{ Bindings: Bindings; Variables: AppVariables }>, provider: OAuthProvider, token: string): void {
  const request =
    provider === "discord"
      ? fetch("https://discord.com/api/oauth2/token/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: c.env.OAUTH_DISCORD_CLIENT_ID,
            client_secret: c.env.OAUTH_DISCORD_CLIENT_SECRET,
            token,
            token_type_hint: "access_token"
          })
        })
      : fetch("https://id.twitch.tv/oauth2/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: c.env.OAUTH_TWITCH_CLIENT_ID ?? "", token })
        });
  c.executionCtx.waitUntil(
    request
      .then((res) => {
        if (!res.ok) console.warn(`${provider} token revoke failed:`, res.status);
      })
      .catch((error) => console.warn(`${provider} token revoke failed:`, error))
  );
}

/**
 * Finds or creates the local user for a provider account. The provider's name is only used as the initial display
 * name, so a name the user later changes in Settings is never overwritten. `role`, when given, is re-applied on
 * every login (Discord guild roles).
 */
async function upsertOAuthUser(
  env: Env,
  args: { provider: OAuthProvider; providerUserId: string; displayName: string | null; role?: AppUser["role"] }
): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT user_id FROM oauth_accounts WHERE provider = ?1 AND provider_user_id = ?2"
  )
    .bind(args.provider, args.providerUserId)
    .first<{ user_id: string }>();

  if (existing) {
    if (args.role) {
      await env.DB.prepare("UPDATE users SET role = ?1, updated_at = datetime('now') WHERE id = ?2 AND role != ?1")
        .bind(args.role, existing.user_id)
        .run();
    }
    return existing.user_id;
  }

  // OAuth accounts don't share an email with us; store a non-contactable placeholder so the NOT NULL/UNIQUE
  // email column is satisfied without ever requesting or persisting the user's real address.
  const userId = crypto.randomUUID();
  const placeholderEmail = `${args.provider}-${args.providerUserId}@users.noreply.dailies`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, display_name, role) VALUES (?1, ?2, ?3, ?4)")
      .bind(userId, placeholderEmail, args.displayName, args.role ?? "user"),
    env.DB.prepare("INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id) VALUES (?1, ?2, ?3, ?4)")
      .bind(crypto.randomUUID(), userId, args.provider, args.providerUserId)
  ]);
  return userId;
}

// Static assets, served at /assets/<name>.<hash>.<css|js> (src/lib/static-assets.ts). The hash is computed once per
// isolate from the content, so a deploy that changes a file changes its URL. Scripts stay classic (non-deferred) and
// sit where their inline versions did, so inline callers still find what they use. To add one: define the string
// (no ${}), register it here, and reference ASSET.<key> from layout() or the page.
const INSTALL_APP_SCRIPT = `
(function () {
  var deferred = null;
  var standalone = function () { return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true; };
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var render = function () {
    document.querySelectorAll("[data-install-app]").forEach(function (box) {
      var btn = box.querySelector("button");
      var hint = box.querySelector(".install-ios");
      var show = !standalone();
      btn.hidden = !(show && deferred);
      hint.hidden = !(show && !deferred && ios);
      box.hidden = btn.hidden && hint.hidden;
    });
  };
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; render(); });
  window.addEventListener("appinstalled", function () { deferred = null; render(); });
  document.querySelectorAll("[data-install-app] button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var e = deferred;
      if (!e) return;
      deferred = null;
      render();
      e.prompt();
    });
  });
  render();
})();
`;
const ROTATION_WEEK_SCRIPT = `
(() => {
  const list = document.getElementById("rotation-list") || document.getElementById("local-rotation-list");
  if (!list) return;
  const KEY = "dgl_rotation_view_v1";
  const css = document.createElement("style");
  css.textContent = ".rv-bar{display:flex;gap:.4rem;margin:.5rem 0}.rv-bar button[aria-pressed=true]{font-weight:700;text-decoration:underline}.rv-week ul{list-style:none;margin:0;padding:0}.rv-week li{padding:.15rem 0}.rv-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:.5rem}.rv-col,.rv-every{border:1px solid currentColor;border-radius:6px;padding:.4rem .5rem;min-width:0;overflow-wrap:anywhere}.rv-col h3,.rv-every h3{margin:0 0 .3rem;font-size:.95rem}.rv-col.rv-today{border-width:3px;font-weight:600}.rv-every{margin-bottom:.5rem}.rv-edit{margin-left:.4rem;font-size:.8rem}.rv-hint{color:var(--muted)}.days-sum{color:var(--muted);font-size:.85rem}.days-ed{margin-top:.4rem;position:relative;z-index:2}.days-ed[hidden]{display:none}.days-ed .days-row{display:flex;flex-wrap:wrap;gap:.25rem;align-items:center}.days-ed button[aria-pressed=true]{font-weight:700;outline:2px solid currentColor}.days-ed .days-day{min-width:2.2rem;min-height:2.2rem;padding:.2rem}li.not-today{opacity:.7}.rotation-list li>.item-main>.days-sum{order:2;flex:1 1 100%}.rotation-list li>.item-main>.days-ed{order:5;flex:1 1 100%}.rv-every ul{columns:2}@media(max-width:639px){.rv-grid{grid-template-columns:1fr}.rv-every ul{columns:1}}";
  document.head.appendChild(css);
  const bar = document.createElement("div");
  bar.className = "rv-bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Rotation view");
  const mk = (id, label) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.dataset.view = id; bar.appendChild(b); return b; };
  mk("today", "Today"); mk("week", "Week");
  const week = document.createElement("section");
  week.className = "rv-week";
  week.setAttribute("aria-label", "Rotation by weekday");
  week.hidden = true;
  list.parentNode.insertBefore(bar, list);
  list.parentNode.insertBefore(week, list);
  const names = [0, 1, 2, 3, 4, 5, 6].map((d) => new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(new Date(2023, 0, 1 + d)));
  const ul = (games) => {
    const el = document.createElement("ul");
    games.forEach((g) => { const li = document.createElement("li"); const a = document.createElement("a"); a.textContent = g.title; if (g.url) { a.href = g.url; a.target = "_blank"; a.rel = "noopener noreferrer"; } li.appendChild(a);
      if (signedIn && g.id) { const b = document.createElement("button"); b.type = "button"; b.className = "link-button rv-edit"; b.textContent = "Edit days"; b.setAttribute("aria-label", "Edit days for " + g.title); b.addEventListener("click", () => editDays(g.id)); li.appendChild(b); }
      el.appendChild(li); });
    return el;
  };
  const games = () => Array.from(list.querySelectorAll("li[data-game-id]")).map((li) => {
    const link = li.querySelector("a.card-link, a.game-title");
    const m = li.getAttribute("data-weekday-mask");
    return { id: li.getAttribute("data-game-id"), title: li.getAttribute("data-game-title") || (link ? link.textContent.trim() : ""), url: link ? link.href : "", mask: m == null || m === "" ? 127 : Number(m) & 127 };
  });
  const signedIn = list.id === "rotation-list";
  const longNames = [0, 1, 2, 3, 4, 5, 6].map((d) => new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(2023, 0, 1 + d)));
  const letters = ["S", "M", "T", "W", "T", "F", "S"];
  const bitOf = (d) => 1 << ((d + 6) % 7);
  const summary = (mask) => {
    if (mask === 127) return "";
    if (mask === 31) return "Weekdays";
    if (mask === 96) return "Weekends";
    const out = [];
    for (const d of [1, 2, 3, 4, 5, 6, 0]) if (mask & bitOf(d)) out.push(names[d]);
    return out.join(", ");
  };
  const maskOf = (li) => { const m = li.getAttribute("data-weekday-mask"); return m == null || m === "" ? 127 : Number(m) & 127; };
  const refreshRow = (li) => {
    const mask = maskOf(li);
    const sum = li.querySelector(".days-sum");
    if (sum) { sum.textContent = summary(mask); sum.hidden = mask === 127; }
    li.classList.toggle("not-today", (mask & bitOf(new Date().getDay())) === 0);
    li.querySelectorAll(".days-day").forEach((b) => b.setAttribute("aria-pressed", String((mask & Number(b.dataset.bit)) !== 0)));
    const every = li.querySelector(".days-all");
    if (every) every.setAttribute("aria-pressed", String(mask === 127));
  };
  const notify = () => { (window.dglPlayedHooks || []).forEach((f) => { try { f(); } catch (e) {} }); };
  const save = async (li, mask) => {
    const prev = li.getAttribute("data-weekday-mask");
    const status = li.querySelector(".days-status");
    li.setAttribute("data-weekday-mask", String(mask)); refreshRow(li); notify();
    try {
      const r = await fetch("/api/me/favorites/" + encodeURIComponent(li.getAttribute("data-game-id")), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ weekdayMask: mask }) });
      if (!r.ok) throw new Error("save");
      if (status) status.textContent = "Saved";
    } catch (e) {
      if (prev == null) li.removeAttribute("data-weekday-mask"); else li.setAttribute("data-weekday-mask", prev);
      refreshRow(li); notify();
      if (status) status.textContent = "Couldn't save days. Try again.";
    }
    if (!week.hidden) renderWeek();
  };
  const decorate = (li) => {
    if (li.querySelector(".days-ed")) return;
    const main = li.querySelector(".item-main"); const actions = li.querySelector(".card-actions");
    if (!main || !actions) return;
    const title = li.getAttribute("data-game-title") || "game";
    const sum = document.createElement("div"); sum.className = "days-sum";
    main.appendChild(sum);
    const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "days-toggle skip-btn"; toggle.textContent = "Days";
    toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-label", "Days you play " + title);
    actions.insertBefore(toggle, actions.firstChild);
    const ed = document.createElement("div"); ed.className = "days-ed"; ed.hidden = true;
    ed.setAttribute("role", "group"); ed.setAttribute("aria-label", "Days you play " + title);
    const row = document.createElement("div"); row.className = "days-row";
    for (let d = 0; d < 7; d++) {
      const b = document.createElement("button"); b.type = "button"; b.className = "days-day"; b.textContent = letters[d];
      b.dataset.bit = String(bitOf(d)); b.setAttribute("aria-label", longNames[d]); b.setAttribute("aria-pressed", "true");
      b.addEventListener("click", () => {
        const cur = maskOf(li); const next = cur ^ bitOf(d);
        const status = ed.querySelector(".days-status");
        if (next === 0) { status.textContent = "Pick at least one day."; return; }
        status.textContent = ""; save(li, next);
      });
      row.appendChild(b);
    }
    const all = document.createElement("button"); all.type = "button"; all.className = "days-all"; all.textContent = "Every day";
    all.addEventListener("click", () => { ed.querySelector(".days-status").textContent = ""; save(li, 127); });
    row.appendChild(all);
    const st = document.createElement("span"); st.className = "days-status days-sum"; st.setAttribute("role", "status"); st.setAttribute("aria-live", "polite");
    row.appendChild(st); ed.appendChild(row); main.appendChild(ed);
    toggle.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); const open = ed.hidden; ed.hidden = !open; toggle.setAttribute("aria-expanded", String(open)); });
    ed.addEventListener("click", (e) => e.stopPropagation());
    refreshRow(li);
  };
  const decorateAll = () => { if (signedIn) list.querySelectorAll("li[data-game-id]").forEach(decorate); };
  const editDays = (id) => {
    show("today", true);
    const li = Array.from(list.querySelectorAll("li[data-game-id]")).find((x) => x.getAttribute("data-game-id") === id);
    if (!li) return;
    decorate(li);
    const ed = li.querySelector(".days-ed"); const t = li.querySelector(".days-toggle");
    ed.hidden = false; t.setAttribute("aria-expanded", "true");
    li.scrollIntoView({ block: "center" });
    const first = ed.querySelector(".days-day"); if (first) first.focus();
  };
  const renderWeek = () => {
    week.textContent = "";
    if (!signedIn) { const p = document.createElement("p"); p.className = "rv-hint"; p.textContent = "Sign in to pick days."; week.appendChild(p); }
    const all = games();
    if (!all.length) { const p = document.createElement("p"); p.textContent = "No games in your rotation yet."; week.appendChild(p); return; }
    const every = all.filter((g) => g.mask === 127);
    if (every.length === all.length) {
      const p = document.createElement("p");
      p.textContent = "All " + all.length + " games are scheduled every day.";
      week.appendChild(p); week.appendChild(ul(all)); return;
    }
    if (every.length) {
      const box = document.createElement("div"); box.className = "rv-every";
      const h = document.createElement("h3"); h.textContent = "Every day: " + every.length + (every.length === 1 ? " game" : " games");
      box.appendChild(h); box.appendChild(ul(every)); week.appendChild(box);
    }
    const grid = document.createElement("div"); grid.className = "rv-grid";
    const today = new Date().getDay();
    for (let d = 0; d < 7; d++) {
      const bit = 1 << ((d + 6) % 7);
      const day = all.filter((g) => g.mask !== 127 && (g.mask & bit) !== 0);
      const col = document.createElement("div"); col.className = "rv-col" + (d === today ? " rv-today" : "");
      if (d === today) col.setAttribute("aria-current", "date");
      const h = document.createElement("h3"); h.textContent = names[d] + " \u00b7 " + (day.length + every.length);
      col.appendChild(h); col.appendChild(ul(day)); grid.appendChild(col);
    }
    week.appendChild(grid);
  };
  const show = (view, save) => {
    const w = view === "week";
    if (w) renderWeek();
    week.hidden = !w; list.hidden = w;
    bar.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
    if (save) { try { localStorage.setItem(KEY, view); } catch (e) {} }
  };
  bar.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.view, true); });
  let saved = "today";
  try { saved = localStorage.getItem(KEY) === "week" ? "week" : "today"; } catch (e) {}
  show(saved, false);
  decorateAll();
  new MutationObserver(() => { decorateAll(); if (!week.hidden) renderWeek(); }).observe(list, { childList: true });
})();
`;
// "LIVE" badges for creator lists. Pages are edge-cached, so live state is fetched here, never rendered into HTML.
// Marks: [data-live-list=<slug>][data-live-login=<twitch login>]. A link element (the header's Twitch button) gets the
// badge inside it; anything else (a list card's <li>) gets its own link to the channel.
const LIVE_BADGES_SCRIPT = `      (() => {
        if (window.__dglLiveBadges) return;
        window.__dglLiveBadges = true;
        const marks = () => Array.from(document.querySelectorAll("[data-live-list]"));
        const home = document.querySelector("[data-live-home]");
        if (marks().length === 0 && !home) return;
        const ago = (iso) => {
          const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
          return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m";
        };
        const renderHome = (live) => {
          if (!home) return;
          const rows = Object.keys(live).map((slug) => Object.assign({ slug }, live[slug])).filter((r) => r.login)
            .sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0)).slice(0, 6);
          const ul = home.querySelector("ul");
          ul.textContent = "";
          rows.forEach((r) => {
            const li = document.createElement("li");
            const add = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; li.append(e); return e; };
            const a = add("a", "live-now-title", r.listTitle || r.slug);
            a.href = "/lists/" + encodeURIComponent(r.slug);
            if (r.nowPlaying) {
              const p = add("span", "live-now-game");
              p.append("Playing ");
              const g = document.createElement("a");
              g.href = "/games/" + encodeURIComponent(r.nowPlaying.slug);
              g.textContent = r.nowPlaying.title;
              p.append(g);
            }
            const v = Number(r.viewerCount) || 0;
            add("span", "live-now-meta", v.toLocaleString("en-US") + " watching" + (r.startedAt ? " \u00b7 live for " + ago(r.startedAt) : ""));
            const w = add("a", "live-now-watch", "Watch");
            w.href = "https://www.twitch.tv/" + encodeURIComponent(r.login);
            w.target = "_blank";
            w.rel = "noopener noreferrer";
            ul.append(li);
          });
          home.hidden = rows.length === 0;
        };
        const apply = (live) => {
          renderHome(live);
          marks().forEach((el) => {
            const info = live[el.dataset.liveList];
            let badge = el.querySelector(":scope > .live-badge, :scope > a.live-badge-link");
            if (!info) { if (badge) badge.remove(); return; }
            const viewers = Number(info.viewerCount) || 0;
            const tip = (info.title ? info.title + " - " : "") + viewers.toLocaleString("en-US") + " viewer" + (viewers === 1 ? "" : "s");
            if (!badge) {
              const isLink = el.tagName === "A";
              badge = document.createElement(isLink ? "span" : "a");
              badge.className = "live-badge" + (isLink ? "" : " live-badge-link");
              badge.setAttribute("data-pulse", "1");
              if (!isLink) {
                badge.href = "https://www.twitch.tv/" + encodeURIComponent(el.dataset.liveLogin || "");
                badge.target = "_blank";
                badge.rel = "noopener noreferrer";
              }
              badge.append("LIVE");
              const hidden = document.createElement("span");
              hidden.className = "visually-hidden";
              hidden.textContent = " now on Twitch";
              badge.append(hidden);
              el.append(isLink ? " " : " ", badge);
            }
            badge.title = tip;
          });
        };
        const load = async () => {
          if (document.hidden) return;
          try {
            const res = await fetch("/api/lists/live", { credentials: "same-origin" });
            if (res.ok) apply(((await res.json()) || {}).live || {});
          } catch (e) {}
        };
        load();
        setInterval(load, 120000);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
      })();
`;
const joinJs = (...parts: string[]) => parts.join(";\n");
const ASSET = {
  page_submit_page: registerAsset("submit-page", "js", PAGE_SCRIPTS["submit-page"].replace("/*@RESET_TZ@*/", () => RESET_TIMEZONE_TOGGLE_SCRIPT)),
  page_game_page: registerAsset("game-page", "js", PAGE_SCRIPTS["game-page"].replace("/*@RESET_TZ@*/", () => RESET_TIMEZONE_TOGGLE_SCRIPT).replace("/*@DEVELOPER@*/", () => DEVELOPER_SCRIPT)),
  page_rotation_signed_in: registerAsset("rotation-signed-in", "js", PAGE_SCRIPTS["rotation-signed-in"].replace("/*@CHECK_SVG_JSON@*/", () => scriptJson(CHECK_SVG))),
  page_rotation_share: registerAsset("rotation-share", "js", PAGE_SCRIPTS["rotation-share"]),
  page_rotation_paste: registerAsset("rotation-paste", "js", PAGE_SCRIPTS["rotation-paste"]),
  page_list_suggestions: registerAsset("list-suggestions", "js", PAGE_SCRIPTS["list-suggestions"]),
  page_list_live: registerAsset("list-live", "js", PAGE_SCRIPTS["list-live"]),
  page_list_edit: registerAsset("list-edit", "js", PAGE_SCRIPTS["list-edit"]),
  page_submit_reset_tz: registerAsset("submit-reset-tz", "js", PAGE_SCRIPTS["submit-reset-tz"].replace("/*@RESET_TZ@*/", () => RESET_TIMEZONE_TOGGLE_SCRIPT)),
  page_admin_resets: registerAsset("admin-resets", "js", PAGE_SCRIPTS["admin-resets"]),
  dev_stats_css: registerAsset("dev-stats", "css", DEVELOPER_STATS_CSS),
  dev_stats_js: registerAsset("dev-stats", "js", DEVELOPER_STATS_SCRIPT),
  page_game_list: registerAsset("game-list", "js", PAGE_SCRIPTS["game-list"]),
  appCss: registerAsset("app", "css", SHARED_CSS),
  headJs: registerAsset("head", "js", joinJs(ERROR_REPORT_SCRIPT, CSRF_FETCH_SCRIPT, GAME_ACTIONS_SCRIPT, ROTATION_TODAY_SCRIPT)),
  appJs: registerAsset("app", "js", joinJs(LAYOUT_SCRIPT, RESET_LOCALIZE_SCRIPT, PLAY_SYNC_SCRIPT, OFFLINE_SCRIPT, SHORTCUTS_SCRIPT, APP_UPDATE_SCRIPT, PILL_FIT_SCRIPT, VOTE_PROMPT_SCRIPT)),
  listPageJs: registerAsset("list-page", "js", LIST_PAGE_SCRIPT),
  liveBadgesJs: registerAsset("live-badges", "js", LIVE_BADGES_SCRIPT),
  embedDialogJs: registerAsset("embed-dialog", "js", EMBED_DIALOG_SCRIPT),
  npCss: registerAsset("now-playing", "css", NOW_PLAYING_CSS),
  npJs: registerAsset("now-playing", "js", NOW_PLAYING_SCRIPT),
  phCss: registerAsset("play-history", "css", PLAY_HISTORY_CSS),
  phJs: registerAsset("play-history", "js", PLAY_HISTORY_SCRIPT),
  listSortJs: registerAsset("list-sort", "js", LIST_SORT_SCRIPT),
  recapJs: registerAsset("recap", "js", RECAP_SCRIPT),
  installJs: registerAsset("install-app", "js", INSTALL_APP_SCRIPT),
  dailyProgressJs: registerAsset("daily-progress", "js", DAILY_PROGRESS_SCRIPT),
  rotationWeekJs: registerAsset("rotation-week", "js", ROTATION_WEEK_SCRIPT),
  page_home_strip: registerAsset("home-strip", "js", PAGE_SCRIPTS["home-strip"]),
  page_home_new_cats: registerAsset("home-new-cats", "js", PAGE_SCRIPTS["home-new-cats"]),
  page_games_page: registerAsset("games-page", "js", PAGE_SCRIPTS["games-page"]),
  page_lists_page: registerAsset("lists-page", "js", PAGE_SCRIPTS["lists-page"]),
  page_settings_hidden: registerAsset("settings-hidden", "js", PAGE_SCRIPTS["settings-hidden"]),
  page_settings_page: registerAsset("settings-page", "js", PAGE_SCRIPTS["settings-page"]),
  page_list_layout: registerAsset("list-layout", "js", PAGE_SCRIPTS["list-layout"]),
  page_admin_settings: registerAsset("admin-settings", "js", PAGE_SCRIPTS["admin-settings"]),
  page_admin_creators: registerAsset("admin-creators", "js", PAGE_SCRIPTS["admin-creators"]),
  page_admin_reports: registerAsset("admin-reports", "js", PAGE_SCRIPTS["admin-reports"]),
  page_admin_categories: registerAsset("admin-categories", "js", PAGE_SCRIPTS["admin-categories"]),
  page_admin_lists: registerAsset("admin-lists", "js", PAGE_SCRIPTS["admin-lists"]),
};
