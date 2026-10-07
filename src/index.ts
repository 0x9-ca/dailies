import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppUser, AppVariables, Env } from "./env";
import { computeGameScore } from "./lib/ranking";
import { canonicalizeUrl, normalizeTimeInput, normalizeUrlInput, slugify } from "./lib/url";
import { createSession, destroySession, hashToken, randomToken, requireAuth, requireRole, sessionMiddleware, wantsSecureCookies } from "./lib/auth";
import { ICON_180, ICON_192, ICON_48, ICON_512, OG_IMAGE_PNG } from "./lib/assets";
import { getCachedJson, invalidateGameCaches, setCachedJson } from "./lib/cache";
import { categoryHue, renderGameOgPng } from "./lib/og";

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
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
});

// Session bootstrap for every request.
app.use("*", sessionMiddleware);

// Only production should be indexed; staging and local dev ask crawlers to stay away.
app.use("*", async (c, next) => {
  await next();
  if (c.env.APP_ENV !== "production") {
    c.header("X-Robots-Tag", "noindex, nofollow");
  }
});

// Logged-out views of public pages are served from Cloudflare's edge cache for a minute, so they cost no D1 reads.
// Visitors with a session, or who have voted (dgl_voted cookie, set by dglGames.saveVote), get a fresh render that
// shows their own votes. Cached copies never contain cookies; the CSRF cookie is added per response instead.
const PUBLIC_CACHE_SECONDS = 60;
const PUBLIC_CACHE_PATHS = /^\/(games(\/[^/]+)?|lists(\/[^/]+)?|mod-log)?$/;

app.use("*", async (c, next) => {
  const cacheable =
    c.req.method === "GET" &&
    !isDevEnv(c.env) &&
    PUBLIC_CACHE_PATHS.test(c.req.path) &&
    !getCookie(c, c.env.SESSION_COOKIE_NAME) &&
    !getCookie(c, "dgl_voted");
  c.set("publicCache", cacheable);
  if (!cacheable) {
    await next();
    return;
  }

  const cacheKey = new Request(c.req.url);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    ensureCsrfCookie(c);
    return c.body(await cached.text(), 200, { "Content-Type": cached.headers.get("Content-Type") ?? "text/html; charset=UTF-8", "Cache-Control": "no-cache", "X-Page-Cache": "HIT" });
  }

  await next();
  if (c.res.status === 200 && (c.res.headers.get("Content-Type") ?? "").startsWith("text/html")) {
    const copy = new Response(c.res.clone().body, { headers: { "Content-Type": c.res.headers.get("Content-Type")!, "Cache-Control": `public, max-age=${PUBLIC_CACHE_SECONDS}` } });
    c.executionCtx.waitUntil(caches.default.put(cacheKey, copy));
  }
  // Browsers must revalidate, or a visitor who just voted could be shown their own stale copy.
  c.header("Cache-Control", "no-cache");
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
  ensureCsrfCookie(c);
  await next();
});

app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
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
      role: provider === "discord" ? (role === "admin" || role === "editor" ? role : "user") : undefined
    },
    c.req.query("link") === "1"
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
    const discordUser = userRes.ok ? ((await userRes.json()) as { id?: string; username?: string | null; global_name?: string | null }) : null;
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
      { provider: "discord", providerUserId: discordUser.id, displayName: discordUser.username || discordUser.global_name || null, role },
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

