// Client side of the played-state sync for signed-in users (server: src/lib/user-plays.ts, GET/POST /api/me/plays).
// Runs in app.js after RESET_LOCALIZE_SCRIPT. Signed in = the header has a Settings link (cached logged-out pages
// never do), so logged-out visitors make no requests. dglMarkPlayed / dglUnmarkPlayed call dglPlaySync.marked /
// .unmarked (dglSkip / dglUnskip call .skipped / .unskipped, synced as { day, gameId } pairs; the server's skips for today and
// yesterday replace the local ones except changes still queued), which queue changes in localStorage dgl_plays_pending_v1 and POST them debounced (keepalive; the queue
// survives failures and is retried on the next load, focus or change). The first sync after sign-in uploads the local
// played map once (dgl_plays_synced_v1 = user id). After that the server's latest play per game replaces the local
// played map (except changes still queued), so an unmark on one device reaches the others. Streak and heatmap counts
// merge by "later day / larger count" in both directions. No ${} or backticks in this text.
export const PLAY_SYNC_SCRIPT = `
(() => {
  const PENDING = "dgl_plays_pending_v1", SYNCED = "dgl_plays_synced_v1", PLAYED = "dgl_played_v1", LOG = "dgl_play_log_v1", STREAK = "dgl_streak_v1", RESET_SEEN = "dgl_plays_reset_seen_v1";
  const DAY = 24 * 60 * 60 * 1000;
  const signedIn = !!document.querySelector('a[href="/me/settings"]');
  if (!signedIn) {
    window.dglPlaySync = { marked() {}, unmarked() {}, skipped() {}, unskipped() {} };
    return;
  }
  const jget = (key, fallback) => {
    try { const v = JSON.parse(window.localStorage.getItem(key) || "null"); return v && typeof v === "object" ? v : fallback; } catch { return fallback; }
  };
  const jset = (key, value) => { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const readPending = () => {
    const p = jget(PENDING, {});
    return {
      plays: Array.isArray(p.plays) ? p.plays : [], unplayed: Array.isArray(p.unplayed) ? p.unplayed : [],
      skipped: Array.isArray(p.skipped) ? p.skipped : [], unskipped: Array.isArray(p.unskipped) ? p.unskipped : []
    };
  };
  const recentLog = () => {
    const log = jget(LOG, {});
    const cutoff = window.dglDateKey(new Date(Date.now() - 119 * DAY));
    const out = {};
    Object.keys(log).forEach((day) => { const n = Math.floor(Number(log[day]) || 0); if (day >= cutoff && n > 0) out[day] = Math.min(n, 1000); });
    return out;
  };
  const readBest = () => { try { return Math.floor(Number(JSON.parse(window.localStorage.getItem("dgl_streak_best_v1") || "0"))) || 0; } catch { return 0; } };
  const readStreak = () => {
    const s = jget(STREAK, {});
    return typeof s.last === "string" && Number(s.count) > 0 ? { last: s.last, count: Math.floor(Number(s.count)) } : null;
  };
  let timer = 0, busy = false, lastSent = "";
  const schedule = (ms) => { window.clearTimeout(timer); timer = window.setTimeout(flush, ms); };
  const flush = async () => {
    if (busy) { schedule(2000); return; }
    const p = readPending();
    // Skips older than yesterday are no longer accepted by the server; drop them so they never block the queue.
    const keepDay = window.dglDateKey(new Date(Date.now() - DAY));
    const freshSkips = (list) => list.filter((x) => typeof x.day === "string" && x.day >= keepDay);
    if (freshSkips(p.skipped).length !== p.skipped.length || freshSkips(p.unskipped).length !== p.unskipped.length) {
      p.skipped = freshSkips(p.skipped); p.unskipped = freshSkips(p.unskipped); jset(PENDING, p);
    }
    const streak = readStreak();
    const log = recentLog();
    const best = Math.max(readBest(), streak ? streak.count : 0);
    const state = JSON.stringify([streak, log, best]);
    if (!p.plays.length && !p.unplayed.length && !p.skipped.length && !p.unskipped.length && state === lastSent) return;
    busy = true;
    const plays = p.plays.slice(0, 200), unplayed = p.unplayed.slice(0, 200), skipped = p.skipped.slice(0, 200), unskipped = p.unskipped.slice(0, 200);
    try {
      const body = { plays, unplayed, skipped, unskipped, log, best };
      if (streak) body.streak = streak;
      const res = await fetch("/api/me/plays", { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true, body: JSON.stringify(body) });
      // 400 means the server will never accept this batch: drop it (below) instead of retrying it forever.
      // Network errors, 429 and 5xx keep the queue for the next attempt.
      if (!res.ok && res.status !== 400) throw new Error("sync");
      const sent = new Set(plays.map((x) => "p" + x.gameId + x.playedAt).concat(unplayed.map((x) => "u" + x.gameId + x.since), skipped.map((x) => "s" + x.gameId + x.day), unskipped.map((x) => "k" + x.gameId + x.day)));
      const cur = readPending();
      cur.plays = cur.plays.filter((x) => !sent.has("p" + x.gameId + x.playedAt));
      cur.unplayed = cur.unplayed.filter((x) => !sent.has("u" + x.gameId + x.since));
      cur.skipped = cur.skipped.filter((x) => !sent.has("s" + x.gameId + x.day));
      cur.unskipped = cur.unskipped.filter((x) => !sent.has("k" + x.gameId + x.day));
      jset(PENDING, cur);
      lastSent = state;
      if (cur.plays.length || cur.unplayed.length || cur.skipped.length || cur.unskipped.length) schedule(200);
    } catch {
      // Offline or rate limited: the queue stays in localStorage for the next attempt.
    } finally {
      busy = false;
    }
  };
  const queueSkip = (field, other, gameId, day) => {
    const p = readPending();
    p[other] = p[other].filter((x) => !(x.gameId === gameId && x.day === day));
    p[field] = p[field].filter((x) => !(x.gameId === gameId && x.day === day));
    p[field].push({ day, gameId });
    p[field] = p[field].slice(-400);
    jset(PENDING, p);
    schedule(1000);
  };
  window.dglPlaySync = {
    skipped(gameId, day) { queueSkip("skipped", "unskipped", gameId, day); },
    unskipped(gameId, day) { queueSkip("unskipped", "skipped", gameId, day); },
    marked(gameId, ms) {
      const p = readPending();
      const last = p.plays.filter((x) => x.gameId === gameId).pop();
      if (!last || ms - Date.parse(last.playedAt) > 10 * 60 * 1000) p.plays.push({ gameId, playedAt: new Date(ms).toISOString() });
      p.plays = p.plays.slice(-400);
      jset(PENDING, p);
      schedule(1000);
    },
    unmarked(gameId, sinceMs) {
      const p = readPending();
      p.plays = p.plays.filter((x) => !(x.gameId === gameId && Date.parse(x.playedAt) >= sinceMs));
      p.unplayed.push({ gameId, since: new Date(sinceMs).toISOString() });
      p.unplayed = p.unplayed.slice(-400);
      jset(PENDING, p);
      schedule(1000);
    }
  };
  let lastSync = 0;
  const sync = async () => {
    lastSync = Date.now();
    try {
      // Cleared elsewhere? Wipe local play data before flush() can re-upload an old streak or log.
      const probe = await fetch("/api/me/plays?since=" + encodeURIComponent(new Date().toISOString()));
      if (probe.ok) {
        const pd = await probe.json();
        const seen = window.localStorage.getItem(RESET_SEEN) || "";
        if (pd && typeof pd.resetAt === "string" && pd.resetAt > seen) {
          ["dgl_played_v1", "dgl_play_log_v1", "dgl_play_games_v1", "dgl_streak_v1", "dgl_streak_best_v1", "dgl_skipped_v1", PENDING].forEach((k) => { try { window.localStorage.removeItem(k); } catch {} });
          try { window.localStorage.setItem(RESET_SEEN, pd.resetAt); window.localStorage.setItem(SYNCED, String(pd.userId)); } catch {}
          lastSent = "";
          window.dglLocalizeResets();
          (window.dglPlayedHooks || []).forEach((hook) => { try { hook(); } catch {} });
        }
      }
      await flush();
      const res = await fetch("/api/me/plays");
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !Array.isArray(data.plays)) return;
      const first = window.localStorage.getItem(SYNCED) !== data.userId;
      const pending = readPending();
      const now = Date.now();
      const cutoff = now - 3 * DAY;
      const local = jget(PLAYED, {});
      if (first) {
        // One-time upload of this browser's history (batched by the queue), then keep the union.
        Object.keys(local).forEach((id) => { if (Number(local[id]) > cutoff) pending.plays.push({ gameId: id, playedAt: new Date(Number(local[id])).toISOString() }); });
        pending.plays = pending.plays.slice(-400);
        jset(PENDING, pending);
        try { window.localStorage.setItem(SYNCED, String(data.userId)); } catch {}
      }
      const latest = {};
      data.plays.forEach((x) => {
        const ms = Date.parse(x.playedAt);
        if (ms > cutoff && !(latest[x.gameId] >= ms)) latest[x.gameId] = ms;
      });
      const next = {};
      if (first) Object.keys(local).forEach((id) => { if (Number(local[id]) > cutoff) next[id] = Number(local[id]); });
      pending.plays.forEach((x) => { const ms = Date.parse(x.playedAt); if (ms > cutoff && !(next[x.gameId] >= ms)) next[x.gameId] = ms; });
      Object.keys(latest).forEach((id) => {
        const undone = pending.unplayed.some((u) => u.gameId === id && Date.parse(u.since) <= latest[id]);
        if (!undone && !(next[id] >= latest[id])) next[id] = latest[id];
      });
      jset(PLAYED, next);
      // Games per local day for the "most played" stat: add the server's plays (the local list never shrinks).
      const byDay = jget("dgl_play_games_v1", {});
      const dayCut = window.dglDateKey(new Date(now - 35 * DAY));
      data.plays.forEach((x) => {
        const day = window.dglDateKey(new Date(Date.parse(x.playedAt)));
        if (day < dayCut) return;
        if (!Array.isArray(byDay[day])) byDay[day] = [];
        if (byDay[day].indexOf(x.gameId) < 0) byDay[day].push(x.gameId);
      });
      jset("dgl_play_games_v1", byDay);
      const bestIn = Math.floor(Number(data.streak && data.streak.best) || 0);
      if (bestIn > readBest()) { try { window.localStorage.setItem("dgl_streak_best_v1", String(bestIn)); } catch {} }
      const s = data.streak, mine = readStreak();
      if (s && s.last && s.count > 0 && (!mine || s.last > mine.last || (s.last === mine.last && s.count > mine.count))) jset(STREAK, { last: s.last, count: s.count });
      const log = jget(LOG, {});
      const cutDay = window.dglDateKey(new Date(now - 119 * DAY));
      Object.keys(data.log || {}).forEach((day) => { const n = Math.floor(Number(data.log[day]) || 0); if (day >= cutDay && n > (Number(log[day]) || 0)) log[day] = n; });
      jset(LOG, log);
      // Skips: the server's list for today and yesterday replaces the local one, keeping changes still queued.
      if (data.skips && typeof data.skips === "object") {
        const todayKey = window.dglDateKey(new Date(now)), yKey = window.dglDateKey(new Date(now - DAY));
        const out = {};
        [todayKey, yKey].forEach((day) => {
          const ids = new Set(Array.isArray(data.skips[day]) ? data.skips[day].filter((id) => typeof id === "string") : []);
          pending.unskipped.forEach((x) => { if (x.day === day) ids.delete(x.gameId); });
          pending.skipped.forEach((x) => { if (x.day === day) ids.add(x.gameId); });
          if (ids.size) out[day] = Array.from(ids);
        });
        jset("dgl_skipped_v1", out);
      }
      window.dglLocalizeResets();
      (window.dglPlayedHooks || []).forEach((hook) => { try { hook(); } catch {} });
      schedule(300);
    } catch {
      // Offline: try again on the next load or focus.
    }
  };
  // Streak and heatmap changes come from other scripts; push them after the next minute tick.
  (window.dglPlayedHooks = window.dglPlayedHooks || []).push(() => { window.setTimeout(flush, 5000); });
  window.addEventListener("pagehide", () => { void flush(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - lastSync > 60000) void sync(); });
  window.setTimeout(sync, 600);
})();
`;
