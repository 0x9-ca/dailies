import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * Gives the "Dle Developer" Discord role to verified developers who are in our server.
 *
 * A role can only be given to someone else by a bot with Manage Roles, so this needs DISCORD_BOT_TOKEN; without it
 * (staging, dev) everything here does nothing. It covers both ways a developer ends up eligible:
 *   - they verify a game while already in the server: queueDeveloperRole() runs right after the claim is verified;
 *   - they join the server afterwards: DeveloperRoleSync keeps checking those who are not in yet, and signing in
 *     with Discord checks at once.
 *
 * Only DeveloperRoleSync talks to Discord, so its calls are one at a time and rate limits are handled in one place.
 * The role is only ever added: losing every verified game, or a moderator taking the role off, is left alone.
 * Someone who leaves and later rejoins is noticed by the daily cron (recheckGrantedRoles) and given it again.
 */

const DEFAULT_API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{15,25}$/;
/** Developers checked per alarm run: a few Discord calls each, well under the subrequest limit. */
const BATCH = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export function developerRoleConfigured(env: Env): boolean {
  return Boolean(env.DISCORD_BOT_TOKEN && env.DISCORD_ROLE_DLE_DEVELOPER && SNOWFLAKE.test(env.DISCORD_GUILD_ID ?? "") && SNOWFLAKE.test(env.DISCORD_ROLE_DLE_DEVELOPER));
}

/** D1's datetime('now') text ("2026-10-15 04:00:00", UTC) as milliseconds. */
function sqlTimeMs(text: string): number {
  return Date.parse(`${text.replace(" ", "T")}Z`);
}

/** Seconds to wait before checking again a developer who is not in the server yet: often at first, then less. */
function recheckSeconds(env: Env, createdAt: string): number {
  const override = Number(env.DEVELOPER_ROLE_RECHECK_SECONDS);
  if (Number.isFinite(override) && override > 0) return override;
  const age = Date.now() - sqlTimeMs(createdAt);
  if (age < DAY_MS) return 10 * 60;
  if (age < 7 * DAY_MS) return 60 * 60;
  return 6 * 60 * 60;
}

type GrantCheck =
  | { kind: "granted" }
  | { kind: "has-role"; joinedAt: string | null }
  | { kind: "not-member" }
  | { kind: "rate-limited"; retryAfterMs: number }
  /** The bot is not allowed (bad token, missing Manage Roles, or the role sits above the bot's own). */
  | { kind: "misconfigured"; status: number; detail: string }
  | { kind: "error"; detail: string };

function discordFetch(env: Env, path: string, init: RequestInit = {}, reason?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "User-Agent": "DiscordBot (https://dailies.0x9.ca, 1.0)"
  };
  // Shown in the server's audit log next to the role change.
  if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);
  return fetch(`${env.DISCORD_API_BASE || DEFAULT_API}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(10_000) });
}

async function retryAfterMs(res: Response): Promise<number> {
  const body = (await res.json().catch(() => null)) as { retry_after?: number } | null;
  const seconds = Number(body?.retry_after ?? res.headers.get("Retry-After") ?? 5);
  return Math.ceil((Number.isFinite(seconds) ? seconds : 5) * 1000) + 500;
}

/** The server member for a Discord user: null if they are not in the server. */
async function getMember(env: Env, discordUserId: string): Promise<{ roles: string[]; joinedAt: string | null } | GrantCheck | null> {
  const res = await discordFetch(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`);
  if (res.status === 404) return null;
  if (res.status === 429) return { kind: "rate-limited", retryAfterMs: await retryAfterMs(res) };
  if (res.status === 401 || res.status === 403) return { kind: "misconfigured", status: res.status, detail: await errorDetail(res) };
  if (!res.ok) return { kind: "error", detail: `member lookup answered ${res.status}` };
  const member = (await res.json()) as { roles?: string[]; joined_at?: string | null };
  return { roles: member.roles ?? [], joinedAt: member.joined_at ?? null };
}

async function errorDetail(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string; code?: number } | null;
  return `${res.status}${body?.code ? ` code ${body.code}` : ""}${body?.message ? `: ${body.message}` : ""}`;
}