app.get("/auth/twitch/callback", async (c) => {
  const callback = readOAuthCallback(c, "twitch");
  if (callback instanceof Response) {
    return callback;
  }
  const { code, link } = callback;
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
      ? ((await userRes.json()) as { data?: Array<{ id: string; login?: string; display_name?: string }> }).data?.[0]
      : undefined;
    if (!twitchUser?.id) {
      return c.text("OAuth profile fetch failed", 400);
    }

    return await completeOAuth(
      c,
      { provider: "twitch", providerUserId: twitchUser.id, displayName: twitchUser.display_name || twitchUser.login || null },
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
app.get("/", async (c) => {
  const user = c.get("user");
  const shouldPromptImport = c.req.query("importLocal") === "1";
  // 8 per list for the two-column desktop layout; narrower screens show the first 5 (see .home-columns CSS).
  const topGames = await listGames(c.env, { sort: "top", limit: 8 });
  const topGameIds = topGames.map((game) => game.id);
  const newGames = await listGames(c.env, { sort: "new", limit: 8 });
  const newGameIds = newGames.map((game) => game.id);
  const { votes: userVotes, favorites: userFavorites } = await getViewerGameState(c, [...new Set([...topGameIds, ...newGameIds])]);
  const playableCount = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM games WHERE status = 'approved'").first<{ n: number }>())?.n ?? 0;

  const topGamesMarkup = renderCompactGameList(topGames, user, userVotes, userFavorites);
  const newGamesMarkup = renderCompactGameList(newGames, user, userVotes, userFavorites);
  return c.html(await layout("0x9 dles – Find the Best Daily Games", user, `
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
      <div class="home-columns">
        <section>
          <h2>Popular Today</h2>
          ${topGamesMarkup}
        </section>
        <section>
          <h2>Newly Added</h2>
          ${newGamesMarkup}
        </section>
      </div>
      <section class="about">
        <h2>About 0x9 dles</h2>
        <p>A daily game (or "dle") is a short puzzle that resets once a day, usually with the same challenge for every player. Wordle started the trend, and now there are hundreds of them covering words, geography, movies, music, logic, math and more. 0x9 dles is a community-run directory that keeps them all in one place so you can find the ones worth playing and build a daily routine around them.</p>
        <h3>How games are ranked</h3>
        <p>Every game has a community score based on up and down votes, so a game with a few votes can't outrank one that many people like. Newer games get a small freshness boost, and games that are frequently reported or whose links stop working are ranked lower. Anyone can vote, with or without an account.</p>
        <h3>Build your daily rotation</h3>
        <p>Favorite the games you play and arrange them into a personal rotation, in your own order and even by weekday. Without an account, your favorites are stored in your browser. Sign in with Discord or Twitch to keep them across devices, and export or import your rotation as a file whenever you like.</p>
        <h3>Find something new</h3>
        <p>Browse the <a href="/games">full game list</a>, filter by category, or explore <a href="/lists">curated lists</a> put together by our editors. Some games are marked <span class="paywall-badge" title="This game requires payment to play">$</span> if they require payment, and NSFW games are labelled. Know a daily we're missing? <a href="/submit">Submit it</a> and, once reviewed, it will show up in the directory.</p>
      </section>
    </main>
    <script>
      document.getElementById("feeling-auspicious-btn")?.addEventListener("click", async () => {
        // Open the tab synchronously (within the click handler) so browsers don't block it as a popup;
        // the fetch below happens after an await, by which point window.open would no longer count as user-initiated.
        const newTab = window.open("", "_blank");
        if (newTab) newTab.opener = null;
        const response = await fetch("/api/games/random");
        if (!response.ok) {
          if (newTab) newTab.close();
          if (window.appToast) window.appToast("No games available.", "error");
          return;
        }
        const game = await response.json();
        if (newTab) newTab.location = game.url;
        fetch("/api/games/" + game.id + "/click", { method: "POST" }).catch(() => {});
        window.location.href = "/games/" + game.slug;
      });
    </script>
    ${renderGameListInteractionScript({ includeImportPanel: !!user, promptFromQuery: shouldPromptImport })}
  `, c.env, { path: "/", description: "0x9 dles is a hub for daily games. Browse, vote on, and favorite the best daily games, curated by the community." }));
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
      <section class="panel">
        <form id="submission-form" class="stack-form">
          <input type="text" name="title" placeholder="Game title" required />
          <input type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" name="url" placeholder="example.com/game" required />
          <textarea name="description" placeholder="Why it is good (optional)" rows="3"></textarea>
          <fieldset>
            <legend>Suggested categories</legend>
            ${categories.results
              .map(
                (cat) =>
                  `<label class="check"><input type="checkbox" name="categories" value="${escapeHtml(cat.slug)}" /> ${escapeHtml(cat.name)}</label>`
              )
              .join("")}
          </fieldset>
          <fieldset>
            <legend>Reset timing (optional)</legend>
            <div data-reset-group>
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
            ${renderTimeZoneDatalist()}
          </fieldset>
          <label class="check"><input type="checkbox" name="paywall" value="1" /> This game is paywalled</label>
          <label class="check"><input type="checkbox" name="nsfw" value="1" /> This game is NSFW</label>
          <button type="submit">Submit for review</button>
        </form>
        <p id="submission-status" class="status" aria-live="polite"></p>
      </section>
    </main>
    <script>
      ${RESET_TIMEZONE_TOGGLE_SCRIPT}
      const form = document.getElementById("submission-form");
      const status = document.getElementById("submission-status");
      form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const formData = new FormData(form);
        const resetBasis = String(formData.get("resetBasis") || "").trim();
        const resetTime = String(formData.get("resetTime") || "").trim();
        const resetTimezone = String(formData.get("resetTimezone") || "").trim();
        const payload = {
          title: String(formData.get("title") || ""),
          url: String(formData.get("url") || ""),
          description: String(formData.get("description") || "").trim() || undefined,
          categories: formData.getAll("categories").map((v) => String(v)),
          resetBasis: resetBasis || undefined,
          resetTime: resetTime || undefined,
          resetTimezone: resetBasis === "server" && resetTimezone ? resetTimezone : undefined,
          paywall: formData.has("paywall"),
          nsfw: formData.has("nsfw")
        };
        if (status) status.textContent = "Submitting...";
        const response = await fetch("/api/games", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (response.ok) {
          form.reset();
          const result = await response.json().catch(() => ({}));
          const submittedStatus = result.status === "approved" ? "Approved and published." : "Submitted. Editors will review it shortly.";
          if (status) status.textContent = submittedStatus;
          if (window.appToast) window.appToast(submittedStatus, "success");
        } else {
          const result = await response.json().catch(() => ({}));
          if (status) status.textContent = result.error || "Submission failed.";
          if (window.appToast) window.appToast((status && status.textContent) || "Submission failed.", "error");
        }
      });
    </script>
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
  paywall_remove: "Paywall label removed"
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
      <p>A public record of games being approved, denied, hidden, restored, or deleted, and of NSFW and paywall label changes. Newest first.${showActor ? " <em>Editors and admins can also see who made each change.</em>" : ""}</p>
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

app.get("/games", async (c) => {
  const user = c.get("user");
  const sort = (c.req.query("sort") || "top") as "top" | "new" | "trending" | "reset";
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

  const countResult = await c.env.DB.prepare(countSql).bind(...countParams).first<{ total: number }>();
  const totalGames = countResult?.total || 0;
  const totalPages = Math.ceil(totalGames / perPage);

  // Fetch one extra to check if there are more pages
  const gamesWithExtra = await listGames(c.env, { sort, category, q, hidePaywall, hideNsfw, limit: perPage + 1, offset });
  const hasMore = gamesWithExtra.length > perPage;
  const games = gamesWithExtra.slice(0, perPage);
  
  const categories = await c.env.DB.prepare("SELECT slug, name, description FROM categories WHERE is_active = 1 ORDER BY name ASC").all<{
    slug: string;
    name: string;
    description: string | null;
  }>();

  if (page > 1 && games.length === 0) {
    return notFoundPage(c);
  }
  const { votes: userVotes, favorites: userFavorites } = await getViewerGameState(c, games.map((game) => game.id));

  // Render games as flat list
  const gamesMarkup = games.length > 0 
    ? renderCompactGameList(games, user, userVotes, userFavorites)
    : "<p>No games found.</p>";

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

  let paginationMarkup = "";
  if (page > 1 || hasMore) {
    paginationMarkup = `<div class="pagination">`;
    if (page > 1) {
      paginationMarkup += `<a href="${escapeHtml(buildPageUrl(page - 1))}">&larr; Previous</a>`;
    }
    paginationMarkup += `<span>Page ${page}${totalPages > 0 ? ` of ${totalPages}` : ""}</span>`;
    if (hasMore) {
      paginationMarkup += `<a href="${escapeHtml(buildPageUrl(page + 1))}">Next &rarr;</a>`;
    }
    paginationMarkup += `</div>`;
  }

  const activeCategory = category ? categories.results.find((cat) => cat.slug === category) : undefined;
  if (category && !activeCategory) {
    return notFoundPage(c);
  }
  const heading = activeCategory ? `Daily ${categoryGamesLabel(activeCategory.name)}` : "Browse Games";
  const pageSuffix = page > 1 ? ` – Page ${page}` : "";
  const pageTitle = (activeCategory ? `${heading} (${totalGames})` : "All Daily Games") + pageSuffix;
  const categoryPath = activeCategory ? `/games?category=${encodeURIComponent(activeCategory.slug)}` : "/games";
  // Later pages list different games, so each is its own canonical page (the sort order is not).
  const canonicalPath = page > 1 ? `${categoryPath}${activeCategory ? "&" : "?"}page=${page}` : categoryPath;
  const categoryDescription = activeCategory?.description && !activeCategory.description.startsWith("Imported from") ? activeCategory.description : "";
  const activeFilterCount = [sort !== "top", !!category, hidePaywall, hideNsfw].filter(Boolean).length;
  const sortLabels: Record<string, string> = { top: "Top rated", new: "Newest", trending: "Trending", reset: "Resetting soonest" };
  const crumbs: Array<[string, string]> = [["Home", "/"], ["Games", "/games"]];
  if (activeCategory) crumbs.push([activeCategory.name, categoryPath]);
  return c.html(await layout(pageTitle, user, `
    <main>
      <h1>${escapeHtml(heading)}</h1>
      ${activeCategory ? `<p>${categoryDescription ? `${escapeHtml(categoryDescription)} ` : ""}${totalGames} daily game${totalGames === 1 ? "" : "s"} in the ${escapeHtml(activeCategory.name)} category, ranked by community votes. Vote for your favorites, add them to your daily rotation, or <a href="/games">browse every category</a>.</p>` : ""}
      <form method="GET" action="/games" class="game-filters" id="game-filters">
        <div class="search-row">
          <input type="search" name="q" placeholder="Search games" aria-label="Search games" value="${escapeHtml(q || "")}" />
          <button type="submit">Search</button>
        </div>
        <details class="filters" id="filters-panel" ${activeFilterCount > 0 ? "open" : ""}>
          <summary>Filters${activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</summary>
          <div class="filters-body">
            <select name="sort" aria-label="Sort">
              ${["top", "new", "trending", "reset"]
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
      <script>
        (() => {
          const form = document.getElementById("game-filters");
          const panel = document.getElementById("filters-panel");
          // Filters are always shown on wider screens; on phones they fold away behind the "Filters" toggle.
          if (panel && window.matchMedia("(min-width: 701px)").matches) panel.open = true;
          form?.querySelectorAll("select, input[type=checkbox]").forEach((control) => {
            control.addEventListener("change", () => form.requestSubmit());
          });

          // Live search: as the user types, fetch this page for the new query and swap in its results (all games,
          // not just this page's), keeping the address bar in step. Enter/Search still does a normal submit.
          const input = form?.querySelector("input[name=q]");
          if (!form || !input) return;
          let timer = 0;
          let controller = null;
          const search = async () => {
            const params = new URLSearchParams(new FormData(form));
            for (const [key, value] of [...params]) if (!value) params.delete(key);
            if (params.get("sort") === "top") params.delete("sort");
            const url = "/games" + (params.toString() ? "?" + params.toString() : "");
            // Looked up here: this script runs before the results container further down the page exists.
            const results = document.getElementById("game-results");
            if (!results) return;
            controller?.abort();
            controller = new AbortController();
            results.setAttribute("aria-busy", "true");
            try {
              const response = await fetch(url, { signal: controller.signal });
              if (!response.ok) throw new Error("search failed");
              const next = new DOMParser().parseFromString(await response.text(), "text/html").getElementById("game-results");
              if (!next) throw new Error("no results");
              results.replaceChildren(...[...next.childNodes].map((node) => document.importNode(node, true)));
              window.dglBindGameRows?.(results);
              window.dglLocalizeResets?.(results);
              const found = results.querySelectorAll("[data-game-row]").length;
              const status = document.getElementById("search-status");
              if (status) status.textContent = found === 0 ? "No games found" : found + (results.querySelector(".pagination a[href*='page=']") ? "+" : "") + " games found";
              window.history.replaceState(null, "", url);
            } catch (error) {
              if (error.name !== "AbortError") form.requestSubmit();
            } finally {
              results.removeAttribute("aria-busy");
            }
          };
          input.addEventListener("input", () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(search, 250);
          });
        })();
      </script>
      <p id="search-status" class="visually-hidden" aria-live="polite"></p>
      <div id="game-results">
        ${gamesMarkup}
        ${paginationMarkup}
      </div>
    </main>
    ${renderGameListInteractionScript({ includeImportPanel: false, promptFromQuery: false })}
  `, c.env, {
    path: canonicalPath,
    description: (activeCategory
      ? `${categoryDescription ? `${categoryDescription} ` : ""}${totalGames} daily game${totalGames === 1 ? "" : "s"} in the ${activeCategory.name} category, ranked by community votes.`
      : `Browse all ${totalGames} daily games: Wordle-style puzzles for words, geography, music, movies and more. Filter by category, sort by rating, trending or newest.`) + pageSuffix,
    jsonLd: [breadcrumbLd(crumbs), gameItemListLd(games, offset)],
    noindex: !!q || hidePaywall || hideNsfw
  }));
});

app.get("/games/:slug", async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user");
  const isAdminOrEditor = user && (user.role === "admin" || user.role === "editor");
  const game = await c.env.DB.prepare(
    `SELECT id, title, slug, url, description, status, vote_up_count, vote_down_count, report_count, reset_basis, reset_time_minutes, reset_timezone, paywall, nsfw,
            COALESCE(approved_at, created_at) AS listed_at, how_to_play
     FROM games
     WHERE slug = ?1 ${isAdminOrEditor ? "" : "AND status = 'approved'"}`
  )
    .bind(slug)
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
    }>();
  if (!game) {
    return notFoundPage(c);
  }

  const allCategories = await c.env.DB.prepare(
    `SELECT id, slug, name FROM categories WHERE is_active = 1 ORDER BY name ASC`
  ).all<{ id: string; slug: string; name: string }>();

  const categories = await c.env.DB.prepare(
    `SELECT categories.slug, categories.name, categories.description
     FROM game_categories
     JOIN categories ON categories.id = game_categories.category_id
     WHERE game_categories.game_id = ?1
     ORDER BY categories.name ASC`
  )
    .bind(game.id)
    .all<{ slug: string; name: string; description: string | null }>();
  const publicLists = await c.env.DB.prepare(
    `SELECT curated_lists.slug, curated_lists.title
     FROM curated_list_items
     JOIN curated_lists ON curated_lists.id = curated_list_items.curated_list_id
     WHERE curated_list_items.game_id = ?1 AND curated_lists.visibility = 'public'
     ORDER BY curated_lists.title ASC`
  )
    .bind(game.id)
    .all<{ slug: string; title: string }>();

  const viewer = await getViewerGameState(c, [game.id]);
  const userVote: -1 | 0 | 1 = viewer.votes.get(game.id) ?? 0;
  const userFavorite = viewer.favorites.has(game.id);

  // Other well-liked games sharing a category: useful next stops for visitors and internal links for crawlers.
  const related = await c.env.DB.prepare(
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
  const relatedHeading = categories.results.length === 1 ? `More in ${categories.results[0].name}` : "Similar daily games";

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
    ? `${Math.round((game.vote_up_count / totalVotes) * 100)}% of ${totalVotes} community vote${totalVotes === 1 ? "" : "s"} are upvotes`
    : "No votes yet. Played it? Vote above.";
  // Rows from SQLite's datetime() are "YYYY-MM-DD HH:MM:SS" (UTC); rows written by the API are ISO strings.
  const listedDate = new Date(game.listed_at.includes("T") ? game.listed_at : game.listed_at.replace(" ", "T") + "Z");
  const listedText = Number.isNaN(listedDate.getTime()) ? "" : listedDate.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const describedCategories = categories.results.filter((cat) => cat.description && !cat.description.startsWith("Imported from"));
  const gameFacts = `
      <section class="game-facts">
        <h2>About ${escapeHtml(game.title)}</h2>
        ${game.how_to_play ? `<h3>How to play</h3>${game.how_to_play.split(/\n\s*\n/).map((para) => `<p>${escapeHtml(para.trim()).replace(/\n/g, "<br />")}</p>`).join("")}<h3>Details</h3>` : ""}
        <p>${escapeHtml(game.title)} is a ${escapeHtml(gameKind)} that you play in your web browser, with a new puzzle every day.${game.paywall ? " It requires payment to play." : " It's free to play, with no download needed."}${game.nsfw ? " It contains NSFW content." : ""}</p>
        <dl>
          ${categories.results.length > 0 ? `<dt>Category</dt><dd>${categories.results.map((cat) => `<a href="/games?category=${encodeURIComponent(cat.slug)}">${escapeHtml(cat.name)}</a>`).join(", ")}${describedCategories.length > 0 ? `: ${describedCategories.map((cat) => escapeHtml(cat.description!)).join(" ")}` : ""}</dd>` : ""}
          <dt>Community rating</dt><dd>${escapeHtml(ratingText)}</dd>
          ${publicLists.results.length > 0 ? `<dt>Featured in</dt><dd>${publicLists.results.map((list) => `<a href="/lists/${encodeURIComponent(list.slug)}">${escapeHtml(list.title)}</a>`).join(", ")}</dd>` : ""}
          ${listedText ? `<dt>Listed on 0x9 dles since</dt><dd>${escapeHtml(listedText)}</dd>` : ""}
        </dl>
      </section>`;
  const trimmedDescription = game.description?.trim() ?? "";
  const baseDescription = trimmedDescription
    ? /[.!?]$/.test(trimmedDescription) ? trimmedDescription : `${trimmedDescription}.`
    : `${game.title} is a ${gameKind}.`;
  const extraDescription = [
    `A ${game.paywall ? "" : "free "}${gameKind} you play in your browser.`,
    totalVotes > 0 ? `${Math.round((game.vote_up_count / totalVotes) * 100)}% liked on 0x9 dles.` : ""
  ].filter((part) => part && baseDescription.length + part.length + 1 <= 160);
  const metaDescription = [baseDescription, ...extraDescription].join(" ");
  // Changes whenever something drawn on the social image changes, so shares pick up edits.
  const ogVersion = shortHash([game.title, game.description ?? "", game.paywall, ...categories.results.map((cat) => cat.slug)].join("|"));
  return c.html(await layout(`${game.title} – ${mainCategory ? `Daily ${categoryGameLabel(mainCategory.name)}` : "Daily Game"}`, user, `
    <main class="narrow">
      <h1>${escapeHtml(game.title)}${game.paywall ? ` <span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}${game.nsfw ? ` <span class="nsfw-badge" title="This game contains NSFW content">nsfw</span>` : ""}</h1>
      ${renderCategoryPills(categories.results)}
      <p>${escapeHtml(game.description || "")}</p>
      <p><a class="btn btn-play" href="${escapeHtml(game.url)}" target="_blank" rel="noopener noreferrer" onclick="fetch('/api/games/${game.id}/click',{method:'POST'}).catch(()=>{})">Play ${escapeHtml(game.title)} ↗</a></p>
      ${(() => {
        const resetSpan = renderResetSpan(game.reset_basis, game.reset_time_minutes, game.reset_timezone, "long");
        return resetSpan ? `<p>${resetSpan}</p>` : "";
      })()}
      <p>Votes: +<span id="vote-up-count">${game.vote_up_count}</span> / -<span id="vote-down-count">${game.vote_down_count}</span>${isAdminOrEditor ? ` | Reports: ${game.report_count}` : ""}</p>
      ${
        user
          ? `<section class="panel">
               <h2>Actions</h2>
               <div class="actions">
                 <button type="button" id="vote-up" class="${userVote === 1 ? "active" : ""}">Vote up</button>
                 <button type="button" id="vote-down" class="${userVote === -1 ? "active" : ""}">Vote down</button>
                 <button type="button" id="favorite-toggle" data-favorited="${userFavorite ? "yes" : "no"}">${
                     userFavorite ? "Remove favorite" : "Add favorite"
                   }</button>
               </div>
               <p id="game-action-status" class="status" aria-live="polite"></p>
             </section>`
          : `<section class="panel">
               <h2>Actions</h2>
                <p>Build your rotation locally without an account.</p>
                <div class="actions">
                  <button type="button" id="vote-up" class="${userVote === 1 ? "active" : ""}">Vote up</button>
                  <button type="button" id="vote-down" class="${userVote === -1 ? "active" : ""}">Vote down</button>
                  <button type="button" id="favorite-local-toggle" data-favorited="no">Add favorite</button>
                  <a href="/me/rotation">View my rotation</a>
                </div>
                <p id="game-action-status" class="status" aria-live="polite"></p>
              </section>`
      }
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
          <textarea name="note" rows="3" placeholder="Optional notes"></textarea>
          <button type="submit">Send report</button>
        </form>
        <p id="report-status" class="status" aria-live="polite"></p>
      </details>
      ${gameFacts}
      ${related.results.length > 0 ? `<section class="related-games">
        <h2>${escapeHtml(relatedHeading)}</h2>
        <ul>${related.results.map((item) => `<li><a href="/games/${encodeURIComponent(item.slug)}">${escapeHtml(item.title)}</a></li>`).join("")}</ul>
      </section>` : ""}
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
                  ${renderTimeZoneDatalist()}
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
                 <select name="listId" id="list-select" required>
                   <option value="">Select a list...</option>
                 </select>
                 <button type="submit">Add game</button>
               </form>
               <p id="add-to-list-status" class="status" aria-live="polite"></p>
             </section>`
          : ""
      }
    </main>
    <script>
            const game = {
              id: ${scriptJson(game.id)},
              title: ${scriptJson(game.title)},
              slug: ${scriptJson(game.slug)}
            };
            const gameId = game.id;
            const status = document.getElementById("game-action-status");
            const upCountNode = document.getElementById("vote-up-count");
            const downCountNode = document.getElementById("vote-down-count");
            let currentVote = ${userVote};
            const voteButtons = {
              up: document.getElementById("vote-up"),
              down: document.getElementById("vote-down")
            };

            const setStatus = (text) => {
              if (status) status.textContent = text;
            };
            const notify = (text, level) => {
              setStatus(text);
              if (window.appToast) window.appToast(text, level);
            };

            const setVoteState = (value) => {
              voteButtons.up?.classList.toggle("active", value === 1);
              voteButtons.down?.classList.toggle("active", value === -1);
            };

            const submitVote = async (value) => {
              const previousVote = currentVote;
              if (currentVote === value) {
                setStatus("Vote already set.");
                return;
              }
              window.dglGames.shiftVoteCounts(upCountNode, downCountNode, previousVote, value);
              currentVote = value;
              setVoteState(value);
              setStatus("Saving vote...");
              if (await window.dglGames.saveVote(gameId, value)) {
                notify("Vote saved.", "success");
                return;
              }
              window.dglGames.shiftVoteCounts(upCountNode, downCountNode, value, previousVote);
              currentVote = previousVote;
              setVoteState(previousVote);
              notify("Could not save vote.", "error");
            };

            voteButtons.up?.addEventListener("click", () => submitVote(1));
            voteButtons.down?.addEventListener("click", () => submitVote(-1));

            // Signed in: the favorite is saved to the account.
            const favoriteButton = document.getElementById("favorite-toggle");
            favoriteButton?.addEventListener("click", async () => {
              const favorited = favoriteButton.getAttribute("data-favorited") === "yes";
              favoriteButton.setAttribute("data-favorited", favorited ? "no" : "yes");
              favoriteButton.textContent = favorited ? "Add favorite" : "Remove favorite";
              setStatus("Updating favorites...");
              if (!(await window.dglGames.setAccountFavorite(gameId, !favorited))) {
                favoriteButton.setAttribute("data-favorited", favorited ? "yes" : "no");
                favoriteButton.textContent = favorited ? "Remove favorite" : "Add favorite";
                notify("Could not update favorite.", "error");
                return;
              }
              notify(favorited ? "Removed from rotation." : "Added to rotation.", "success");
            });

            // Signed out: the favorite lives in this browser's local rotation.
            const localFavoriteButton = document.getElementById("favorite-local-toggle");
            const setLocalFavoriteState = (favorited) => {
              if (!localFavoriteButton) return;
              localFavoriteButton.setAttribute("data-favorited", favorited ? "yes" : "no");
              localFavoriteButton.textContent = favorited ? "Remove favorite" : "Add favorite";
            };
            localFavoriteButton?.addEventListener("click", async () => {
              const favorited = await window.dglGames.toggleLocalFavorite(game);
              setLocalFavoriteState(favorited);
              notify(favorited ? "Added to favorites." : "Removed from favorites.", "success");
            });
            setLocalFavoriteState(window.dglGames.isLocalFavorite(gameId));

            const reportForm = document.getElementById("report-form");
            const reportStatus = document.getElementById("report-status");
            const setReportStatus = (text) => {
              if (reportStatus) reportStatus.textContent = text;
            };
            reportForm?.addEventListener("submit", async (event) => {
              event.preventDefault();
              if (!(reportForm instanceof HTMLFormElement)) return;
              const formData = new FormData(reportForm);
              const payload = {
                reason: String(formData.get("reason") || "other"),
                note: String(formData.get("note") || "").trim() || undefined
              };
              setReportStatus("Submitting report...");
              const response = await fetch("/api/games/" + gameId + "/report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
              });
              if (response.ok) {
                reportForm.reset();
                setReportStatus("Report submitted. Thank you.");
                if (window.appToast) window.appToast("Report submitted.", "success");
              } else {
                setReportStatus("Could not submit report.");
                if (window.appToast) window.appToast("Could not submit report.", "error");
              }
            });

            const adminEditForm = document.getElementById("admin-edit-form");
            if (adminEditForm) {
              ${RESET_TIMEZONE_TOGGLE_SCRIPT}
              const adminStatus = document.getElementById("admin-edit-status");
              const setAdminStatus = (text) => {
                if (adminStatus) adminStatus.textContent = text;
              };
              adminEditForm.addEventListener("submit", async (event) => {
                event.preventDefault();
                if (!(adminEditForm instanceof HTMLFormElement)) return;
                const formData = new FormData(adminEditForm);
                const categories = formData.getAll("categories");
                const resetBasis = formData.get("reset_basis");
                const resetTimeValue = String(formData.get("reset_time") || "").trim();
                const resetTimeParts = /^(\\d{1,2}):(\\d{2})/.exec(resetTimeValue);
                const resetTimeMinutes = resetTimeParts ? Number(resetTimeParts[1]) * 60 + Number(resetTimeParts[2]) : null;
                const resetTimezone = String(formData.get("reset_timezone") || "").trim();
                const payload = {
                  title: String(formData.get("title") || ""),
                  url: String(formData.get("url") || ""),
                  description: String(formData.get("description") || "").trim() || null,
                  status: String(formData.get("status") || "approved"),
                  reset_basis: resetBasis ? String(resetBasis) : null,
                  reset_time_minutes: resetTimeMinutes,
                  reset_timezone: resetBasis === "server" && resetTimezone ? resetTimezone : null,
                  paywall: formData.has("paywall"),
                  nsfw: formData.has("nsfw"),
                  how_to_play: String(formData.get("how_to_play") || ""),
                  category_ids: categories.map(c => String(c))
                };
                setAdminStatus("Saving changes...");
                const response = await fetch("/api/games/" + gameId + "/admin-update", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload)
                });
                if (response.ok) {
                  const result = await response.json().catch(() => null);
                  setAdminStatus("Changes saved successfully.");
                  if (window.appToast) window.appToast("Game updated.", "success");
                  setTimeout(() => {
                    if (result && result.slug) {
                      window.location.href = "/games/" + result.slug;
                    } else {
                      window.location.reload();
                    }
                  }, 1000);
                } else {
                  setAdminStatus("Could not save changes.");
                  if (window.appToast) window.appToast("Could not save changes.", "error");
                }
              });
            }

            const listSelect = document.getElementById("list-select");
            const addToListForm = document.getElementById("add-to-list-form");
            const addToListStatus = document.getElementById("add-to-list-status");
            if (listSelect && addToListForm) {
              fetch("/api/lists").then(r => r.json()).then((data) => {
                for (const list of (data.results || [])) {
                  const opt = document.createElement("option");
                  opt.value = list.id;
                  opt.textContent = list.title;
                  listSelect.appendChild(opt);
                }
              }).catch(() => {});
              addToListForm.addEventListener("submit", async (e) => {
                e.preventDefault();
                const listId = listSelect.value;
                if (!listId) return;
                if (addToListStatus) addToListStatus.textContent = "Adding...";
                try {
                  const existing = await fetch("/api/lists/" + listId).then(r => r.json());
                  const nextPos = (existing.items?.length ?? 0) + 1;
                  const res = await fetch("/api/lists/" + listId + "/items", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ gameId: gameId, position: nextPos })
                  });
                  if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error || "Failed to add game");
                  }
                  if (addToListStatus) addToListStatus.textContent = "Game added to list.";
                  if (window.appToast) window.appToast("Game added to list.", "success");
                } catch (err) {
                  if (addToListStatus) addToListStatus.textContent = err.message;
                  if (window.appToast) window.appToast(err.message, "error");
                }
              });
            }
    </script>
  `, c.env, { path: `/games/${game.slug}`, description: metaDescription,
    image: { path: `/og/games/${encodeURIComponent(game.slug)}.png?v=${ogVersion}`, alt: `${game.title}: ${gameKind} on 0x9 dles` },
    jsonLd: [breadcrumbLd([["Home", "/"], ["Games", "/games"], [game.title, `/games/${game.slug}`]]), gameLd] }));
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
  const ownerName = owner.display_name || "Someone";

  return c.html(await layout(`${ownerName}'s Rotation`, user, `
    <main class="narrow">
      <h1>${escapeHtml(ownerName)}'s Daily Rotation</h1>
      <p>This is a shared view of ${escapeHtml(ownerName)}'s favorite daily games.</p>
      ${favorites.results.length > 0 ? `
        ${renderListSortControl()}
        <ol class="rotation-list" id="shared-rotation-list">
          ${favorites.results
            .map(
              (item) => {
                const reset = renderResetItemData(item.reset_basis, item.reset_time_minutes, item.reset_timezone);
                return `<li class="card-click" data-game-id="${item.id}" ${reset.attrs}>
                <div class="item-main">
                  <a class="game-title card-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}${item.paywall ? ` <span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}${item.nsfw ? ` <span class="nsfw-badge" title="This game contains NSFW content">nsfw</span>` : ""}</a>
                  ${renderCategoryPills(categoriesByGameId.get(item.id))}
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
    <script>
      ${LIST_SORT_SCRIPT}
      window.dglListSort.init(document.getElementById("shared-rotation-list"), document.getElementById("list-sort-select"));
    </script>
  `, c.env, { path: `/rotation/${shareToken}`, description: `${ownerName}'s shared daily game rotation.`, noindex: true }));
});

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
          <button type="button" id="import-btn">Import JSON</button>
          <input type="file" id="import-file" accept=".json" hidden>
        </div>
        <p id="import-status" class="status" aria-live="polite"></p>
        ${renderListSortControl()}
        <ol id="local-rotation-list" class="rotation-list"></ol>
        <p id="rotation-status" class="status" aria-live="polite"></p>
      </main>
      <script>
        ${LIST_SORT_SCRIPT}
        const list = document.getElementById("local-rotation-list");
        const listSorter = window.dglListSort.init(list, document.getElementById("list-sort-select"));
        const status = document.getElementById("rotation-status");

        const setStatus = (text) => {
          if (status) status.textContent = text;
        };

        const readFavorites = () => window.dglGames.readLocalFavorites().filter((row) => row.slug && row.title);
        const writeFavorites = window.dglGames.writeLocalFavorites;

        const moveItemByDirection = (item, direction) => {
          if (!list) return;
          if (!(item instanceof HTMLElement)) return;
          if (direction === "up") {
            const previous = item.previousElementSibling;
            if (previous) list.insertBefore(item, previous);
            return;
          }
          const next = item.nextElementSibling;
          if (next) list.insertBefore(next, item);
        };

        const persistFromDom = () => {
          if (!list) return;
          const items = Array.from(list.querySelectorAll("li[data-game-id]"));
          const next = items.map((item) => ({
            id: item.getAttribute("data-game-id") || "",
            slug: item.getAttribute("data-game-slug") || "",
            title: item.getAttribute("data-game-title") || ""
          })).filter((row) => row.id && row.slug && row.title);
          writeFavorites(next);
        };

        const removeFavorite = (gameId) => {
          const next = readFavorites().filter((row) => row.id !== gameId);
          writeFavorites(next);
          render();
          setStatus("Removed from local favorites.");
        };

        const wireInteractions = () => {
          if (!list) return;
          const items = Array.from(list.querySelectorAll("li[data-game-id]"));
          items.forEach((item) => {
            const handle = item.querySelector(".drag");
            handle?.addEventListener("pointerdown", (event) => {
              if (event.pointerType === "mouse" && event.button !== 0) return;
              event.preventDefault();
              const pointerId = event.pointerId;
              item.classList.add("dragging");

              const onPointerMove = (moveEvent) => {
                if (moveEvent.pointerId !== pointerId) return;
                const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
                const over = target && target.closest("li[data-game-id]");
                if (!over || over === item || !list.contains(over)) return;
                const rect = over.getBoundingClientRect();
                const before = moveEvent.clientY < rect.top + rect.height / 2;
                list.insertBefore(item, before ? over : over.nextSibling);
              };

              const onPointerUp = (upEvent) => {
                if (upEvent.pointerId !== pointerId) return;
                window.removeEventListener("pointermove", onPointerMove);
                window.removeEventListener("pointerup", onPointerUp);
                window.removeEventListener("pointercancel", onPointerUp);
                item.classList.remove("dragging");
                persistFromDom();
              };

              window.addEventListener("pointermove", onPointerMove);
              window.addEventListener("pointerup", onPointerUp);
              window.addEventListener("pointercancel", onPointerUp);
            });

            item.querySelectorAll("button[data-local-move]").forEach((button) => {
              button.addEventListener("click", () => {
                const direction = button.getAttribute("data-local-move");
                if (!direction) return;
                moveItemByDirection(item, direction);
                persistFromDom();
              });
            });

            item.querySelector("button[data-local-remove]")?.addEventListener("click", () => {
              const gameId = item.getAttribute("data-game-id");
              if (!gameId) return;
              removeFavorite(gameId);
            });
          });
        };

        const render = () => {
          if (!list) return;
          const favorites = readFavorites();
          const exportButton = document.getElementById("export-btn");
          const sortControl = document.getElementById("list-sort-select")?.closest(".list-sort");
          if (exportButton) exportButton.hidden = favorites.length === 0;
          if (sortControl) sortControl.hidden = favorites.length === 0;
          if (favorites.length === 0) {
            list.innerHTML = '<li class="empty-state"><p>Your rotation is empty. Tap ☆ on any game to add it here.</p><a class="btn" href="/games">Browse games</a></li>';
            return;
          }
          list.innerHTML = "";
          favorites.forEach((item) => {
            const li = document.createElement("li");
            li.className = "card-click";
            li.setAttribute("data-game-id", item.id);
            li.setAttribute("data-game-slug", item.slug);
            li.setAttribute("data-game-title", item.title);

            const drag = document.createElement("span");
            drag.className = "drag";
            drag.textContent = "::";
            li.appendChild(drag);

            const itemMain = document.createElement("div");
            itemMain.className = "item-main";

            // Points at the details page until rotation-info supplies the game's own address.
            const link = document.createElement("a");
            link.className = "game-title card-link";
            link.href = "/games/" + encodeURIComponent(item.slug);
            link.textContent = item.title;
            itemMain.appendChild(link);

            const pills = document.createElement("div");
            pills.className = "category-pills";
            pills.setAttribute("data-category-pills", item.id);
            itemMain.appendChild(pills);

            li.appendChild(itemMain);

            // Same compact controls as the signed-in rotation.
            const actions = document.createElement("div");
            actions.className = "card-actions";
            const reorder = document.createElement("div");
            reorder.className = "reorder-controls";
            const up = document.createElement("button");
            up.type = "button";
            up.setAttribute("data-local-move", "up");
            up.setAttribute("aria-label", "Move up");
            up.textContent = "↑";
            const down = document.createElement("button");
            down.type = "button";
            down.setAttribute("data-local-move", "down");
            down.setAttribute("aria-label", "Move down");
            down.textContent = "↓";
            reorder.appendChild(up);
            reorder.appendChild(down);
            actions.appendChild(reorder);

            const details = document.createElement("a");
            details.className = "btn-details";
            details.href = "/games/" + encodeURIComponent(item.slug);
            details.title = "Details";
            details.setAttribute("aria-label", item.title + " details");
            details.textContent = "…";
            actions.appendChild(details);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.setAttribute("data-local-remove", "1");
            remove.setAttribute("aria-label", "Remove from rotation");
            remove.textContent = "X";
            actions.appendChild(remove);
            li.appendChild(actions);

            list.appendChild(li);
          });
          wireInteractions();
          listSorter.refresh();
          loadCategoryPills(favorites.map((item) => item.id));
          loadGameInfo(favorites.map((item) => item.id));
        };

        const gameInfoCache = new Map();
        const applyGameInfo = () => {
          if (!list) return;
          list.querySelectorAll("li[data-game-id]").forEach((li) => {
            const info = gameInfoCache.get(li.getAttribute("data-game-id"));
            if (!info) return;
            const link = li.querySelector(".card-link");
            if (link && info.url) {
              link.href = info.url;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
            }
            const reset = info.reset;
            if (!reset) return;
            li.dataset.resetKind = reset.kind;
            li.dataset.resetMin = String(reset.min);
            const itemMain = li.querySelector(".item-main");
            if (itemMain && !itemMain.querySelector(".meta")) {
              const meta = document.createElement("div");
              meta.className = "meta";
              const label = document.createElement("span");
              label.setAttribute("data-reset-at-kind", reset.kind);
              label.setAttribute("data-reset-at", String(reset.min));
              label.textContent = reset.label;
              meta.appendChild(label);
              itemMain.appendChild(meta);
              window.dglLocalizeResets(meta);
            }
          });
          listSorter.apply();
        };

        const loadGameInfo = async (gameIds) => {
          const missing = gameIds.filter((id) => !gameInfoCache.has(id));
          if (missing.length === 0) { applyGameInfo(); return; }
          try {
            for (let i = 0; i < missing.length; i += 50) {
              const chunk = missing.slice(i, i + 50);
              const response = await fetch("/api/games/rotation-info?ids=" + chunk.map(encodeURIComponent).join(","));
              if (!response.ok) continue;
              const body = await response.json();
              chunk.forEach((id) => gameInfoCache.set(id, body[id] || null));
            }
            applyGameInfo();
          } catch {
            // Links fall back to the details page and reset times are optional; ignore failures.
          }
        };

        const categoryHue = (slug) => {
          let hash = 0;
          for (let i = 0; i < slug.length; i++) {
            hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
          }
          return hash % 360;
        };

        const loadCategoryPills = async (gameIds) => {
          if (!list || gameIds.length === 0) return;
          try {
            const response = await fetch("/api/games/categories?ids=" + gameIds.map(encodeURIComponent).join(","));
            if (!response.ok) return;
            const categoriesByGameId = await response.json();
            Object.keys(categoriesByGameId).forEach((gameId) => {
              const container = list.querySelector('[data-category-pills="' + CSS.escape(gameId) + '"]');
              if (!container) return;
              const categories = categoriesByGameId[gameId] || [];
              container.innerHTML = categories
                .map((cat) => {
                  const hue = categoryHue(cat.slug);
                  const style = "color:hsl(" + hue + ", 65%, 28%); background:hsl(" + hue + ", 65%, 90%); border-color:hsl(" + hue + ", 55%, 72%);";
                  const name = cat.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                  return '<a href="/games?category=' + encodeURIComponent(cat.slug) + '" class="tag category-pill" style="' + style + '">' + name + '</a>';
                })
                .join("");
            });
          } catch {
            // Category pills are a non-critical enhancement; ignore failures.
          }
        };

        document.getElementById("export-btn")?.addEventListener("click", () => {
          const favorites = readFavorites();
          if (favorites.length === 0) {
            setStatus("No favorites to export.");
            return;
          }
          const exportData = { version: 1, items: favorites };
          const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "dailies-rotation.json";
          a.click();
          URL.revokeObjectURL(url);
          setStatus("Exported " + favorites.length + " favorite" + (favorites.length === 1 ? "" : "s") + ".");
        });

        document.getElementById("import-btn")?.addEventListener("click", () => {
          document.getElementById("import-file")?.click();
        });

        document.getElementById("import-file")?.addEventListener("change", (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const importStatus = document.getElementById("import-status");
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const data = JSON.parse(reader.result);
              if (!data || data.version !== 1 || !Array.isArray(data.items)) {
                if (importStatus) importStatus.textContent = "Invalid file format.";
                return;
              }
              const valid = data.items.filter((item) => item && typeof item.id === "string" && item.id.length > 0 && typeof item.slug === "string" && typeof item.title === "string");
              if (valid.length === 0) {
                if (importStatus) importStatus.textContent = "No valid items found in file.";
                return;
              }
              const existing = readFavorites();
              const existingIds = new Set(existing.map((e) => e.id));
              let added = 0;
              for (const item of valid) {
                if (!existingIds.has(item.id)) {
                  existing.push({ id: item.id, slug: item.slug, title: item.title });
                  added += 1;
                }
              }
              writeFavorites(existing);
              if (importStatus) importStatus.textContent = "Imported " + added + " new favorite" + (added === 1 ? "" : "s") + ".";
              render();
            } catch {
              if (importStatus) importStatus.textContent = "Could not read file.";
            }
          };
          reader.readAsText(file);
          event.target.value = "";
        });

        render();
      </script>
    `, c.env, { path: "/me/rotation", description: "Your personal daily game rotation. Drag to reorder, export, and share." }));
  }

  const favorites = await c.env.DB.prepare(
    `SELECT games.id, games.title, games.slug, games.url, games.paywall, games.nsfw, games.reset_basis, games.reset_time_minutes, games.reset_timezone, favorites.position
     FROM favorites
     JOIN games ON games.id = favorites.game_id
     WHERE favorites.user_id = ?1
     ORDER BY favorites.position ASC`
  )
    .bind(user.id)
    .all<{ id: string; title: string; slug: string; url: string; paywall: number; nsfw: number; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null; position: number }>();

  const categoriesByGameId = await getCategoriesForGames(c.env, favorites.results.map((item) => item.id));

  const userWithToken = await c.env.DB.prepare(
    "SELECT rotation_share_token FROM users WHERE id = ?1"
  )
    .bind(user.id)
    .first<{ rotation_share_token: string | null }>();

  const shareToken = userWithToken?.rotation_share_token;
  const shareUrl = shareToken ? `${c.env.APP_URL}/rotation/${shareToken}` : null;

  return c.html(await layout("My Rotation", user, `
    <main class="narrow">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
        <h1 style="margin: 0;">My Daily Rotation</h1>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
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
        ${favorites.results.length > 0 ? `<button type="button" id="export-btn">Export JSON</button>` : ""}
        <button type="button" id="import-btn">Import JSON</button>
        <input type="file" id="import-file" accept=".json" hidden>
      </div>
      <p id="import-status" class="status" aria-live="polite"></p>
      ${favorites.results.length > 0 ? renderListSortControl() : `<div class="empty-state"><p>Your rotation is empty. Tap ☆ on any game to add it here.</p><a class="btn" href="/games">Browse games</a></div>`}
      <ol id="rotation-list" class="rotation-list">
        ${favorites.results
          .map(
            (item) => {
              const reset = renderResetItemData(item.reset_basis, item.reset_time_minutes, item.reset_timezone);
              return `<li class="card-click" data-game-id="${item.id}" ${reset.attrs}>
              <span class="drag">::</span>
              <div class="item-main">
                <a class="game-title card-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}${item.paywall ? ` <span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}${item.nsfw ? ` <span class="nsfw-badge" title="This game contains NSFW content">nsfw</span>` : ""}</a>
                ${renderCategoryPills(categoriesByGameId.get(item.id))}
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
    <script>
      ${LIST_SORT_SCRIPT}
      window.dglListSort.init(document.getElementById("rotation-list"), document.getElementById("list-sort-select"));
    </script>
    <script>
      const list = document.getElementById("rotation-list");
      const status = document.getElementById("rotation-status");
      const shareStatus = document.getElementById("share-status");
      const importPanel = document.getElementById("rotation-local-import-panel");
      const importSummary = document.getElementById("rotation-local-import-summary");
      const importStatus = document.getElementById("rotation-local-import-status");
      const importButton = document.getElementById("rotation-local-import-btn");
      const importDismissButton = document.getElementById("rotation-local-import-dismiss");

      const setStatus = (text) => {
        if (status) status.textContent = text;
      };

      const setImportStatus = (text) => {
        if (importStatus) importStatus.textContent = text;
      };

      const localFavoriteCount = window.dglGames.readLocalFavorites().length;
      if (importPanel && localFavoriteCount > 0) {
        importPanel.hidden = false;
        if (importSummary) {
          importSummary.textContent = "Found " + localFavoriteCount + " local favorite" + (localFavoriteCount === 1 ? "" : "s") + ".";
        }
      }

      importDismissButton?.addEventListener("click", () => {
        if (importPanel) importPanel.hidden = true;
      });

      importButton?.addEventListener("click", async () => {
        setImportStatus("Importing local favorites...");
        const result = await window.dglGames.importLocalFavorites();
        if (result !== "imported") {
          setImportStatus(result === "empty" ? "No valid local favorites to import." : "Could not import local favorites.");
          return;
        }
        setImportStatus("Imported local favorites.");
        if (window.appToast) window.appToast("Imported local favorites.", "success");
        window.location.reload();
      });

      // Share button handlers
      const setShareStatus = (text) => {
        if (shareStatus) shareStatus.textContent = text;
      };

      document.getElementById("generate-share-btn")?.addEventListener("click", async () => {
        setShareStatus("Generating share link...");
        const response = await fetch("/api/me/rotation/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" }
        });
        if (response.ok) {
          const data = await response.json();
          if (window.appToast) window.appToast("Share link generated!", "success");
          window.location.reload();
        } else {
          setShareStatus("Could not generate share link.");
          if (window.appToast) window.appToast("Could not generate share link.", "error");
        }
      });

      document.getElementById("copy-share-btn")?.addEventListener("click", async () => {
        const shareUrl = ${shareUrl ? `"${escapeHtml(shareUrl)}"` : "null"};
        if (shareUrl) {
          try {
            await navigator.clipboard.writeText(shareUrl);
            setShareStatus("Link copied to clipboard!");
            if (window.appToast) window.appToast("Link copied!", "success");
          } catch {
            setShareStatus("Could not copy link. Please try again.");
          }
        }
      });

      document.getElementById("disable-share-btn")?.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to disable your share link? The current link will stop working.")) {
          return;
        }
        setShareStatus("Disabling share link...");
        const response = await fetch("/api/me/rotation/share", {
          method: "DELETE"
        });
        if (response.ok) {
          if (window.appToast) window.appToast("Share link disabled.", "success");
          window.location.reload();
        } else {
          setShareStatus("Could not disable share link.");
          if (window.appToast) window.appToast("Could not disable share link.", "error");
        }
      });

      const moveItemByDirection = (item, direction) => {
        if (!list) return;
        if (!(item instanceof HTMLElement)) return;
        if (direction === "up") {
          const previous = item.previousElementSibling;
          if (previous) {
            list.insertBefore(item, previous);
          }
          return;
        }
        const next = item.nextElementSibling;
        if (next) {
          list.insertBefore(next, item);
        }
      };

      const saveOrder = async () => {
        if (!list) return;
        const items = Array.from(list.querySelectorAll("li[data-game-id]"));
        const payload = {
          items: items.map((item, index) => ({
            gameId: item.getAttribute("data-game-id"),
            position: index + 1
          }))
        };
        setStatus("Saving order...");
        const response = await fetch("/api/me/favorites/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (response.ok) {
          setStatus("Order saved.");
        } else {
          setStatus("Could not save order.");
          if (window.appToast) window.appToast("Could not save order.", "error");
        }
      };

      document.getElementById("export-btn")?.addEventListener("click", async () => {
        const response = await fetch("/api/me/favorites/export");
        if (!response.ok) {
          setStatus("Could not export favorites.");
          return;
        }
        const data = await response.json();
        if (!data.items || data.items.length === 0) {
          setStatus("No favorites to export.");
          return;
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "dailies-rotation.json";
        a.click();
        URL.revokeObjectURL(url);
        setStatus("Exported " + data.items.length + " favorite" + (data.items.length === 1 ? "" : "s") + ".");
      });

      document.getElementById("import-btn")?.addEventListener("click", () => {
        document.getElementById("import-file")?.click();
      });

      document.getElementById("import-file")?.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const importFileStatus = document.getElementById("import-status");
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const data = JSON.parse(reader.result);
            if (!data || data.version !== 1 || !Array.isArray(data.items)) {
              if (importFileStatus) importFileStatus.textContent = "Invalid file format.";
              return;
            }
            if (importFileStatus) importFileStatus.textContent = "Importing...";
            const response = await fetch("/api/me/favorites/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data)
            });
            if (!response.ok) {
              if (importFileStatus) importFileStatus.textContent = "Could not import favorites.";
              return;
            }
            const result = await response.json();
            if (importFileStatus) importFileStatus.textContent = "Imported " + result.imported + " new favorite" + (result.imported === 1 ? "" : "s") + ".";
            if (window.appToast) window.appToast("Imported " + result.imported + " favorites.", "success");
            window.location.reload();
          } catch {
            if (importFileStatus) importFileStatus.textContent = "Could not read file.";
          }
        };
        reader.readAsText(file);
        event.target.value = "";
      });

      if (list) {
        const items = Array.from(list.querySelectorAll("li[data-game-id]"));
        items.forEach((item) => {
          const handle = item.querySelector(".drag");
          handle?.addEventListener("pointerdown", (event) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            event.preventDefault();
            const pointerId = event.pointerId;
            item.classList.add("dragging");

            const onPointerMove = (moveEvent) => {
              if (moveEvent.pointerId !== pointerId) return;
              const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
              const over = target && target.closest("li[data-game-id]");
              if (!over || over === item || !list.contains(over)) return;
              const rect = over.getBoundingClientRect();
              const before = moveEvent.clientY < rect.top + rect.height / 2;
              list.insertBefore(item, before ? over : over.nextSibling);
            };

            const onPointerUp = (upEvent) => {
              if (upEvent.pointerId !== pointerId) return;
              window.removeEventListener("pointermove", onPointerMove);
              window.removeEventListener("pointerup", onPointerUp);
              window.removeEventListener("pointercancel", onPointerUp);
              item.classList.remove("dragging");
              void saveOrder();
            };

            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
            window.addEventListener("pointercancel", onPointerUp);
          });

          item.querySelectorAll("button[data-move]").forEach((button) => {
            button.addEventListener("click", async () => {
              const direction = button.getAttribute("data-move");
              if (!direction) return;
              moveItemByDirection(item, direction);
              await saveOrder();
            });
          });
        });

        document.querySelectorAll("button[data-unfavorite]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const gameId = btn.getAttribute("data-unfavorite");
            if (!gameId) return;
            setStatus("Removing from rotation...");
            if (await window.dglGames.setAccountFavorite(gameId, false)) {
              btn.closest("li")?.remove();
              setStatus("Removed from rotation.");
              if (window.appToast) window.appToast("Removed from rotation.", "success");
            } else {
              setStatus("Could not remove.");
              if (window.appToast) window.appToast("Could not remove from rotation.", "error");
            }
          });
        });
      }
    </script>
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
        <form id="profile-form" class="stack-form">
          <label for="display-name">Display name</label>
          <input id="display-name" name="displayName" maxlength="80" placeholder="Your name" value="${escapeHtml(auth.displayName || "")}" />
          <button type="submit">Save profile</button>
        </form>
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
      <p id="me-settings-status" class="status" aria-live="polite"></p>
    </main>
    <script>
      const statusNode = document.getElementById("me-settings-status");
      const setStatus = (text) => {
        if (statusNode) statusNode.textContent = text;
      };

      const profileForm = document.getElementById("profile-form");
      profileForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!(profileForm instanceof HTMLFormElement)) return;
        const fd = new FormData(profileForm);
        const displayName = String(fd.get("displayName") || "").trim();
        setStatus("Saving profile...");
        const response = await fetch("/api/me/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName })
        });
        if (!response.ok) {
          setStatus("Could not save profile.");
          return;
        }
        setStatus("Profile updated.");
        if (window.appToast) window.appToast("Profile updated.", "success");
      });

      document.querySelectorAll("button[data-unlink]").forEach((button) => {
        button.addEventListener("click", async () => {
          const provider = button.getAttribute("data-unlink");
          const name = provider === "twitch" ? "Twitch" : "Discord";
          if (!provider || !window.confirm("Unlink " + name + "? You won't be able to sign in with it until you link it again.")) return;
          setStatus("Unlinking " + name + "...");
          const response = await fetch("/api/me/accounts/" + encodeURIComponent(provider), { method: "DELETE" });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setStatus(body.error || "Could not unlink " + name + ".");
            return;
          }
          window.location.href = "/me/settings";
        });
      });

      document.querySelectorAll("button[data-session-revoke]").forEach((button) => {
        button.addEventListener("click", async () => {
          const sessionId = button.getAttribute("data-session-revoke");
          if (!sessionId) return;
          setStatus("Revoking session...");
          const response = await fetch("/api/me/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
          if (!response.ok) {
            setStatus("Could not revoke session.");
            return;
          }
          setStatus("Session revoked.");
          window.location.reload();
        });
      });
    </script>
  `, c.env));
});

app.get("/lists", async (c) => {
  const user = c.get("user");
  const isAdminEditor = !!user && (user.role === "editor" || user.role === "admin");
  const lists = await c.env.DB.prepare(
    `SELECT id, slug, title, description, visibility, owner_user_id, twitch_login, twitch_user_id,
            (SELECT COUNT(*) FROM curated_list_items WHERE curated_list_id = curated_lists.id) AS game_count
     FROM curated_lists
     ORDER BY updated_at DESC`
  ).all<{
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
  const visible = lists.results.filter((row) => canViewList(row.visibility, row.owner_user_id, user, { listTwitchUserId: row.twitch_user_id, userTwitchId }));
  return c.html(await layout("Curated Lists of Daily Games", user, `
    <main class="narrow">
      <h1>Curated Lists</h1>
      ${isAdminEditor ? `
        <section class="panel">
          <h2>Create list</h2>
          <form id="create-list-form" class="stack-form">
            <input name="title" placeholder="List title" required />
            <textarea name="description" rows="2" placeholder="Description"></textarea>
            <select name="visibility">
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
            .map((row) => `<li><a href="/lists/${row.slug}">${escapeHtml(row.title)}</a>${renderVerifiedBadge(row.twitch_login)}${row.visibility === "private" ? " <small>(private)</small>" : ""}
              <br /><small class="muted">${row.game_count} game${row.game_count === 1 ? "" : "s"}${row.twitch_login ? ` · picked by ${escapeHtml(row.twitch_login)} on Twitch` : ""}${row.description ? ` · ${escapeHtml(row.description)}` : ""}</small></li>`)
            .join("")}
        </ul>
      ` : `<p>No curated lists yet.</p>`}
    </main>
    <script>
      (() => {
        const form = document.getElementById("create-list-form");
        if (!form) return;
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          const status = document.getElementById("create-list-status");
          try {
            const res = await fetch("/api/lists", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({
                title: fd.get("title"),
                description: fd.get("description") || undefined,
                visibility: fd.get("visibility"),
              }),
            });
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.error || "Failed to create list");
            }
            window.location.reload();
          } catch (err) {
            if (status) status.textContent = err.message;
          }
        });
      })();
    </script>
  `, c.env, { path: "/lists", description: "Curated lists of daily games picked by editors and Twitch streamers. See which dailies they play, then add them to your own rotation.", jsonLd: [breadcrumbLd([["Home", "/"], ["Lists", "/lists"]])] }));
});

app.get("/lists/:slug", async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user");
  const isStaff = !!user && (user.role === "editor" || user.role === "admin");
  const list = await c.env.DB.prepare(
    `SELECT id, slug, title, description, visibility, owner_user_id, twitch_login, twitch_user_id
     FROM curated_lists
     WHERE slug = ?1`
  )
    .bind(slug)
    .first<{ id: string; slug: string; title: string; description: string | null; visibility: "public" | "private"; owner_user_id: string; twitch_login: string | null; twitch_user_id: string | null }>();
  const userTwitchId = await getUserTwitchId(c.env, user);
  if (!list || !canViewList(list.visibility, list.owner_user_id, user, { listTwitchUserId: list.twitch_user_id, userTwitchId })) {
    return notFoundPage(c);
  }
  // The list's tagged Twitch user can edit its games, title and description; staff can edit everything.
  const isTwitchOwner = !!list.twitch_user_id && list.twitch_user_id === userTwitchId;
  const canEdit = isStaff || isTwitchOwner;
  // Everyone who can edit views the list normally and opts in to edit mode with ?edit=1.
  const isAdminEditor = canEdit && c.req.query("edit") === "1";
  const items = await c.env.DB.prepare(
    `SELECT games.id, games.slug, games.title, games.url, games.paywall, games.nsfw, games.reset_basis, games.reset_time_minutes, games.reset_timezone,
            games.vote_up_count, games.vote_down_count, curated_list_items.position
     FROM curated_list_items
     JOIN games ON games.id = curated_list_items.game_id
     WHERE curated_list_items.curated_list_id = ?1
     ORDER BY curated_list_items.position ASC`
  )
    .bind(list.id)
    .all<{ id: string; slug: string; title: string; url: string; paywall: number; nsfw: number; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null; vote_up_count: number; vote_down_count: number; position: number }>();

  const categoriesByGameId = await getCategoriesForGames(c.env, items.results.map((item) => item.id));

  // The viewer's own votes and favorites, for the vote/favorite buttons (read-only view only).
  const { votes: userVotes, favorites: userFavorites } = isAdminEditor
    ? { votes: new Map<string, -1 | 1>(), favorites: new Set<string>() }
    : await getViewerGameState(c, items.results.map((item) => item.id));

  let adminGames: Array<{ id: string; title: string; slug: string }> = [];
  if (isAdminEditor) {
    const games = await c.env.DB.prepare(
      "SELECT id, title, slug FROM games WHERE status = 'approved' ORDER BY title ASC"
    ).all<{ id: string; title: string; slug: string }>();
    adminGames = games.results;
  }

  const twitchLive = list.twitch_user_id ? await isTwitchUserLive(c.env, list.twitch_user_id) : false;

  return c.html(await layout(`${list.title} – Daily Game List | 0x9 dles`, user, `
    <main class="narrow">
      <h1>${escapeHtml(list.title)}${renderVerifiedBadge(list.twitch_login)}</h1>
      ${list.twitch_login ? `<p class="twitch-watch"><a class="btn btn-twitch" href="https://www.twitch.tv/${encodeURIComponent(list.twitch_login)}" target="_blank" rel="noopener noreferrer" title="${twitchLive ? `${escapeHtml(list.twitch_login)} is live now. ` : ""}Opens Twitch in a new tab">${TWITCH_ICON_SVG}<span>Watch ${escapeHtml(list.twitch_login)}<span class="wide-only"> on Twitch</span></span>${twitchLive ? `<span class="live-badge">LIVE<span class="visually-hidden"> now</span></span>` : ""}<span class="external-arrow" aria-hidden="true">↗</span><span class="visually-hidden"> (opens in a new tab)</span></a></p>` : ""}
      <p>${escapeHtml(list.description || "")}</p>
      ${canEdit ? `<p><code>${escapeHtml(list.slug)}</code> · ${list.visibility}</p>` : ""}
      ${canEdit ? `<p><a class="btn" href="/lists/${encodeURIComponent(list.slug)}${isAdminEditor ? "" : "?edit=1"}">${isAdminEditor ? "Done editing" : "Edit list"}</a></p>` : ""}
      ${isAdminEditor ? `
        <section class="panel">
          <h2>Edit list</h2>
          <form id="list-edit-form" class="stack-form">
            <input type="text" name="title" value="${escapeHtml(list.title)}" required />
            ${isStaff ? `<input type="text" name="slug" value="${escapeHtml(list.slug)}" required pattern="[a-z0-9-]+" title="Lowercase alphanumeric with hyphens" />` : ""}
            <textarea name="description" rows="2" placeholder="Description">${escapeHtml(list.description || "")}</textarea>
            <div class="actions">
              <button type="submit">Save details</button>
              ${isStaff ? `<button type="button" id="list-visibility-toggle">Set ${list.visibility === "public" ? "private" : "public"}</button>
              <button type="button" id="list-delete-btn">Delete list</button>` : ""}
            </div>
          </form>
          <p id="list-edit-status" class="status" aria-live="polite"></p>
        </section>
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
      ${!isAdminEditor && items.results.length > 1 ? renderListSortControl() : ""}
      <ol class="rotation-list" id="list-items">
        ${items.results.map((item) => {
          const currentVote = userVotes.get(item.id) || 0;
          const currentFavorite = userFavorites.has(item.id);
          return `<li draggable="${isAdminEditor}" ${isAdminEditor ? "" : `class="card-click"`} data-game-id="${item.id}" ${isAdminEditor ? "" : `data-game-row="${item.id}" data-vote="${currentVote}" data-game-slug="${escapeHtml(item.slug)}" data-game-title="${escapeHtml(item.title)}"`} ${renderResetItemData(item.reset_basis, item.reset_time_minutes, item.reset_timezone).attrs}>
          ${isAdminEditor ? `<span class="drag">::</span>` : ""}
          <div class="item-main">
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="game-title${isAdminEditor ? "" : " card-link"}">${escapeHtml(item.title)}${item.paywall ? ` <span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}${item.nsfw ? ` <span class="nsfw-badge" title="This game contains NSFW content">nsfw</span>` : ""}</a>
            ${renderCategoryPills(categoriesByGameId.get(item.id))}
            ${isAdminEditor
              ? renderGameMeta(0, 0, renderResetSpan(item.reset_basis, item.reset_time_minutes, item.reset_timezone))
              : renderGameMeta(item.vote_up_count, item.vote_down_count, renderResetSpan(item.reset_basis, item.reset_time_minutes, item.reset_timezone))}
          </div>
          <div class="card-actions">
            ${isAdminEditor ? "" : `
              <button type="button" data-list-vote="up" class="${currentVote === 1 ? "active" : ""}" title="Vote up">▲ <span data-up-count>${item.vote_up_count}</span></button>
              <button type="button" data-list-vote="down" class="${currentVote === -1 ? "active" : ""}" title="Vote down">▼ <span data-down-count>${item.vote_down_count}</span></button>
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
            ${renderDetailsLink(item.slug, item.title)}
            ${isAdminEditor ? `<button type="button" class="list-remove-game" data-game-id="${item.id}">X</button>` : ""}
          </div>
        </li>`;
        }).join("")}
      </ol>
      <p id="list-reorder-status" class="status" aria-live="polite"></p>
    </main>
    ${!isAdminEditor && items.results.length > 1 ? `<script>
      ${LIST_SORT_SCRIPT}
      window.dglListSort.init(document.getElementById("list-items"), document.getElementById("list-sort-select"));
    </script>` : ""}
    ${!isAdminEditor ? renderGameListInteractionScript({ includeImportPanel: false, promptFromQuery: false }) : ""}
    ${isAdminEditor ? `
    <script>
      (() => {
        const listId = ${scriptJson(list.id)};
        const status = document.getElementById("list-edit-status");
        const setStatus = (t) => { if (status) status.textContent = t; };

        document.getElementById("list-edit-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          setStatus("Saving...");
          const res = await fetch("/api/lists/" + listId, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: fd.get("title"),
              ...(fd.get("slug") ? { slug: fd.get("slug") } : {}),
              description: fd.get("description") || undefined
            })
          });
          if (res.ok) {
            setStatus("Saved.");
            window.location.href = "/lists/" + encodeURIComponent(String(fd.get("slug") || ${scriptJson(list.slug)})) + "?edit=1";
          } else {
            const body = await res.json().catch(() => ({}));
            setStatus(body.error || "Could not save.");
          }
        });

        document.getElementById("list-twitch-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const login = String(new FormData(e.target).get("login") || "").trim();
          const twitchStatus = document.getElementById("list-twitch-status");
          if (twitchStatus) twitchStatus.textContent = "Saving...";
          const res = await fetch("/api/lists/" + listId + "/twitch", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ login: login || null })
          });
          if (res.ok) {
            window.location.reload();
          } else {
            const body = await res.json().catch(() => ({}));
            if (twitchStatus) twitchStatus.textContent = body.error || "Could not save.";
          }
        });

        document.getElementById("list-visibility-toggle")?.addEventListener("click", async () => {
          setStatus("Updating visibility...");
          const res = await fetch("/api/lists/" + listId + "/visibility", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ visibility: ${scriptJson(list.visibility === "public" ? "private" : "public")} })
          });
          if (res.ok) { window.location.reload(); } else { setStatus("Could not update visibility."); }
        });

        document.getElementById("list-delete-btn")?.addEventListener("click", async () => {
          if (!confirm("Delete this list?")) return;
          setStatus("Deleting...");
          const res = await fetch("/api/lists/" + listId, { method: "DELETE" });
          if (res.ok) { window.location.href = "/lists"; } else { setStatus("Could not delete."); }
        });

        document.querySelectorAll(".list-remove-game").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const gameId = btn.getAttribute("data-game-id");
            setStatus("Removing game...");
            const res = await fetch("/api/lists/" + listId + "/items/" + gameId, { method: "DELETE" });
            if (res.ok) { window.location.reload(); } else { setStatus("Could not remove game."); }
          });
        });

        const listEl = document.getElementById("list-items");
        const reorderStatus = document.getElementById("list-reorder-status");
        const setReorderStatus = (t) => { if (reorderStatus) reorderStatus.textContent = t; };
        let dragItem = null;

        const saveOrder = async () => {
          if (!listEl) return;
          const items = Array.from(listEl.querySelectorAll("li[data-game-id]"));
          const payload = {
            items: items.map((item, index) => ({
              gameId: item.getAttribute("data-game-id"),
              position: index + 1
            }))
          };
          setReorderStatus("Saving order...");
          const res = await fetch("/api/lists/" + listId + "/items/reorder", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (res.ok) {
            setReorderStatus("Order saved.");
            items.forEach((item, i) => {
              item.querySelectorAll(".position-label").forEach(el => el.textContent = String(i + 1));
            });
          } else {
            setReorderStatus("Could not save order.");
            if (window.appToast) window.appToast("Could not save order.", "error");
          }
        };

        const moveItem = (item, direction) => {
          if (!listEl) return;
          if (direction === "up" && item.previousElementSibling) {
            listEl.insertBefore(item, item.previousElementSibling);
          } else if (direction === "down" && item.nextElementSibling) {
            listEl.insertBefore(item, item.nextElementSibling.nextSibling);
          }
        };

        if (listEl) {
          Array.from(listEl.querySelectorAll("li[data-game-id]")).forEach((item) => {
            item.addEventListener("dragstart", () => {
              dragItem = item;
              item.classList.add("dragging");
            });
            item.addEventListener("dragend", () => {
              item.classList.remove("dragging");
              dragItem = null;
              void saveOrder();
            });
            item.addEventListener("dragover", (event) => {
              event.preventDefault();
            });
            item.addEventListener("drop", (event) => {
              event.preventDefault();
              if (!dragItem || dragItem === item) return;
              const rect = item.getBoundingClientRect();
              const before = event.clientY < rect.top + rect.height / 2;
              if (before) {
                listEl.insertBefore(dragItem, item);
              } else {
                listEl.insertBefore(dragItem, item.nextSibling);
              }
            });
            item.querySelectorAll("button[data-move]").forEach((button) => {
              button.addEventListener("click", async () => {
                const direction = button.getAttribute("data-move");
                if (!direction) return;
                moveItem(item, direction);
                await saveOrder();
              });
            });
          });
        }

        const allGames = ${scriptJson(adminGames.map(g => ({ id: g.id, title: g.title, slug: g.slug })))};
        const searchInput = document.getElementById("game-search-input");
        const searchList = document.getElementById("game-search-list");
        const selectedInput = document.getElementById("game-search-selected");
        const addStatus = document.getElementById("list-add-status");
        let selectedGame = null;
        let activeIdx = -1;

        const renderFilter = (q) => {
          const query = q.toLowerCase();
          const matches = allGames.filter(g => !query || g.title.toLowerCase().includes(query) || g.slug.toLowerCase().includes(query)).slice(0, 20);
          searchList.innerHTML = "";
          activeIdx = -1;
          if (matches.length === 0 || !query) { searchList.classList.remove("open"); return; }
          matches.forEach((g, i) => {
            const div = document.createElement("div");
            div.className = "game-search-item";
            div.textContent = g.title;
            div.dataset.idx = i;
            div.dataset.gameId = g.id;
            div.dataset.gameTitle = g.title;
            div.addEventListener("mousedown", (e) => {
              e.preventDefault();
              pickGame(g);
            });
            searchList.appendChild(div);
          });
          searchList.classList.add("open");
        };

        const pickGame = (g) => {
          selectedGame = g;
          selectedInput.value = g.id;
          searchInput.value = g.title;
          searchList.classList.remove("open");
          const tag = document.createElement("div");
          tag.className = "game-search-selected";
          const strong = document.createElement("strong");
          strong.textContent = g.title;
          const clearButton = document.createElement("button");
          clearButton.type = "button";
          clearButton.id = "clear-game-selection";
          clearButton.textContent = "change";
          tag.append("Selected: ", strong, " ", clearButton);
          searchList.parentNode.appendChild(tag);
          document.getElementById("clear-game-selection")?.addEventListener("click", () => {
            selectedGame = null;
            selectedInput.value = "";
            searchInput.value = "";
            tag.remove();
            searchInput.focus();
          });
        };

        searchInput?.addEventListener("input", () => { renderFilter(searchInput.value); });
        searchInput?.addEventListener("focus", () => { renderFilter(searchInput.value); });
        searchInput?.addEventListener("blur", () => { setTimeout(() => searchList.classList.remove("open"), 150); });
        searchInput?.addEventListener("keydown", (e) => {
          const items = searchList.querySelectorAll(".game-search-item");
          if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle("active", i === activeIdx)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); items.forEach((el, i) => el.classList.toggle("active", i === activeIdx)); }
          else if (e.key === "Enter" && activeIdx >= 0 && items[activeIdx]) { e.preventDefault(); const g = allGames.find(x => x.id === items[activeIdx].dataset.gameId); if (g) pickGame(g); }
        });

        document.getElementById("list-add-game-btn")?.addEventListener("click", async () => {
          if (!selectedGame) { if (addStatus) addStatus.textContent = "Select a game first."; return; }
          if (addStatus) addStatus.textContent = "Adding game...";
          const nextPos = ${items.results.length} + 1;
          const res = await fetch("/api/lists/" + listId + "/items", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: selectedGame.id, position: nextPos })
          });
          if (res.ok) { window.location.reload(); } else {
            const body = await res.json().catch(() => ({}));
            if (addStatus) addStatus.textContent = body.error || "Could not add game.";
          }
        });
      })();
    </script>
    ` : ""}
  `, c.env, { path: `/lists/${list.slug}`, description: listMetaDescription(list, items.results), noindex: isAdminEditor || list.visibility !== "public", jsonLd: [breadcrumbLd([["Home", "/"], ["Lists", "/lists"], [list.title, `/lists/${list.slug}`]]), gameItemListLd(items.results)] }));
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
    "SELECT slug, updated_at FROM games WHERE status = 'approved' ORDER BY updated_at DESC"
  ).all<{ slug: string; updated_at: string }>();
  const lists = await c.env.DB.prepare(
    "SELECT slug, updated_at FROM curated_lists WHERE visibility = 'public' ORDER BY updated_at DESC"
  ).all<{ slug: string; updated_at: string }>();

  const categoriesWithGames = await c.env.DB.prepare(
    `SELECT DISTINCT categories.slug
     FROM categories
     JOIN game_categories ON game_categories.category_id = categories.id
     JOIN games ON games.id = game_categories.game_id
     WHERE categories.is_active = 1 AND games.status = 'approved'
     ORDER BY categories.slug ASC`
  ).all<{ slug: string }>();

  const toLastmod = (value: string) => value.replace(" ", "T") + "Z";
  const latest = (rows: Array<{ updated_at: string }>) => (rows.length > 0 ? toLastmod(rows[0].updated_at) : null);
  const latestGame = latest(games.results);
  const latestList = latest(lists.results);
  const latestAny = [latestGame, latestList].filter((v): v is string => !!v).sort().pop() ?? null;
  const urls = [
    { loc: "/", lastmod: latestAny },
    { loc: "/games", lastmod: latestGame },
    { loc: "/lists", lastmod: latestList },
    { loc: "/mod-log", lastmod: null as string | null },
    ...categoriesWithGames.results.map((cat) => ({ loc: `/games?category=${encodeURIComponent(cat.slug)}`, lastmod: latestGame })),
    ...SIBLING_SITE_URLS.map((loc) => ({ loc, lastmod: null as string | null })),
    ...games.results.map((game) => ({ loc: `/games/${game.slug}`, lastmod: toLastmod(game.updated_at) })),
    ...lists.results.map((list) => ({ loc: `/lists/${list.slug}`, lastmod: toLastmod(list.updated_at) }))
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
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#121212",
      theme_color: "#121212",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }
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
     FROM curated_lists WHERE visibility = 'public' ORDER BY title ASC`
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
    `- [All daily games](${base}/games): every game, sortable by rating, newest, trending or resetting soonest`,
    `- [Curated lists](${base}/lists): lists of games picked by editors and Twitch streamers`,
    `- [Submit a game](${base}/submit): suggest a daily game that's missing`,
    "",
    "## Categories",
    "",
    ...categories.results
      .filter((cat) => cat.game_count > 0)
      .map((cat) => {
        const description = cat.description && !cat.description.startsWith("Imported from") ? `: ${oneLine(cat.description)}` : "";
        return `- [${cat.name}](${base}/games?category=${encodeURIComponent(cat.slug)}) (${cat.game_count} game${cat.game_count === 1 ? "" : "s"})${description}`;
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
    ""
  ].join("\n");
  return c.body(body, 200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=3600" });
});

