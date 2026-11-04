import type { Env } from "../env";

const TTL_SECONDS = 60;

export async function getCachedJson<T>(env: Env, key: string): Promise<T | null> {
  const value = await env.CACHE.get(key);
  if (!value) {
    return null;
  }
  return JSON.parse(value) as T;
}

export async function setCachedJson(env: Env, key: string, value: unknown, ttlSeconds = TTL_SECONDS): Promise<void> {
  // KV's minimum TTL is 60s.
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.ceil(ttlSeconds)) });
}

// Per call: at most this many KV list pages and this many deletes, so one write request can never exhaust the
// subrequest budget. Anything beyond the cap simply expires with its 60s TTL.
const INVALIDATE_MAX_LIST_PAGES = 3;
const INVALIDATE_MAX_DELETES = 800;

export async function invalidateGameCaches(env: Env): Promise<void> {
  // Keep invalidation simple by deleting all list keys under the games prefix, following the list cursor.
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < INVALIDATE_MAX_LIST_PAGES && names.length < INVALIDATE_MAX_DELETES; page++) {
    const res = await env.CACHE.list({ prefix: "games:", cursor });
    for (const k of res.keys) names.push(k.name);
    if (res.list_complete) break;
    cursor = res.cursor;
  }
  await Promise.all(names.slice(0, INVALIDATE_MAX_DELETES).map((name) => env.CACHE.delete(name)));
}

/** Seconds from `now` until the next UTC midnight. */
export function secondsUntilNextUtcDay(now: number = Date.now()): number {
  const nextMidnight = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
  return Math.ceil((nextMidnight - now) / 1000);
}