/** Gives the role to a Discord user if they are in the server. Checks first, so people who are not in cost one cheap call. */
async function grantIfMember(env: Env, discordUserId: string): Promise<GrantCheck> {
  if (!SNOWFLAKE.test(discordUserId)) return { kind: "error", detail: "stored Discord id is not valid" };
  try {
    const member = await getMember(env, discordUserId);
    if (member === null) return { kind: "not-member" };
    if ("kind" in member) return member;
    if (member.roles.includes(env.DISCORD_ROLE_DLE_DEVELOPER!)) return { kind: "has-role", joinedAt: member.joinedAt };
    const res = await discordFetch(
      env,
      `/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${env.DISCORD_ROLE_DLE_DEVELOPER}`,
      { method: "PUT" },
      "Verified game developer on 0x9 dles"
    );
    if (res.ok) return { kind: "granted" };
    if (res.status === 404) return { kind: "not-member" }; // left between the two calls
    if (res.status === 429) return { kind: "rate-limited", retryAfterMs: await retryAfterMs(res) };
    if (res.status === 401 || res.status === 403) return { kind: "misconfigured", status: res.status, detail: await errorDetail(res) };
    return { kind: "error", detail: `role grant answered ${res.status}` };
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : "request failed" };
  }
}

/**
 * Keeps discord_role_grants in step with who is eligible: a user with a verified claim and a linked Discord account
 * has a row. A user who linked a different Discord account since gets the row reset, so the new one is checked.
 * `userId` limits it to one person.
 */