// Admin SSR pages.
app.get("/admin", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  return c.html(await layout("Admin", auth, `
    <main>
      <h1>Admin</h1>
      <div class="admin-grid">
        <a class="panel" href="/admin/submissions">Moderate submissions</a>
        <a class="panel" href="/admin/reports">Review reports</a>
        <a class="panel" href="/admin/categories">Manage categories</a>
        <a class="panel" href="/admin/lists">Manage curated lists</a>
      </div>
    </main>
  `, c.env));
});

app.get("/admin/submissions", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const status = (c.req.query("status") || "pending") as "pending" | "rejected" | "disabled" | "approved";
  const q = (c.req.query("q") || "").trim();
  const rows = q
    ? await c.env.DB.prepare(
        `SELECT id, title, slug, url, description, status, moderation_note, created_at, reset_basis, reset_time_minutes, reset_timezone, paywall, nsfw
         FROM games
         WHERE status = ?1
           AND (title LIKE ?2 OR url LIKE ?2 OR description LIKE ?2)
         ORDER BY created_at DESC
         LIMIT 200`
      )
        .bind(status, `%${q}%`)
        .all<{ id: string; title: string; slug: string; url: string; description: string | null; status: string; moderation_note: string | null; created_at: string; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null; paywall: number; nsfw: number }>()
    : await c.env.DB.prepare(
        `SELECT id, title, slug, url, description, status, moderation_note, created_at, reset_basis, reset_time_minutes, reset_timezone, paywall, nsfw
         FROM games
         WHERE status = ?1
         ORDER BY created_at DESC
         LIMIT 200`
      )
        .bind(status)
        .all<{ id: string; title: string; slug: string; url: string; description: string | null; status: string; moderation_note: string | null; created_at: string; reset_basis: "local" | "server" | null; reset_time_minutes: number | null; reset_timezone: string | null; paywall: number; nsfw: number }>();

  return c.html(await layout("Admin Submissions", auth, `
    <main>
      <h1>Moderate Submissions</h1>
      <form method="GET" action="/admin/submissions">
        <select name="status">
          ${["pending", "rejected", "disabled", "approved"]
            .map((option) => `<option value="${option}" ${option === status ? "selected" : ""}>${option}</option>`)
            .join("")}
        </select>
        <input name="q" value="${escapeHtml(q)}" placeholder="Search title, URL, description" />
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
              <p><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">Visit game</a> · <a href="/games/${row.slug}">Detail page</a></p>
              <p>Status: <strong>${row.status}</strong>${row.moderation_note ? ` · Note: ${escapeHtml(row.moderation_note)}` : ""}</p>
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
                <span data-tz-wrap><input type="text" list="tz-list" data-tz-input data-reset-timezone="${row.id}" placeholder="Time zone, e.g. America/New_York" maxlength="64" value="${escapeHtml(row.reset_timezone || "")}" /></span>
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
      ${renderTimeZoneDatalist()}
    </main>
    <script>
      ${RESET_TIMEZONE_TOGGLE_SCRIPT}
      const statusNode = document.getElementById("admin-submissions-status");
      const setStatus = (text) => {
        if (statusNode) statusNode.textContent = text;
      };

      const runAction = async (gameId, action) => {
        const payload = action === "reject" ? { note: window.prompt("Reject note (optional):") || "" } : {};
        setStatus("Running " + action + "...");
        const response = await fetch("/api/admin/games/" + gameId + "/" + action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          setStatus("Action failed.");
          return;
        }
        setStatus("Action complete. Refreshing...");
        window.location.reload();
      };

      const collectSelectedIds = () => {
        const checks = Array.from(document.querySelectorAll("input[type=checkbox][data-game-select]"));
        return checks
          .filter((box) => box instanceof HTMLInputElement && box.checked)
          .map((box) => box.getAttribute("value"))
          .filter((id) => typeof id === "string" && id.length > 0);
      };

      const runBulkAction = async (action) => {
        const ids = collectSelectedIds();
        if (ids.length === 0) {
          setStatus("Select at least one submission first.");
          return;
        }
        const note = action === "reject" ? window.prompt("Reject note for selected submissions (optional):") || "" : "";
        setStatus("Running bulk " + action + " on " + ids.length + " item(s)...");
        const response = await fetch("/api/admin/games/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ids, note })
        });
        if (!response.ok) {
          setStatus("Bulk action failed.");
          return;
        }
        setStatus("Bulk action complete. Refreshing...");
        window.location.reload();
      };

      document.querySelectorAll("button[data-action][data-game-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const gameId = button.getAttribute("data-game-id");
          const action = button.getAttribute("data-action");
          if (!gameId || !action) return;
          void runAction(gameId, action);
        });
      });

      document.querySelectorAll("button[data-bulk-game-action]").forEach((button) => {
        button.addEventListener("click", () => {
          const action = button.getAttribute("data-bulk-game-action");
          if (!action) return;
          void runBulkAction(action);
        });
      });

      document.querySelector("button[data-select-all-games]")?.addEventListener("click", () => {
        const checks = Array.from(document.querySelectorAll("input[type=checkbox][data-game-select]"));
        const allChecked = checks.every((box) => box instanceof HTMLInputElement && box.checked);
        checks.forEach((box) => {
          if (box instanceof HTMLInputElement) {
            box.checked = !allChecked;
          }
        });
      });

      document.querySelectorAll("button[data-reset-save]").forEach((button) => {
        button.addEventListener("click", async () => {
          const gameId = button.getAttribute("data-reset-save");
          if (!gameId) return;
          const basisNode = document.querySelector("select[data-reset-basis='" + gameId + "']");
          const timeNode = document.querySelector("input[data-reset-time='" + gameId + "']");
          const zoneNode = document.querySelector("input[data-reset-timezone='" + gameId + "']");
          if (!(basisNode instanceof HTMLSelectElement) || !(timeNode instanceof HTMLInputElement) || !(zoneNode instanceof HTMLInputElement)) {
            return;
          }
          setStatus("Saving reset settings...");
          const response = await fetch("/api/admin/games/" + gameId + "/reset", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resetBasis: basisNode.value || null,
              resetTime: timeNode.value || null,
              resetTimezone: basisNode.value === "server" ? (zoneNode.value.trim() || null) : null
            })
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setStatus(body.error || "Could not save reset settings.");
            return;
          }
          setStatus("Reset settings saved.");
        });
      });
    </script>
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
      <form method="GET" action="/admin/reports">
        <select name="status">
          ${["open", "resolved", "dismissed"]
            .map((option) => `<option value="${option}" ${option === status ? "selected" : ""}>${option}</option>`)
            .join("")}
        </select>
        <input name="q" value="${escapeHtml(q)}" placeholder="Search title, reason, note" />
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
    <script>
      const statusNode = document.getElementById("admin-reports-status");
      const setStatus = (text) => {
        if (statusNode) statusNode.textContent = text;
      };

      const confirmations = {
        delete: "Permanently delete the reported game(s)? This also removes votes, favorites and all reports for them. This cannot be undone."
      };

      const runAction = async (reportId, action) => {
        if (confirmations[action] && !window.confirm(confirmations[action])) return;
        setStatus("Running " + action + "...");
        const response = await fetch("/api/admin/reports/" + reportId + "/" + action, { method: "POST" });
        if (!response.ok) {
          setStatus("Action failed.");
          return;
        }
        setStatus("Action complete. Refreshing...");
        window.location.reload();
      };

      const collectSelectedIds = () => {
        const checks = Array.from(document.querySelectorAll("input[type=checkbox][data-report-select]"));
        return checks
          .filter((box) => box instanceof HTMLInputElement && box.checked)
          .map((box) => box.getAttribute("value"))
          .filter((id) => typeof id === "string" && id.length > 0);
      };

      const runBulkAction = async (action) => {
        const ids = collectSelectedIds();
        if (ids.length === 0) {
          setStatus("Select at least one report first.");
          return;
        }
        if (confirmations[action] && !window.confirm(confirmations[action])) return;
        setStatus("Running bulk " + action + " on " + ids.length + " item(s)...");
        const response = await fetch("/api/admin/reports/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ids })
        });
        if (!response.ok) {
          setStatus("Bulk action failed.");
          return;
        }
        setStatus("Bulk action complete. Refreshing...");
        window.location.reload();
      };

      document.querySelectorAll("button[data-report-action][data-report-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const reportId = button.getAttribute("data-report-id");
          const action = button.getAttribute("data-report-action");
          if (!reportId || !action) return;
          void runAction(reportId, action);
        });
      });

      document.querySelectorAll("button[data-bulk-report-action]").forEach((button) => {
        button.addEventListener("click", () => {
          const action = button.getAttribute("data-bulk-report-action");
          if (!action) return;
          void runBulkAction(action);
        });
      });

      document.querySelector("button[data-select-all-reports]")?.addEventListener("click", () => {
        const checks = Array.from(document.querySelectorAll("input[type=checkbox][data-report-select]"));
        const allChecked = checks.every((box) => box instanceof HTMLInputElement && box.checked);
        checks.forEach((box) => {
          if (box instanceof HTMLInputElement) {
            box.checked = !allChecked;
          }
        });
      });
    </script>
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
          <input name="slug" placeholder="slug" required />
          <input name="name" placeholder="Name" required />
          <textarea name="description" rows="2" placeholder="Description"></textarea>
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
    <script>
      const statusNode = document.getElementById("admin-categories-status");
      const setStatus = (text) => {
        if (statusNode) statusNode.textContent = text;
      };

      const createForm = document.getElementById("create-category-form");
      createForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!(createForm instanceof HTMLFormElement)) return;
        const fd = new FormData(createForm);
        const payload = {
          slug: String(fd.get("slug") || ""),
          name: String(fd.get("name") || ""),
          description: String(fd.get("description") || "").trim() || undefined,
          isActive: fd.get("isActive") === "on"
        };
        setStatus("Creating category...");
        const response = await fetch("/api/admin/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          setStatus("Could not create category.");
          return;
        }
        setStatus("Category created.");
        window.location.reload();
      });

      document.querySelectorAll("button[data-category-toggle]").forEach((button) => {
        button.addEventListener("click", async () => {
          const categoryId = button.getAttribute("data-category-toggle");
          const nextActive = button.getAttribute("data-next-active") === "1";
          if (!categoryId) return;
          setStatus("Updating category...");
          const response = await fetch("/api/admin/categories/" + categoryId, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive: nextActive })
          });
          if (!response.ok) {
            setStatus("Could not update category.");
            return;
          }
          setStatus("Category updated.");
          window.location.reload();
        });
      });

      document.querySelectorAll("button[data-category-delete]").forEach((button) => {
        button.addEventListener("click", async () => {
          const categoryId = button.getAttribute("data-category-delete");
          if (!categoryId) return;
          if (!window.confirm("Delete this category?")) return;
          setStatus("Deleting category...");
          const response = await fetch("/api/admin/categories/" + categoryId, { method: "DELETE" });
          if (!response.ok) {
            setStatus("Could not delete category.");
            return;
          }
          setStatus("Category deleted.");
          window.location.reload();
        });
      });
    </script>
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
          <input name="title" placeholder="List title" required />
          <textarea name="description" rows="2" placeholder="Description"></textarea>
          <select name="visibility">
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
              <form class="stack-form" data-list-edit="${list.id}">
                <label>Edit list metadata</label>
                <input type="text" name="title" value="${escapeHtml(list.title)}" required />
                <input type="text" name="slug" value="${escapeHtml(list.slug)}" required pattern="[a-z0-9-]+" title="Lowercase alphanumeric with hyphens" />
                <textarea name="description" rows="2" placeholder="Description">${escapeHtml(list.description || "")}</textarea>
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
                <select name="gameId">${itemOptions}</select>
                <input type="number" name="position" min="1" value="1" required />
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
            </article>`;
          })
          .join("")}
      </div>
      <p id="admin-lists-status" class="status" aria-live="polite"></p>
    </main>
    <script>
      const statusNode = document.getElementById("admin-lists-status");
      const setStatus = (text) => {
        if (statusNode) statusNode.textContent = text;
      };

      const createForm = document.getElementById("create-list-form");
      createForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!(createForm instanceof HTMLFormElement)) return;
        const fd = new FormData(createForm);
        const payload = {
          title: String(fd.get("title") || ""),
          description: String(fd.get("description") || "").trim() || undefined,
          visibility: String(fd.get("visibility") || "private")
        };
        setStatus("Creating list...");
        const response = await fetch("/api/lists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          setStatus("Could not create list.");
          return;
        }
        setStatus("List created.");
        window.location.reload();
      });

      document.querySelectorAll("button[data-list-visibility]").forEach((button) => {
        button.addEventListener("click", async () => {
          const listId = button.getAttribute("data-list-visibility");
          const visibility = button.getAttribute("data-next-visibility");
          if (!listId || !visibility) return;
          setStatus("Updating visibility...");
          const response = await fetch("/api/lists/" + listId + "/visibility", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ visibility })
          });
          if (!response.ok) {
            setStatus("Could not update visibility.");
            return;
          }
          setStatus("Visibility updated.");
          window.location.reload();
        });
      });

      document.querySelectorAll("button[data-list-delete]").forEach((button) => {
        button.addEventListener("click", async () => {
          const listId = button.getAttribute("data-list-delete");
          if (!listId) return;
          if (!window.confirm("Delete this list?")) return;
          setStatus("Deleting list...");
          const response = await fetch("/api/lists/" + listId, { method: "DELETE" });
          if (!response.ok) {
            setStatus("Could not delete list.");
            return;
          }
          setStatus("List deleted.");
          window.location.reload();
        });
      });

      document.querySelectorAll("form[data-list-add-item]").forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!(form instanceof HTMLFormElement)) return;
          const listId = form.getAttribute("data-list-add-item");
          if (!listId) return;
          const fd = new FormData(form);
          const payload = {
            gameId: String(fd.get("gameId") || ""),
            position: Number(fd.get("position") || 1)
          };
          setStatus("Adding item...");
          const response = await fetch("/api/lists/" + listId + "/items", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            setStatus("Could not add list item.");
            return;
          }
          setStatus("Item added.");
          window.location.reload();
        });
      });

      document.querySelectorAll("form[data-list-edit]").forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!(form instanceof HTMLFormElement)) return;
          const listId = form.getAttribute("data-list-edit");
          if (!listId) return;
          const fd = new FormData(form);
          const payload = {
            title: String(fd.get("title") || ""),
            slug: String(fd.get("slug") || ""),
            description: String(fd.get("description") || "")
          };
          setStatus("Saving list details...");
          const response = await fetch("/api/lists/" + listId, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            setStatus("Could not save list details.");
            return;
          }
          setStatus("List details saved.");
          if (window.appToast) window.appToast("List details updated.", "success");
          window.location.reload();
        });
      });

      document.querySelectorAll("button[data-list-remove-item][data-game-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          const listId = button.getAttribute("data-list-remove-item");
          const gameId = button.getAttribute("data-game-id");
          if (!listId || !gameId) return;
          setStatus("Removing item...");
          const response = await fetch("/api/lists/" + listId + "/items/" + gameId, { method: "DELETE" });
          if (!response.ok) {
            setStatus("Could not remove item.");
            return;
          }
          setStatus("Item removed.");
          window.location.reload();
        });
      });

      document.querySelectorAll("ul[data-sortable-list]").forEach((listNode) => {
        let dragItem = null;
        const listId = listNode.getAttribute("data-sortable-list");
        const items = () => Array.from(listNode.querySelectorAll("li[data-game-id]"));

        const moveItemByDirection = (item, direction) => {
          if (!(item instanceof HTMLElement)) return;
          if (direction === "up") {
            const previous = item.previousElementSibling;
            if (previous) {
              listNode.insertBefore(item, previous);
            }
            return;
          }
          const next = item.nextElementSibling;
          if (next) {
            listNode.insertBefore(next, item);
          }
        };

        const relabel = () => {
          items().forEach((item, index) => {
            const label = item.querySelector(".position-label");
            if (label) label.textContent = String(index + 1);
          });
        };

        relabel();

        items().forEach((item) => {
          item.addEventListener("dragstart", () => {
            dragItem = item;
            item.classList.add("dragging");
          });

          item.addEventListener("dragend", () => {
            item.classList.remove("dragging");
            dragItem = null;
            relabel();
            if (listId) {
              void saveListOrder(listId, false);
            }
          });

          item.addEventListener("dragover", (event) => {
            event.preventDefault();
          });

          item.addEventListener("drop", (event) => {
            event.preventDefault();
            if (!dragItem || dragItem === item) return;
            const rect = item.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (before) {
              listNode.insertBefore(dragItem, item);
            } else {
              listNode.insertBefore(dragItem, item.nextSibling);
            }
            relabel();
          });

          item.querySelectorAll("button[data-list-move]").forEach((button) => {
            button.addEventListener("click", () => {
              const direction = button.getAttribute("data-list-move");
              if (!direction) return;
              moveItemByDirection(item, direction);
              relabel();
              if (listId) {
                void saveListOrder(listId, false);
              }
            });
          });
        });
      });

      const saveListOrder = async (listId, reloadAfterSave) => {
        const listNode = document.querySelector("ul[data-sortable-list='" + listId + "']");
        if (!listNode) return;
        const items = Array.from(listNode.querySelectorAll("li[data-game-id]"));
        const payload = {
          items: items.map((item, index) => ({
            gameId: item.getAttribute("data-game-id"),
            position: index + 1
          }))
        };
        setStatus("Saving item order...");
        const response = await fetch("/api/lists/" + listId + "/items/reorder", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          setStatus("Could not save item order.");
          if (window.appToast) window.appToast("Could not save item order.", "error");
          return;
        }
        setStatus("Item order saved.");
        if (window.appToast) window.appToast("List order saved.", "success");
        if (reloadAfterSave) {
          window.location.reload();
        }
      };

      document.querySelectorAll("button[data-save-list-order]").forEach((button) => {
        button.addEventListener("click", async () => {
          const listId = button.getAttribute("data-save-list-order");
          if (!listId) return;
          await saveListOrder(listId, true);
        });
      });
    </script>
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
  paywall: z.boolean().optional().default(false),
  nsfw: z.boolean().optional().default(false)
});

