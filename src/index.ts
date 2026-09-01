import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppUser, AppVariables, Env } from "./env";
import { computeGameScore } from "./lib/ranking";
import { canonicalizeUrl, slugify } from "./lib/url";
import { createSession, destroySession, randomToken, requireAuth, requireRole, sessionMiddleware } from "./lib/auth";
import { getCachedJson, invalidateGameCaches, setCachedJson } from "./lib/cache";

type Bindings = Env;

const app = new Hono<{ Bindings: Bindings; Variables: AppVariables }>();

// Session bootstrap for every request.
app.use("*", sessionMiddleware);

// Double-submit-cookie CSRF setup for browser API calls.
app.use("*", async (c, next) => {
  let csrfToken = getCookie(c, "csrf_token");
  if (!csrfToken) {
    csrfToken = randomToken();
    setCookie(c, "csrf_token", csrfToken, {
      path: "/",
      sameSite: "Lax",
      secure: c.env.APP_URL.startsWith("https://"),
      httpOnly: false,
      maxAge: 60 * 60 * 24 * 30
    });
  }
  c.set("csrfToken", csrfToken);
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

const emailRequestSchema = z.object({ email: z.string().email() });
const emailCodeSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/)
});

app.get("/health", (c) => c.json({ ok: true }));

// Development-only quick role login helper.
app.get("/auth/mock-login/:role", async (c) => {
  if (!isDevEnv(c.env)) {
    return c.text("Mock login is only available in development environment", 404);
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

app.get("/auth/google", async (c) => {
  if (!c.env.OAUTH_GOOGLE_CLIENT_ID) {
    return c.text("Google OAuth not configured", 501);
  }
  const state = crypto.randomUUID();
  setCookie(c, "oauth_state_google", state, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: c.env.APP_URL.startsWith("https://"),
    maxAge: 600
  });
  const redirectUri = `${c.env.APP_URL}/auth/google/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.OAUTH_GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

app.get("/auth/google/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const stored = getCookie(c, "oauth_state_google");
  deleteCookie(c, "oauth_state_google", { path: "/" });
  if (!state || !code || !stored || state !== stored) {
    return c.text("Invalid OAuth state", 400);
  }
  if (!c.env.OAUTH_GOOGLE_CLIENT_SECRET) {
    return c.text("Google OAuth secret not configured", 501);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.OAUTH_GOOGLE_CLIENT_ID,
      client_secret: c.env.OAUTH_GOOGLE_CLIENT_SECRET,
      redirect_uri: `${c.env.APP_URL}/auth/google/callback`,
      grant_type: "authorization_code"
    })
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error("Google token exchange failed:", tokenRes.status, errText);
    return c.text("OAuth token exchange failed", 400);
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenJson.access_token) {
    console.error("Google token missing access_token:", JSON.stringify(tokenJson));
    return c.text("OAuth token missing", 400);
  }

  const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` }
  });
  if (!profileRes.ok) {
    return c.text("OAuth profile fetch failed", 400);
  }
  const profile = (await profileRes.json()) as { sub: string; email: string; name?: string; picture?: string };
  await upsertOAuthUser(c.env, {
    provider: "google",
    providerUserId: profile.sub,
    email: profile.email,
    displayName: profile.name || null,
    avatarUrl: profile.picture || null
  });
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(profile.email).first<{ id: string }>();
  if (!user) {
    return c.text("Unable to create user", 500);
  }
  await createSession(c, user.id);
  return c.redirect("/?importLocal=1");
});

app.get("/auth/github", async (c) => {
  if (!c.env.OAUTH_GITHUB_CLIENT_ID) {
    return c.text("GitHub OAuth not configured", 501);
  }
  const state = crypto.randomUUID();
  setCookie(c, "oauth_state_github", state, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: c.env.APP_URL.startsWith("https://"),
    maxAge: 600
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.OAUTH_GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${c.env.APP_URL}/auth/github/callback`);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

app.get("/auth/github/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const stored = getCookie(c, "oauth_state_github");
  deleteCookie(c, "oauth_state_github", { path: "/" });
  if (!state || !code || !stored || state !== stored) {
    return c.text("Invalid OAuth state", 400);
  }
  if (!c.env.OAUTH_GITHUB_CLIENT_SECRET) {
    return c.text("GitHub OAuth secret not configured", 501);
  }
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.OAUTH_GITHUB_CLIENT_ID,
      client_secret: c.env.OAUTH_GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${c.env.APP_URL}/auth/github/callback`
    })
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error("GitHub token exchange failed:", tokenRes.status, errText);
    if (tokenRes.status === 429) {
      return c.text("GitHub rate limit exceeded. Please try again in a few minutes.", 429);
    }
    return c.text("OAuth token exchange failed", 400);
  }
  const token = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!token.access_token) {
    console.error("GitHub token missing access_token:", JSON.stringify(token));
    return c.text("OAuth token missing", 400);
  }
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token.access_token}`,
      "User-Agent": "daily-game-list"
    }
  });
  if (!userRes.ok) {
    return c.text("OAuth profile fetch failed", 400);
  }
  const ghUser = (await userRes.json()) as {
    id: number;
    login?: string | null;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
  };
  let email = ghUser.email;
  if (!email) {
    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token.access_token}`,
        "User-Agent": "daily-game-list"
      }
    });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified?: boolean | null }>;
      email =
        emails.find((e) => e.primary && e.verified === true)?.email ||
        emails.find((e) => e.verified === true)?.email ||
        emails.find((e) => e.primary)?.email ||
        emails[0]?.email ||
        null;
    }
  }
  if (!email && ghUser.login) {
    email = `${ghUser.login}@users.noreply.github.com`;
  }
  if (!email) {
    return c.text("GitHub account email unavailable", 400);
  }
  await upsertOAuthUser(c.env, {
    provider: "github",
    providerUserId: String(ghUser.id),
    email,
    displayName: ghUser.login || ghUser.name || null,
    avatarUrl: ghUser.avatar_url || null
  });
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first<{ id: string }>();
  if (!user) {
    return c.text("Unable to create user", 500);
  }
  await createSession(c, user.id);
  return c.redirect("/?importLocal=1");
});

// Discord OAuth
app.get("/auth/discord", async (c) => {
  if (!c.env.OAUTH_DISCORD_CLIENT_ID) {
    return c.text("Discord OAuth not configured", 501);
  }
  const state = crypto.randomUUID();
  setCookie(c, "oauth_state_discord", state, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: c.env.APP_URL.startsWith("https://"),
    maxAge: 600
  });
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", c.env.OAUTH_DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${c.env.APP_URL}/auth/discord/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify email guilds.members.read");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

app.get("/auth/discord/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const stored = getCookie(c, "oauth_state_discord");
  deleteCookie(c, "oauth_state_discord", { path: "/" });
  if (!state || !code || !stored || state !== stored) {
    return c.text("Invalid OAuth state", 400);
  }
  if (!c.env.OAUTH_DISCORD_CLIENT_SECRET) {
    return c.text("Discord OAuth secret not configured", 501);
  }
  if (!c.env.DISCORD_GUILD_ID) {
    return c.text("Discord guild not configured", 501);
  }

  // Exchange code for access token
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.OAUTH_DISCORD_CLIENT_ID,
      client_secret: c.env.OAUTH_DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${c.env.APP_URL}/auth/discord/callback`
    })
  });
  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error("Discord token exchange failed:", tokenRes.status, errText);
    if (tokenRes.status === 429) {
      return c.text("Discord rate limit exceeded. Please try again in a few minutes.", 429);
    }
    return c.text("OAuth token exchange failed", 400);
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenJson.access_token) {
    console.error("Discord token missing access_token:", JSON.stringify(tokenJson));
    return c.text("OAuth token missing", 400);
  }

  // Get user profile
  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` }
  });
  if (!userRes.ok) {
    return c.text("OAuth profile fetch failed", 400);
  }
  const discordUser = (await userRes.json()) as {
    id: string;
    username?: string | null;
    global_name?: string | null;
    email?: string | null;
    avatar?: string | null;
  };

  if (!discordUser.email) {
    return c.text("Discord account email unavailable", 400);
  }

  // Check guild membership and roles
  const guildMemberRes = await fetch(
    `https://discord.com/api/users/@me/guilds/${c.env.DISCORD_GUILD_ID}/member`,
    {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` }
    }
  );

  let role: "user" | "editor" | "admin" = "user";
  if (guildMemberRes.ok) {
    const memberData = (await guildMemberRes.json()) as { roles?: string[] };
    const userRoles = memberData.roles || [];
    
    // Check for admin or editor roles
    const adminRoleId = c.env.DISCORD_ROLE_ADMIN || "";
    const editorRoleId = c.env.DISCORD_ROLE_EDITOR || "";
    
    if (adminRoleId && userRoles.includes(adminRoleId)) {
      role = "admin";
    } else if (editorRoleId && userRoles.includes(editorRoleId)) {
      role = "editor";
    }
  }

  // Create or update user
  await upsertOAuthUser(c.env, {
    provider: "discord",
    providerUserId: discordUser.id,
    email: discordUser.email,
    displayName: discordUser.username || discordUser.global_name || null,
    avatarUrl: discordUser.avatar ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png` : null
  });

  // Update role if user is a guild member with special roles
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(discordUser.email).first<{ id: string }>();
  if (!user) {
    return c.text("Unable to create user", 500);
  }

  if (role !== "user") {
    await c.env.DB.prepare("UPDATE users SET role = ?1, updated_at = datetime('now') WHERE id = ?2")
      .bind(role, user.id)
      .run();
  }

  await createSession(c, user.id);
  return c.redirect("/?importLocal=1");
});

app.get("/auth/logout", async (c) => {
  await destroySession(c);
  return c.redirect("/");
});

app.get("/login", (c) => {
  const user = c.get("user");
  if (user) {
    return c.redirect("/");
  }

  const status = c.req.query("status");
  const turnstileSiteKey = (c.env.TURNSTILE_SITE_KEY || "").trim();
  const message =
    status === "sent"
      ? "Check your email for a code and magic link."
      : status === "invalid"
      ? "Invalid or expired sign-in token/code."
      : status === "unavailable"
      ? "Email sign-in is temporarily unavailable. Please try again later."
      : status === "ok"
      ? "Signed in successfully."
      : "";
  const messageClass = status === "invalid" || status === "unavailable" ? "status error" : "status";

  return c.html(layout("Login", null, `
    <main>
      <section class="panel">
        <h1>Sign in</h1>
        <p>Sign in with Discord.</p>
        ${message ? `<p class="${messageClass}">${escapeHtml(message)}</p>` : ""}
      </section>
      <section class="panel">
        <h2>Continue with</h2>
        <div class="actions">
          <a class="btn" href="/auth/discord">Discord</a>
        </div>
      </section>
    </main>
  `, c.env));
});

