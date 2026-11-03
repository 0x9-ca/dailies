// Stream history for creator lists (see migrations/0039): recording helper plus the history page's CSS and script.
import type { Env } from "../env";

export const PLAY_HISTORY_DEDUPE_MS = 30 * 60 * 1000;
export const PLAY_HISTORY_KEEP_DAYS = 90;
export const PLAY_HISTORY_PAGE_DAYS = 30;

/** Records a game as started now, unless it was the list's latest entry within the last 30 minutes. Prunes rows over 90 days old. */
export async function recordPlay(env: Env, listId: string, gameId: string, now = Date.now()): Promise<void> {
  const last = await env.DB.prepare("SELECT game_id, started_at FROM list_play_history WHERE list_id = ?1 ORDER BY started_at DESC, id DESC LIMIT 1")
    .bind(listId)
    .first<{ game_id: string; started_at: string }>();
  const lastMs = last ? Date.parse(last.started_at) : NaN;
  if (!(last && last.game_id === gameId && now - lastMs < PLAY_HISTORY_DEDUPE_MS)) {
    await env.DB.prepare("INSERT INTO list_play_history (list_id, game_id, started_at) VALUES (?1, ?2, ?3)").bind(listId, gameId, new Date(now).toISOString()).run();
  }
  const cutoff = new Date(now - PLAY_HISTORY_KEEP_DAYS * 86400000).toISOString();
  await env.DB.prepare("DELETE FROM list_play_history WHERE list_id = ?1 AND started_at < ?2").bind(listId, cutoff).run();
}

export const PLAY_HISTORY_CSS = `
.ph-day { margin: 1.4rem 0 0; }
.ph-day h2 { margin: 0 0 0.4rem; font-size: 1.1rem; }
.ph-list { list-style: none; margin: 0; padding: 0; }
.ph-list li { display: flex; align-items: center; gap: 0.75rem; padding: 0.45rem 0; border-top: 1px solid var(--border); }
.ph-list li:first-child { border-top: 0; }
.ph-time { flex: none; min-width: 5.2em; color: var(--muted, #6b7280); font-variant-numeric: tabular-nums; }
.ph-list a { font-weight: 600; flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.ph-del { flex: none; min-width: 44px; min-height: 44px; padding: 0; line-height: 1; font-size: 1.2rem; }
.ph-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin: 1.5rem 0 0; }
`;

// No template substitutions: served as an asset. Data comes from #data-play-history.
export const PLAY_HISTORY_SCRIPT = `
(() => {
  const dataEl = document.getElementById("data-play-history");
  const root = document.getElementById("ph-days");
  if (!dataEl || !root) return;
  const D = JSON.parse(dataEl.textContent || "{}");
  const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
  const keyOf = (d) => d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  const toast = (msg) => { if (window.appToast) window.appToast(msg, "error", 3500); };
  const render = () => {
    root.textContent = "";
    const rows = D.entries.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    // Days newest first, plays within a day in play order (oldest first).
    const days = [];
    for (const e of rows) {
      const d = new Date(e.at);
      const k = keyOf(d);
      if (!days.length || days[days.length - 1].k !== k) days.push({ k, d, items: [] });
      days[days.length - 1].items.unshift(e);
    }
    for (const day of days) {
      const sec = document.createElement("section");
      sec.className = "ph-day";
      const h = document.createElement("h2");
      h.textContent = dayFmt.format(day.d);
      const ul = document.createElement("ul");
      ul.className = "ph-list";
      for (const e of day.items) {
        const li = document.createElement("li");
        const t = document.createElement("time");
        t.className = "ph-time";
        t.dateTime = e.at;
        t.textContent = timeFmt.format(new Date(e.at));
        const a = document.createElement("a");
        a.href = "/games/" + encodeURIComponent(e.slug);
        a.textContent = e.title;
        li.append(t, a);
        if (D.canManage) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "secondary ph-del";
          b.textContent = "\\u00D7";
          b.title = "Remove this entry";
          b.setAttribute("aria-label", "Remove " + e.title + " at " + t.textContent);
          b.addEventListener("click", async () => {
            b.disabled = true;
            try {
              const res = await fetch("/api/lists/" + encodeURIComponent(D.listId) + "/history/" + e.id, { method: "DELETE" });
              if (!res.ok) throw new Error();
              D.entries = D.entries.filter((x) => x.id !== e.id);
              render();
            } catch { b.disabled = false; toast("Could not remove that entry."); }
          });
          li.append(b);
        }
        ul.append(li);
      }
      sec.append(h, ul);
      root.append(sec);
    }
    const empty = document.getElementById("ph-empty");
    if (empty) empty.hidden = days.length > 0;
  };
  render();
  const clear = document.getElementById("ph-clear");
  if (clear) clear.addEventListener("click", async () => {
    if (!window.confirm("Clear the whole Stream history for this list? This can't be undone.")) return;
    clear.disabled = true;
    try {
      const res = await fetch("/api/lists/" + encodeURIComponent(D.listId) + "/history", { method: "DELETE" });
      if (!res.ok) throw new Error();
      window.location.href = "/lists/" + encodeURIComponent(D.slug);
    } catch { clear.disabled = false; toast("Could not clear the history."); }
  });
})();
`;
