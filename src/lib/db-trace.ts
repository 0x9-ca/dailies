// Dev-only D1 tracing (DB_TRACE=1): counts round trips and times them per request, logged as one JSON line.
// Off by default; when off the caller skips this module entirely.
import type { Env } from "../env";

type Rec = { sql: string; ms: number; stmts: number };

export function withDbTrace(env: Env, req: Request): { env: Env; done: (status: number) => void } {
  const recs: Rec[] = [];
  const latency = Number(env.DB_TRACE) || 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();
  const timed = async <T>(sql: string, stmts: number, fn: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    // DB_TRACE=<ms> (more than 1) adds that much latency per round trip, to mimic remote D1 locally.
    if (latency > 1) await new Promise((r) => setTimeout(r, latency));
    try { return await fn(); } finally { recs.push({ sql, ms: performance.now() - t, stmts }); }
  };
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p: D1PreparedStatement = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...a: unknown[]) => wrap(target.bind(...a), sql);
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...a: unknown[]) => timed(sql, 1, () => (target as any)[prop](...a));
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      }
    });
    real.set(p, stmt);
    sqlOf.set(p, sql);
    return p;
  };
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) =>
          timed(`BATCH[${stmts.length}] ${stmts.map((s) => (sqlOf.get(s) || "").slice(0, 60)).join(" | ")}`, stmts.length, () =>
            target.batch(stmts.map((s) => real.get(s) || s)));
      }
      const v = (target as any)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    }
  });
  const start = performance.now();
  const url = new URL(req.url);
  return {
    env: { ...env, DB: db } as Env,
    done: (status) => {
      const dbMs = recs.reduce((n, r) => n + r.ms, 0);
      const counts = new Map<string, number>();
      for (const r of recs) counts.set(r.sql, (counts.get(r.sql) || 0) + 1);
      console.log("DB_TRACE " + JSON.stringify({
        route: `${req.method} ${url.pathname}${url.search}`, status,
        queries: recs.length, statements: recs.reduce((n, r) => n + r.stmts, 0),
        dbMs: Math.round(dbMs), totalMs: Math.round(performance.now() - start),
        repeated: [...counts].filter(([, n]) => n > 1).map(([sql, n]) => `${n}x ${sql.replace(/\s+/g, " ").slice(0, 120)}`),
        detail: recs.map((r) => `${Math.round(r.ms)}ms ${r.sql.replace(/\s+/g, " ").slice(0, 100)}`)
      }));
    }
  };
}