app.post("/auth/email/request", async (c) => {
  return c.text("Email authentication disabled", 404);
  const body = await c.req.parseBody();
  if (!isValidCsrfBody(c, body)) {
    return c.text("Invalid CSRF token", 403);
  }

  const parsed = emailRequestSchema.safeParse({ email: String(body.email || "") });
  if (!parsed.success) {
    return c.redirect("/login?status=invalid");
  }

  if (!isDevEnv(c.env) && !hasEmailLoginDeliveryConfigured(c.env)) {
    return c.redirect("/login?status=unavailable");
  }

  const email = normalizeEmail(parsed.data.email);
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  if (isEnabled(c.env.TURNSTILE_ENFORCE_EMAIL_AUTH)) {
    const turnstileToken = typeof body["cf-turnstile-response"] === "string" ? body["cf-turnstile-response"] : "";
    const ok = await verifyTurnstile(c.env, turnstileToken, ip);
    if (!ok) {
      return c.redirect("/login?status=invalid");
    }
  }
  const emailBurstMax = parsePositiveInt(c.env.EMAIL_AUTH_RATE_EMAIL_BURST_MAX, 3);
  const emailBurstWindowSec = parsePositiveInt(c.env.EMAIL_AUTH_RATE_EMAIL_BURST_WINDOW_SEC, 10 * 60);
  const ipBurstMax = parsePositiveInt(c.env.EMAIL_AUTH_RATE_IP_BURST_MAX, 6);
  const ipBurstWindowSec = parsePositiveInt(c.env.EMAIL_AUTH_RATE_IP_BURST_WINDOW_SEC, 10 * 60);
  const emailHourlyMax = parsePositiveInt(c.env.EMAIL_AUTH_RATE_EMAIL_HOURLY_MAX, 8);
  const emailHourlyWindowSec = parsePositiveInt(c.env.EMAIL_AUTH_RATE_EMAIL_HOURLY_WINDOW_SEC, 60 * 60);
  const ipHourlyMax = parsePositiveInt(c.env.EMAIL_AUTH_RATE_IP_HOURLY_MAX, 20);
  const ipHourlyWindowSec = parsePositiveInt(c.env.EMAIL_AUTH_RATE_IP_HOURLY_WINDOW_SEC, 60 * 60);

  const burstByEmail = await enforceRateLimit(c.env, `email-auth-burst:${email}`, emailBurstMax, emailBurstWindowSec);
  const burstByIp = await enforceRateLimit(c.env, `email-auth-ip-burst:${ip}`, ipBurstMax, ipBurstWindowSec);
  const rateByEmail = await enforceRateLimit(c.env, `email-auth:${email}`, emailHourlyMax, emailHourlyWindowSec);
  const rateByIp = await enforceRateLimit(c.env, `email-auth-ip:${ip}`, ipHourlyMax, ipHourlyWindowSec);
  if (!burstByEmail.ok || !burstByIp.ok || !rateByEmail.ok || !rateByIp.ok) {
    return c.redirect("/login?status=sent");
  }

  let user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first<{ id: string }>();
  if (!user) {
    const userId = crypto.randomUUID();
    await c.env.DB.prepare("INSERT INTO users (id, email, role) VALUES (?1, ?2, 'user')").bind(userId, email).run();
    user = { id: userId };
  }

  const code = generateOneTimeCode();
  const magicToken = randomToken();
  const codeHash = await hashAuthToken(c.env.SESSION_SECRET, code);
  const magicTokenHash = await hashAuthToken(c.env.SESSION_SECRET, magicToken);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await c.env.DB.prepare("DELETE FROM email_login_tokens WHERE email = ?1 AND consumed_at IS NULL").bind(email).run();
  await c.env.DB.prepare(
    `INSERT INTO email_login_tokens
      (id, email, user_id, code_hash, magic_token_hash, expires_at, request_ip, user_agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  )
    .bind(
      crypto.randomUUID(),
      email,
      user.id,
      codeHash,
      magicTokenHash,
      expiresAt,
      ip,
      c.req.header("user-agent") || ""
    )
    .run();

  const magicLink = `${c.env.APP_URL}/auth/email/verify?token=${encodeURIComponent(magicToken)}`;
  await sendEmailLogin(c.env, {
    to: email,
    code,
    magicLink
  });

  return c.redirect("/login?status=sent");
});

app.post("/auth/email/verify-code", async (c) => {
  return c.text("Email authentication disabled", 404);
  const body = await c.req.parseBody();
  if (!isValidCsrfBody(c, body)) {
    return c.text("Invalid CSRF token", 403);
  }
  const parsed = emailCodeSchema.safeParse({
    email: String(body.email || ""),
    code: String(body.code || "").trim()
  });
  if (!parsed.success) {
    return c.redirect("/login?status=invalid");
  }

  const ip = c.req.header("cf-connecting-ip") || "unknown";
  if (isEnabled(c.env.TURNSTILE_ENFORCE_EMAIL_AUTH)) {
    const turnstileToken = typeof body["cf-turnstile-response"] === "string" ? body["cf-turnstile-response"] : "";
    const ok = await verifyTurnstile(c.env, turnstileToken, ip);
    if (!ok) {
      return c.redirect("/login?status=invalid");
    }
  }

  const email = normalizeEmail(parsed.data.email);
  const verifyEmailMax = parsePositiveInt(c.env.EMAIL_AUTH_RATE_VERIFY_EMAIL_MAX, 8);
  const verifyEmailWindowSec = parsePositiveInt(c.env.EMAIL_AUTH_RATE_VERIFY_EMAIL_WINDOW_SEC, 10 * 60);
  const verifyIpMax = parsePositiveInt(c.env.EMAIL_AUTH_RATE_VERIFY_IP_MAX, 20);
  const verifyIpWindowSec = parsePositiveInt(c.env.EMAIL_AUTH_RATE_VERIFY_IP_WINDOW_SEC, 10 * 60);
  const byEmail = await enforceRateLimit(c.env, `email-auth-verify:${email}`, verifyEmailMax, verifyEmailWindowSec);
  const byIp = await enforceRateLimit(c.env, `email-auth-verify-ip:${ip}`, verifyIpMax, verifyIpWindowSec);
  if (!byEmail.ok || !byIp.ok) {
    return c.redirect("/login?status=invalid");
  }

  const codeHash = await hashAuthToken(c.env.SESSION_SECRET, parsed.data.code);

  const tokenRow = await c.env.DB.prepare(
    `SELECT id, user_id
     FROM email_login_tokens
     WHERE email = ?1
       AND code_hash = ?2
       AND consumed_at IS NULL
       AND expires_at > datetime('now')
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(email, codeHash)
    .first<{ id: string; user_id: string }>();

  if (!tokenRow) {
    return c.redirect("/login?status=invalid");
  }

  await c.env.DB.prepare("UPDATE email_login_tokens SET consumed_at = datetime('now') WHERE id = ?1").bind(tokenRow.id).run();
  await createSession(c, tokenRow.user_id);
  return c.redirect("/?importLocal=1");
});

app.get("/auth/email/verify", async (c) => {
  return c.text("Email authentication disabled", 404);
  const token = c.req.query("token") || "";
  if (!token) {
    return c.redirect("/login?status=invalid");
  }

  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const magicIpMax = parsePositiveInt(c.env.EMAIL_AUTH_RATE_MAGIC_IP_MAX, 40);
  const magicIpWindowSec = parsePositiveInt(c.env.EMAIL_AUTH_RATE_MAGIC_IP_WINDOW_SEC, 60 * 60);
  const byIp = await enforceRateLimit(c.env, `email-auth-magic-ip:${ip}`, magicIpMax, magicIpWindowSec);
  if (!byIp.ok) {
    return c.redirect("/login?status=invalid");
  }

  const tokenHash = await hashAuthToken(c.env.SESSION_SECRET, token);
  const tokenRow = await c.env.DB.prepare(
    `SELECT id, user_id
     FROM email_login_tokens
     WHERE magic_token_hash = ?1
       AND consumed_at IS NULL
       AND expires_at > datetime('now')
     LIMIT 1`
  )
    .bind(tokenHash)
    .first<{ id: string; user_id: string }>();

  if (!tokenRow) {
    return c.redirect("/login?status=invalid");
  }

  await c.env.DB.prepare("UPDATE email_login_tokens SET consumed_at = datetime('now') WHERE id = ?1").bind(tokenRow.id).run();
  await createSession(c, tokenRow.user_id);
  return c.redirect("/?importLocal=1");
});

// Public SSR pages.
app.get("/", async (c) => {
  const user = c.get("user");
  const shouldPromptImport = c.req.query("importLocal") === "1";
  const topGames = await listGames(c.env, { sort: "top", limit: 12 });
  const topGameIds = topGames.map((game) => game.id);
  const userVotes = new Map<string, -1 | 1>();
  const userFavorites = new Set<string>();
  if (topGameIds.length > 0) {
    const placeholders = topGameIds.map((_id, index) => `?${index + 2}`).join(", ");
    const voteRows = user
      ? await c.env.DB.prepare(
          `SELECT game_id, value
           FROM votes
           WHERE user_id = ?1 AND game_id IN (${placeholders})`
        )
          .bind(user.id, ...topGameIds)
          .all<{ game_id: string; value: -1 | 1 }>()
      : await c.env.DB.prepare(
          `SELECT game_id, value
           FROM anonymous_votes
           WHERE anon_ip_hash = ?1 AND game_id IN (${placeholders})`
        )
          .bind(await getAnonymousVoteKey(c), ...topGameIds)
          .all<{ game_id: string; value: -1 | 1 }>();
    for (const row of voteRows.results) {
      userVotes.set(row.game_id, row.value);
    }
    if (user) {
      const favoriteRows = await c.env.DB.prepare(
        `SELECT game_id
         FROM favorites
         WHERE user_id = ?1 AND game_id IN (${placeholders})`
      )
        .bind(user.id, ...topGameIds)
        .all<{ game_id: string }>();
      for (const row of favoriteRows.results) {
        userFavorites.add(row.game_id);
      }
    }
  }

  const topGamesMarkup = renderCompactGameList(topGames, user, userVotes, userFavorites);
  const curated = await c.env.DB.prepare(
    `SELECT id, slug, title, description
     FROM curated_lists
     WHERE visibility = 'public'
     ORDER BY updated_at DESC
     LIMIT 6`
  ).all<{ id: string; slug: string; title: string; description: string | null }>();
  return c.html(layout("Daily Game List", user, `
    <main>
      <section class="hero">
        <h1>Dailies</h1>
        <p>Find the best daily games.</p>
	<p>No login required (unless you really want to). Votes, favorites, etc. all stored locally.</p>
        <a class="btn" href="/games">Browse games</a>
      </section>
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
      <section>
        <h2>Popular Today</h2>
        ${topGamesMarkup}
      </section>
      <section>
        <h2>Curated Lists</h2>
        <ul>
          ${curated.results
            .map((list) => `<li><a href="/lists/${list.slug}">${escapeHtml(list.title)}</a>${list.description ? ` - ${escapeHtml(list.description)}` : ""}</li>`)
            .join("")}
        </ul>
      </section>
    </main>
    ${renderGameListInteractionScript({ includeImportPanel: !!user, promptFromQuery: shouldPromptImport })}
  `, c.env));
});

app.get("/submit", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.redirect("/login");
  }

  const categories = await c.env.DB.prepare("SELECT slug, name FROM categories WHERE is_active = 1 ORDER BY name ASC").all<{
    slug: string;
    name: string;
  }>();

  return c.html(layout("Submit a Daily Game", user, `
    <main>
      <h1>Submit a Daily Game</h1>
      <section class="panel">
        <form id="submission-form" class="stack-form">
          <input type="text" name="title" placeholder="Game title" required />
          <input type="url" name="url" placeholder="https://example.com/game" required />
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
            <label>Time basis
              <select name="resetBasis">
                <option value="">Unknown</option>
                <option value="local">Local time</option>
                <option value="server">Server time</option>
              </select>
            </label>
            <label>Reset time
              <input type="time" name="resetTime" />
            </label>
          </fieldset>
          <button type="submit">Submit for review</button>
        </form>
        <p id="submission-status" class="status" aria-live="polite"></p>
      </section>
    </main>
    <script>
      const form = document.getElementById("submission-form");
      const status = document.getElementById("submission-status");
      form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const formData = new FormData(form);
        const resetBasis = String(formData.get("resetBasis") || "").trim();
        const resetTime = String(formData.get("resetTime") || "").trim();
        const payload = {
          title: String(formData.get("title") || ""),
          url: String(formData.get("url") || ""),
          description: String(formData.get("description") || "").trim() || undefined,
          categories: formData.getAll("categories").map((v) => String(v)),
          resetBasis: resetBasis || undefined,
          resetTime: resetTime || undefined
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
  `, c.env));
});

