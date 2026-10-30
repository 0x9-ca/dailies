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

/** Origins that may serve the site: APP_URL's and, if set, SHORT_URL's. */
export function publicOrigins(env: Env): string[] {
  const app = originOf(env.APP_URL);
  const short = shortOrigin(env);
  return [app, short].filter((o): o is string => !!o);
}

/** The origin of this request when it is an allowed public origin, otherwise APP_URL's. */
export function requestOrigin(env: Env, requestUrl: string): string {
  const origin = originOf(requestUrl);
  return origin && publicOrigins(env).includes(origin) ? origin : (originOf(env.APP_URL) ?? env.APP_URL);
}

/** True when the request arrived on the short host. */
export function isShortHost(env: Env, requestUrl: string): boolean {
  const short = shortOrigin(env);
  return !!short && originOf(requestUrl) === short;
}