app.get("/api/games", async (c) => {
  const sort = (c.req.query("sort") || "top") as "top" | "new" | "trending" | "reset";
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
  return c.json(result);
});

// Link and reset timing for a set of games, for the logged-out rotation page (its local favorites only store
// id, slug and title): the link lets a tap on a row open the game, the reset time sorts and labels it.
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

app.get("/api/games/random", async (c) => {
  const game = await c.env.DB.prepare(
    "SELECT id, slug, url FROM games WHERE status = 'approved' AND nsfw = 0 ORDER BY RANDOM() LIMIT 1"
  ).first<{ id: string; slug: string; url: string }>();
  if (!game) {
    return c.json({ error: "No games available" }, 404);
  }
  return c.json(game);
});

app.post("/api/games", async (c) => {
  const user = c.get("user");
  const submitRateKey = user
    ? `submit:${user.id}`
    : `submit:anon:${await getAnonymousVoteKey(c)}`;
  const submitRate = await enforceRateLimit(c.env, submitRateKey, 10, 60 * 60);
  if (!submitRate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: submitRate.retryAfterSeconds }, 429);
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

  const duplicate = await c.env.DB.prepare("SELECT id FROM games WHERE canonical_url = ?1").bind(canonicalUrl).first();
  if (duplicate) {
    return c.json({ error: "Game URL already submitted" }, 409);
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
        (id, title, slug, url, canonical_url, description, submitted_by_user_id, status, approved_at, approved_by_user_id, created_at, updated_at, reset_basis, reset_time_minutes, paywall, nsfw, reset_timezone)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'approved', ?8, ?9, ?8, ?8, ?10, ?11, ?12, ?13, ?14)`
    )
      .bind(id, parsed.data.title, slug, parsed.data.url, canonicalUrl, parsed.data.description || null, user!.id, now, user!.id, resetBasis, resetTimeMinutes, parsed.data.paywall ? 1 : 0, parsed.data.nsfw ? 1 : 0, resetTimezone.value)
      .run();
    await writeAudit(c.env, user!.id, "game", id, "approve", { title: parsed.data.title, slug, via: "submission" });
  } else {
    await c.env.DB.prepare(
      `INSERT INTO games
        (id, title, slug, url, canonical_url, description, submitted_by_user_id, status, created_at, updated_at, reset_basis, reset_time_minutes, paywall, nsfw, reset_timezone)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8, ?9, ?10, ?11, ?12, ?13)`
    )
      .bind(id, parsed.data.title, slug, parsed.data.url, canonicalUrl, parsed.data.description || null, user?.id || null, now, resetBasis, resetTimeMinutes, parsed.data.paywall ? 1 : 0, parsed.data.nsfw ? 1 : 0, resetTimezone.value)
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
  return c.json({ id, status: bypassModeration ? "approved" : "pending" }, 201);
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
  const maxPosRow = await c.env.DB.prepare("SELECT COALESCE(MAX(position), 0) AS maxPosition FROM favorites WHERE user_id = ?1")
    .bind(auth.id)
    .first<{ maxPosition: number }>();
  const position = (maxPosRow?.maxPosition || 0) + 1;
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO favorites (user_id, game_id, position) VALUES (?1, ?2, ?3)"
  )
    .bind(auth.id, gameId, position)
    .run();
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

  const before = await c.env.DB.prepare("SELECT title, slug, status, paywall, nsfw FROM games WHERE id = ?1")
    .bind(gameId)
    .first<{ title: string; slug: string; status: string; paywall: number; nsfw: number }>();
  if (before) {
    if (before.status !== parsed.data.status) {
      const statusAction = ({ approved: "approve", rejected: "reject", disabled: "disable" } as Record<string, "approve" | "reject" | "disable">)[parsed.data.status];
      if (statusAction) {
        await logGameEvents(c.env, auth.id, [gameId], statusAction);
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
         how_to_play = CASE WHEN ?12 = 1 THEN ?13 ELSE how_to_play END, updated_at = datetime('now')
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

  const existingMax = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(position), 0) AS maxPosition FROM favorites WHERE user_id = ?1"
  )
    .bind(auth.id)
    .first<{ maxPosition: number }>();

  let nextPosition = (existingMax?.maxPosition || 0) + 1;
  let imported = 0;
  const updatedGameIds = new Set<string>();
  for (const gameId of parsed.data.ids) {
    const game = await c.env.DB.prepare("SELECT id FROM games WHERE id = ?1 AND status = 'approved'").bind(gameId).first<{ id: string }>();
    if (!game) {
      continue;
    }
    const result = await c.env.DB.prepare("INSERT OR IGNORE INTO favorites (user_id, game_id, position) VALUES (?1, ?2, ?3)")
      .bind(auth.id, gameId, nextPosition)
      .run();
    const changed = (result.meta as { changes?: number } | undefined)?.changes || 0;
    if (changed > 0) {
      imported += 1;
      nextPosition += 1;
      updatedGameIds.add(gameId);
    }
  }

  for (const gameId of updatedGameIds) {
    await updateGameScore(c.env, gameId);
  }
  if (updatedGameIds.size > 0) {
    await invalidateGameCaches(c.env);
  }

  return c.json({ ok: true, imported });
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
  const exportData = {
    version: 1,
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
  const existingMax = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(position), 0) AS maxPosition FROM favorites WHERE user_id = ?1"
  )
    .bind(auth.id)
    .first<{ maxPosition: number }>();
  let nextPosition = (existingMax?.maxPosition || 0) + 1;
  let imported = 0;
  const updatedGameIds = new Set<string>();
  for (const item of parsed.data.items) {
    const game = await c.env.DB.prepare("SELECT id FROM games WHERE id = ?1 AND status = 'approved'")
      .bind(item.id)
      .first<{ id: string }>();
    if (!game) continue;
    const result = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO favorites (user_id, game_id, position) VALUES (?1, ?2, ?3)"
    )
      .bind(auth.id, item.id, nextPosition)
      .run();
    const changed = (result.meta as { changes?: number } | undefined)?.changes || 0;
    if (changed > 0) {
      imported += 1;
      nextPosition += 1;
      updatedGameIds.add(item.id);
    }
  }
  for (const gameId of updatedGameIds) {
    await updateGameScore(c.env, gameId);
  }
  if (updatedGameIds.size > 0) {
    await invalidateGameCaches(c.env);
  }
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
    ...(provider === "discord" ? [c.env.DB.prepare("UPDATE users SET role = 'user', updated_at = datetime('now') WHERE id = ?1").bind(auth.id)] : [])
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

app.post("/api/games/:id/report", async (c) => {
  const user = c.get("user");
  const gameId = c.req.param("id");

  let reporterId: string;
  let rateLimitKey: string;
  if (user) {
    reporterId = user.id;
    rateLimitKey = `report:${user.id}`;
  } else {
    const ipHash = await getAnonymousVoteKey(c);
    const anonEmail = `anon-${ipHash}@anonymous.local`;
    let anonUser = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(anonEmail).first<{ id: string }>();
    if (!anonUser) {
      const anonId = crypto.randomUUID();
      await c.env.DB.prepare("INSERT INTO users (id, email, role) VALUES (?1, ?2, 'user')").bind(anonId, anonEmail).run();
      anonUser = { id: anonId };
    }
    reporterId = anonUser.id;
    rateLimitKey = `report:anon:${ipHash}`;
  }

  const reportRate = await enforceRateLimit(c.env, rateLimitKey, 20, 60 * 60);
  if (!reportRate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: reportRate.retryAfterSeconds }, 429);
  }
  const parsed = reportSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
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

app.post("/api/games/:id/click", async (c) => {
  const gameId = c.req.param("id");
  // Clicks feed the score, so cap how many one visitor can contribute per game.
  const clickRate = await enforceRateLimit(c.env, `click:${await getAnonymousVoteKey(c)}:${gameId}`, 5, 60 * 60);
  if (!clickRate.ok) {
    return c.json({ ok: true });
  }
  await c.env.DB.prepare("UPDATE games SET click_count = click_count + 1 WHERE id = ?1").bind(gameId).run();
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
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
  const items = await c.env.DB.prepare(
    `SELECT games.id, games.slug, games.title, curated_list_items.position
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
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens").optional()
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
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const visibility = z.enum(["public", "private"]).safeParse((await c.req.json()).visibility);
  if (!visibility.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  await c.env.DB.prepare("UPDATE curated_lists SET visibility = ?1, updated_by_user_id = ?2, updated_at = datetime('now') WHERE id = ?3")
    .bind(visibility.data, auth.id, c.req.param("id"))
    .run();
  await writeAudit(c.env, auth.id, "list", c.req.param("id"), "update_visibility", { visibility: visibility.data });
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
  const existing = await c.env.DB.prepare("SELECT title, description, slug FROM curated_lists WHERE id = ?1")
    .bind(listId)
    .first<{ title: string; description: string | null; slug: string }>();
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
     SET title = ?1, description = ?2, slug = ?3, updated_by_user_id = ?4, updated_at = datetime('now')
     WHERE id = ?5`
  )
    .bind(
      parsed.data.title ?? existing.title,
      parsed.data.description === undefined ? existing.description : parsed.data.description,
      parsed.data.slug ?? existing.slug,
      auth.id,
      listId
    )
    .run();
  await writeAudit(c.env, auth.id, "list", listId, "update_list", parsed.data);
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
  const maxPos = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(position), 0) as maxPos FROM curated_list_items WHERE curated_list_id = ?1"
  ).bind(listId).first<{ maxPos: number }>();
  const nextPos = (maxPos?.maxPos ?? 0) + 1;
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO curated_list_items (curated_list_id, game_id, position, added_by_user_id)
     VALUES (?1, ?2, ?3, ?4)`
  )
    .bind(listId, parsed.data.gameId, nextPos, auth.id)
    .run();
  await writeAudit(c.env, auth.id, "list", listId, "add_item", { gameId: parsed.data.gameId, position: nextPos });
  return c.json({ ok: true });
});