app.get("/games", async (c) => {
  const user = c.get("user");
  const sort = (c.req.query("sort") || "top") as "top" | "new" | "trending" | "reset";
  const category = c.req.query("category") || undefined;
  const q = c.req.query("q") || undefined;
  const page = Math.max(1, parsePositiveInt(c.req.query("page"), 1));
  const perPage = 98; // Max 98 to stay within D1's 100 bind parameter limit (1 for user_id + up to 99 for game_ids when fetching perPage+1)
  const offset = (page - 1) * perPage;
  
  // Fetch one extra to check if there are more pages
  const gamesWithExtra = await listGames(c.env, { sort, category, q, limit: perPage + 1, offset });
  const hasMore = gamesWithExtra.length > perPage;
  const games = gamesWithExtra.slice(0, perPage);
  
  const categories = await c.env.DB.prepare("SELECT slug, name FROM categories WHERE is_active = 1 ORDER BY name ASC").all<{
    slug: string;
    name: string;
  }>();

  const gameIds = games.map((game) => game.id);
  const userVotes = new Map<string, -1 | 1>();
  const userFavorites = new Set<string>();
  if (gameIds.length > 0) {
    const placeholders = gameIds.map((_id, index) => `?${index + 2}`).join(", ");
    const voteRows = user
      ? await c.env.DB.prepare(
          `SELECT game_id, value
           FROM votes
           WHERE user_id = ?1 AND game_id IN (${placeholders})`
        )
          .bind(user.id, ...gameIds)
          .all<{ game_id: string; value: -1 | 1 }>()
      : await c.env.DB.prepare(
          `SELECT game_id, value
           FROM anonymous_votes
           WHERE anon_ip_hash = ?1 AND game_id IN (${placeholders})`
        )
          .bind(await getAnonymousVoteKey(c), ...gameIds)
          .all<{ game_id: string; value: -1 | 1 }>();
    for (const row of voteRows.results) {
      userVotes.set(row.game_id, row.value);
    }

    if (user) {
      const favoriteRows = await c.env.DB.prepare(
        `SELECT game_id
         FROM favorites
         WHERE user_id = ?1 AND game_id IN (${placeholders})`
      )
        .bind(user.id, ...gameIds)
        .all<{ game_id: string }>();
      for (const row of favoriteRows.results) {
        userFavorites.add(row.game_id);
      }
    }
  }

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
    if (newPage > 1) params.set("page", String(newPage));
    return `/games${params.toString() ? "?" + params.toString() : ""}`;
  };

  let paginationMarkup = "";
  if (page > 1 || hasMore) {
    paginationMarkup = `<div class="pagination">`;
    if (page > 1) {
      paginationMarkup += `<a href="${escapeHtml(buildPageUrl(page - 1))}">&larr; Previous</a>`;
    }
    paginationMarkup += `<span>Page ${page}</span>`;
    if (hasMore) {
      paginationMarkup += `<a href="${escapeHtml(buildPageUrl(page + 1))}">Next &rarr;</a>`;
    }
    paginationMarkup += `</div>`;
  }

  return c.html(layout("Browse Games", user, `
    <main>
      <h1>Browse Games</h1>
      <form method="GET" action="/games">
        <input type="text" name="q" placeholder="Search" value="${escapeHtml(q || "")}" />
        <select name="sort">
          ${["top", "new", "trending", "reset"]
            .map((s) => `<option value="${s}" ${s === sort ? "selected" : ""}>${s}</option>`)
            .join("")}
        </select>
        <select name="category">
          <option value="">All categories</option>
          ${categories.results
            .map((cat) => `<option value="${cat.slug}" ${cat.slug === category ? "selected" : ""}>${escapeHtml(cat.name)}</option>`)
            .join("")}
        </select>
        <button type="submit">Apply</button>
      </form>
      ${gamesMarkup}
      ${paginationMarkup}
    </main>
    ${renderGameListInteractionScript({ includeImportPanel: false, promptFromQuery: false })}
  `, c.env));
});

