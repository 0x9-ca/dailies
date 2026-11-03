// "Now playing" on creator lists: server helpers plus the client script and CSS (see migrations/0038).
import type { Env } from "../env";
import { getCachedJson, setCachedJson } from "./cache";

export const NOW_PLAYING_MAX_AGE_MS = 6 * 3600 * 1000;
/** KV's minimum TTL is 60s, so the cached copy carries its own timestamp and is ignored after this long. */
const CACHE_FRESH_MS = 10_000;

export type NowPlaying = { gameId: string; title: string; startedAt: string } | { gameId: null };
type Cached = { at: number; value: NowPlaying };

export const nowPlayingKey = (slug: string) => `np:v1:${slug}`;

/** The stored row as the API shows it: null once older than 6 hours (or unparseable). */
export function resolveNowPlaying(row: { gameId: string | null; title: string | null; at: string | null }, now = Date.now()): NowPlaying {
  if (!row.gameId || !row.title || !row.at) return { gameId: null };
  const ms = Date.parse(row.at);
  if (Number.isNaN(ms) || now - ms > NOW_PLAYING_MAX_AGE_MS || ms - now > 60_000) return { gameId: null };
  return { gameId: row.gameId, title: row.title, startedAt: new Date(ms).toISOString() };
}

/** Reads the list's Now playing; public lists go through a ~10s KV cache. `canView` is only asked for private lists. Null = no such list. */
export async function readNowPlaying(
  env: Env,
  slug: string,
  canView: (list: { visibility: string; owner_user_id: string; twitch_user_id: string | null }) => Promise<boolean>
): Promise<NowPlaying | null> {
  const cached = await getCachedJson<Cached>(env, nowPlayingKey(slug)).catch(() => null);
  if (cached && Date.now() - cached.at < CACHE_FRESH_MS) {
    const v = cached.value;
    return v.gameId ? resolveNowPlaying({ gameId: v.gameId, title: v.title, at: v.startedAt }) : v;
  }
  const row = await env.DB.prepare(
    `SELECT l.visibility, l.owner_user_id, l.twitch_user_id, l.now_playing_game_id AS gameId, l.now_playing_at AS at, g.title AS title
     FROM curated_lists l LEFT JOIN games g ON g.id = l.now_playing_game_id WHERE l.slug = ?1`
  )
    .bind(slug)
    .first<{ visibility: string; owner_user_id: string; twitch_user_id: string | null; gameId: string | null; at: string | null; title: string | null }>();
  if (!row) return null;
  if (row.visibility !== "public") return (await canView(row)) ? resolveNowPlaying(row) : null;
  const raw: NowPlaying = row.gameId && row.title && row.at ? { gameId: row.gameId, title: row.title, startedAt: row.at } : { gameId: null };
  await setCachedJson(env, nowPlayingKey(slug), { at: Date.now(), value: raw } satisfies Cached).catch(() => undefined);
  return resolveNowPlaying(row);
}