app.delete("/api/lists/:id/items/:gameId", async (c) => {
  const auth = await requireListEditor(c, c.req.param("id"));
  if (auth instanceof Response) {
    return auth;
  }
  await c.env.DB.prepare("DELETE FROM curated_list_items WHERE curated_list_id = ?1 AND game_id = ?2")
    .bind(c.req.param("id"), c.req.param("gameId"))
    .run();
  await writeAudit(c.env, auth.id, "list", c.req.param("id"), "remove_item", { gameId: c.req.param("gameId") });
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
  return c.json({ ok: true });
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
    "UPDATE games SET reset_basis = ?1, reset_time_minutes = ?2, reset_timezone = ?4, updated_at = datetime('now') WHERE id = ?3"
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

  await logGameEvents(c.env, auth.id, parsed.data.ids, parsed.data.action, parsed.data.note ? { note: parsed.data.note } : {});
  const statements = parsed.data.ids.map((gameId) => {
    if (parsed.data.action === "approve") {
      return c.env.DB.prepare(
        "UPDATE games SET status = 'approved', approved_at = datetime('now'), approved_by_user_id = ?1, updated_at = datetime('now') WHERE id = ?2"
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
    return c.env.DB.prepare("UPDATE games SET status = 'approved', updated_at = datetime('now') WHERE id = ?1").bind(gameId);
  });

  await c.env.DB.batch(statements);
  if (parsed.data.action === "approve" || parsed.data.action === "restore") {
    for (const gameId of parsed.data.ids) {
      await updateGameScore(c.env, gameId);
    }
  }

  await invalidateGameCaches(c.env);
  return c.json({ ok: true, count: parsed.data.ids.length });
});

app.post("/api/admin/games/:id/approve", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  await logGameEvents(c.env, auth.id, [gameId], "approve");
  await c.env.DB.prepare(
    `UPDATE games
     SET status = 'approved', approved_at = datetime('now'), approved_by_user_id = ?1, updated_at = datetime('now')
     WHERE id = ?2`
  )
    .bind(auth.id, gameId)
    .run();
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
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
  await c.env.DB.prepare("UPDATE games SET status = 'approved', updated_at = datetime('now') WHERE id = ?1").bind(gameId).run();
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
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runLinkChecks(env));
    ctx.waitUntil(recalculateAllScores(env));
  }
};

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
  if (owns) {
    return auth;
  }
  return c.json({ error: "Forbidden" }, 403);
}