app.get("/games/:slug", async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user");
  const isAdminOrEditor = user && (user.role === "admin" || user.role === "editor");
  const game = await c.env.DB.prepare(
    `SELECT id, title, slug, url, description, status, vote_up_count, vote_down_count, report_count, reset_basis, reset_time_minutes
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
    }>();
  if (!game) {
    return c.text("Not found", 404);
  }

  const allCategories = await c.env.DB.prepare(
    `SELECT id, slug, name FROM categories WHERE is_active = 1 ORDER BY name ASC`
  ).all<{ id: string; slug: string; name: string }>();

  const categories = await c.env.DB.prepare(
    `SELECT categories.slug, categories.name
     FROM game_categories
     JOIN categories ON categories.id = game_categories.category_id
     WHERE game_categories.game_id = ?1
     ORDER BY categories.name ASC`
  )
    .bind(game.id)
    .all<{ slug: string; name: string }>();

  let userVote: -1 | 0 | 1 = 0;
  let userFavorite = false;
  if (user) {
    const vote = await c.env.DB.prepare("SELECT value FROM votes WHERE user_id = ?1 AND game_id = ?2")
      .bind(user.id, game.id)
      .first<{ value: -1 | 1 }>();
    userVote = vote?.value || 0;
    const favorite = await c.env.DB.prepare("SELECT 1 AS found FROM favorites WHERE user_id = ?1 AND game_id = ?2")
      .bind(user.id, game.id)
      .first<{ found: number }>();
    userFavorite = !!favorite;
  } else {
    const vote = await c.env.DB.prepare("SELECT value FROM anonymous_votes WHERE anon_ip_hash = ?1 AND game_id = ?2")
      .bind(await getAnonymousVoteKey(c), game.id)
      .first<{ value: -1 | 1 }>();
    userVote = vote?.value || 0;
  }

  return c.html(layout(game.title, user, `
    <main>
      <h1>${escapeHtml(game.title)}</h1>
      <p>${escapeHtml(game.description || "")}</p>
      <p>${categories.results.map((cat) => `<span class="tag">${escapeHtml(cat.name)}</span>`).join(" ")}</p>
      <p><a href="${escapeHtml(game.url)}" target="_blank" rel="noopener noreferrer">Open game</a></p>
      ${(() => {
        const resetLabel = getResetMetaLabel(game.reset_basis, game.reset_time_minutes);
        return resetLabel ? `<p>${escapeHtml(resetLabel)}</p>` : "";
      })()}
      <p>Votes: +<span id="vote-up-count">${game.vote_up_count}</span> / -<span id="vote-down-count">${game.vote_down_count}</span> | Reports: ${game.report_count}</p>
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
               <form id="report-form" class="stack-form">
                 <label>Report issue
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
                <p><a href="/auth/google">Sign in</a> to sync favorites and report issues.</p>
                <p id="game-action-status" class="status" aria-live="polite"></p>
              </section>`
      }
      ${
        user && (user.role === "admin" || user.role === "editor")
          ? `<section class="panel">
               <h2>Admin: Edit Game</h2>
               <form id="admin-edit-form" class="stack-form">
                 <label>Title
                   <input type="text" name="title" value="${escapeHtml(game.title)}" required />
                 </label>
                 <label>URL
                   <input type="url" name="url" value="${escapeHtml(game.url)}" required />
                 </label>
                 <label>Description
                   <textarea name="description" rows="3">${escapeHtml(game.description || "")}</textarea>
                 </label>
                 <label>Status
                   <select name="status" required>
                     <option value="pending" ${game.status === "pending" ? "selected" : ""}>Pending</option>
                     <option value="approved" ${game.status === "approved" ? "selected" : ""}>Approved</option>
                     <option value="rejected" ${game.status === "rejected" ? "selected" : ""}>Rejected</option>
                     <option value="disabled" ${game.status === "disabled" ? "selected" : ""}>Disabled</option>
                   </select>
                 </label>
                 <label>Reset Basis
                   <select name="reset_basis">
                     <option value="" ${!game.reset_basis ? "selected" : ""}>None</option>
                     <option value="local" ${game.reset_basis === "local" ? "selected" : ""}>Local</option>
                     <option value="server" ${game.reset_basis === "server" ? "selected" : ""}>Server</option>
                   </select>
                 </label>
                 <label>Reset Time (minutes since midnight, 0-1439)
                   <input type="number" name="reset_time_minutes" min="0" max="1439" value="${game.reset_time_minutes ?? ""}" />
                 </label>
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
    </main>
    ${
      user
        ? `<script>
            const gameId = ${JSON.stringify(game.id)};
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

            const setVoteState = (value) => {
              voteButtons.up?.classList.toggle("active", value === 1);
              voteButtons.down?.classList.toggle("active", value === -1);
            };

            const applyOptimisticVote = (fromValue, toValue) => {
              const upCurrent = Number(upCountNode?.textContent || "0");
              const downCurrent = Number(downCountNode?.textContent || "0");
              let upNext = upCurrent;
              let downNext = downCurrent;
              if (fromValue === 1) upNext -= 1;
              if (fromValue === -1) downNext -= 1;
              if (toValue === 1) upNext += 1;
              if (toValue === -1) downNext += 1;
              if (upCountNode) upCountNode.textContent = String(Math.max(0, upNext));
              if (downCountNode) downCountNode.textContent = String(Math.max(0, downNext));
            };

            const submitVote = async (value) => {
              const previousVote = currentVote;
              if (currentVote === value) {
                setStatus("Vote already set.");
                return;
              }
              applyOptimisticVote(previousVote, value);
              currentVote = value;
              setVoteState(value);
              setStatus("Saving vote...");
              const response = await fetch("/api/games/" + gameId + "/vote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value })
              });
              if (response.ok) {
                setStatus("Vote saved.");
                if (window.appToast) window.appToast("Vote saved.", "success");
                return;
              }
              applyOptimisticVote(value, previousVote);
              currentVote = previousVote;
              setVoteState(previousVote);
              setStatus("Could not save vote.");
              if (window.appToast) window.appToast("Could not save vote.", "error");
            };

            voteButtons.up?.addEventListener("click", async () => {
              await submitVote(1);
            });

            voteButtons.down?.addEventListener("click", async () => {
              await submitVote(-1);
            });

            const favoriteButton = document.getElementById("favorite-toggle");
            favoriteButton?.addEventListener("click", async () => {
              const favorited = favoriteButton.getAttribute("data-favorited") === "yes";
              favoriteButton.setAttribute("data-favorited", favorited ? "no" : "yes");
              favoriteButton.textContent = favorited ? "Add favorite" : "Remove favorite";
              setStatus("Updating favorites...");
              const response = await fetch("/api/games/" + gameId + "/favorite", {
                method: favorited ? "DELETE" : "POST"
              });
              if (!response.ok) {
                favoriteButton.setAttribute("data-favorited", favorited ? "yes" : "no");
                favoriteButton.textContent = favorited ? "Remove favorite" : "Add favorite";
                setStatus("Could not update favorite.");
                if (window.appToast) window.appToast("Could not update favorite.", "error");
                return;
              }
              setStatus(favorited ? "Removed from rotation." : "Added to rotation.");
              if (window.appToast) window.appToast(favorited ? "Removed from rotation." : "Added to rotation.", "success");
            });

            const reportForm = document.getElementById("report-form");
            reportForm?.addEventListener("submit", async (event) => {
              event.preventDefault();
              if (!(reportForm instanceof HTMLFormElement)) return;
              const formData = new FormData(reportForm);
              const payload = {
                reason: String(formData.get("reason") || "other"),
                note: String(formData.get("note") || "").trim() || undefined
              };
              setStatus("Submitting report...");
              const response = await fetch("/api/games/" + gameId + "/report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
              });
              if (response.ok) {
                reportForm.reset();
                setStatus("Report submitted. Thank you.");
                if (window.appToast) window.appToast("Report submitted.", "success");
              } else {
                setStatus("Could not submit report.");
                if (window.appToast) window.appToast("Could not submit report.", "error");
              }
            });

            const adminEditForm = document.getElementById("admin-edit-form");
            if (adminEditForm) {
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
                const resetTimeMinutes = formData.get("reset_time_minutes");
                const payload = {
                  title: String(formData.get("title") || ""),
                  url: String(formData.get("url") || ""),
                  description: String(formData.get("description") || "").trim() || null,
                  status: String(formData.get("status") || "approved"),
                  reset_basis: resetBasis ? String(resetBasis) : null,
                  reset_time_minutes: resetTimeMinutes && String(resetTimeMinutes).trim() ? Number(resetTimeMinutes) : null,
                  category_ids: categories.map(c => String(c))
                };
                setAdminStatus("Saving changes...");
                const response = await fetch("/api/games/" + gameId + "/admin-update", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload)
                });
                if (response.ok) {
                  setAdminStatus("Changes saved successfully.");
                  if (window.appToast) window.appToast("Game updated.", "success");
                  setTimeout(() => window.location.reload(), 1000);
                } else {
                  setAdminStatus("Could not save changes.");
                  if (window.appToast) window.appToast("Could not save changes.", "error");
                }
              });
            }
           </script>`
        : `<script>
            const storageKey = "dgl_local_favorites_v1";
            const game = {
              id: ${JSON.stringify(game.id)},
              title: ${JSON.stringify(game.title)},
              slug: ${JSON.stringify(game.slug)}
            };
            const status = document.getElementById("game-action-status");
            const upCountNode = document.getElementById("vote-up-count");
            const downCountNode = document.getElementById("vote-down-count");
            const voteButtons = {
              up: document.getElementById("vote-up"),
              down: document.getElementById("vote-down")
            };
            let currentVote = ${userVote};
            const favoriteButton = document.getElementById("favorite-local-toggle");
            const anonIdKey = "dgl_anon_favorites_id_v1";

            const setStatus = (text) => {
              if (status) status.textContent = text;
            };

            const setVoteState = (value) => {
              voteButtons.up?.classList.toggle("active", value === 1);
              voteButtons.down?.classList.toggle("active", value === -1);
            };

            const applyOptimisticVote = (fromValue, toValue) => {
              const upCurrent = Number(upCountNode?.textContent || "0");
              const downCurrent = Number(downCountNode?.textContent || "0");
              let upNext = upCurrent;
              let downNext = downCurrent;
              if (fromValue === 1) upNext -= 1;
              if (fromValue === -1) downNext -= 1;
              if (toValue === 1) upNext += 1;
              if (toValue === -1) downNext += 1;
              if (upCountNode) upCountNode.textContent = String(Math.max(0, upNext));
              if (downCountNode) downCountNode.textContent = String(Math.max(0, downNext));
            };

            const submitVote = async (value) => {
              const previousVote = currentVote;
              if (currentVote === value) {
                setStatus("Vote already set.");
                return;
              }
              applyOptimisticVote(previousVote, value);
              currentVote = value;
              setVoteState(value);
              setStatus("Saving vote...");
              const response = await fetch("/api/games/" + game.id + "/vote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ value })
              });
              if (response.ok) {
                setStatus("Vote saved.");
                if (window.appToast) window.appToast("Vote saved.", "success");
                return;
              }
              applyOptimisticVote(value, previousVote);
              currentVote = previousVote;
              setVoteState(previousVote);
              setStatus("Could not save vote.");
              if (window.appToast) window.appToast("Could not save vote.", "error");
            };

            const readFavorites = () => {
              try {
                const raw = window.localStorage.getItem(storageKey);
                if (!raw) return [];
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            };

            const writeFavorites = (items) => {
              window.localStorage.setItem(storageKey, JSON.stringify(items));
            };

            const getAnonId = () => {
              let value = window.localStorage.getItem(anonIdKey) || "";
              if (value) return value;
              if (typeof crypto !== "undefined" && crypto.randomUUID) {
                value = crypto.randomUUID();
              } else {
                value = "anon-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
              }
              window.localStorage.setItem(anonIdKey, value);
              return value;
            };

            const isFavorite = () => readFavorites().some((item) => item && item.id === game.id);

            const setButtonState = (favorited) => {
              if (!favoriteButton) return;
              favoriteButton.setAttribute("data-favorited", favorited ? "yes" : "no");
              favoriteButton.textContent = favorited ? "Remove favorite" : "Add favorite";
            };

            favoriteButton?.addEventListener("click", async () => {
              const current = readFavorites();
              const exists = current.some((item) => item && item.id === game.id);
              if (exists) {
                writeFavorites(current.filter((item) => item && item.id !== game.id));
                await fetch("/api/games/" + game.id + "/favorite-anon", {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ anonId: getAnonId() })
                }).catch(() => undefined);
                setButtonState(false);
                setStatus("Removed from favorites.");
                if (window.appToast) window.appToast("Removed from favorites.", "success");
                return;
              }
              current.push(game);
              writeFavorites(current);
              await fetch("/api/games/" + game.id + "/favorite-anon", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ anonId: getAnonId() })
              }).catch(() => undefined);
              setButtonState(true);
              setStatus("Added to favorites.");
              if (window.appToast) window.appToast("Added to favorites.", "success");
            });

            voteButtons.up?.addEventListener("click", async () => {
              await submitVote(1);
            });

            voteButtons.down?.addEventListener("click", async () => {
              await submitVote(-1);
            });

            setVoteState(currentVote);
            setButtonState(isFavorite());
          </script>`
    }
  `, c.env));
});

app.get("/rotation/:shareToken", async (c) => {
  const shareToken = c.req.param("shareToken");
  const user = c.get("user");
  
  // Find the user with this share token
  const owner = await c.env.DB.prepare(
    "SELECT id, display_name, email FROM users WHERE rotation_share_token = ?1"
  )
    .bind(shareToken)
    .first<{ id: string; display_name: string | null; email: string }>();
  
  if (!owner) {
    return c.text("Rotation not found or link has been disabled", 404);
  }
  
  const favorites = await c.env.DB.prepare(
    `SELECT games.id, games.title, games.slug, games.url, favorites.position
     FROM favorites
     JOIN games ON games.id = favorites.game_id
     WHERE favorites.user_id = ?1
     ORDER BY favorites.position ASC`
  )
    .bind(owner.id)
    .all<{ id: string; title: string; slug: string; url: string; position: number }>();
  
  const ownerName = owner.display_name || owner.email.split('@')[0];
  
  return c.html(layout(`${escapeHtml(ownerName)}'s Rotation`, user, `
    <main>
      <h1>${escapeHtml(ownerName)}'s Daily Rotation</h1>
      <p>This is a shared view of ${escapeHtml(ownerName)}'s favorite daily games.</p>
      ${favorites.results.length > 0 ? `
        <ol class="rotation-list">
          ${favorites.results
            .map(
              (item) => `<li>
                <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
                <a href="/games/${item.slug}" class="details-link">details</a>
              </li>`
            )
            .join("")}
        </ol>
      ` : '<p>No favorites in this rotation yet.</p>'}
    </main>
  `, c.env));
});

app.get("/me/rotation", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.html(layout("My Rotation", null, `
      <main>
        <h1>My Daily Rotation</h1>
        <p>Your favorites are stored in this browser via local storage.</p>
        <p><a href="/login">Sign in</a> to sync favorites across devices.</p>
        <ol id="local-rotation-list" class="rotation-list"></ol>
        <p id="rotation-status" class="status" aria-live="polite"></p>
      </main>
      <script>
        const storageKey = "dgl_local_favorites_v1";
        const list = document.getElementById("local-rotation-list");
        const status = document.getElementById("rotation-status");
        let dragItem = null;

        const setStatus = (text) => {
          if (status) status.textContent = text;
        };

        const readFavorites = () => {
          try {
            const raw = window.localStorage.getItem(storageKey);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((row) => row && row.id && row.slug && row.title) : [];
          } catch {
            return [];
          }
        };

        const writeFavorites = (items) => {
          window.localStorage.setItem(storageKey, JSON.stringify(items));
        };

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
            item.addEventListener("dragstart", () => {
              dragItem = item;
              item.classList.add("dragging");
            });
            item.addEventListener("dragend", () => {
              item.classList.remove("dragging");
              dragItem = null;
              persistFromDom();
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
                list.insertBefore(dragItem, item);
              } else {
                list.insertBefore(dragItem, item.nextSibling);
              }
              persistFromDom();
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
          if (favorites.length === 0) {
            list.innerHTML = "<li>No local favorites yet. Open any game and add it.</li>";
            return;
          }
          list.innerHTML = "";
          favorites.forEach((item) => {
            const li = document.createElement("li");
            li.draggable = true;
            li.setAttribute("data-game-id", item.id);
            li.setAttribute("data-game-slug", item.slug);
            li.setAttribute("data-game-title", item.title);

            const drag = document.createElement("span");
            drag.className = "drag";
            drag.textContent = "::";
            li.appendChild(drag);

            const link = document.createElement("a");
            link.href = "/games/" + encodeURIComponent(item.slug);
            link.textContent = item.title;
            li.appendChild(link);

            const reorder = document.createElement("div");
            reorder.className = "reorder-controls";
            const up = document.createElement("button");
            up.type = "button";
            up.setAttribute("data-local-move", "up");
            up.textContent = "Up";
            const down = document.createElement("button");
            down.type = "button";
            down.setAttribute("data-local-move", "down");
            down.textContent = "Down";
            reorder.appendChild(up);
            reorder.appendChild(down);
            li.appendChild(reorder);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.setAttribute("data-local-remove", "1");
            remove.textContent = "Remove";
            li.appendChild(remove);

            list.appendChild(li);
          });
          wireInteractions();
        };

        render();
      </script>
    `, c.env));
  }

  const favorites = await c.env.DB.prepare(
    `SELECT games.id, games.title, games.slug, favorites.position
     FROM favorites
     JOIN games ON games.id = favorites.game_id
     WHERE favorites.user_id = ?1
     ORDER BY favorites.position ASC`
  )
    .bind(user.id)
    .all<{ id: string; title: string; slug: string; position: number }>();

  const userWithToken = await c.env.DB.prepare(
    "SELECT rotation_share_token FROM users WHERE id = ?1"
  )
    .bind(user.id)
    .first<{ rotation_share_token: string | null }>();

  const shareToken = userWithToken?.rotation_share_token;
  const shareUrl = shareToken ? `${c.env.APP_URL}/rotation/${shareToken}` : null;

  return c.html(layout("My Rotation", user, `
    <main>
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
      <ol id="rotation-list" class="rotation-list">
        ${favorites.results
          .map(
            (item) => `<li draggable="true" data-game-id="${item.id}">
              <span class="drag">::</span>
              <a href="/games/${item.slug}">${escapeHtml(item.title)}</a>
              <div class="reorder-controls">
                <button type="button" data-move="up" aria-label="Move up">Up</button>
                <button type="button" data-move="down" aria-label="Move down">Down</button>
              </div>
            </li>`
          )
          .join("")}
      </ol>
      <p id="rotation-status" class="status" aria-live="polite"></p>
    </main>
    <script>
      const list = document.getElementById("rotation-list");
      const status = document.getElementById("rotation-status");
      const shareStatus = document.getElementById("share-status");
      const importPanel = document.getElementById("rotation-local-import-panel");
      const importSummary = document.getElementById("rotation-local-import-summary");
      const importStatus = document.getElementById("rotation-local-import-status");
      const importButton = document.getElementById("rotation-local-import-btn");
      const importDismissButton = document.getElementById("rotation-local-import-dismiss");
      let dragItem = null;

      const setStatus = (text) => {
        if (status) status.textContent = text;
      };

      const setImportStatus = (text) => {
        if (importStatus) importStatus.textContent = text;
      };

      const localStorageKey = "dgl_local_favorites_v1";
      const readLocalFavorites = () => {
        try {
          const raw = window.localStorage.getItem(localStorageKey);
          if (!raw) return [];
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return [];
          return parsed.filter((row) => row && typeof row.id === "string" && row.id.length > 0);
        } catch {
          return [];
        }
      };

      const localFavorites = readLocalFavorites();
      if (importPanel && localFavorites.length > 0) {
        importPanel.hidden = false;
        if (importSummary) {
          importSummary.textContent = "Found " + localFavorites.length + " local favorite" + (localFavorites.length === 1 ? "" : "s") + ".";
        }
      }

      importDismissButton?.addEventListener("click", () => {
        if (importPanel) importPanel.hidden = true;
      });

      importButton?.addEventListener("click", async () => {
        const ids = [];
        const seen = new Set();
        for (const row of localFavorites) {
          if (!row || typeof row.id !== "string") continue;
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          ids.push(row.id);
        }
        if (ids.length === 0) {
          setImportStatus("No valid local favorites to import.");
          return;
        }
        setImportStatus("Importing local favorites...");
        const response = await fetch("/api/me/favorites/import-local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids })
        });
        if (!response.ok) {
          setImportStatus("Could not import local favorites.");
          return;
        }
        window.localStorage.removeItem(localStorageKey);
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

      if (list) {
        const items = Array.from(list.querySelectorAll("li[data-game-id]"));
        items.forEach((item) => {
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
              list.insertBefore(dragItem, item);
            } else {
              list.insertBefore(dragItem, item.nextSibling);
            }
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
      }
    </script>
  `, c.env));
});

app.get("/me/settings", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }

  const sessionToken = getCookie(c, c.env.SESSION_COOKIE_NAME) || "";
  const currentSessionId = sessionToken ? await hashAuthToken(c.env.SESSION_SECRET, sessionToken) : "";
  const sessions = await c.env.DB.prepare(
    `SELECT id, created_at, expires_at
     FROM sessions
     WHERE user_id = ?1
     ORDER BY created_at DESC
     LIMIT 30`
  )
    .bind(auth.id)
    .all<{ id: string; created_at: string; expires_at: string }>();

  return c.html(layout("Account Settings", auth, `
    <main>
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
  const lists = await c.env.DB.prepare(
    `SELECT id, slug, title, description, visibility, owner_user_id
     FROM curated_lists
     ORDER BY updated_at DESC`
  ).all<{
    id: string;
    slug: string;
    title: string;
    description: string | null;
    visibility: "public" | "private";
    owner_user_id: string;
  }>();

  const visible = lists.results.filter((row) => canViewList(row.visibility, row.owner_user_id, user));
  return c.html(layout("Curated Lists", user, `
    <main>
      <h1>Curated Lists</h1>
      <ul>
        ${visible
          .map((row) => `<li><a href="/lists/${row.slug}">${escapeHtml(row.title)}</a> (${row.visibility})</li>`)
          .join("")}
      </ul>
    </main>
  `, c.env));
});

app.get("/lists/:slug", async (c) => {
  const slug = c.req.param("slug");
  const user = c.get("user");
  const list = await c.env.DB.prepare(
    `SELECT id, slug, title, description, visibility, owner_user_id
     FROM curated_lists
     WHERE slug = ?1`
  )
    .bind(slug)
    .first<{ id: string; slug: string; title: string; description: string | null; visibility: "public" | "private"; owner_user_id: string }>();
  if (!list || !canViewList(list.visibility, list.owner_user_id, user)) {
    return c.text("Not found", 404);
  }
  const items = await c.env.DB.prepare(
    `SELECT games.slug, games.title, curated_list_items.position
     FROM curated_list_items
     JOIN games ON games.id = curated_list_items.game_id
     WHERE curated_list_items.curated_list_id = ?1
     ORDER BY curated_list_items.position ASC`
  )
    .bind(list.id)
    .all<{ slug: string; title: string; position: number }>();

  return c.html(layout(list.title, user, `
    <main>
      <h1>${escapeHtml(list.title)}</h1>
      <p>${escapeHtml(list.description || "")}</p>
      <ol>${items.results.map((item) => `<li>#${item.position} <a href="/games/${item.slug}">${escapeHtml(item.title)}</a></li>`).join("")}</ol>
    </main>
  `, c.env));
});

// Admin SSR pages.
app.get("/admin", (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  return c.html(layout("Admin", auth, `
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
        `SELECT id, title, slug, url, description, status, moderation_note, created_at, reset_basis, reset_time_minutes
         FROM games
         WHERE status = ?1
           AND (title LIKE ?2 OR url LIKE ?2 OR description LIKE ?2)
         ORDER BY created_at DESC
         LIMIT 200`
      )
        .bind(status, `%${q}%`)
        .all<{ id: string; title: string; slug: string; url: string; description: string | null; status: string; moderation_note: string | null; created_at: string; reset_basis: "local" | "server" | null; reset_time_minutes: number | null }>()
    : await c.env.DB.prepare(
        `SELECT id, title, slug, url, description, status, moderation_note, created_at, reset_basis, reset_time_minutes
         FROM games
         WHERE status = ?1
         ORDER BY created_at DESC
         LIMIT 200`
      )
        .bind(status)
        .all<{ id: string; title: string; slug: string; url: string; description: string | null; status: string; moderation_note: string | null; created_at: string; reset_basis: "local" | "server" | null; reset_time_minutes: number | null }>();

  return c.html(layout("Admin Submissions", auth, `
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
              <h2>${escapeHtml(row.title)}</h2>
              <p>${escapeHtml(row.description || "")}</p>
              <p><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">Visit game</a> · <a href="/games/${row.slug}">Detail page</a></p>
              <p>Status: <strong>${row.status}</strong>${row.moderation_note ? ` · Note: ${escapeHtml(row.moderation_note)}` : ""}</p>
              ${(() => {
                const resetLabel = getResetMetaLabel(row.reset_basis, row.reset_time_minutes);
                return resetLabel ? `<p>${escapeHtml(resetLabel)}</p>` : "";
              })()}
              <div class="actions">
                <select data-reset-basis="${row.id}">
                  <option value="" ${!row.reset_basis ? "selected" : ""}>Unknown</option>
                  <option value="local" ${row.reset_basis === "local" ? "selected" : ""}>Local</option>
                  <option value="server" ${row.reset_basis === "server" ? "selected" : ""}>Server</option>
                </select>
                <input type="time" data-reset-time="${row.id}" value="${row.reset_time_minutes === null ? "" : escapeHtml(formatResetTime(row.reset_time_minutes))}" />
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
    <script>
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
          if (!(basisNode instanceof HTMLSelectElement) || !(timeNode instanceof HTMLInputElement)) {
            return;
          }
          setStatus("Saving reset settings...");
          const response = await fetch("/api/admin/games/" + gameId + "/reset", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resetBasis: basisNode.value || null,
              resetTime: timeNode.value || null
            })
          });
          if (!response.ok) {
            setStatus("Could not save reset settings.");
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
                games.id AS game_id, games.slug AS game_slug, games.title
         FROM reports
         JOIN games ON games.id = reports.game_id
         WHERE reports.status = ?1
           AND (games.title LIKE ?2 OR reports.reason LIKE ?2 OR reports.note LIKE ?2)
         ORDER BY reports.created_at DESC
         LIMIT 200`
      )
        .bind(status, `%${q}%`)
        .all<{ id: string; reason: string; status: string; note: string | null; created_at: string; game_id: string; game_slug: string; title: string }>()
    : await c.env.DB.prepare(
        `SELECT reports.id, reports.reason, reports.status, reports.note, reports.created_at,
                games.id AS game_id, games.slug AS game_slug, games.title
         FROM reports
         JOIN games ON games.id = reports.game_id
         WHERE reports.status = ?1
         ORDER BY reports.created_at DESC
         LIMIT 200`
      )
        .bind(status)
        .all<{ id: string; reason: string; status: string; note: string | null; created_at: string; game_id: string; game_slug: string; title: string }>();

  return c.html(layout("Admin Reports", auth, `
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
        <button type="button" data-bulk-report-action="resolve">Bulk resolve</button>
        <button type="button" data-bulk-report-action="dismiss">Bulk dismiss</button>
      </div>
      <div class="stack">
        ${rows.results
          .map(
            (row) => `<article class="panel">
              <h2>${escapeHtml(row.title)}</h2>
              <p>Reason: <strong>${escapeHtml(row.reason)}</strong> · Status: <strong>${escapeHtml(row.status)}</strong></p>
              <p>${escapeHtml(row.note || "No note provided")}</p>
              <p><a href="/games/${row.game_slug}">Open game context</a></p>
              <label class="check"><input type="checkbox" data-report-select value="${row.id}" /> Select</label>
              <div class="actions">
                <button type="button" data-report-action="resolve" data-report-id="${row.id}">Resolve</button>
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

      const runAction = async (reportId, action) => {
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

  return c.html(layout("Admin Categories", auth, `
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
    "SELECT id, title, slug FROM games WHERE status = 'approved' ORDER BY title ASC LIMIT 500"
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

  return c.html(layout("Admin Lists", auth, `
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
const submissionSchema = z.object({
  title: z.string().min(2).max(120),
  url: z.string().url(),
  description: z.string().max(500).optional(),
  categories: z.array(z.string()).max(8).optional(),
  resetBasis: z.enum(["local", "server"]).optional(),
  resetTime: z.string().regex(/^\d{2}:\d{2}$/).optional()
});

app.get("/api/games", async (c) => {
  const sort = (c.req.query("sort") || "top") as "top" | "new" | "trending" | "reset";
  const category = c.req.query("category") || undefined;
  const q = c.req.query("q") || undefined;
  const page = Math.max(1, parsePositiveInt(c.req.query("page"), 1));
  const perPage = Math.min(100, Math.max(1, parsePositiveInt(c.req.query("perPage"), 25)));
  const offset = (page - 1) * perPage;
  const key = `games:${sort}:${category || "all"}:${q || "none"}:${page}:${perPage}`;
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
  const withExtra = await listGames(c.env, { sort, category, q, limit: perPage + 1, offset });
  const hasMore = withExtra.length > perPage;
  const results = withExtra.slice(0, perPage);
  await setCachedJson(c.env, key, results);
  return c.json({ results, page, perPage, hasMore, cached: false });
});

app.get("/api/categories", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, slug, name, description FROM categories WHERE is_active = 1 ORDER BY name").all();
  return c.json(rows);
});

app.post("/api/games", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const submitRate = await enforceRateLimit(c.env, `submit:${auth.id}`, 10, 60 * 60);
  if (!submitRate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: submitRate.retryAfterSeconds }, 429);
  }
  const parsed = submissionSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
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

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const slug = uniqueSlug(parsed.data.title, id);
  const bypassModeration = auth.role === "editor" || auth.role === "admin";

  if (bypassModeration) {
    await c.env.DB.prepare(
      `INSERT INTO games
        (id, title, slug, url, canonical_url, description, submitted_by_user_id, status, approved_at, approved_by_user_id, created_at, updated_at, reset_basis, reset_time_minutes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'approved', ?8, ?9, ?8, ?8, ?10, ?11)`
    )
      .bind(id, parsed.data.title, slug, parsed.data.url, canonicalUrl, parsed.data.description || null, auth.id, now, auth.id, resetBasis, resetTimeMinutes)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO games
        (id, title, slug, url, canonical_url, description, submitted_by_user_id, status, created_at, updated_at, reset_basis, reset_time_minutes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8, ?9, ?10)`
    )
      .bind(id, parsed.data.title, slug, parsed.data.url, canonicalUrl, parsed.data.description || null, auth.id, now, resetBasis, resetTimeMinutes)
      .run();
  }

  if (parsed.data.categories && parsed.data.categories.length > 0) {
    for (const categorySlug of parsed.data.categories) {
      const category = await c.env.DB.prepare("SELECT id FROM categories WHERE slug = ?1 AND is_active = 1").bind(categorySlug).first<{ id: string }>();
      if (category) {
        await c.env.DB.prepare(
          "INSERT OR IGNORE INTO game_categories (game_id, category_id, assigned_by_user_id) VALUES (?1, ?2, ?3)"
        )
          .bind(id, category.id, auth.id)
          .run();
      }
    }
  }

  if (bypassModeration) {
    await updateGameScore(c.env, id);
  }

  await invalidateGameCaches(c.env);
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

  await c.env.DB.batch([
    voteUpsert,
    c.env.DB.prepare(
      `UPDATE games
       SET vote_up_count =
             (SELECT COUNT(*) FROM votes WHERE game_id = ?1 AND value = 1) +
             (SELECT COUNT(*) FROM anonymous_votes WHERE game_id = ?1 AND value = 1),
           vote_down_count =
             (SELECT COUNT(*) FROM votes WHERE game_id = ?1 AND value = -1) +
             (SELECT COUNT(*) FROM anonymous_votes WHERE game_id = ?1 AND value = -1),
           updated_at = datetime('now')
       WHERE id = ?1`
    ).bind(gameId)
  ]);
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
  title: z.string().min(1).max(200),
  url: z.string().url(),
  description: z.string().max(1000).nullable(),
  status: z.enum(["pending", "approved", "rejected", "disabled"]),
  reset_basis: z.enum(["local", "server"]).nullable(),
  reset_time_minutes: z.number().int().min(0).max(1439).nullable(),
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

  const canonicalUrl = canonicalizeUrl(parsed.data.url);

  // Update game
  await c.env.DB.prepare(
    `UPDATE games 
     SET title = ?1, url = ?2, canonical_url = ?3, description = ?4, status = ?5,
         reset_basis = ?6, reset_time_minutes = ?7, updated_at = datetime('now')
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
      gameId
    )
    .run();

  // Update slug if title changed
  const game = await c.env.DB.prepare("SELECT slug FROM games WHERE id = ?1")
    .bind(gameId)
    .first<{ slug: string }>();
  if (game) {
    const newSlug = slugify(parsed.data.title);
    if (newSlug !== game.slug) {
      await c.env.DB.prepare("UPDATE games SET slug = ?1 WHERE id = ?2")
        .bind(newSlug, gameId)
        .run();
    }
  }

  // Update categories
  await c.env.DB.prepare("DELETE FROM game_categories WHERE game_id = ?1")
    .bind(gameId)
    .run();

  for (const categoryId of parsed.data.category_ids) {
    await c.env.DB.prepare("INSERT INTO game_categories (id, game_id, category_id) VALUES (?1, ?2, ?3)")
      .bind(crypto.randomUUID(), gameId, categoryId)
      .run();
  }

  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
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
  const statements = parsed.data.items.map((item) =>
    c.env.DB.prepare("UPDATE favorites SET position = ?1, updated_at = datetime('now') WHERE user_id = ?2 AND game_id = ?3").bind(
      item.position,
      auth.id,
      item.gameId
    )
  );
  await c.env.DB.batch(statements);
  return c.json({ ok: true });
});

app.post("/api/me/rotation/share", async (c) => {
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  
  // Check if user already has a share token
  const existing = await c.env.DB.prepare("SELECT rotation_share_token FROM users WHERE id = ?1")
    .bind(auth.id)
    .first<{ rotation_share_token: string | null }>();
  
  if (existing?.rotation_share_token) {
    return c.json({ shareToken: existing.rotation_share_token });
  }
  
  // Generate a new random token
  const token = crypto.randomUUID().replace(/-/g, '');
  
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
    const currentSessionId = await hashAuthToken(c.env.SESSION_SECRET, token);
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
  const auth = requireAuth(c);
  if (auth instanceof Response) {
    return auth;
  }
  const reportRate = await enforceRateLimit(c.env, `report:${auth.id}`, 20, 60 * 60);
  if (!reportRate.ok) {
    return c.json({ error: "Rate limit exceeded", retryAfterSeconds: reportRate.retryAfterSeconds }, 429);
  }
  const parsed = reportSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const reportId = crypto.randomUUID();
  const gameId = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO reports (id, game_id, reported_by_user_id, reason, note)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(reportId, gameId, auth.id, parsed.data.reason, parsed.data.note || null),
    c.env.DB.prepare(
      "UPDATE games SET report_count = report_count + 1, updated_at = datetime('now') WHERE id = ?1"
    ).bind(gameId)
  ]);
  await updateGameScore(c.env, gameId);
  await invalidateGameCaches(c.env);
  return c.json({ id: reportId }, 201);
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
    "SELECT id, slug, title, description, visibility, owner_user_id, updated_at FROM curated_lists ORDER BY updated_at DESC"
  ).all<{ id: string; slug: string; title: string; description: string | null; visibility: "public" | "private"; owner_user_id: string; updated_at: string }>();
  const visible = rows.results.filter((row) => canViewList(row.visibility, row.owner_user_id, user));
  return c.json({ results: visible });
});

app.get("/api/lists/:slug", async (c) => {
  const user = c.get("user");
  const list = await c.env.DB.prepare(
    "SELECT id, slug, title, description, visibility, owner_user_id FROM curated_lists WHERE slug = ?1"
  )
    .bind(c.req.param("slug"))
    .first<{ id: string; slug: string; title: string; description: string | null; visibility: "public" | "private"; owner_user_id: string }>();
  if (!list || !canViewList(list.visibility, list.owner_user_id, user)) {
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
  return c.json({ ...list, items: items.results });
});

const createListSchema = z.object({
  title: z.string().min(2).max(100),
  description: z.string().max(300).optional(),
  visibility: z.enum(["public", "private"]).default("private")
});

const updateListSchema = z.object({
  title: z.string().min(2).max(100).optional(),
  description: z.string().max(300).optional()
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
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = updateListSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const listId = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT title, description FROM curated_lists WHERE id = ?1")
    .bind(listId)
    .first<{ title: string; description: string | null }>();
  if (!existing) {
    return c.json({ error: "Not found" }, 404);
  }
  await c.env.DB.prepare(
    `UPDATE curated_lists
     SET title = ?1, description = ?2, updated_by_user_id = ?3, updated_at = datetime('now')
     WHERE id = ?4`
  )
    .bind(
      parsed.data.title ?? existing.title,
      parsed.data.description === undefined ? existing.description : parsed.data.description,
      auth.id,
      listId
    )
    .run();
  await writeAudit(c.env, auth.id, "list", listId, "update_list", parsed.data);
  return c.json({ ok: true });
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
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = listItemSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO curated_list_items (curated_list_id, game_id, position, added_by_user_id)
     VALUES (?1, ?2, ?3, ?4)`
  )
    .bind(c.req.param("id"), parsed.data.gameId, parsed.data.position, auth.id)
    .run();
  await writeAudit(c.env, auth.id, "list", c.req.param("id"), "add_item", parsed.data);
  return c.json({ ok: true });
});

app.delete("/api/lists/:id/items/:gameId", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
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
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = reorderListItemsSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }
  const listId = c.req.param("id");

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
        `SELECT id, title, slug, url, status, moderation_note, created_at, reset_basis, reset_time_minutes
         FROM games
         WHERE status = ?1
           AND (title LIKE ?2 OR url LIKE ?2 OR description LIKE ?2)
         ORDER BY created_at DESC
         LIMIT 200`
      )
        .bind(status, `%${q}%`)
        .all()
    : await c.env.DB.prepare(
        "SELECT id, title, slug, url, status, moderation_note, created_at, reset_basis, reset_time_minutes FROM games WHERE status = ?1 ORDER BY created_at DESC LIMIT 200"
      )
        .bind(status)
        .all();
  return c.json(rows);
});

const adminResetSchema = z.object({
  resetBasis: z.union([z.literal("local"), z.literal("server"), z.null()]).optional(),
  resetTime: z.union([z.string().regex(/^\d{2}:\d{2}$/), z.null()]).optional()
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
  const existing = await c.env.DB.prepare("SELECT reset_basis, reset_time_minutes FROM games WHERE id = ?1")
    .bind(gameId)
    .first<{ reset_basis: "local" | "server" | null; reset_time_minutes: number | null }>();
  if (!existing) {
    return c.json({ error: "Not found" }, 404);
  }

  const nextBasis = resetBasis === undefined ? existing.reset_basis : resetBasis;
  const nextResetTime = resetTimeMinutes === undefined ? existing.reset_time_minutes : resetTimeMinutes;
  await c.env.DB.prepare(
    "UPDATE games SET reset_basis = ?1, reset_time_minutes = ?2, updated_at = datetime('now') WHERE id = ?3"
  )
    .bind(nextBasis, nextResetTime, gameId)
    .run();
  await writeAudit(c.env, auth.id, "game", gameId, "update_reset", { resetBasis: nextBasis, resetTimeMinutes: nextResetTime });
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

  await writeAudit(c.env, auth.id, "game", "bulk", parsed.data.action, {
    count: parsed.data.ids.length,
    note: parsed.data.note || null
  });
  await invalidateGameCaches(c.env);
  return c.json({ ok: true, count: parsed.data.ids.length });
});

app.post("/api/admin/games/:id/approve", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  await c.env.DB.prepare(
    `UPDATE games
     SET status = 'approved', approved_at = datetime('now'), approved_by_user_id = ?1, updated_at = datetime('now')
     WHERE id = ?2`
  )
    .bind(auth.id, gameId)
    .run();
  await updateGameScore(c.env, gameId);
  await writeAudit(c.env, auth.id, "game", gameId, "approve", {});
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
  await c.env.DB.prepare(
    "UPDATE games SET status = 'rejected', moderation_note = ?1, updated_at = datetime('now') WHERE id = ?2"
  )
    .bind(note.data.note || null, gameId)
    .run();
  await writeAudit(c.env, auth.id, "game", gameId, "reject", { note: note.data.note || null });
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.post("/api/admin/games/:id/disable", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  await c.env.DB.prepare("UPDATE games SET status = 'disabled', updated_at = datetime('now') WHERE id = ?1").bind(gameId).run();
  await writeAudit(c.env, auth.id, "game", gameId, "disable", {});
  await invalidateGameCaches(c.env);
  return c.json({ ok: true });
});

app.post("/api/admin/games/:id/restore", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const gameId = c.req.param("id");
  await c.env.DB.prepare("UPDATE games SET status = 'approved', updated_at = datetime('now') WHERE id = ?1").bind(gameId).run();
  await writeAudit(c.env, auth.id, "game", gameId, "restore", {});
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

const bulkReportsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["resolve", "dismiss"])
});

app.post("/api/admin/reports/bulk", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  const parsed = bulkReportsSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.flatten() }, 400);
  }

  const nextStatus = parsed.data.action === "resolve" ? "resolved" : "dismissed";
  const statements = parsed.data.ids.map((reportId) =>
    c.env.DB.prepare(
      "UPDATE reports SET status = ?1, resolved_by_user_id = ?2, resolved_at = datetime('now') WHERE id = ?3"
    ).bind(nextStatus, auth.id, reportId)
  );
  await c.env.DB.batch(statements);
  await writeAudit(c.env, auth.id, "report", "bulk", parsed.data.action, { count: parsed.data.ids.length });
  return c.json({ ok: true, count: parsed.data.ids.length });
});

app.post("/api/admin/reports/:id/resolve", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  await c.env.DB.prepare(
    "UPDATE reports SET status = 'resolved', resolved_by_user_id = ?1, resolved_at = datetime('now') WHERE id = ?2"
  )
    .bind(auth.id, c.req.param("id"))
    .run();
  await writeAudit(c.env, auth.id, "report", c.req.param("id"), "resolve", {});
  return c.json({ ok: true });
});

app.post("/api/admin/reports/:id/dismiss", async (c) => {
  const auth = requireRole(c, ["editor", "admin"]);
  if (auth instanceof Response) {
    return auth;
  }
  await c.env.DB.prepare(
    "UPDATE reports SET status = 'dismissed', resolved_by_user_id = ?1, resolved_at = datetime('now') WHERE id = ?2"
  )
    .bind(auth.id, c.req.param("id"))
    .run();
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

app.notFound((c) => c.text("Not found", 404));

app.onError((error, c) => {
  console.error(JSON.stringify({ message: error.message, stack: error.stack, requestId: c.get("requestId") }));
  return c.json({ error: "Internal server error", requestId: c.get("requestId") }, 500);
});

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runLinkChecks(env));
  }
};

async function runLinkChecks(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, url, link_fail_count
     FROM games
     WHERE status = 'approved'
     ORDER BY COALESCE(last_checked_at, '1970-01-01') ASC
     LIMIT 30`
  ).all<{ id: string; url: string; link_fail_count: number }>();

  for (const row of rows.results) {
    let ok = false;
    try {
      const head = await fetch(row.url, { method: "HEAD", redirect: "follow" });
      ok = head.ok;
      if (!ok) {
        const getRes = await fetch(row.url, { method: "GET", redirect: "follow" });
        ok = getRes.ok;
      }
    } catch {
      ok = false;
    }

    if (ok) {
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

  await env.DB.prepare("DELETE FROM rate_limits WHERE updated_at < datetime('now', '-2 days')").run();
  await invalidateGameCaches(env);
}

function uniqueSlug(title: string, id: string): string {
  const base = slugify(title) || "game";
  return `${base}-${id.slice(0, 8)}`;
}

function canViewList(visibility: "public" | "private", ownerUserId: string, user: AppUser | null): boolean {
  if (visibility === "public") {
    return true;
  }
  if (!user) {
    return false;
  }
  return user.id === ownerUserId || user.role === "editor" || user.role === "admin";
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

async function listGames(
  env: Env,
  opts: { sort: "top" | "new" | "trending" | "reset"; category?: string; q?: string; limit: number; offset?: number }
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
  }>
> {
  const sortSql =
    opts.sort === "new"
      ? "games.created_at DESC"
      : opts.sort === "trending"
      ? "games.updated_at DESC, games.score DESC"
      : opts.sort === "reset"
      ? `CASE WHEN games.reset_time_minutes IS NULL THEN 1 ELSE 0 END ASC,
         CASE
           WHEN games.reset_time_minutes IS NULL THEN 9999
           ELSE ((games.reset_time_minutes - ((CAST(strftime('%H','now') AS INTEGER) * 60) + CAST(strftime('%M','now') AS INTEGER)) + 1440) % 1440)
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

  params.push(opts.limit, opts.offset || 0);

  const sql = `
    SELECT DISTINCT games.id, games.title, games.slug, games.url, games.description,
           games.score, games.vote_up_count, games.vote_down_count,
           games.reset_basis, games.reset_time_minutes
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
    }>();

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
    resetTimeMinutes: row.reset_time_minutes
  }));
}

async function updateGameScore(env: Env, gameId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT games.vote_up_count, games.vote_down_count, games.report_count, games.created_at,
            (SELECT COUNT(*) FROM favorites WHERE game_id = games.id) AS favorite_count_user,
            (SELECT COUNT(*) FROM anonymous_favorites WHERE game_id = games.id) AS favorite_count_anon
     FROM games
     WHERE games.id = ?1`
  )
    .bind(gameId)
    .first<{
      vote_up_count: number;
      vote_down_count: number;
      report_count: number;
      created_at: string;
      favorite_count_user: number;
      favorite_count_anon: number;
    }>();
  if (!row) {
    return;
  }
  const score = computeGameScore({
    upVotes: row.vote_up_count,
    downVotes: row.vote_down_count,
    reportCount: row.report_count,
    favoriteCount: (row.favorite_count_user || 0) + (row.favorite_count_anon || 0),
    createdAtIso: row.created_at
  });
  await env.DB.prepare("UPDATE games SET score = ?1, updated_at = datetime('now') WHERE id = ?2").bind(score, gameId).run();
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

function renderGames(
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
  }>
): string {
  if (games.length === 0) {
    return "<p>No games found.</p>";
  }
  return `
    <ul class="games">
      ${games
        .map(
          (game) => `
        <li>
          <a href="/games/${game.slug}">${escapeHtml(game.title)}</a>
          <p>${escapeHtml(game.description || "")}</p>
          ${(() => {
            const resetLabel = getResetMetaLabel(game.resetBasis, game.resetTimeMinutes);
            return resetLabel ? `<small>${escapeHtml(resetLabel)}</small><br />` : "";
          })()}
          <small>Score ${game.score.toFixed(3)} | +${game.voteUpCount} / -${game.voteDownCount}</small>
        </li>
      `
        )
        .join("")}
    </ul>
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
        const resetLabel = getResetMetaLabel(game.resetBasis, game.resetTimeMinutes);
        const meta = `${resetLabel ? `${resetLabel} | ` : ""}Score ${game.score.toFixed(2)} | +${game.voteUpCount} / -${game.voteDownCount}`;
        return `<li>
          <div class="game-row" data-game-row="${game.id}" data-vote="${currentVote}" data-game-slug="${escapeHtml(game.slug)}" data-game-title="${escapeHtml(game.title)}">
            <div>
              <a href="${escapeHtml(game.url)}" target="_blank" rel="noopener noreferrer" style="font-weight: bold; font-size: inherit; line-height: inherit;">${escapeHtml(game.title)}</a>
              <div class="meta">${escapeHtml(meta)}</div>
            </div>
            <div class="compact-actions">
              <button type="button" data-list-vote="up" class="${currentVote === 1 ? "active" : ""}">+ <span data-up-count>${game.voteUpCount}</span></button>
              <button type="button" data-list-vote="down" class="${currentVote === -1 ? "active" : ""}">- <span data-down-count>${game.voteDownCount}</span></button>
              ${
                user
                  ? `<button type="button" data-list-favorite="${currentFavorite ? "yes" : "no"}">${currentFavorite ? "★" : "☆"}</button>`
                  : `<button type="button" data-local-favorite="no">☆</button>`
              }
              <a href="/games/${game.slug}" class="btn-details">...</a>
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
      const storageKey = "dgl_local_favorites_v1";
      const readFavorites = () => {
        try {
          const raw = window.localStorage.getItem(storageKey);
          if (!raw) return [];
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      };
      const writeFavorites = (items) => {
        window.localStorage.setItem(storageKey, JSON.stringify(items));
      };
      const anonIdKey = "dgl_anon_favorites_id_v1";
      const getAnonId = () => {
        let value = window.localStorage.getItem(anonIdKey) || "";
        if (value) {
          return value;
        }
        if (typeof crypto !== "undefined" && crypto.randomUUID) {
          value = crypto.randomUUID();
        } else {
          value = "anon-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        }
        window.localStorage.setItem(anonIdKey, value);
        return value;
      };

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
        const favorites = readFavorites().filter((row) => row && typeof row.id === "string" && row.id.length > 0);
        if (panel && favorites.length > 0) {
          panel.hidden = false;
          if (summary) {
            summary.textContent = "Found " + favorites.length + " local favorite" + (favorites.length === 1 ? "" : "s") + ".";
          }
          const dismiss = () => {
            panel.hidden = true;
            const url = new URL(window.location.href);
            url.searchParams.delete("importLocal");
            window.history.replaceState({}, "", url.toString());
          };
          dismissButton?.addEventListener("click", dismiss);
          importButton?.addEventListener("click", async () => {
            const ids = [];
            const seen = new Set();
            for (const row of favorites) {
              if (!row || typeof row.id !== "string") continue;
              if (seen.has(row.id)) continue;
              seen.add(row.id);
              ids.push(row.id);
            }
            if (ids.length === 0) {
              setStatus("No valid local favorites to import.");
              return;
            }
            setStatus("Importing favorites...");
            const response = await fetch("/api/me/favorites/import-local", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ids })
            });
            if (!response.ok) {
              setStatus("Could not import local favorites.");
              return;
            }
            window.localStorage.removeItem(storageKey);
            setStatus("Imported. Redirecting to your rotation...");
            if (window.appToast) window.appToast("Imported local favorites.", "success");
            window.setTimeout(() => {
              window.location.href = "/me/rotation";
            }, 500);
          });
        }
      }

      document.querySelectorAll("[data-game-row]").forEach((node) => {
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
          if (upButton instanceof HTMLButtonElement) upButton.classList.toggle("active", value === 1);
          if (downButton instanceof HTMLButtonElement) downButton.classList.toggle("active", value === -1);
        };
        const applyVoteCounts = (fromValue, toValue) => {
          if (!(upCount instanceof HTMLElement) || !(downCount instanceof HTMLElement)) return;
          let up = Number(upCount.textContent || "0");
          let down = Number(downCount.textContent || "0");
          if (fromValue === 1) up -= 1;
          if (fromValue === -1) down -= 1;
          if (toValue === 1) up += 1;
          if (toValue === -1) down += 1;
          upCount.textContent = String(Math.max(0, up));
          downCount.textContent = String(Math.max(0, down));
        };

        const submitVote = async (value) => {
          const previous = currentVote;
          if (currentVote === value) return;
          currentVote = value;
          setVoteState(value);
          applyVoteCounts(previous, value);
          const response = await fetch("/api/games/" + gameId + "/vote", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value })
          });
          if (response.ok) return;
          currentVote = previous;
          setVoteState(previous);
          applyVoteCounts(value, previous);
          if (window.appToast) window.appToast("Could not save vote.", "error");
        };

        if (upButton instanceof HTMLButtonElement) {
          upButton.addEventListener("click", () => {
            void submitVote(1);
          });
        }
        if (downButton instanceof HTMLButtonElement) {
          downButton.addEventListener("click", () => {
            void submitVote(-1);
          });
        }

        if (favoriteButton instanceof HTMLButtonElement) {
          favoriteButton.addEventListener("click", async () => {
            const favorited = favoriteButton.getAttribute("data-list-favorite") === "yes";
            favoriteButton.setAttribute("data-list-favorite", favorited ? "no" : "yes");
            favoriteButton.textContent = favorited ? "☆" : "★";
            const response = await fetch("/api/games/" + gameId + "/favorite", {
              method: favorited ? "DELETE" : "POST"
            });
            if (!response.ok) {
              favoriteButton.setAttribute("data-list-favorite", favorited ? "yes" : "no");
              favoriteButton.textContent = favorited ? "★" : "☆";
              if (window.appToast) window.appToast("Could not update favorite.", "error");
            }
          });
        }

        if (localFavoriteButton instanceof HTMLButtonElement) {
          const title = node.getAttribute("data-game-title") || "";
          const slug = node.getAttribute("data-game-slug") || "";
          const syncLocalButton = () => {
            const items = readFavorites();
            const found = items.some((item) => item && item.id === gameId);
            localFavoriteButton.setAttribute("data-local-favorite", found ? "yes" : "no");
            localFavoriteButton.textContent = found ? "★" : "☆";
          };
          localFavoriteButton.addEventListener("click", async () => {
            const items = readFavorites();
            const found = items.some((item) => item && item.id === gameId);
            if (found) {
              writeFavorites(items.filter((item) => !(item && item.id === gameId)));
              await fetch("/api/games/" + gameId + "/favorite-anon", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ anonId: getAnonId() })
              }).catch(() => undefined);
            } else {
              items.push({ id: gameId, slug, title });
              writeFavorites(items);
              await fetch("/api/games/" + gameId + "/favorite-anon", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ anonId: getAnonId() })
              }).catch(() => undefined);
            }
            syncLocalButton();
          });
          syncLocalButton();
        }
      });
    })();
  </script>`;
}

function isValidCsrfBody(
  c: Context<{ Bindings: Bindings; Variables: AppVariables }>,
  body: Record<string, string | File>
): boolean {
  const token = typeof body.csrf_token === "string" ? body.csrf_token : "";
  const cookie = getCookie(c, "csrf_token") || "";
  return token.length > 0 && cookie.length > 0 && token === cookie;
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
  return hashAuthToken(c.env.SESSION_SECRET, `anon-vote:${ip}`);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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

function getResetMetaLabel(resetBasis: "local" | "server" | null | undefined, resetTimeMinutes: number | null | undefined): string {
  const time = formatResetTime(resetTimeMinutes);
  if (time === "Unknown") {
    return "";
  }
  if (resetBasis === "local" || resetBasis === "server") {
    return `Reset ${time} (${resetBasis.toUpperCase()})`;
  }
  return `Reset ${time}`;
}

function isEnabled(value: string | undefined): boolean {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isDevEnv(env: Env): boolean {
  const appEnv = (env.APP_ENV || "").trim().toLowerCase();
  return appEnv === "dev" || appEnv === "development";
}

function hasEmailLoginDeliveryConfigured(env: Env): boolean {
  return Boolean(env.EMAIL?.send || env.RESEND_API_KEY || env.POSTMARK_SERVER_TOKEN || env.EMAIL_AUTH_WEBHOOK_URL);
}

function generateOneTimeCode(): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(random).padStart(6, "0");
}

async function hashAuthToken(secret: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:${value}`));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyTurnstile(env: Env, token: string, remoteIp: string): Promise<boolean> {
  if (!token || !env.TURNSTILE_SECRET_KEY) {
    return false;
  }

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteIp
      })
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { success?: boolean };
    return payload.success === true;
  } catch {
    return false;
  }
}

async function sendEmailLogin(
  env: Env,
  args: { to: string; code: string; magicLink: string }
): Promise<void> {
  const fromAddress = env.EMAIL_AUTH_FROM || "noreply@example.com";
  const subject = "Your Daily Game List sign-in code";
  const html = `<p>Your Daily Game List sign-in code: <strong>${escapeHtml(args.code)}</strong></p><p><a href="${escapeHtml(
    args.magicLink
  )}">Sign in with magic link</a></p><p>This code/link expires in 15 minutes.</p>`;
  const text = [
    "Your Daily Game List sign-in code:",
    args.code,
    "",
    "Or sign in instantly with this magic link:",
    args.magicLink,
    "",
    "This code/link expires in 15 minutes."
  ].join("\n");

  // Preferred path: Cloudflare Email Service Worker binding.
  if (env.EMAIL?.send) {
    await env.EMAIL.send({
      to: args.to,
      from: { email: fromAddress, name: "Daily Game List" },
      subject,
      text,
      html
    });
    return;
  }

  // Fallback provider: Resend REST API.
  if (env.RESEND_API_KEY) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [args.to],
        subject,
        text,
        html
      })
    });
    if (!response.ok) {
      throw new Error(`Resend send failed with ${response.status}`);
    }
    return;
  }

  // Fallback provider: Postmark REST API.
  if (env.POSTMARK_SERVER_TOKEN) {
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        From: fromAddress,
        To: args.to,
        Subject: subject,
        TextBody: text,
        HtmlBody: html,
        MessageStream: "outbound"
      })
    });
    if (!response.ok) {
      throw new Error(`Postmark send failed with ${response.status}`);
    }
    return;
  }

  if (env.EMAIL_AUTH_WEBHOOK_URL) {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (env.EMAIL_AUTH_WEBHOOK_TOKEN) {
      headers.set("Authorization", `Bearer ${env.EMAIL_AUTH_WEBHOOK_TOKEN}`);
    }
    await fetch(env.EMAIL_AUTH_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        to: args.to,
        from: fromAddress,
        subject,
        text,
        html
      })
    });
    return;
  }

  if (isDevEnv(env)) {
    console.log(
      JSON.stringify({
        message: "EMAIL_AUTH_WEBHOOK_URL not configured. Login token generated for development only.",
        to: args.to,
        code: args.code,
        magicLink: args.magicLink
      })
    );
    return;
  }

  throw new Error("Email login delivery is not configured");
}

