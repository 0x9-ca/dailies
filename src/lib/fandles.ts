// Fan-dles: verifying that a developer is part of a streamer's community. See migrations/0029.

/** Twitch scopes asked for only when a developer chooses to verify; ordinary sign-ins request none. */
export const FANDLE_SCOPES = "user:read:follows user:read:subscriptions";
/** A follower needs to have followed this long (subscribers qualify at once). */
export const FANDLE_MIN_FOLLOW_DAYS = 7;
/**
 * How long a check counts before the developer has to verify again. No limit by default: a membership stays until the
 * developer leaves or staff change this at /admin/settings (days; empty = never).
 */
export const FANDLE_SETTING_MEMBERSHIP_DAYS = "fandle_membership_days";
/** Stored in fandle_members.expires_at: expiry is worked out from verified_at and the setting, so this never lapses. */
export const FANDLE_NO_EXPIRY = "9999-12-31 00:00:00";

/** SQL for "this membership still counts" given the setting (null = always). Days is a validated integer. */
export function fandleActiveSql(alias: string, membershipDays: number | null): string {
  // A member an admin added by hand never lapses.
  return membershipDays && Number.isInteger(membershipDays) ? `(${alias}.source = 'manual' OR ${alias}.verified_at > datetime('now', '-${membershipDays} days'))` : "1 = 1";
}
/**
 * Games shown per developer, and in total, in a streamer's Fan-dles. No limit by default; an admin can set either at
 * /admin/settings (site_settings keys below). FANDLE_HARD_MAX_SHOWN only guards the page's size when there is no total.
 */
export const FANDLE_SETTING_MAX_PER_DEVELOPER = "fandle_max_per_developer";
export const FANDLE_SETTING_MAX_SHOWN = "fandle_max_shown";
export const FANDLE_HARD_MAX_SHOWN = 100;
export const FANDLE_SETTING_LIMIT_MAX = 100;

const DAY_MS = 86_400_000;

export type FandleRelationship = { followedAt: string | null; subscribed: boolean };
export type FandleDecision =
  | { ok: true; source: "sub" | "follow" }
  | { ok: false; reason: "not_following" | "too_new"; eligibleAt?: string };

/** Subscribers qualify at once; followers once they've followed for FANDLE_MIN_FOLLOW_DAYS. */
export function decideFandle(rel: FandleRelationship, nowMs: number = Date.now()): FandleDecision {
  if (rel.subscribed) return { ok: true, source: "sub" };
  if (!rel.followedAt) return { ok: false, reason: "not_following" };
  const followedMs = Date.parse(rel.followedAt);
  if (Number.isNaN(followedMs)) return { ok: false, reason: "not_following" };
  const eligibleMs = followedMs + FANDLE_MIN_FOLLOW_DAYS * DAY_MS;
  if (nowMs >= eligibleMs) return { ok: true, source: "follow" };
  return { ok: false, reason: "too_new", eligibleAt: new Date(eligibleMs).toISOString() };
}

/** Thrown when Twitch can't answer (down, or the scopes weren't granted). */
export class TwitchCheckError extends Error {}

const HELIX = "https://api.twitch.tv/helix";

/**
 * Asks Twitch, with the developer's own token, whether they follow and/or subscribe to one broadcaster. Only these two
 * questions are asked, filtered to that one channel, so the developer's wider follow list is never read.
 */
export async function fetchTwitchRelationship(
  clientId: string,
  accessToken: string,
  viewerId: string,
  broadcasterId: string
): Promise<FandleRelationship> {
  const headers = { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId };
  const get = (path: string) => fetch(`${HELIX}${path}`, { headers, signal: AbortSignal.timeout(5000) });
  const [follows, subs] = await Promise.all([
    get(`/channels/followed?user_id=${encodeURIComponent(viewerId)}&broadcaster_id=${encodeURIComponent(broadcasterId)}`),
    get(`/subscriptions/user?broadcaster_id=${encodeURIComponent(broadcasterId)}&user_id=${encodeURIComponent(viewerId)}`)
  ]).catch(() => {
    throw new TwitchCheckError("unreachable");
  });
  if (follows.status === 401 || follows.status === 403) throw new TwitchCheckError("scope");
  if (!follows.ok) throw new TwitchCheckError("unavailable");
  const followedAt = ((await follows.json()) as { data?: Array<{ followed_at?: string }> }).data?.[0]?.followed_at ?? null;
  // 200: subscribed. 404 (not subscribed) and 400 (the channel has no subscriptions) both mean "not a subscriber".
  if (subs.status === 401 || subs.status === 403) throw new TwitchCheckError("scope");
  if (subs.status >= 500) throw new TwitchCheckError("unavailable");
  return { followedAt, subscribed: subs.ok };
}