/** App access token for Twitch's Helix API (client credentials), cached in KV until shortly before expiry. */
async function getTwitchAppToken(env: Env): Promise<string | null> {
  if (!env.OAUTH_TWITCH_CLIENT_ID || !env.OAUTH_TWITCH_CLIENT_SECRET) {
    return null;
  }
  const cached = await env.CACHE.get("twitch:app_token");
  if (cached) {
    return cached;
  }
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.OAUTH_TWITCH_CLIENT_ID,
      client_secret: env.OAUTH_TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials"
    }),
    signal: AbortSignal.timeout(2500)
  });
  if (!res.ok) {
    console.error("Twitch app token request failed:", res.status, await res.text());
    return null;
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    return null;
  }
  await env.CACHE.put("twitch:app_token", json.access_token, { expirationTtl: Math.max(60, (json.expires_in ?? 3600) - 300) });
  return json.access_token;
}

/**
 * Whether a Twitch user is streaming right now, for the LIVE tag on their list. Cached in KV for a minute per user
 * so list views don't each call Twitch. Any failure (no credentials, timeout, Twitch error) counts as not live.
 */
async function isTwitchUserLive(env: Env, twitchUserId: string): Promise<boolean> {
  const key = `twitch:live:${twitchUserId}`;
  const cached = await env.CACHE.get(key);
  if (cached !== null) {
    return cached === "1";
  }
  try {
    const token = await getTwitchAppToken(env);
    if (!token) {
      return false;
    }
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(twitchUserId)}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": env.OAUTH_TWITCH_CLIENT_ID! },
      signal: AbortSignal.timeout(2500)
    });
    if (res.status === 401) {
      await env.CACHE.delete("twitch:app_token");
    }
    if (!res.ok) {
      return false;
    }
    const live = (((await res.json()) as { data?: unknown[] }).data?.length ?? 0) > 0;
    await env.CACHE.put(key, live ? "1" : "0", { expirationTtl: 60 });
    return live;
  } catch {
    return false;
  }
}

/** Resolves a Twitch username to its stable id and canonical login. null = no such user; throws if Twitch is unreachable. */
async function lookupTwitchUser(env: Env, login: string): Promise<{ id: string; login: string } | null> {
  const token = await getTwitchAppToken(env);
  if (!token) {
    throw new Error("twitch-unavailable");
  }
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
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
  if (!twitchLogin) {
    return "";
  }
  return `<span class="verified-badge" title="Verified: curated by Twitch user ${escapeHtml(twitchLogin)}" aria-label="Verified"><svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polygon points="12.00,1.80 15.14,4.42 19.21,4.79 19.58,8.86 22.20,12.00 19.58,15.14 19.21,19.21 15.14,19.58 12.00,22.20 8.86,19.58 4.79,19.21 4.42,15.14 1.80,12.00 4.42,8.86 4.79,4.79 8.86,4.42" fill="#1d9bf0" stroke="#1d9bf0" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 12.5l3.2 3.2L17 8.8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
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
  const row = await env.DB.prepare("SELECT window_start, count FROM rate_limits WHERE key = ?1")
    .bind(key)
    .first<{ window_start: number; count: number }>();

  if (!row) {
    await env.DB.prepare(
      "INSERT INTO rate_limits (key, window_start, count, updated_at) VALUES (?1, ?2, 1, datetime('now'))"
    )
      .bind(key, windowStart)
      .run();
    return { ok: true, retryAfterSeconds: 0 };
  }

  if (row.window_start !== windowStart) {
    await env.DB.prepare(
      "UPDATE rate_limits SET window_start = ?1, count = 1, updated_at = datetime('now') WHERE key = ?2"
    )
      .bind(windowStart, key)
      .run();
    return { ok: true, retryAfterSeconds: 0 };
  }

  if (row.count >= maxRequests) {
    const retryAfter = Math.max(1, windowStart + windowSeconds - now);
    return { ok: false, retryAfterSeconds: retryAfter };
  }

  await env.DB.prepare("UPDATE rate_limits SET count = count + 1, updated_at = datetime('now') WHERE key = ?1")
    .bind(key)
    .run();
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
  const placeholders = uniqueIds.map((_id, index) => `?${index + 1}`).join(", ");
  const rows = await env.DB.prepare(
    `SELECT game_categories.game_id, categories.slug, categories.name
     FROM game_categories
     JOIN categories ON categories.id = game_categories.category_id
     WHERE game_categories.game_id IN (${placeholders})
     ORDER BY categories.name ASC`
  )
    .bind(...uniqueIds)
    .all<{ game_id: string; slug: string; name: string }>();
  for (const row of rows.results) {
    const list = map.get(row.game_id) ?? [];
    list.push({ slug: row.slug, name: row.name });
    map.set(row.game_id, list);
  }
  return map;
}


function renderCategoryPills(categories: Array<{ slug: string; name: string }> | undefined): string {
  if (!categories || categories.length === 0) {
    return "";
  }
  return `<div class="category-pills">${categories
    .map((cat) => {
      const hue = categoryHue(cat.slug);
      const style = `color:hsl(${hue}, 65%, 28%); background:hsl(${hue}, 65%, 90%); border-color:hsl(${hue}, 55%, 72%);`;
      return `<a href="/games?category=${encodeURIComponent(cat.slug)}" class="tag category-pill" style="${style}">${escapeHtml(cat.name)}</a>`;
    })
    .join("")}</div>`;
}

async function listGames(
  env: Env,
  opts: {
    sort: "top" | "new" | "trending" | "reset";
    category?: string;
    q?: string;
    limit: number;
    offset?: number;
    hidePaywall?: boolean;
    hideNsfw?: boolean;
  }
): Promise<
  Array<{
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
  }>
> {
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
      ? "games.updated_at DESC, games.score DESC"
      : opts.sort === "reset"
      ? `CASE WHEN games.reset_time_minutes IS NULL THEN 1 ELSE 0 END ASC,
         CASE
           WHEN games.reset_time_minutes IS NULL THEN 9999
           ELSE ((((games.reset_time_minutes - (${resetOffsetSql}) - ((CAST(strftime('%H','now') AS INTEGER) * 60) + CAST(strftime('%M','now') AS INTEGER))) % 1440) + 1440) % 1440)
         END ASC,
         games.title ASC`
      : "games.score DESC, games.vote_up_count DESC";

  const params: Array<string | number> = [];
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

  params.push(...sortParams, opts.limit, opts.offset || 0);

  const sql = `
    SELECT DISTINCT games.id, games.title, games.slug, games.url, games.description,
           games.score, games.vote_up_count, games.vote_down_count,
           games.reset_basis, games.reset_time_minutes, games.reset_timezone, games.paywall, games.nsfw
    FROM games
    LEFT JOIN game_categories ON games.id = game_categories.game_id
    LEFT JOIN categories ON categories.id = game_categories.category_id
    ${whereSql}
    ORDER BY ${sortSql}
    LIMIT ?
    OFFSET ?
  `;

  const rows = await env.DB.prepare(sql)
    .bind(...params)
    .all<{
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
    }>();

  const categoriesByGameId = await getCategoriesForGames(env, rows.results.map((row) => row.id));

  return rows.results.map((row) => ({
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
    categories: categoriesByGameId.get(row.id) ?? []
  }));
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
): Promise<void> {
  const ids = [...new Set(gameIds)];
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
  // D1 allows 100 bound parameters per query: 1 for the viewer plus up to 98 game ids.
  for (let i = 0; i < gameIds.length; i += 98) {
    const ids = gameIds.slice(i, i + 98);
    const placeholders = ids.map((_id, index) => `?${index + 2}`).join(", ");
    const voteRows = await c.env.DB.prepare(
      user
        ? `SELECT game_id, value FROM votes WHERE user_id = ?1 AND game_id IN (${placeholders})`
        : `SELECT game_id, value FROM anonymous_votes WHERE anon_ip_hash = ?1 AND game_id IN (${placeholders})`
    )
      .bind(viewerKey, ...ids)
      .all<{ game_id: string; value: -1 | 1 }>();
    for (const row of voteRows.results) {
      votes.set(row.game_id, row.value);
    }
    if (user) {
      const favoriteRows = await c.env.DB.prepare(`SELECT game_id FROM favorites WHERE user_id = ?1 AND game_id IN (${placeholders})`)
        .bind(user.id, ...ids)
        .all<{ game_id: string }>();
      for (const row of favoriteRows.results) {
        favorites.add(row.game_id);
      }
    }
  }
  return { votes, favorites };
}

// A real link (not a scripted button) so crawlers can follow it to the game's page.
function renderDetailsLink(slug: string, title: string): string {
  return `<a class="btn-details" href="/games/${encodeURIComponent(slug)}" aria-label="${escapeHtml(`${title} details`)}" title="Details">…</a>`;
}

// Share of votes that are upvotes, e.g. "88% liked". Empty when nobody has voted yet.
function renderLikedLabel(upVotes: number, downVotes: number): string {
  const total = upVotes + downVotes;
  if (total === 0) {
    return "";
  }
  return `<span title="${upVotes} up, ${downVotes} down">${Math.round((upVotes / total) * 100)}% liked</span>`;
}

// "Score and reset" line under a game card's title.
function renderGameMeta(upVotes: number, downVotes: number, resetSpan: string): string {
  const parts = [renderLikedLabel(upVotes, downVotes), resetSpan].filter(Boolean);
  return parts.length > 0 ? `<div class="meta">${parts.join(" · ")}</div>` : "";
}

function gameAriaLabel(game: { title: string; description: string | null; voteUpCount: number; voteDownCount: number }): string {
  const description = (game.description || "").trim();
  const intro = description ? `${game.title}: ${description}` : game.title;
  const sentence = /[.!?]$/.test(intro) ? intro : `${intro}.`;
  const total = game.voteUpCount + game.voteDownCount;
  return total === 0 ? `${sentence} No votes yet.` : `${sentence} ${Math.round((game.voteUpCount / total) * 100)}% of ${total} vote${total === 1 ? "" : "s"} are upvotes.`;
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
  }>,
  user: AppUser | null,
  userVotes: Map<string, -1 | 1>,
  userFavorites: Set<string>
): string {
  if (games.length === 0) {
    return "<p>No games found.</p>";
  }

  return `<ul class="games compact">
    ${games
      .map((game) => {
        const currentVote = userVotes.get(game.id) || 0;
        const currentFavorite = userFavorites.has(game.id);
        return `<li class="card-click">
          <div class="game-row" data-game-row="${game.id}" data-vote="${currentVote}" data-game-slug="${escapeHtml(game.slug)}" data-game-title="${escapeHtml(game.title)}">
            <div class="game-top">
              <div class="game-name">
                <a class="game-title card-link" href="${escapeHtml(game.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(gameAriaLabel(game))}">${escapeHtml(game.title)}</a>
                ${game.paywall ? `<span class="paywall-badge" title="This game requires payment to play">$</span>` : ""}
                ${game.nsfw ? `<span class="nsfw-badge" title="This game contains NSFW content">nsfw</span>` : ""}
              </div>
              <div class="compact-actions">
                <button type="button" data-list-vote="up" class="${currentVote === 1 ? "active" : ""}" title="Vote up">▲ <span data-up-count>${game.voteUpCount}</span></button>
                <button type="button" data-list-vote="down" class="${currentVote === -1 ? "active" : ""}" title="Vote down">▼ <span data-down-count>${game.voteDownCount}</span></button>
                ${
                  user
                    ? `<button type="button" data-list-favorite="${currentFavorite ? "yes" : "no"}" aria-label="Favorite">${currentFavorite ? "★" : "☆"}</button>`
                    : `<button type="button" data-local-favorite="no" aria-label="Favorite">☆</button>`
                }
                ${renderDetailsLink(game.slug, game.title)}
              </div>
            </div>
            <div class="game-sub">
              ${renderCategoryPills(game.categories)}
              ${renderGameMeta(game.voteUpCount, game.voteDownCount, renderResetSpan(game.resetBasis, game.resetTimeMinutes, game.resetTimezone))}
            </div>
          </div>
        </li>`;
      })
      .join("")}
  </ul>`;
}

function renderGameListInteractionScript(opts: { includeImportPanel: boolean; promptFromQuery: boolean }): string {
  return `<script>
    (() => {
      const games = window.dglGames;
      const promptFromQuery = ${opts.promptFromQuery ? "true" : "false"};
      const includeImportPanel = ${opts.includeImportPanel ? "true" : "false"};
      if (includeImportPanel && promptFromQuery) {
        const panel = document.getElementById("local-favorites-import-panel");
        const summary = document.getElementById("local-favorites-import-summary");
        const status = document.getElementById("local-favorites-import-status");
        const importButton = document.getElementById("local-favorites-import-btn");
        const dismissButton = document.getElementById("local-favorites-import-dismiss");
        const setStatus = (text) => {
          if (status) status.textContent = text;
        };
        const favoriteCount = games.readLocalFavorites().length;
        if (panel && favoriteCount > 0) {
          panel.hidden = false;
          if (summary) {
            summary.textContent = "Found " + favoriteCount + " local favorite" + (favoriteCount === 1 ? "" : "s") + ".";
          }
          const dismiss = () => {
            panel.hidden = true;
            const url = new URL(window.location.href);
            url.searchParams.delete("importLocal");
            window.history.replaceState({}, "", url.toString());
          };
          dismissButton?.addEventListener("click", dismiss);
          importButton?.addEventListener("click", async () => {
            setStatus("Importing favorites...");
            const result = await games.importLocalFavorites();
            if (result !== "imported") {
              setStatus(result === "empty" ? "No valid local favorites to import." : "Could not import local favorites.");
              return;
            }
            setStatus("Imported. Redirecting to your rotation...");
            if (window.appToast) window.appToast("Imported local favorites.", "success");
            window.setTimeout(() => {
              window.location.href = "/me/rotation";
            }, 500);
          });
        }
      }

      // Wires up vote/favorite buttons on every game row under root. Exposed so pages that swap in new rows
      // (live search on /games) can wire those too.
      const bindRows = (root) => root.querySelectorAll("[data-game-row]").forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const gameId = node.getAttribute("data-game-row");
        if (!gameId) return;
        const upButton = node.querySelector("button[data-list-vote='up']");
        const downButton = node.querySelector("button[data-list-vote='down']");
        const favoriteButton = node.querySelector("button[data-list-favorite]");
        const localFavoriteButton = node.querySelector("button[data-local-favorite]");
        const upCount = node.querySelector("[data-up-count]");
        const downCount = node.querySelector("[data-down-count]");
        let currentVote = Number(node.getAttribute("data-vote") || "0");

        const setVoteState = (value) => {
          upButton?.classList.toggle("active", value === 1);
          downButton?.classList.toggle("active", value === -1);
        };

        const submitVote = async (value) => {
          const previous = currentVote;
          if (currentVote === value) return;
          currentVote = value;
          setVoteState(value);
          games.shiftVoteCounts(upCount, downCount, previous, value);
          if (await games.saveVote(gameId, value)) return;
          currentVote = previous;
          setVoteState(previous);
          games.shiftVoteCounts(upCount, downCount, value, previous);
          if (window.appToast) window.appToast("Could not save vote.", "error");
        };

        upButton?.addEventListener("click", () => submitVote(1));
        downButton?.addEventListener("click", () => submitVote(-1));

        favoriteButton?.addEventListener("click", async () => {
          const favorited = favoriteButton.getAttribute("data-list-favorite") === "yes";
          favoriteButton.setAttribute("data-list-favorite", favorited ? "no" : "yes");
          favoriteButton.textContent = favorited ? "☆" : "★";
          if (!(await games.setAccountFavorite(gameId, !favorited))) {
            favoriteButton.setAttribute("data-list-favorite", favorited ? "yes" : "no");
            favoriteButton.textContent = favorited ? "★" : "☆";
            if (window.appToast) window.appToast("Could not update favorite.", "error");
          }
        });

        if (localFavoriteButton) {
          const game = { id: gameId, slug: node.getAttribute("data-game-slug") || "", title: node.getAttribute("data-game-title") || "" };
          const setLocalFavoriteState = (favorited) => {
            localFavoriteButton.setAttribute("data-local-favorite", favorited ? "yes" : "no");
            localFavoriteButton.textContent = favorited ? "★" : "☆";
          };
          localFavoriteButton.addEventListener("click", async () => {
            setLocalFavoriteState(await games.toggleLocalFavorite(game));
          });
          setLocalFavoriteState(games.isLocalFavorite(gameId));
        }
      });
      bindRows(document);
      window.dglBindGameRows = bindRows;
    })();
  </script>`;
}

function getClientIp(c: Context<{ Bindings: Bindings; Variables: AppVariables }>): string {
  const cfIp = (c.req.header("cf-connecting-ip") || "").trim();
  if (cfIp) {
    return cfIp;
  }
  const forwarded = c.req.header("x-forwarded-for") || "";
  const first = forwarded.split(",")[0]?.trim() || "";
  return first || "unknown";
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

function renderTimeZoneDatalist(): string {
  return `<datalist id="tz-list">${listTimeZones().map((zone) => `<option value="${escapeHtml(zone)}"></option>`).join("")}</datalist>`;
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
    <input type="text" name="${inputName}" list="tz-list" data-tz-input placeholder="e.g. America/New_York" maxlength="64" value="${escapeHtml(value || "")}" ${extraAttrs} />
  </label>`;
}

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
      minutesLeft
    };
  };
  window.dglLocalizeResets = (root) => {
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
      }
    });
  };
  window.dglLocalizeResets();
  window.setInterval(() => window.dglLocalizeResets(), 60 * 1000);