/** True when the game is on the list: main list, suggestions or Fan-dles. `fandleActive` is fandleActiveSql("fm", days). */
export async function gameInList(env: Env, listId: string, gameId: string, fandleActive: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok WHERE
       EXISTS (SELECT 1 FROM curated_list_items WHERE curated_list_id = ?1 AND game_id = ?2)
       OR EXISTS (SELECT 1 FROM list_suggestions WHERE curated_list_id = ?1 AND game_id = ?2)
       OR EXISTS (
         SELECT 1 FROM curated_lists cl
         JOIN fandle_members fm ON fm.list_id = cl.id
         JOIN game_claims gc ON gc.user_id = fm.user_id AND gc.status = 'verified' AND gc.game_id = ?2
         JOIN games ON games.id = gc.game_id AND games.status = 'approved'
         WHERE cl.id = ?1 AND cl.fandles_enabled = 1 AND ${fandleActive})`
  )
    .bind(listId, gameId)
    .first();
  return !!row;
}

export const NOW_PLAYING_CSS = `
.np-pill { display: inline-flex; align-items: center; gap: 0.45em; margin: 0 0 var(--sp-3, 0.75rem); padding: 0.25em 0.8em; border: 1.5px solid var(--stream-accent, #38bdf8); border-radius: 999px; font-size: 0.9rem; font-weight: 700; }
.np-pill[hidden] { display: none; }
.np-pill::before { content: "\\25B6"; font-size: 0.75em; color: var(--stream-accent, #38bdf8); }
html.dgl-stream .np-pill, html.dgl-overlay .np-pill { display: none !important; }
.rotation-list li { position: relative; }
.rotation-list li.np-now { box-shadow: inset 4px 0 0 var(--stream-accent, #38bdf8); }
.np-label { display: none; position: absolute; top: 50%; right: 0.7em; transform: translateY(-50%); padding: 0.1em 0.55em; border-radius: 999px; background: var(--stream-accent, #38bdf8); color: var(--stream-bg, #0b0d12); font-size: 0.7rem; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; pointer-events: none; z-index: 2; }
li.np-now > .np-label { display: block; }
html.dgl-stream .rotation-list li.np-now { border-color: var(--stream-accent); box-shadow: 0 0 0 max(3px, 0.12em) var(--stream-accent), 0 0 1.2em var(--stream-accent); }
html.dgl-stream .rotation-list li.np-now .item-main { padding-right: 7em; }
html.dgl-stream .rotation-list li.np-now > .np-label { font-size: 0.5em; }
html.dgl-stream.np-editor .rotation-list li.np-now > .np-label { right: 3.6em; }
.np-set { display: none; }
html.dgl-stream.np-editor .np-set { display: flex; position: absolute; top: 50%; right: 0.5em; transform: translateY(-50%); z-index: 6; align-items: center; justify-content: center; width: 1.6em; height: 1.6em; padding: 0; border: max(1.5px, 0.06em) solid var(--stream-accent); border-radius: 50%; background: var(--stream-row, #12151c); color: var(--stream-accent); font-size: 0.7em; line-height: 1; cursor: pointer; opacity: 0; pointer-events: none; transition: opacity 0.15s ease; }
html.dgl-stream.np-editor.np-show .np-set, html.dgl-stream.np-editor .np-set:focus-visible { opacity: 1; pointer-events: auto; }
@media (prefers-reduced-motion: reduce) { html.dgl-stream.np-editor .np-set { transition: none; } }
.overlay-panel .ov-np { margin: 0.35rem 0 0.1rem; font-size: 0.95em; font-weight: 800; color: #fde047; }
.overlay-panel .ov-np[hidden] { display: none; }
`;

// No template substitutions in here: it is served as an asset. Server data comes from #data-now-playing.
export const NOW_PLAYING_SCRIPT = `
(() => {
  const dataEl = document.getElementById("data-now-playing");
  const list = document.getElementById("list-items");
  if (!dataEl || !list) return;
  const D = JSON.parse(dataEl.textContent || "{}");
  const root = document.documentElement;
  const P = window.DGL_STREAM || { view: "", scroll: 1 };
  const params = new URLSearchParams(location.search);
  const overlay = P.view === "overlay";
  const showOverlayLine = params.get("np") !== "0";
  const canSet = !!D.canSet;
  const AUTO_KEY = "dgl_np_autoset_v1";
  const isStream = () => root.classList.contains("dgl-stream");
  const rows = () => Array.from(list.children).filter((li) => li.hasAttribute("data-game-id"));
  const toast = (msg) => { if (window.appToast) window.appToast(msg, "error", 3500); };
  let cur = null, busy = 0, lastShown = "";

  const head = document.querySelector(".list-head");
  const pill = document.createElement("p");
  pill.className = "np-pill";
  pill.id = "np-pill";
  pill.hidden = true;
  pill.setAttribute("role", "status");
  if (head) head.insertAdjacentElement("afterend", pill);
  const panel = document.getElementById("overlay-panel");
  let ovLine = null;
  if (panel) {
    ovLine = document.createElement("p");
    ovLine.className = "ov-np";
    ovLine.id = "ov-np";
    ovLine.hidden = true;
    const t = panel.querySelector(".ov-title");
    if (t) t.after(ovLine); else panel.prepend(ovLine);
  }

  const scrollToRow = (li) => {
    if (!isStream() || P.scroll === 0 || !li || list.scrollHeight <= list.clientHeight + 2) return;
    const lr = list.getBoundingClientRect(), r = li.getBoundingClientRect();
    list.scrollTop += (r.top + r.height / 2) - (lr.top + lr.height / 2);
  };

  const render = () => {
    const id = cur ? cur.gameId : "";
    let hit = null;
    rows().forEach((li) => {
      const on = !!id && li.getAttribute("data-game-id") === id;
      li.classList.toggle("np-now", on);
      let label = li.querySelector(":scope > .np-label");
      if (on && !label) {
        label = document.createElement("span");
        label.className = "np-label";
        label.textContent = "Now playing";
        li.appendChild(label);
      }
      if (!on && label) label.remove();
      if (on) hit = li;
      if (canSet && !li.querySelector(":scope > .np-set")) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "np-set";
        b.setAttribute("data-np-set", "");
        b.textContent = "\\u25B6";
        b.title = "Set Now playing";
        b.setAttribute("aria-label", "Set Now playing: " + (li.getAttribute("data-game-title") || ""));
        li.appendChild(b);
      }
    });
    const text = cur ? "Now playing: " + cur.title : "";
    pill.textContent = text;
    pill.hidden = !cur;
    if (ovLine) { ovLine.textContent = text; ovLine.hidden = !cur || !showOverlayLine; }
    if (id !== lastShown) {
      lastShown = id;
      if (hit) scrollToRow(hit);
      window.dispatchEvent(new Event("resize"));
    }
  };
  const apply = (v) => { cur = v && v.gameId ? { gameId: v.gameId, title: v.title, startedAt: v.startedAt } : null; render(); };

  // Rows added or replaced by live refresh get the highlight too.
  new MutationObserver(() => render()).observe(list, { childList: true });

  const poll = async () => {
    if (document.hidden || busy) return;
    try {
      const res = await fetch("/api/lists/" + encodeURIComponent(D.slug) + "/now-playing", { cache: "no-store" });
      if (res.ok && !busy) apply(await res.json());
    } catch {}
  };
  // Every 15s in stream mode and the overlay, 60s on the normal page; never while the tab is hidden.
  const every = () => (overlay || isStream() ? 15000 : 60000);
  let timer = 0;
  const loop = () => { window.clearTimeout(timer); timer = window.setTimeout(async () => { await poll(); loop(); }, every()); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { void poll(); loop(); } });
  new MutationObserver(loop).observe(root, { attributes: true, attributeFilter: ["class"] });
  void poll();
  loop();

  if (!canSet) { render(); return; }
  root.classList.add("np-editor");
  render();

  const put = async (gameId, title) => {
    const prev = cur;
    busy += 1;
    apply(gameId ? { gameId, title: title || "", startedAt: new Date().toISOString() } : null);
    try {
      const res = await fetch("/api/lists/" + encodeURIComponent(D.listId) + "/now-playing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: gameId || null })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save that.");
      apply(data);
    } catch (error) {
      apply(prev);
      toast(error && error.message ? error.message : "Could not save that.");
    } finally { busy -= 1; }
  };
  const setRow = (li) => {
    if (!li || (cur && cur.gameId === li.getAttribute("data-game-id"))) return;
    void put(li.getAttribute("data-game-id"), li.getAttribute("data-game-title") || "");
  };

  // Capture on the document so this runs before the stream list's click-to-mark handler.
  document.addEventListener("click", (event) => {
    const b = event.target instanceof Element ? event.target.closest("[data-np-set]") : null;
    if (!b) return;
    event.preventDefault();
    event.stopPropagation();
    setRow(b.closest("li[data-game-id]"));
  }, true);

  // p sets the hovered or focused row, Shift+P clears.
  let hoverRow = null;
  list.addEventListener("pointerover", (event) => { hoverRow = event.target instanceof Element ? event.target.closest("li[data-game-id]") : null; });
  list.addEventListener("pointerleave", () => { hoverRow = null; });
  document.addEventListener("keydown", (event) => {
    if (!isStream() || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
    if (event.key !== "p" && event.key !== "P") return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "P") { event.preventDefault(); if (cur) void put(null); return; }
    const focused = document.activeElement instanceof Element ? document.activeElement.closest("li[data-game-id]") : null;
    const li = hoverRow || (focused && list.contains(focused) ? focused : null);
    if (li) { event.preventDefault(); setRow(li); }
  });

  // Like the pane switcher, the buttons show on mouse movement and fade out after 3 seconds of stillness.
  let hideTimer = 0;
  const reveal = () => {
    if (!isStream()) return;
    root.classList.add("np-show");
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => root.classList.remove("np-show"), 3000);
  };
  document.addEventListener("mousemove", (event) => { if (event.movementX || event.movementY) reveal(); });
  document.addEventListener("focusin", reveal);

  // Opening a game from the list sets it (editors; switch off in Stream settings).
  const autoOn = () => { try { return window.localStorage.getItem(AUTO_KEY) !== "0"; } catch { return true; } };
  document.addEventListener("dgl:game-opened", (event) => {
    const d = event.detail || {};
    if (!d.id || !autoOn() || (cur && cur.gameId === d.id)) return;
    const li = rows().find((r) => r.getAttribute("data-game-id") === d.id);
    void put(d.id, (li && li.getAttribute("data-game-title")) || d.title || "");
  });

  const pop = document.getElementById("stream-settings");
  if (pop) {
    const auto = document.createElement("label");
    auto.className = "ss-check";
    auto.innerHTML = '<input type="checkbox" id="ss-np-auto"> Set Now playing when I open a game';
    const themeLabel = document.getElementById("ss-theme") && document.getElementById("ss-theme").closest("label");
    if (themeLabel) themeLabel.after(auto); else pop.appendChild(auto);
    const box = auto.querySelector("input");
    box.checked = autoOn();
    box.addEventListener("change", () => { try { window.localStorage.setItem(AUTO_KEY, box.checked ? "1" : "0"); } catch {} });
  }
})();
(() => {
  // Stream settings for everyone: the overlay link's np=0 switch (runs after the list script's own link builder).
  const pop = document.getElementById("stream-settings");
  const url = document.getElementById("ss-overlay-url");
  if (!pop || !url) return;
  const label = document.createElement("label");
  label.className = "ss-check";
  label.innerHTML = '<input type="checkbox" id="ss-onp"> Show Now playing in the overlay';
  const box = label.querySelector("input");
  box.checked = new URLSearchParams(location.search).get("np") !== "0";
  const row = url.closest(".ss-url");
  if (row) row.before(label); else pop.appendChild(label);
  const sync = () => {
    const u = url.value.replace(/&np=0/, "");
    url.value = box.checked ? u : u + "&np=0";
  };
  pop.addEventListener("input", sync);
  pop.addEventListener("change", sync);
  sync();
})();
`;