export async function syncGrantRows(env: Env, userId?: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO discord_role_grants (user_id, discord_user_id)
     SELECT claims.user_id, MIN(accounts.provider_user_id)
     FROM (SELECT DISTINCT user_id FROM game_claims WHERE status = 'verified') AS claims
     JOIN oauth_accounts AS accounts ON accounts.user_id = claims.user_id AND accounts.provider = 'discord'
     WHERE (?1 IS NULL OR claims.user_id = ?1)
     GROUP BY claims.user_id
     ON CONFLICT(user_id) DO UPDATE SET
       discord_user_id = excluded.discord_user_id,
       granted_at = CASE WHEN discord_role_grants.discord_user_id = excluded.discord_user_id THEN discord_role_grants.granted_at ELSE NULL END,
       next_check_at = CASE WHEN discord_role_grants.discord_user_id = excluded.discord_user_id THEN discord_role_grants.next_check_at ELSE NULL END`
  ).bind(userId ?? null).run();
}

/**
 * Called when someone becomes a verified developer, or signs in or links Discord: makes sure they are on the list and
 * asks for a check straight away. Never throws, so it cannot break verification or sign-in.
 */
export async function queueDeveloperRole(env: Env, userId: string): Promise<void> {
  if (!developerRoleConfigured(env)) return;
  try {
    await syncGrantRows(env, userId);
    // Due now, even if the last check said "not in the server yet": they may have just joined.
    const waiting = await env.DB.prepare("UPDATE discord_role_grants SET next_check_at = NULL WHERE user_id = ?1 AND granted_at IS NULL").bind(userId).run();
    if ((waiting.meta.changes ?? 0) > 0) await env.ROLE_SYNC.get(env.ROLE_SYNC.idFromName("developers")).kick();
  } catch (error) {
    console.error(JSON.stringify({ message: "developer role queue failed", error: error instanceof Error ? error.message : String(error) }));
  }
}

const STILL_VERIFIED = "EXISTS (SELECT 1 FROM game_claims WHERE game_claims.user_id = discord_role_grants.user_id AND game_claims.status = 'verified')";

/**
 * One pass over the developers still waiting for the role. Returns when to run again (epoch ms), or null when no one
 * is waiting (a new verification, sign-in or the daily cron wakes it up again).
 */
export async function syncDeveloperRoles(env: Env): Promise<number | null> {
  if (!developerRoleConfigured(env)) return null;
  await syncGrantRows(env);

  const due = await env.DB.prepare(
    `SELECT user_id, discord_user_id, created_at FROM discord_role_grants
     WHERE granted_at IS NULL AND (next_check_at IS NULL OR next_check_at <= datetime('now')) AND ${STILL_VERIFIED}
     ORDER BY COALESCE(checked_at, '') LIMIT ?1`
  ).bind(BATCH).all<{ user_id: string; discord_user_id: string; created_at: string }>();

  for (const row of due.results) {
    const check = await grantIfMember(env, row.discord_user_id);
    switch (check.kind) {
      case "granted":
      case "has-role":
        await env.DB.prepare("UPDATE discord_role_grants SET granted_at = datetime('now'), checked_at = datetime('now'), next_check_at = NULL WHERE user_id = ?1").bind(row.user_id).run();
        console.log(JSON.stringify({ message: "developer role granted", userId: row.user_id, alreadyHad: check.kind === "has-role" }));
        break;
      case "not-member":
        await env.DB.prepare("UPDATE discord_role_grants SET checked_at = datetime('now'), next_check_at = datetime('now', ?2) WHERE user_id = ?1")
          .bind(row.user_id, `+${recheckSeconds(env, row.created_at)} seconds`)
          .run();
        break;
      case "rate-limited":
        return Date.now() + check.retryAfterMs;
      case "misconfigured":
        // Needs a person: fix the token, give the bot Manage Roles, or move its role above Dle Developer.
        console.error(JSON.stringify({ message: "developer role: Discord refused the bot", detail: check.detail }));
        return Date.now() + 60 * 60 * 1000;
      case "error":
        console.error(JSON.stringify({ message: "developer role: Discord check failed", userId: row.user_id, detail: check.detail }));
        return Date.now() + 2 * 60 * 1000;
    }
  }

  // Anyone left over from a full batch goes next; otherwise wake for the earliest developer who is waiting.
  const next = await env.DB.prepare(
    `SELECT MIN(COALESCE(next_check_at, datetime('now'))) AS at FROM discord_role_grants WHERE granted_at IS NULL AND ${STILL_VERIFIED}`
  ).first<{ at: string | null }>();
  if (!next?.at) return null;
  return Math.max(sqlTimeMs(next.at), Date.now() + 5_000);
}

/**
 * Daily: finds developers who were given the role but have since left the server. Their row goes back to waiting, so
 * they get the role again when they rejoin. (Discord drops a member's roles when they leave.) A member who is still in
 * but was given the role by someone else, or had it removed by a moderator, is left as they are.
 */
export async function recheckGrantedRoles(env: Env): Promise<void> {
  if (!developerRoleConfigured(env)) return;
  const rows = await env.DB.prepare(
    `SELECT user_id, discord_user_id, granted_at FROM discord_role_grants
     WHERE granted_at IS NOT NULL AND (checked_at IS NULL OR checked_at <= datetime('now', '-20 hours')) AND ${STILL_VERIFIED}
     ORDER BY COALESCE(checked_at, '') LIMIT 100`
  ).all<{ user_id: string; discord_user_id: string; granted_at: string }>();
  let reset = 0;
  for (const row of rows.results) {
    if (!SNOWFLAKE.test(row.discord_user_id)) continue;
    let member;
    try {
      member = await getMember(env, row.discord_user_id);
    } catch {
      continue;
    }
    if (member !== null && "kind" in member) {
      if (member.kind === "rate-limited" || member.kind === "misconfigured") break;
      continue;
    }
    // Not in the server any more, or joined again after we gave the role: either way, owed it afresh.
    const rejoined = member !== null && member.joinedAt !== null && Date.parse(member.joinedAt) > sqlTimeMs(row.granted_at) + 60_000;
    if (member === null || rejoined) {
      await env.DB.prepare("UPDATE discord_role_grants SET granted_at = NULL, next_check_at = NULL, checked_at = datetime('now') WHERE user_id = ?1").bind(row.user_id).run();
      reset += 1;
    } else {
      await env.DB.prepare("UPDATE discord_role_grants SET checked_at = datetime('now') WHERE user_id = ?1").bind(row.user_id).run();
    }
  }
  if (reset > 0) await env.ROLE_SYNC.get(env.ROLE_SYNC.idFromName("developers")).kick();
}

/** The daily cron's part: tidy up, and make sure the checking loop is running for anyone who is waiting. */
export async function runDeveloperRoleMaintenance(env: Env): Promise<void> {
  if (!developerRoleConfigured(env)) return;
  try {
    await recheckGrantedRoles(env);
    await env.ROLE_SYNC.get(env.ROLE_SYNC.idFromName("developers")).kick();
  } catch (error) {
    console.error(JSON.stringify({ message: "developer role maintenance failed", error: error instanceof Error ? error.message : String(error) }));
  }
}

/**
 * Runs the checks (one instance, "developers"). The alarm is the only clock: a per-minute cron was tried for the
 * announcements and never fired on this account, so waiting is done with the object's own alarm instead.
 */
export class DeveloperRoleSync extends DurableObject<Env> {
  /** Makes sure a pass runs within a second or so, without pushing back one that is already due sooner. */
  async kick(): Promise<void> {
    const soon = Date.now() + 1_000;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > soon) await this.ctx.storage.setAlarm(soon);
  }

  async alarm(): Promise<void> {
    let next: number | null;
    try {
      next = await syncDeveloperRoles(this.env);
    } catch (error) {
      console.error(JSON.stringify({ message: "developer role pass failed", error: error instanceof Error ? error.message : String(error) }));
      next = Date.now() + 5 * 60 * 1000;
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