`;

// Shared client-side vote/favorite actions, loaded on every page by layout(). Logged-out favorites live in
// localStorage (key dgl_local_favorites_v1) and are mirrored to /favorite-anon so they count toward scoring.
const GAME_ACTIONS_SCRIPT = `
  window.dglGames = (() => {
    const FAVORITES_KEY = "dgl_local_favorites_v1";
    const ANON_ID_KEY = "dgl_anon_favorites_id_v1";
    const readLocalFavorites = () => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row.id === "string" && row.id.length > 0) : [];
      } catch {
        return [];
      }
    };
    const writeLocalFavorites = (items) => {
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(items));
    };
    // The API only accepts a UUID. randomUUID is missing outside secure contexts (e.g. the LAN dev URL), and older
    // clients stored non-UUID ids, so those are replaced.
    const getAnonId = () => {
      let value = window.localStorage.getItem(ANON_ID_KEY) || "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        value = crypto.randomUUID
          ? crypto.randomUUID()
          : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
        window.localStorage.setItem(ANON_ID_KEY, value);
      }
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
    const saveVote = async (gameId, value) => {
      const ok = await succeeded(fetch("/api/games/" + encodeURIComponent(gameId) + "/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value })
      }));
      if (ok && !hasVoted()) document.cookie = "dgl_voted=1; path=/; max-age=31536000; samesite=lax";
      return ok;
    };
    const isReturningVisitor = () => hasVoted() || readLocalFavorites().length > 0;
    // Moves one vote from fromValue to toValue (1, -1 or 0) in the displayed up/down counts.
    const shiftVoteCounts = (upNode, downNode, fromValue, toValue) => {
      if (!(upNode instanceof HTMLElement) || !(downNode instanceof HTMLElement)) return;
      const up = Number(upNode.textContent || "0") - (fromValue === 1 ? 1 : 0) + (toValue === 1 ? 1 : 0);
      const down = Number(downNode.textContent || "0") - (fromValue === -1 ? 1 : 0) + (toValue === -1 ? 1 : 0);
      upNode.textContent = String(Math.max(0, up));
      downNode.textContent = String(Math.max(0, down));
    };
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
    return { readLocalFavorites, writeLocalFavorites, isLocalFavorite, toggleLocalFavorite, setAccountFavorite, saveVote, shiftVoteCounts, importLocalFavorites, isReturningVisitor };
  })();
