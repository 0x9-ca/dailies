import type { Env } from "../env";

const TTL_SECONDS = 60;

export async function getCachedJson<T>(env: Env, key: string): Promise<T | null> {
  const value = await env.CACHE.get(key);
  if (!value) {
    return null;
  }
  return JSON.parse(value) as T;
}

export async function setCachedJson(env: Env, key: string, value: unknown): Promise<void> {
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: TTL_SECONDS });
}

export async function invalidateGameCaches(env: Env): Promise<void> {
  // Keep invalidation simple by deleting all list keys under the games prefix.
  const keys = await env.CACHE.list({ prefix: "games:" });
  await Promise.all(keys.keys.map((k) => env.CACHE.delete(k.name)));
}
