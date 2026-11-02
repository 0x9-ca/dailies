import type { Env } from "../env";

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The short public origin (SHORT_URL), or null when unset or the same as APP_URL. */
export function shortOrigin(env: Env): string | null {
  const short = originOf(env.SHORT_URL);
  return short && short !== originOf(env.APP_URL) ? short : null;
}

/** APP_URL's origin: the only host that serves the site. */
export function appOrigin(env: Env): string {
  return originOf(env.APP_URL) ?? env.APP_URL;
}

/** Short paths for sharing and the long routes they expand to. */
export const SHORT_PATHS = [["c", "lists"], ["g", "games"], ["r", "rotation"]] as const;

/** The long path for a short-host path (/c/x -> /lists/x); other paths are unchanged. */
export function expandShortPath(path: string): string {
  const m = /^\/([cgr])(\/[^/]+)$/.exec(path);
  const long = m && SHORT_PATHS.find(([s]) => s === m[1]);
  return long && m ? `/${long[1]}${m[2]}` : path;
}

/** True when the request arrived on the short host. */
export function isShortHost(env: Env, requestUrl: string): boolean {
  const short = shortOrigin(env);
  return !!short && originOf(requestUrl) === short;
}