`;

// Client helper: toggles a list between its manual order and "resetting soonest" order.
const LIST_SORT_SCRIPT = `
  window.dglListSort = (() => {
    const KEY = "dgl_list_sort_v1";
    const readMode = () => {
      try { return window.localStorage.getItem(KEY) === "reset" ? "reset" : "default"; } catch { return "default"; }
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
    const init = (list, select) => {
      if (!list || !select) return { refresh() {}, apply() {} };
      const items = () => Array.from(list.children).filter((el) => el.tagName === "LI" && el.hasAttribute("data-game-id"));
      const apply = () => {
        const mode = select.value === "reset" ? "reset" : "default";
        const now = new Date();
        list.classList.toggle("sorted-by-reset", mode === "reset");
        const sorted = items().sort((a, b) => {
          const indexDiff = Number(a.dataset.defaultIndex) - Number(b.dataset.defaultIndex);
          if (mode !== "reset") return indexDiff;
          const ua = minutesUntilReset(a, now);
          const ub = minutesUntilReset(b, now);
          if (ua === ub) return indexDiff;
          return ua < ub ? -1 : 1;
        });
        sorted.forEach((li) => list.appendChild(li));
      };
      // Re-capture the manual order from the DOM (call after the list is rebuilt in its manual order).
      const refresh = () => {
        items().forEach((li, index) => { li.dataset.defaultIndex = String(index); });
        apply();
      };
      select.value = readMode();
      select.addEventListener("change", () => { writeMode(select.value); apply(); });
      refresh();
      return { refresh, apply };
    };
    return { init };
  })();
`;

function renderListSortControl(): string {
  return `<label class="list-sort">Sort
    <select id="list-sort-select" aria-label="Sort order">
      <option value="default">Default order</option>
      <option value="reset">Resetting soonest</option>
    </select>
  </label>`;
}

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

async function layout(title: string, user: AppUser | null, body: string, env: Env, opts?: { description?: string; path?: string; jsonLd?: unknown[]; noindex?: boolean; image?: { path: string; alt: string } }): Promise<string> {
  const listCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM curated_lists").first<{ cnt: number }>();
  const hasLists = (listCount?.cnt ?? 0) > 0;
  const isAdminEditor = !!user && (user.role === "editor" || user.role === "admin");
  let pendingSubmissionCount = 0;
  let openReportCount = 0;
  if (isAdminEditor) {
    const pendingSubmissions = await env.DB.prepare("SELECT COUNT(*) as cnt FROM games WHERE status = 'pending'").first<{ cnt: number }>();
    const openReports = await env.DB.prepare("SELECT COUNT(*) as cnt FROM reports WHERE status = 'open'").first<{ cnt: number }>();
    pendingSubmissionCount = pendingSubmissions?.cnt ?? 0;
    openReportCount = openReports?.cnt ?? 0;
  }
  const description = opts?.description || "Find the best daily games. Browse, vote, favorite, and explore curated lists.";
  const pagePath = opts?.path || "/";
  const fullTitle = title.includes("0x9 dles") ? title : `${title} | 0x9 dles`;
  const image = opts?.image ?? { path: "/og.png?v=2", alt: "0x9 dles: the best daily games, all in one place" };
  // Links that fit in the header on desktop but move into the ☰ menu on phones.
  const secondaryLinks = [
    hasLists || isAdminEditor ? `<a href="/lists">Lists</a>` : "",
    user ? `<a href="/me/settings">Settings</a>` : "",
    isAdminEditor
      ? `<a href="/admin">Admin${openReportCount > 0 ? `<span class="moderation-badge moderation-badge-reports" title="Open reports">${openReportCount}</span>` : ""}${pendingSubmissionCount > 0 ? `<span class="moderation-badge moderation-badge-submissions" title="Pending submissions">${pendingSubmissionCount}</span>` : ""}</a>`
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
    <script>${GAME_ACTIONS_SCRIPT}</script>
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
    <meta name="theme-color" content="#121212" />
    <meta name="apple-mobile-web-app-title" content="0x9 dles" />
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
    <style>
      :root {
        color-scheme: dark;
        --bg: #121212;
        --bg-soft: #1a1a1a;
        --ink: #E0E0E0;
        --muted: #B0B0B0;
        --accent: #888888;
        --accent-strong: #777777;
        --card: #1e1e1e;
        --border: #444444;
        --shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
        --header-bg: rgba(18, 18, 18, 0.85);
        --on-accent: #121212;
        --brand-blue: #00a4fc;
        --title-ink: #f2f2f2;
        --reset-bar: #7dd3fc;
      }
      html[data-theme="light"] {
        color-scheme: light;
        --bg: #f5f5f7;
        --bg-soft: #ececf0;
        --ink: #1c1c1e;
        --muted: #5c5c63;
        --accent: #4b5563;
        --accent-strong: #374151;
        --card: #ffffff;
        --border: #c9c9d1;
        --shadow: 0 10px 24px rgba(0, 0, 0, 0.08);
        --header-bg: rgba(245, 245, 247, 0.85);
        --on-accent: #ffffff;
        --brand-blue: #0077c2;
        --title-ink: #111114;
        --reset-bar: #0ea5e9;
      }
      * { box-sizing: border-box; }
      /* Elements toggled with the hidden attribute stay hidden even when a rule gives them a display value. */
      [hidden] { display: none !important; }
      body {
        margin: 0;
        color: var(--ink);
        font-family: "Manrope", "IBM Plex Sans", "Segoe UI", "Helvetica Neue", sans-serif;
        background: var(--bg);
      }
      header.site-header {
        display: flex;
        align-items: center;
        gap: 1.25rem;
        padding: 0.8rem 1.5rem;
        border-bottom: 1px solid var(--border);
        background: var(--header-bg);
        backdrop-filter: blur(10px);
        position: sticky;
        top: 0;
        z-index: 20;
      }
      /* Mirrors the logo: "0x9" with the x in the logo's blue. */
      .brand { font-weight: 800; font-size: 1.45rem; letter-spacing: 0.01em; color: var(--ink); text-decoration: none; white-space: nowrap; margin-right: 0.5rem; }
      .brand-x { color: var(--brand-blue); }
      .site-nav { display: flex; align-items: center; gap: 1rem; min-width: 0; }
      .nav-extra { display: contents; }
      .site-nav a, .nav-menu-panel a { color: var(--ink); text-decoration: none; font-weight: 600; white-space: nowrap; }
      .site-nav a:hover, .nav-menu-panel a:hover { color: var(--accent); }
      .header-tools { display: flex; align-items: center; gap: 0.6rem; margin-left: auto; white-space: nowrap; color: var(--muted); font-size: 0.9rem; }
      .theme-toggle { padding: 0.25rem 0.5rem; cursor: pointer; }
      .logout-form { display: inline; margin: 0; }
      .logout-form button { background: none; border: none; padding: 0; color: var(--accent); text-decoration: underline; font: inherit; cursor: pointer; }
      .nav-menu { display: none; position: relative; }
      .nav-menu > summary { list-style: none; cursor: pointer; position: relative; display: flex; align-items: center; justify-content: center; min-width: 44px; min-height: 40px; border: 1px solid var(--border); border-radius: 8px; font-size: 1.15rem; color: var(--ink); }
      .nav-menu > summary::-webkit-details-marker { display: none; }
      .menu-dot { position: absolute; top: -4px; right: -4px; width: 10px; height: 10px; border-radius: 50%; background: #dc2626; }
      .nav-menu-panel { position: absolute; right: 0; top: calc(100% + 0.5rem); min-width: 230px; display: flex; flex-direction: column; padding: 0.4rem; background: var(--card); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); z-index: 30; white-space: normal; }
      .nav-menu-panel > a { padding: 0.75rem; border-radius: 8px; }
      .nav-menu-panel > a.menu-narrow-only { display: none; }
      .nav-menu-theme { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.75rem; color: var(--ink); font-weight: 600; }
      .nav-menu-account { border-top: 1px solid var(--border); margin-top: 0.3rem; padding: 0.75rem 0.75rem 0.35rem; color: var(--muted); }
      main { max-width: 1200px; margin: 1rem auto; padding: 0 1rem 2rem; }
      main.narrow { max-width: 820px; }
      h1, h2 { letter-spacing: 0.01em; }
      .hero {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
        padding: 1.25rem;
      }
      .hero { margin-top: 0; }
      .hero h1 { margin-top: 0; }
      .hero p { color: var(--muted); }
      .about { margin-top: 2rem; }
      .about p { color: var(--muted); max-width: 70ch; line-height: 1.6; }
      /* Shared by links and <button>s, so both get the same font, height and text position. */
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.55rem 0.9rem;
        border: 1px solid transparent;
        border-radius: 9px;
        background: var(--accent);
        color: var(--on-accent);
        font: inherit;
        font-weight: 700;
        line-height: 1.25;
        text-decoration: none;
        cursor: pointer;
      }
      /* Two equal-width buttons side by side, centred; stacked only on very narrow phones where they can't fit. */
      /* Home: Popular Today and Newly Added side by side, one card per row, on wide screens; stacked (5 each) otherwise. */
      .home-columns ul.games { grid-template-columns: 1fr; }
      /* Time left before today's game resets: a light blue line along the bottom of the card (see RESET_LOCALIZE_SCRIPT). */
      li.reset-bar { position: relative; }
      ul.games.compact li.reset-bar, .rotation-list li.reset-bar { padding-bottom: calc(0.65rem + 5px); }
      li.reset-bar::after { content: ""; position: absolute; left: 10px; bottom: 4px; height: 3px; width: calc((100% - 20px) * var(--reset-left, 0)); border-radius: 2px; background: var(--reset-bar); opacity: 0.85; pointer-events: none; }
      .twitch-watch { text-align: center; }
      .btn-twitch { gap: 0.5rem; background: #9146FF; border-color: #9146FF; color: #fff; }
      .btn-discord { gap: 0.5rem; background: #5865F2; border-color: #5865F2; color: #fff; }
      .linked-accounts { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.6rem; }
      .linked-accounts li { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 10px; }
      .linked-account-name { display: inline-flex; align-items: center; gap: 0.5rem; font-weight: 700; color: var(--ink); flex: 1; }
      .linked-account-status { color: #22c55e; font-weight: 700; }
      .link-account-form { margin: 0; }
      .external-arrow { font-size: 0.9em; opacity: 0.85; }
      /* Twitch's own live red, white text. */
      .btn-twitch { white-space: nowrap; max-width: 100%; }
      .btn-twitch > span:first-of-type { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      /* Phones: the Twitch icon says where the button goes, so "on Twitch" is dropped to keep it on one line. */
      @media (max-width: 480px) { .btn-twitch .wide-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); } }
      .live-badge { background: #eb0400; color: #fff; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.08em; padding: 0.15rem 0.4rem; border-radius: 4px; line-height: 1.2; }
      .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      @media (min-width: 800px) {
        .home-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1.5rem; align-items: start; }
      }
      @media (max-width: 799px) {
        .home-columns ul.games li:nth-child(n + 6) { display: none; }
      }
      .actions.home-actions { display: grid; grid-template-columns: 1fr 1fr; max-width: 460px; margin-left: auto; margin-right: auto; }
      .home-actions .btn { min-width: 0; white-space: nowrap; }
      ul.games { list-style:none; padding:0; display:grid; gap:0.8rem; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); }
      ul.games li { display:flex; background: var(--card); border:1px solid var(--border); border-radius:12px; padding:0.8rem; box-shadow: var(--shadow); }
      ul.games.compact { gap: 0.6rem; }
      ul.games.compact li { padding: 0.65rem 0.75rem; border-radius: 10px; }
      /* Card: name and buttons on the first line, tags and stats on the second. */
      .game-row { display: flex; flex-direction: column; gap: 0.3rem; width: 100%; }
      .game-top { display: flex; align-items: flex-start; gap: 0.5rem; }
      .game-name { flex: 1; min-width: 0; padding-top: 0.2rem; overflow-wrap: break-word; }
      .game-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.5rem; }
      .game-sub .category-pills { margin-top: 0; }
      .game-sub .tag { font-size: 0.75rem; padding: 0.1rem 0.4rem; }
      .game-sub .meta { margin: 0; }
      /* Game names, the same on every card and row. */
      .game-title { font-size: 1.1rem; font-weight: 700; line-height: 1.3; color: var(--title-ink); text-decoration-color: var(--border); }
      .game-title:hover { text-decoration-color: currentColor; }
      /* The game name's link stretches over the whole card, so a tap anywhere opens the game; buttons and tags sit above it. */
      .card-click { position: relative; }
      .card-click .card-link::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
      .card-click button, .card-click .btn-details, .card-click .category-pill, .card-click .drag { position: relative; z-index: 1; }
      .card-click:hover { border-color: var(--accent); }
      .list-sort { display: inline-flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0; }
      .rotation-list.sorted-by-reset .drag, .rotation-list.sorted-by-reset .reorder-controls { display: none; }
      .game-row .meta, .rotation-list .item-main .meta { color: var(--muted); font-size: 0.8rem; }
      .game-row .compact-actions { display: flex; gap: 0.3rem; align-items: center; flex-shrink: 0; }
      .btn-details {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.3rem 0.55rem;
        font-size: 0.85rem;
        text-decoration: none;
        border: 1px solid var(--border);
        border-radius: 7px;
        background: var(--bg-soft);
        color: var(--ink);
        font-weight: bold;
      }
      .btn-details:hover { background: var(--border); }
      .card-actions { display:flex; gap:0.35rem; align-items:center; flex-wrap:nowrap; margin-left:auto; }
      .game-row .compact-actions button, .rotation-list .compact-actions button, .card-actions button {
        padding: 0.3rem 0.55rem;
        font-size: 0.85rem;
        border: 1px solid var(--border);
        border-radius: 7px;
        background: var(--bg-soft);
        color: var(--ink);
        font-weight: bold;
        white-space: nowrap;
        cursor: pointer;
      }
      .game-row .compact-actions button:hover, .rotation-list .compact-actions button:hover, .card-actions button:hover {
        background: var(--border);
      }
      .rotation-list .reorder-controls { display:inline-flex; gap:0.25rem; }
      .panel {
        margin: 1rem 0;
        padding: 1rem;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--card);
        box-shadow: var(--shadow);
      }
      .panel > h2:first-child { margin-top: 0; }
      .panel > h2:last-child { margin-bottom: 0.5rem; }
      .panel > p:last-child { margin-bottom: 0; }
      .panel > form:last-child { margin-bottom: 0; }
      .admin-grid { display:grid; gap:0.8rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .stack { display:flex; flex-direction:column; gap:0.8rem; }
      .stack-form { display:flex; flex-direction:column; gap:0.6rem; }
      textarea { padding:0.5rem; border-radius:6px; border:1px solid var(--border); background:var(--bg-soft); color:var(--ink); }
      fieldset { border:1px solid var(--border); border-radius:8px; padding:0.6rem; }
      .check { display:inline-flex; align-items:center; gap:0.35rem; margin-right:0.7rem; margin-bottom:0.4rem; }
      .status { min-height: 1.2rem; color:var(--accent); font-weight: 600; }
      .status.error { color: #cc6666; }
      .actions { display:flex; gap:0.6rem; flex-wrap:wrap; margin-bottom:0.8rem; }
      button.active { background: var(--accent); color: var(--on-accent); }
      .tag { display:inline-block; margin-right:0.35rem; margin-bottom:0.35rem; padding:0.2rem 0.45rem; border-radius:999px; border:1px solid var(--border); background:var(--bg-soft); font-size: 0.85rem; color:var(--muted); }
      .verified-badge { display:inline-flex; vertical-align:middle; margin-left:0.35rem; font-size:0.9em; }
      .paywall-badge { color:#22c55e; font-weight:700; margin-left:0.3rem; font-size:1em; }
      .nsfw-badge { color:#ef4444; font-weight:700; margin-left:0.3rem; font-size:0.75em; font-variant:small-caps; letter-spacing:0.05em; }
      .moderation-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 1.3em;
        height: 1.3em;
        padding: 0 0.35em;
        margin-left: 0.3rem;
        border-radius: 9999px;
        background: #dc2626;
        color: #fff;
        font-size: 0.75rem;
        font-weight: 700;
        line-height: 1;
        vertical-align: middle;
      }
      .moderation-badge-submissions { background: #16a34a; }
      button.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
      .rotation-list { list-style:none; padding:0; display:flex; flex-direction:column; gap:0.7rem; }
      .rotation-list li { display:flex; align-items:center; gap:0.75rem; border:1px solid var(--border); border-radius:10px; padding:0.65rem; background:var(--card); }
      .rotation-list li > .item-main { flex: 1; min-width: 0; }
      .rotation-list li > .item-main > a { display:block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rotation-list .item-main .tag { font-size: 0.75rem; padding: 0.1rem 0.4rem; }
      .category-pills { display:flex; flex-wrap:wrap; gap:0.3rem; margin-top:0.3rem; }
      .category-pills:empty { display:none; margin-top:0; }
      .category-pills .tag { margin:0; }
      .category-pill { text-decoration:none; font-weight:700; }
      .drag { cursor: grab; font-weight: 700; color:var(--muted); touch-action: none; }
      .rotation-list li.dragging { opacity: 0.55; }
      .weekday-controls { display:flex; gap:0.4rem; flex-wrap:wrap; }
      .weekday-controls label { display:inline-flex; align-items:center; gap:0.2rem; font-size:0.85rem; color:var(--muted); }
      .reorder-controls { display:inline-flex; gap:0.35rem; }
      .reorder-controls button { padding: 0.3rem 0.45rem; font-size: 0.78rem; }
      .game-search-wrap { position: relative; width: 100%; max-width: 400px; }
      .game-search-list { position: absolute; top: 100%; left: 0; right: 0; max-height: 240px; overflow-y: auto; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 6px; z-index: 10; display: none; }
      .game-search-list.open { display: block; }
      .game-search-item { padding: 0.5rem 0.65rem; cursor: pointer; color: var(--ink); font-size: 0.9rem; }
      .game-search-item:hover, .game-search-item.active { background: var(--card); }
      .game-search-item small { color: var(--muted); }
      .game-search-selected { margin-top: 0.4rem; font-size: 0.9rem; color: var(--muted); }
      .game-search-selected button { background: none; border: none; color: var(--accent); cursor: pointer; text-decoration: underline; font-size: inherit; padding: 0; }
      #toast-stack {
        position: fixed;
        right: 1rem;
        bottom: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        z-index: 99;
      }
      .toast {
        min-width: 220px;
        max-width: 320px;
        border-radius: 10px;
        padding: 0.7rem 0.8rem;
        border: 1px solid var(--border);
        background: var(--card);
        box-shadow: var(--shadow);
        color: var(--ink);
        font-weight: 600;
      }
      .toast.success { border-color: #666666; }
      .toast.error { border-color: #cc6666; }
      form { display:flex; gap: 0.6rem; flex-wrap:wrap; margin-bottom: 1rem; }
      input, select, button {
        padding: 0.5rem;
        border-radius: 7px;
        border: 1px solid var(--border);
        background: var(--bg-soft);
        color: var(--ink);
      }
      input::placeholder, textarea::placeholder { color: #777777; }
      button {
        background: var(--bg-soft);
        color: var(--ink);
        border: 1px solid var(--border);
        cursor: pointer;
      }
      a { color: var(--accent); }
      p { color: var(--muted); }
      .intro { color: var(--ink); font-size: 1.05rem; line-height: 1.5; margin: 0.25rem 0 1rem; }
      .btn-play { font-size: 1.1rem; padding: 0.8rem 1.4rem; }
      .report-panel > summary { cursor: pointer; font-weight: 700; }
      .report-panel[open] > summary { margin-bottom: 0.75rem; }
      .game-facts { margin-top: 1.5rem; }
      .game-facts dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.45rem 1rem; margin: 0.75rem 0 0; }
      .game-facts dt { color: var(--muted); }
      .game-facts dd { margin: 0; }
      @media (max-width: 480px) { .game-facts dl { grid-template-columns: 1fr; gap: 0.15rem; } .game-facts dd { margin-bottom: 0.5rem; } }
      .related-games ul { columns: 2; padding-left: 1.2rem; }
      .related-games li { margin-bottom: 0.4rem; }
      .empty-state { text-align: center; padding: 1.5rem 1rem; border: 1px dashed var(--border); border-radius: 12px; }
      .rotation-list li.empty-state { display: block; }
      .empty-state p { margin-top: 0; }
      form.game-filters { flex-direction: column; flex-wrap: nowrap; align-items: stretch; }
      .search-row { display: flex; gap: 0.5rem; }
      .search-row input { flex: 1; min-width: 0; max-width: 420px; }
      .filters > summary { display: none; }
      .filters-body { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; }
      @media (max-width: 700px) {
        header.site-header { padding: 0.6rem 0.75rem; gap: 0.7rem; }
        .brand { font-size: 1.1rem; margin-right: 0; }
        .site-nav { gap: 0.7rem; }
        .site-nav a { font-size: 0.95rem; }
        .nav-extra, .account-desktop, .header-tools > .theme-toggle, .label-long { display: none; }
        .nav-menu { display: block; }
        /* Small buttons in cards and rows get an invisible margin that makes the tap target about 46px tall. */
        .compact-actions button, .compact-actions .btn-details, .card-actions button, .card-actions .btn-details { position: relative; min-height: 30px; }
        .compact-actions button::after, .compact-actions .btn-details::after, .card-actions button::after, .card-actions .btn-details::after { content: ""; position: absolute; inset: -9px -2px; }
        .compact-actions, .card-actions { gap: 0.3rem; }
        .actions button, .actions .btn { min-height: 44px; }
        .home-actions .btn { font-size: 0.85rem; padding: 0.55rem 0.3rem; }
        .btn-play { display: block; text-align: center; }
        .related-games ul { columns: 1; }
        .filters > summary { display: list-item; cursor: pointer; font-weight: 600; padding: 0.4rem 0; }
        .filters-body select { flex: 1 1 45%; }
      }
      /* Narrow phones: Submit moves from the header row into the menu so the row never overlaps. */
      @media (max-width: 369px) {
        .actions.home-actions { grid-template-columns: 1fr; max-width: 260px; }
      }
      @media (max-width: 400px) {
        .site-nav a[href="/submit"] { display: none; }
        .nav-menu-panel > a.menu-narrow-only { display: block; }
      }
      #game-results[aria-busy="true"] { opacity: 0.55; transition: opacity 0.15s; }
      .game-count { text-align: center; color: var(--muted); font-size: 1.05rem; font-weight: 400; letter-spacing: normal; line-height: 1.5; margin: 0.25rem 0 0.9rem; }
      .list-index li { margin-bottom: 0.7rem; }
      .list-index .muted { color: var(--muted); }
      .game-count strong { color: var(--brand-blue); font-size: 1.6rem; font-weight: 800; font-variant-numeric: tabular-nums; margin-right: 0.2rem; }
      /* Big screens: larger cards and text, with the buttons in a 2x2 grid (votes left, favorite top right, details bottom right). */
      @media (min-width: 1200px) {
        ul.games { grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr)); gap: 1rem; }
        ul.games.compact li { padding: 0.95rem 1.05rem; border-radius: 14px; }
        ul.games.compact li.reset-bar { padding-bottom: calc(0.95rem + 6px); }
        .game-row { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto 1fr; grid-template-areas: "name actions" "sub actions"; column-gap: 0.9rem; row-gap: 0.45rem; align-items: start; }
        .game-top { display: contents; }
        .game-name { grid-area: name; padding-top: 0; }
        .game-sub { grid-area: sub; }
        .game-row .compact-actions { grid-area: actions; display: grid; grid-template-columns: auto auto; grid-template-rows: auto auto; grid-auto-flow: column; gap: 0.35rem; }
        .game-row .compact-actions > * { display: inline-flex; align-items: center; justify-content: center; gap: 0.3rem; height: 2.15rem; min-width: 3.4rem; font-size: 0.95rem; padding: 0 0.6rem; }
        ul.games .game-title { font-size: 1.3rem; }
        .game-sub .tag { font-size: 0.85rem; padding: 0.15rem 0.5rem; }
        .game-row .meta { font-size: 0.9rem; }
      }
    </style>
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">0<span class="brand-x">x</span>9 dles</a>
      <nav class="site-nav" aria-label="Main">
        <a href="/games">Games</a>
        <a href="/me/rotation"><span class="label-long">My </span>Rotation</a>
        <a href="/submit">Submit</a>
        <span class="nav-extra">${secondaryLinks}</span>
      </nav>
      <div class="header-tools">
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
    ${body}
    <footer style="text-align: center; padding: 2rem 1rem; margin-top: 4rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.9rem;">
      <p>
        <a href="https://github.com/0x9-ca/dailies" target="_blank" rel="noopener noreferrer">github</a>
        |
        <a href="https://discord.gg/uRApjQJ4vh" target="_blank" rel="noopener noreferrer">discord</a>
        |
        <a href="/mod-log">mod log</a>
      </p>
    </footer>
    <div id="toast-stack" aria-live="polite" aria-atomic="true"></div>
    <script>
      (() => {
        const buttons = document.querySelectorAll("[data-theme-toggle]");
        const root = document.documentElement;
        const render = () => buttons.forEach((btn) => { btn.textContent = root.dataset.theme === "light" ? "\u{1F319}" : "\u2600\uFE0F"; });
        buttons.forEach((btn) => btn.addEventListener("click", () => {
          const next = root.dataset.theme === "light" ? "dark" : "light";
          if (next === "light") root.dataset.theme = "light"; else delete root.dataset.theme;
          try { localStorage.setItem("dgl_theme", next); } catch (e) {}
          render();
        }));
        render();

        // A tap outside the open phone menu only closes it (cards are links, so it would otherwise open a game).
        const menu = document.getElementById("nav-menu");
        document.addEventListener("click", (event) => {
          if (!menu || !menu.open || menu.contains(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
          menu.open = false;
        }, true);
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && menu) menu.open = false;
        });
      })();
    </script>
    <script>
      (() => {
        const stack = document.getElementById("toast-stack");
        const showToast = (message, level = "success") => {
          if (!stack || !message) return;
          const node = document.createElement("div");
          node.className = "toast " + level;
          node.textContent = message;
          stack.appendChild(node);
          window.setTimeout(() => {
            node.remove();
          }, 2500);
        };

        window.appToast = showToast;

        const getCookie = (name) => {
          const key = name + "=";
          const parts = document.cookie.split(";");
          for (const raw of parts) {
            const part = raw.trim();
            if (part.startsWith(key)) {
              return decodeURIComponent(part.slice(key.length));
            }
          }
          return "";
        };

        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init = {}) => {
          const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          const method = String((init && init.method) || (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET") || "GET").toUpperCase();
          const sameOrigin = requestUrl.startsWith("/") || requestUrl.startsWith(window.location.origin);
          if (!sameOrigin || method === "GET" || method === "HEAD" || method === "OPTIONS") {
            return originalFetch(input, init);
          }

          const token = getCookie("csrf_token");
          const headers = new Headers(init.headers || (typeof input !== "string" && !(input instanceof URL) ? input.headers : undefined));
          if (token) {
            headers.set("x-csrf-token", token);
          }
          return originalFetch(input, { ...init, headers, credentials: "same-origin" });
        };
      })();
    </script>
    <script>${RESET_LOCALIZE_SCRIPT}</script>
  </body>
</html>`;
}

// JSON for an inline <script>: escaping "<" stops a value such as a game title from closing the tag.
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

function oauthRedirectUri(env: Env, provider: OAuthProvider): string {
  return `${env.APP_URL}/auth/${provider}/callback`;
}

const OAUTH_AUTHORIZE: Record<OAuthProvider, { url: string; scope: string }> = {
  // identify: user id + name; guilds.members.read: roles in our guild (editor/admin). Twitch: no scopes, so no email.
  discord: { url: "https://discord.com/api/oauth2/authorize", scope: "identify guilds.members.read" },
  twitch: { url: "https://id.twitch.tv/oauth2/authorize", scope: "" }
};

function oauthClientId(env: Env, provider: OAuthProvider): string | undefined {
  return provider === "discord" ? env.OAUTH_DISCORD_CLIENT_ID : env.OAUTH_TWITCH_CLIENT_ID;
}

function beginOAuth(c: Context<{ Bindings: Bindings; Variables: AppVariables }>, provider: OAuthProvider, intent: "login" | "link"): Response {
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
  const url = new URL(OAUTH_AUTHORIZE[provider].url);
  url.searchParams.set("client_id", oauthClientId(c.env, provider) ?? "");
  url.searchParams.set("redirect_uri", oauthRedirectUri(c.env, provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_AUTHORIZE[provider].scope);
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
}

/** The authorization code and intent from a provider callback, or the Response to send instead. */
function readOAuthCallback(
  c: Context<{ Bindings: Bindings; Variables: AppVariables }>,
  provider: OAuthProvider
): { code: string; link: boolean } | Response {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const [storedState, intent] = (getCookie(c, `oauth_state_${provider}`) ?? "").split(".");
  deleteCookie(c, `oauth_state_${provider}`, { path: "/" });
  if (c.req.query("error")) {
    // The user pressed cancel on the provider's consent screen.
    return c.redirect(intent === "link" ? "/me/settings" : "/login");
  }
  if (!state || !code || !storedState || state !== storedState) {
    return c.text("Invalid OAuth state", 400);
  }
  return { code, link: intent === "link" };
}

type OAuthProfile = { provider: OAuthProvider; providerUserId: string; displayName: string | null; role?: AppUser["role"] };

/**
 * Finishes a provider sign-in. A login signs in to (or creates) the account for that provider account. A link
 * (started from Settings) attaches it to the signed-in user instead, merging its existing account if it has one.
 */
async function completeOAuth(c: Context<{ Bindings: Bindings; Variables: AppVariables }>, profile: OAuthProfile, link: boolean): Promise<Response> {
  if (!link) {
    const userId = await upsertOAuthUser(c.env, profile);
    await createSession(c, userId);
    return c.redirect("/?importLocal=1");
  }
  const user = c.get("user");
  if (!user) {
    return c.redirect("/login");
  }
  const result = await linkOAuthAccount(c.env, user.id, profile);
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
    reassign("oauth_accounts", "user_id"),
    reassign("reports", "reported_by_user_id"),
    reassign("reports", "resolved_by_user_id"),
    reassign("audit_log", "actor_user_id"),
    reassign("games", "submitted_by_user_id"),
    reassign("games", "approved_by_user_id"),
    reassign("categories", "created_by_user_id"),
    reassign("game_categories", "assigned_by_user_id"),
    reassign("curated_lists", "owner_user_id"),
    reassign("curated_lists", "created_by_user_id"),
    reassign("curated_lists", "updated_by_user_id"),
    reassign("curated_list_items", "added_by_user_id"),
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
      redirect_uri: oauthRedirectUri(c.env, provider)
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