function layout(title: string, user: AppUser | null, body: string, env: Env): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #080b12;
        --bg-soft: #0d1320;
        --ink: #e7edf8;
        --muted: #9cabca;
        --accent: #38d5a2;
        --accent-strong: #1da67b;
        --card: #101827;
        --border: #24324c;
        --shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        font-family: "Manrope", "IBM Plex Sans", "Segoe UI", "Helvetica Neue", sans-serif;
        background:
          radial-gradient(circle at 0% -10%, rgba(56, 213, 162, 0.14), transparent 40%),
          radial-gradient(circle at 110% -20%, rgba(106, 180, 255, 0.22), transparent 45%),
          linear-gradient(180deg, #070a10 0%, #0b101b 65%, #080b12 100%);
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 1rem 1.5rem;
        border-bottom: 1px solid var(--border);
        background: rgba(8, 11, 18, 0.72);
        backdrop-filter: blur(10px);
        position: sticky;
        top: 0;
        z-index: 20;
      }
      nav a { margin-right: 0.75rem; color: var(--ink); text-decoration: none; font-weight: 600; }
      nav a:hover { color: var(--accent); }
      main { max-width: 960px; margin: 1rem auto; padding: 0 1rem 2rem; }
      h1, h2 { letter-spacing: 0.01em; }
      .hero {
        background: linear-gradient(135deg, rgba(17, 25, 40, 0.94), rgba(14, 32, 49, 0.88));
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
        padding: 1.25rem;
      }
      .hero p { color: var(--muted); }
      .btn {
        display: inline-block;
        padding: 0.55rem 0.9rem;
        border-radius: 9px;
        background: linear-gradient(135deg, var(--accent), #2bbfc8);
        color: #04130f;
        font-weight: 700;
        text-decoration: none;
      }
      ul.games { list-style:none; padding:0; display:grid; gap:0.8rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
      ul.games li { background: var(--card); border:1px solid var(--border); border-radius:12px; padding:0.8rem; box-shadow: var(--shadow); }
      ul.games.compact { gap: 0.45rem; }
      ul.games.compact li { padding: 0.5rem 0.6rem; border-radius: 10px; }
      .game-row { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; align-items: center; }
      .game-row .meta { color: var(--muted); font-size: 0.8rem; }
      .game-row .compact-actions { display: flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
      .game-row .compact-actions button { padding: 0.3rem 0.45rem; font-size: 0.78rem; }
      .game-row .compact-actions .btn-details {
        padding: 0.3rem 0.55rem;
        font-size: 0.85rem;
        text-decoration: none;
        border: 1px solid var(--border);
        border-radius: 7px;
        background: linear-gradient(180deg, #1a2740, #131d31);
        color: var(--ink);
        font-weight: bold;
      }
      .game-row .compact-actions .btn-details:hover {
        background: linear-gradient(180deg, #1e2d4a, #16213a);
      }
      .panel {
        margin: 1rem 0;
        padding: 1rem;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: linear-gradient(160deg, rgba(17, 24, 39, 0.95), rgba(12, 19, 31, 0.95));
        box-shadow: var(--shadow);
      }
      .admin-grid { display:grid; gap:0.8rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .stack { display:flex; flex-direction:column; gap:0.8rem; }
      .stack-form { display:flex; flex-direction:column; gap:0.6rem; }
      textarea { padding:0.5rem; border-radius:6px; border:1px solid var(--border); background:#0d1422; color:var(--ink); }
      fieldset { border:1px solid var(--border); border-radius:8px; padding:0.6rem; }
      .check { display:inline-flex; align-items:center; gap:0.35rem; margin-right:0.7rem; margin-bottom:0.4rem; }
      .status { min-height: 1.2rem; color:var(--accent); font-weight: 600; }
      .status.error { color: #ff9eb5; }
      .actions { display:flex; gap:0.6rem; flex-wrap:wrap; margin-bottom:0.8rem; }
      button.active { background: linear-gradient(135deg, var(--accent), #2bbfc8); color:#04130f; }
      .tag { display:inline-block; margin-right:0.35rem; margin-bottom:0.35rem; padding:0.2rem 0.45rem; border-radius:999px; border:1px solid #2c3a58; background:#152138; font-size: 0.85rem; color:#b4c7ea; }
      .rotation-list { list-style:none; padding:0; display:flex; flex-direction:column; gap:0.7rem; }
      .rotation-list li { display:flex; align-items:center; flex-wrap:wrap; gap:0.75rem; border:1px solid var(--border); border-radius:10px; padding:0.65rem; background:#101827; }
      .drag { cursor: grab; font-weight: 700; color:#7e90b2; }
      .rotation-list li.dragging { opacity: 0.55; }
      .weekday-controls { display:flex; gap:0.4rem; flex-wrap:wrap; }
      .weekday-controls label { display:inline-flex; align-items:center; gap:0.2rem; font-size:0.85rem; color:var(--muted); }
      .reorder-controls { display:inline-flex; gap:0.35rem; }
      .reorder-controls button { padding: 0.3rem 0.45rem; font-size: 0.78rem; }
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
        background: #101a2a;
        box-shadow: var(--shadow);
        color: var(--ink);
        font-weight: 600;
      }
      .toast.success { border-color: #2c805f; }
      .toast.error { border-color: #9b4d63; }
      form { display:flex; gap: 0.6rem; flex-wrap:wrap; margin-bottom: 1rem; }
      input, select, button {
        padding: 0.5rem;
        border-radius: 7px;
        border: 1px solid var(--border);
        background: #0d1422;
        color: var(--ink);
      }
      input::placeholder, textarea::placeholder { color: #7c8da9; }
      button {
        background: linear-gradient(180deg, #1a2740, #131d31);
        color: var(--ink);
        border: 1px solid #2c3f63;
        cursor: pointer;
      }
      a { color: #8ac5ff; }
      p { color: var(--muted); }
      @media (max-width: 700px) {
        header { flex-direction: column; align-items:flex-start; gap:0.5rem; }
      }
    </style>
  </head>
  <body>
    <header>
      <nav>
        <a href="/">Home</a>
        <a href="/games">Games</a>
        ${user ? `<a href="/submit">Submit</a>` : ""}
        <a href="/me/rotation">My Rotation</a>
        ${user ? `<a href="/me/settings">Settings</a>` : ""}
        ${user && (user.role === "editor" || user.role === "admin") ? `<a href="/admin">Admin</a>` : ""}
        ${!user ? `<a href="/login">Login</a>` : ""}
      </nav>
      <div>
        ${
          user
            ? `Signed in as ${escapeHtml(user.displayName || user.email)} (${user.role}) - <a href="/auth/logout">Logout</a>`
            : isDevEnv(env) 
                ? `Sign in: <a href="/login">Login page</a> | Dev: <a href="/auth/mock-login/user">User</a> <a href="/auth/mock-login/editor">Editor</a> <a href="/auth/mock-login/admin">Admin</a>`
                : `Sign in: <a href="/login">Login page</a>`
        }
      </div>
    </header>
    ${body}
    <footer style="text-align: center; padding: 2rem 1rem; margin-top: 4rem; border-top: 1px solid #2c3f63; color: var(--muted); font-size: 0.9rem;">
      <p>
        <a href="https://github.com/mr-delayer/dailies" target="_blank" rel="noopener noreferrer">GitHub</a>
        |
        <a href="https://discord.gg/uRApjQJ4vh" target="_blank" rel="noopener noreferrer">Discord</a>
      </p>
    </footer>
    <div id="toast-stack" aria-live="polite" aria-atomic="true"></div>
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
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function upsertOAuthUser(
  env: Env,
  args: {
    provider: "google" | "github" | "discord";
    providerUserId: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  }
): Promise<void> {
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(args.email).first<{ id: string }>();
  const userId = existing?.id || crypto.randomUUID();

  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, avatar_url, role) VALUES (?1, ?2, ?3, ?4, 'user')"
    )
      .bind(userId, args.email, args.displayName, args.avatarUrl)
      .run();
  } else {
    await env.DB.prepare(
      "UPDATE users SET display_name = COALESCE(?1, display_name), avatar_url = COALESCE(?2, avatar_url), updated_at = datetime('now') WHERE id = ?3"
    )
      .bind(args.displayName, args.avatarUrl, userId)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(provider, provider_user_id) DO UPDATE SET user_id = excluded.user_id`
  )
    .bind(crypto.randomUUID(), userId, args.provider, args.providerUserId)
    .run();
}
