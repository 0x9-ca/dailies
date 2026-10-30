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

export async function invalidateGameCaches(env: Env): Promise<void> {
  // Keep invalidation simple by deleting all list keys under the games prefix.
  const keys = await env.CACHE.list({ prefix: "games:" });
  await Promise.all(keys.keys.map((k) => env.CACHE.delete(k.name)));
}

/** Seconds from `now` until the next UTC midnight. */
export function secondsUntilNextUtcDay(now: number = Date.now()): number {
  const nextMidnight = (Math.floor(now / 86_400_000) + 1) * 86_400_000;
  return Math.ceil((nextMidnight - now) / 1000);
}
