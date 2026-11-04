// Static CSS and client scripts, served as content-hashed, immutable assets at /assets/<name>.<hash>.<css|js>.
// Constants are template literals: keep ${} out of them (server data goes in a tiny inline bootstrap instead).

type AssetKind = "css" | "js";
interface Asset { name: string; kind: AssetKind; body: string; url: string }

const assets = new Map<string, Asset>();

// cyrb53: fast 53-bit string hash, synchronous (no async crypto), computed once per isolate at module load.
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Registers a static asset and returns its URL (/assets/<name>.<hash>.<ext>); the hash changes with the content. */
export function registerAsset(name: string, kind: AssetKind, body: string): string {
  const url = `/assets/${name}.${cyrb53(body).toString(36)}.${kind}`;
  assets.set(name + "." + kind, { name, kind, body, url });
  return url;
}

const ASSET_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff"
};

/**
 * GET /assets/<name>.<hash>.<ext>. A current hash is served immutable. A known name with another hash (an old page
 * after a deploy, or a typo) redirects to the current file without caching; an unknown name is a 404.
 */
export function serveAsset(file: string, method: string): Response {
  const m = /^([a-z0-9-]+)\.([a-z0-9]+)\.(css|js)$/.exec(file);
  const asset = m ? assets.get(m[1] + "." + m[3]) : undefined;
  if (!asset) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (asset.url !== "/assets/" + file) return new Response(null, { status: 302, headers: { Location: asset.url, "Cache-Control": "no-store" } });
  const type = asset.kind === "css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
  return new Response(method === "HEAD" ? null : asset.body, { headers: { ...ASSET_HEADERS, "Content-Type": type } });
}

export const SHARED_CSS = `      :root {
        color-scheme: dark;
        --bg: #121212;
        --bg-soft: #1a1a1a;
        --ink: #E0E0E0;
        --muted: #B0B0B0;
        --placeholder: #8a8a8a;
        /* Borders of inputs and buttons: 3:1 against the page, so the control is visible (WCAG 1.4.11). */
        --control-border: #6e6e6e;
        --accent: #888888;
        --accent-strong: #777777;
        --card: #1e1e1e;
        --border: #444444;
        --shadow: 0 18px 40px rgba(0, 0, 0, 0.35);
        --header-bg: rgba(18, 18, 18, 0.85);
        --on-accent: #121212;
        --brand-blue: #00a4fc;
        --primary: #00a4fc;
        --primary-strong: #35b8ff;
        --on-primary: #04121c;
        --vote-up-flash: #4ade80;
        --vote-down-flash: #f87171;
        --badge-paywall: #4ade80;
        --badge-nsfw: #f87171;
        --badge-new: #7dd3fc;
        --played-ok: #4ade80;
        /* Played cards: a slightly darker card, title in --muted (about 8:1 on it). */
        --played-bg: #171717;
        --warn: #fbbf24;
        --title-ink: #f2f2f2;
        --reset-bar: #7dd3fc;
        --reset-bar-soon: #f87171;
        --heat-0: #2a2a2a;
        --heat-1: #0e4a6e;
        --heat-2: #0b78ad;
        --heat-3: #00a4fc;
        --heat-4: #7dd3fc;
        --sp-1: 0.25rem;
        --sp-2: 0.5rem;
        --sp-3: 0.75rem;
        --sp-4: 1rem;
        --sp-5: 1.5rem;
        --sp-6: 2rem;
        --row-hover: #262626;
        --stream-bg: #000000;
        --stream-row: #0d0d0d;
        --stream-ink: #ffffff;
        --stream-sep: #6b6b6b;
        --stream-accent: #38bdf8;
        --stream-reset: #fde047;
        --stream-bar: #111111;
        /* Stream mode: played rows' text (about 6:1 on --stream-row). */
        --stream-done: #8f8f8f;
      }
      html[data-theme="light"] {
        color-scheme: light;
        --bg: #f5f5f7;
        --bg-soft: #ececf0;
        --ink: #1c1c1e;
        --muted: #5c5c63;
        --placeholder: #66666d;
        --control-border: #7b7b83;
        --accent: #4b5563;
        --accent-strong: #374151;
        --card: #ffffff;
        --border: #c9c9d1;
        --shadow: 0 10px 24px rgba(0, 0, 0, 0.08);
        --header-bg: rgba(245, 245, 247, 0.85);
        --on-accent: #ffffff;
        --brand-blue: #006db3;
        --primary: #006db3;
        --primary-strong: #005a94;
        --on-primary: #ffffff;
        --vote-up-flash: #15803d;
        --vote-down-flash: #b91c1c;
        --badge-paywall: #166534;
        --badge-nsfw: #b91c1c;
        --badge-new: #0369a1;
        --played-ok: #166534;
        --played-bg: #ececf0;
        --warn: #92400e;
        --title-ink: #111114;
        --reset-bar: #0ea5e9;
        --reset-bar-soon: #dc2626;
        --heat-0: #e4e4ea;
        --heat-1: #b6dcf2;
        --heat-2: #6ab6e3;
        --heat-3: #1f8fcf;
        --heat-4: #005a94;
        --row-hover: #f0f0f4;
        --stream-bg: #ffffff;
        --stream-row: #ffffff;
        --stream-ink: #000000;
        --stream-sep: #3a3a40;
        --stream-accent: #005a94;
        --stream-reset: #8a1c00;
        --stream-bar: #eeeef2;
        --stream-done: #6b6b6b;
      }
      * { box-sizing: border-box; }
      /* Elements toggled with the hidden attribute stay hidden even when a rule gives them a display value. */
      [hidden] { display: none !important; }
      body {
        margin: 0;
        color: var(--ink);
        font-family: "Manrope", "IBM Plex Sans", "Segoe UI", "Helvetica Neue", sans-serif;
        background: var(--bg);
      }
      header.site-header {
        display: flex;
        align-items: center;
        gap: 1.25rem;
        padding: 0.8rem 1.5rem;
        border-bottom: 1px solid var(--border);
        background: var(--header-bg);
        backdrop-filter: blur(10px);
        position: sticky;
        top: 0;
        z-index: 20;
      }
      /* Mirrors the logo: "0x9" with the x in the logo's blue. */
      .brand { font-weight: 800; font-size: 1.45rem; letter-spacing: 0.01em; color: var(--ink); text-decoration: none; white-space: nowrap; margin-right: 0.5rem; }
      .brand-x { color: var(--brand-blue); }
      .skip-link { position: absolute; left: 0.75rem; top: -4rem; z-index: 50; display: inline-flex; align-items: center; min-height: 44px; padding: 0 0.9rem; background: var(--primary); color: var(--on-primary); border-radius: 8px; font-weight: 700; text-decoration: none; }
      .skip-link:focus { top: 0.75rem; }
      main:focus { outline: none; }
      .site-nav a[aria-current="page"], .nav-menu-panel a[aria-current="page"] { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 0.45rem; text-decoration-color: var(--brand-blue); }
      .site-nav { display: flex; align-items: center; gap: 1rem; min-width: 0; }
      .nav-extra { display: contents; }
      .site-nav a, .nav-menu-panel a { color: var(--ink); text-decoration: none; font-weight: 600; white-space: nowrap; }
      .site-nav a:hover, .nav-menu-panel a:hover { color: var(--accent); }
      .header-tools { display: flex; align-items: center; gap: 0.6rem; margin-left: auto; white-space: nowrap; color: var(--muted); font-size: 0.9rem; }
      .theme-toggle { padding: 0.25rem 0.5rem; cursor: pointer; }
      .logout-form { display: inline; margin: 0; }
      .logout-form button { background: none; border: none; padding: 0; color: var(--accent); text-decoration: underline; font: inherit; cursor: pointer; }
      /* Search: an inline field on wide screens; at 1200px and below an icon that opens the field over the whole header. */
      .header-search { position: relative; display: flex; align-items: center; flex: 0 1 260px; min-width: 120px; margin-left: auto; }
      .header-search input { width: 100%; min-width: 0; padding: 0.45rem 2.1rem 0.45rem 0.7rem; border-radius: 999px; border: 1px solid var(--control-border); background: var(--bg-soft); color: var(--ink); font-size: 0.92rem; }
      .header-search input::-webkit-search-cancel-button { display: none; }
      .header-search-go { position: absolute; right: 0.15rem; top: 50%; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 50%; background: none; color: var(--muted); cursor: pointer; }
      .header-search-go:hover { color: var(--ink); }
      .header-search-go svg, .search-toggle svg { width: 1.05rem; height: 1.05rem; }
      .header-search-close, .search-toggle { display: none; }
      .header-search + .header-tools { margin-left: 0; }
      @media (min-width: 1201px) { .site-header > .site-nav { flex: none; } }
      .search-toggle { align-items: center; justify-content: center; min-width: 44px; min-height: 40px; padding: 0; border: 1px solid var(--control-border); border-radius: 8px; background: none; color: var(--ink); cursor: pointer; }
      .search-toggle svg { width: 1.2rem; height: 1.2rem; }
      @media (max-width: 1200px) {
        .search-toggle { display: inline-flex; }
        .header-search { display: none; position: absolute; inset: 0; z-index: 5; flex: none; margin: 0; padding: 0 0.75rem; gap: 0.5rem; background: var(--bg); border-bottom: 1px solid var(--border); }
        .site-header.searching .header-search { display: flex; }
        .header-search input { flex: 1; width: auto; min-height: 44px; font-size: 1rem; padding-right: 2.6rem; }
        .header-search-go { right: calc(0.75rem + 44px + 0.5rem + 0.2rem); }
        .header-search .search-suggest { left: 0.75rem; right: 0.75rem; width: auto; }
        .header-search-close { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 44px; height: 44px; border: 0; border-radius: 8px; background: none; color: var(--ink); font-size: 1.1rem; cursor: pointer; }
      }
      .nav-menu { display: none; position: relative; }
      .nav-menu > summary { list-style: none; cursor: pointer; position: relative; display: flex; align-items: center; justify-content: center; min-width: 44px; min-height: 40px; border: 1px solid var(--control-border); border-radius: 8px; font-size: 1.15rem; color: var(--ink); }
      .nav-menu > summary::-webkit-details-marker { display: none; }
      .menu-dot { position: absolute; top: -4px; right: -4px; width: 10px; height: 10px; border-radius: 50%; background: #dc2626; }
      .nav-menu-panel { position: absolute; right: 0; top: calc(100% + 0.5rem); min-width: 230px; display: flex; flex-direction: column; padding: 0.4rem; background: var(--card); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); z-index: 30; white-space: normal; }
      .nav-menu-panel > a { padding: 0.75rem; border-radius: 8px; }
      .nav-menu-panel > a.menu-narrow-only { display: none; }
      .nav-menu-theme { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0.75rem; color: var(--ink); font-weight: 600; }
      .nav-menu-account { border-top: 1px solid var(--border); margin-top: 0.3rem; padding: 0.75rem 0.75rem 0.35rem; color: var(--muted); }
      main { max-width: 1200px; margin: 1rem auto; padding: 0 1rem 2rem; }
      main.narrow { max-width: 820px; }
      .changelog h2 { font-size: 1.1rem; margin: 1.75rem 0 0.5rem; }
      .changelog li { margin: 0.35rem 0; line-height: 1.5; }
      h1, h2 { letter-spacing: 0.01em; }
      .hero {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
        padding: 1.25rem;
      }
      .hero { margin-top: 0; }
      .hero h1 { margin-top: 0; }
      .hero p { color: var(--muted); }
      .about { margin-top: 2rem; }
      .about p { color: var(--muted); max-width: 70ch; line-height: 1.6; }
      .about-categories { list-style: none; padding: 0; margin: 0.5rem 0 0; display: flex; flex-wrap: wrap; gap: 0.5rem; }
      .about-categories .tag { margin: 0; }
      /* Verified developer: an outlined blue pill after the category pills, so it doesn't read as another category. */
      .fandles { margin-top: 2rem; }
      .fandle-form { display: inline; margin: 0; }
      .fandle-join .actions { margin-top: 0.5rem; }
      .category-pills [hidden] { display: none !important; }
      button.tag.pill-more { cursor: pointer; font-family: inherit; line-height: inherit; font-weight: 700; color: var(--muted); background: var(--bg-soft); border: 1px solid var(--control-border); }
      button.tag.pill-more:hover { color: var(--ink); }
      .tag.dev-pill { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--brand-blue); background: transparent; border-color: var(--brand-blue); font-weight: 700; text-decoration: none; }
      /* A developer without a public profile: same look, but plain text. Taps pass through to the card behind it. */
      .tag.dev-pill.dev-pill-static { pointer-events: none; }
      .dev-pill-static::after { display: none; }
      .tag.dev-pill svg { width: 0.95em; height: 0.95em; flex: none; }
      .tag.dev-pill .dev-pill-name { display: block; max-width: 11ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pill-count { font-weight: 600; opacity: 0.9; font-variant-numeric: tabular-nums; margin-left: 0.15rem; }
      /* Shared by links and <button>s, so both get the same font, height and text position. */
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.55rem 0.9rem;
        border: 1px solid transparent;
        border-radius: 9px;
        background: var(--primary);
        color: var(--on-primary);
        font: inherit;
        font-weight: 700;
        line-height: 1.25;
        text-decoration: none;
        cursor: pointer;
      }
      /* Two equal-width buttons side by side, centred; stacked only on very narrow phones where they can't fit. */
      /* Home: Popular Today and Newly Added side by side, one card per row, on wide screens; stacked (5 each) otherwise. */
      .home-columns ul.games { grid-template-columns: 1fr; }
      /* Time left before today's game resets: a light blue line along the bottom of the card (see RESET_LOCALIZE_SCRIPT). */
      li.reset-bar { position: relative; }
      ul.games.compact li.reset-bar, .rotation-list li.reset-bar { padding-bottom: calc(0.65rem + 5px); }
      li.reset-bar::after { content: ""; position: absolute; left: 10px; bottom: 4px; height: 3px; width: calc((100% - 20px) * var(--reset-left, 0)); border-radius: 2px; background: var(--reset-bar); opacity: 0.85; pointer-events: none; }
      /* Under two hours to the reset and not played yet: the bar turns red. */
      li.reset-bar.reset-soon::after { background: var(--reset-bar-soon); }
      /* Played since the last reset (this browser): a muted card and a dimmer title, both at AA contrast in each theme.
         Not whole-card opacity, which pushed the small text below 4.5:1. Back to full title colour on hover or focus. */
      html:not(.dgl-stream) li.played { background: var(--played-bg); transition: background-color 0.15s ease; }
      html:not(.dgl-stream) li.played .game-title { color: var(--muted); transition: color 0.15s ease; }
      html:not(.dgl-stream) li.played:hover .game-title, html:not(.dgl-stream) li.played:focus-within .game-title { color: var(--title-ink); }
      .twitch-watch { text-align: center; }
      .btn:hover { background: var(--primary-strong); }
      .btn-twitch { gap: 0.5rem; background: #9146FF; border-color: #9146FF; color: #fff; }
      .btn-discord { gap: 0.5rem; background: #5865F2; border-color: #5865F2; color: #fff; }
      .btn-twitch:hover { background: #9146FF; filter: brightness(1.1); }
      .btn-discord:hover { background: #5865F2; filter: brightness(1.1); }
      .linked-accounts { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.6rem; }
      .linked-accounts li { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding: 0.6rem 0.75rem; border: 1px solid var(--border); border-radius: 10px; }
      .linked-account-name { display: inline-flex; align-items: center; gap: 0.5rem; font-weight: 700; color: var(--ink); flex: 1; }
      .linked-account-status { color: #22c55e; font-weight: 700; }
      .link-account-form { margin: 0; }
      .external-arrow { font-size: 0.9em; opacity: 0.85; }
      /* Twitch's own live red, white text. */
      .btn-twitch { white-space: nowrap; max-width: 100%; }
      .btn-twitch > span:first-of-type { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      /* Phones: the Twitch icon says where the button goes, so "on Twitch" is dropped to keep it on one line. */
      @media (max-width: 480px) { .btn-twitch .wide-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); } }
      .live-badge { background: #eb0400; color: #fff; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.08em; padding: 0.15rem 0.4rem; border-radius: 4px; line-height: 1.2; }
      .play-history-line { margin: 0.4rem 0 0; font-size: 0.88rem; opacity: 0.85; }
      .live-now-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 0.6rem; }
      .live-now-list li { display: flex; flex-direction: column; gap: 0.2rem; padding: 0.6rem 0.75rem; border: 1px solid #8884; border-left: 3px solid #eb0400; border-radius: 6px; }
      .live-now-title { font-weight: 700; }
      .live-now-meta, .live-now-game { font-size: 0.88rem; opacity: 0.85; }
      .live-now-watch { align-self: flex-start; font-size: 0.88rem; font-weight: 700; }
      a.live-badge-link { color: #fff; text-decoration: none; margin-left: 0.35rem; vertical-align: middle; display: inline-block; }
      a.live-badge-link:hover, a.live-badge-link:focus-visible { filter: brightness(1.15); }
      .live-badge[data-pulse] { animation: live-pulse 2s ease-in-out infinite; }
      @keyframes live-pulse { 50% { opacity: 0.65; } }
      @media (prefers-reduced-motion: reduce) { .live-badge[data-pulse] { animation: none; } }
      .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      @media (min-width: 800px) {
        .home-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1.5rem; align-items: start; }
      }
      @media (max-width: 799px) {
        .home-columns ul.games li:nth-child(n + 6) { display: none; }
      }
      .actions.home-actions { display: grid; grid-template-columns: 1fr 1fr; max-width: 460px; margin-left: auto; margin-right: auto; }
      .home-actions .btn { min-width: 0; white-space: nowrap; }
      ul.games { list-style:none; padding:0; display:grid; gap:0.8rem; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); }
      ul.games li { display:flex; background: var(--card); border:1px solid var(--border); border-radius:12px; padding:0.8rem; box-shadow: var(--shadow); }
      ul.games.compact { gap: 0.6rem; }
      ul.games.compact li { padding: 0.65rem 0.75rem; border-radius: 10px; }
      /* Card: name and buttons on the first line, tags and stats on the second. */
      .game-row { display: flex; flex-direction: column; gap: 0.3rem; width: 100%; }
      .game-top { display: flex; align-items: flex-start; gap: 0.5rem; }
      .game-name { flex: 1; min-width: 0; padding-top: 0.2rem; overflow-wrap: break-word; }
      .game-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.5rem; }
      .game-sub .category-pills { margin-top: 0; }
      .game-sub .tag { font-size: 0.75rem; padding: 0.1rem 0.4rem; }
      .game-sub .meta { margin: 0; }
      /* Game names, the same on every card and row. */
      /* anywhere (not break-word): a long unbroken word then counts as breakable in the card's min-content width, so it can't widen the card. */
      .game-title { font-size: 1.1rem; font-weight: 700; line-height: 1.3; color: var(--title-ink); text-decoration-color: var(--border); overflow-wrap: anywhere; }
      .game-title:hover { text-decoration-color: currentColor; }
      /* The game name's link stretches over the whole card, so a tap anywhere opens the game; buttons and tags sit above it. */
      .card-click { position: relative; }
      .card-click .card-link::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
      .card-click button, .card-click .btn-details, .card-click .category-pill, .card-click .drag { position: relative; z-index: 1; }
      .card-click:hover { border-color: var(--accent); }
      .list-sort { display: inline-flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0; }
      .rotation-list.sorted-by-reset .drag, .rotation-list.sorted-by-reset .reorder-controls { display: none; }
      .game-row .meta, .rotation-list .item-main .meta { color: var(--muted); font-size: 0.85rem; }
      .status:empty { margin: 0; }
      /* Vote counts: equal-width digits and a minimum width, so the buttons line up from row to row. */
      .compact-actions button, .game-actions button { font-variant-numeric: tabular-nums; }
      .compact-actions button[data-list-vote] { min-width: 3.3rem; }
      /* With a mouse the card is the cue, so the title underline only shows on hover. Touch keeps it. */
      @media (hover: hover) {
        .card-click .game-title { text-decoration-color: transparent; }
        .card-click:hover .game-title, .card-click .game-title:focus-visible { text-decoration-color: currentColor; }
      }
      .meta > :not([hidden]) ~ :not([hidden])::before { content: "·"; margin: 0 0.4em; }
      /* "83% liked" and "Resets in 3h 12m" never break mid-phrase; a part that doesn't fit moves to the next line. */
      .meta > * { white-space: nowrap; }
      /* Games added to or removed from a curated list while it's open. */
      .row-enter { animation: row-enter 0.9s ease-out; }
      @keyframes row-enter {
        from { opacity: 0; transform: translateY(-6px); box-shadow: 0 0 0 2px var(--brand-blue); }
        60% { opacity: 1; transform: none; box-shadow: 0 0 0 2px var(--brand-blue); }
        to { box-shadow: 0 0 0 2px transparent; }
      }
      .row-leave { opacity: 0; transform: scale(0.98); transition: opacity 0.3s ease, transform 0.3s ease; }
      @media (prefers-reduced-motion: reduce) {
        @keyframes row-enter { from { opacity: 0; } to { opacity: 1; } }
        .row-leave { transform: none; }
      }
      .meta:not(:has(> :not([hidden]))) { display: none; }
      /* A vote count or rating that just changed (live update or the viewer's own vote) pulses once. */
      .count-bump { display: inline-block; animation: count-bump 0.7s ease-out; }
      .count-bump.count-up { --bump-color: var(--vote-up-flash); }
      .count-bump.count-down { --bump-color: var(--vote-down-flash); }
      @keyframes count-bump {
        0% { transform: scale(1); color: inherit; }
        25% { transform: scale(1.3); color: var(--bump-color, var(--brand-blue)); }
        100% { transform: scale(1); color: inherit; }
      }
      .game-row .compact-actions { display: flex; gap: 0.3rem; align-items: center; flex-shrink: 0; }
      .btn-details {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.3rem 0.55rem;
        font-size: 0.85rem;
        text-decoration: none;
        border: 1px solid var(--border);
        border-radius: 7px;
        background: var(--bg-soft);
        color: var(--ink);
        font-weight: bold;
      }
      .btn-details:hover { background: var(--border); }
      .card-actions { display:flex; gap:0.35rem; align-items:center; flex-wrap:nowrap; margin-left:auto; }
      .game-row .compact-actions button, .rotation-list .compact-actions button, .card-actions button {
        padding: 0.3rem 0.55rem;
        font-size: 0.85rem;
        border: 1px solid var(--border);
        border-radius: 7px;
        background: var(--bg-soft);
        color: var(--ink);
        font-weight: bold;
        white-space: nowrap;
        cursor: pointer;
      }
      .game-row .compact-actions button:hover, .rotation-list .compact-actions button:hover, .card-actions button:hover {
        background: var(--border);
      }
      .rotation-list .reorder-controls { display:inline-flex; gap:0.25rem; }
      .rotation-list .skip-btn { padding: 0.3rem 0.5rem; font-size: 0.78rem; white-space: nowrap; background: transparent; color: var(--muted); }
      .rotation-list .skip-btn[hidden] { display: none; }
      .rotation-list li.skipped { order: 1; opacity: 0.55; }
      .rotation-list li.skipped:hover, .rotation-list li.skipped:focus-within { opacity: 0.85; }
      .panel {
        margin: 1rem 0;
        padding: 1rem;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--card);
        box-shadow: var(--shadow);
      }
      .paste-rows { list-style: none; margin: 0.8rem 0; padding: 0; display: grid; gap: 0.5rem; }
      .paste-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.2rem 0.6rem; align-items: center; padding: 0.5rem; border: 1px solid var(--control-border); border-radius: 6px; }
      .paste-row input[type=checkbox] { width: 1.2rem; height: 1.2rem; }
      .paste-input { overflow-wrap: anywhere; font-size: 0.85rem; color: var(--muted, inherit); }
      .paste-match { grid-column: 2; display: flex; flex-wrap: wrap; gap: 0.2rem 0.6rem; align-items: center; min-width: 0; }
      .paste-match select { max-width: 100%; min-width: 0; }
      #rotation-paste-text { width: 100%; box-sizing: border-box; margin: 0.4rem 0 0.6rem; }
      .panel > h2:first-child { margin-top: 0; }
      .panel > h2:last-child { margin-bottom: 0.5rem; }
      .panel > p:last-child { margin-bottom: 0; }
      .panel > form:last-child { margin-bottom: 0; }
      .admin-grid { display:grid; gap:0.8rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
      .stack { display:flex; flex-direction:column; gap:0.8rem; }
      .stack-form { display:flex; flex-direction:column; gap:0.6rem; }
      /* A select with a very long option would otherwise stretch the form (and the page) past a phone screen. */
      .stack-form label, .stack-form select, .stack-form input, .stack-form textarea { min-width: 0; max-width: 100%; }
      /* A select sizes to its longest option (time zone names), so it fills the column instead of pushing the form wider than the screen. */
      .stack-form select { width: 100%; }
      .stack-form fieldset { min-width: 0; max-width: 100%; }
      .stack-form [data-reset-group] { min-width: 0; }
      .stack-form [data-reset-group] > label { display: flex; flex-direction: column; gap: 0.25rem; }
      textarea { padding:0.5rem; border-radius:6px; border:1px solid var(--control-border); background:var(--bg-soft); color:var(--ink); }
      fieldset { border:1px solid var(--border); border-radius:8px; padding:0.6rem; }
      .check { display:inline-flex; align-items:center; gap:0.35rem; margin-right:0.7rem; margin-bottom:0.4rem; }
      .offline-banner { background: var(--card); color: var(--warn); border-bottom: 1px solid var(--border); padding: 0.5rem 1rem; text-align: center; font-weight: 600; font-size: 0.9rem; }
      .status { min-height: 1.2rem; color:var(--accent); font-weight: 600; }
      .status.error { color: #cc6666; }
      .actions { display:flex; gap:0.6rem; flex-wrap:wrap; margin-bottom:0.8rem; }
      button.active { background: var(--accent); color: var(--on-accent); }
      .tag { display:inline-block; margin-right:0.35rem; margin-bottom:0.35rem; padding:0.2rem 0.45rem; border-radius:999px; border:1px solid var(--border); background:var(--bg-soft); font-size: 0.85rem; color:var(--muted); }
      .profile-head { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
      .profile-head h1 { margin: 0; overflow-wrap: anywhere; }
      .profile-avatar { width: 96px; height: 96px; border-radius: 50%; flex: none; object-fit: cover; background: var(--bg-soft); border: 1px solid var(--border); }
      .profile-avatar-initial { display: flex; align-items: center; justify-content: center; font-size: 2.6rem; font-weight: 800; color: var(--muted); }
      .profile-streak { margin: 0 0 1rem; }
      .profile-badges { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.4rem 0; }
      .profile-badge { display: inline-flex; align-items: center; gap: 0.2rem; padding: 0.15rem 0.6rem; border: 1px solid var(--border); border-radius: 999px; font-size: 0.85rem; background: var(--bg-soft); }
      .profile-badge .verified-badge { margin: 0; }
      .profile-rotation { padding-left: 1.4rem; }
      #public-profile-form input[type="text"] { width: 100%; box-sizing: border-box; }
      .profile-preview { margin-bottom: 1rem; }
      @media (max-width: 480px) { .profile-head { flex-direction: column; align-items: flex-start; } }
      .developer-line { margin: 0.25rem 0; color: var(--muted); }
      .developer-line .verified-badge { margin-left: 0; margin-right: 0.2rem; }
      .claim-panel pre { overflow-x: auto; margin: 0.4rem 0; padding: 0.5rem 0.7rem; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 8px; }
      .claim-panel textarea { width: 100%; }
      .verified-badge { display:inline-flex; vertical-align:middle; margin-left:0.35rem; font-size:0.9em; }
      .paywall-badge { color: var(--badge-paywall); font-weight:700; margin-left:0.3rem; font-size:1em; }
      .nsfw-badge { color: var(--badge-nsfw); font-weight:700; margin-left:0.3rem; font-size:0.75em; font-variant:small-caps; letter-spacing:0.05em; }
      .feed-link { margin: 0 0 0.5rem; font-size: 0.9em; }
      .similar-results { margin-top: 1.5rem; }
      .similar-title { font-size: 1rem; margin: 0 0 0.5rem; color: var(--muted); }
      .did-you-mean { margin: 0.5rem 0 0; font-weight: 600; }
      @media (max-width: 700px) { .feed-link a { display: inline-flex; align-items: center; min-height: 44px; } }
      .duplicate-warning { color: var(--warn); font-weight: 600; }
      .played-pill { display: inline-block; margin-left: 0.3rem; padding: 0 0.45em; border: 1px solid var(--played-ok); border-radius: 999px; color: var(--played-ok); font-size: 0.7em; font-weight: 700; line-height: 1.6; letter-spacing: 0.02em; vertical-align: middle; white-space: nowrap; }
      .played-pill[hidden] { display: none; }
      .list-played-btn.is-played { color: var(--played-ok); border-color: var(--played-ok); }
      .played-count, .ov-played { margin: 0; font-weight: 800; font-variant-numeric: tabular-nums; }
      html:not(.dgl-stream) .played-count { display: none; }
      .played-count[hidden], .ov-played[hidden] { display: none !important; }
      .stream-settings textarea { flex: 1; min-width: 0; font: inherit; font-size: 0.8rem; resize: none; }
      .stream-settings .ss-badge-preview { display: block; max-width: 100%; height: auto; margin: 0.4rem 0; border-radius: 8px; }
      .new-badge { display: inline-block; margin-left: 0.3rem; padding: 0 0.4em; border: 1px solid var(--badge-new); border-radius: 999px; color: var(--badge-new); font-size: 0.7em; font-weight: 700; line-height: 1.6; letter-spacing: 0.03em; vertical-align: middle; white-space: nowrap; }
      [data-share] { min-height: 44px; }
      .moderation-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 1.3em;
        height: 1.3em;
        padding: 0 0.35em;
        margin-left: 0.3rem;
        border-radius: 9999px;
        background: #dc2626;
        color: #fff;
        font-size: 0.75rem;
        font-weight: 700;
        line-height: 1;
        vertical-align: middle;
      }
      .moderation-badge-submissions { background: #16a34a; }
      button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--control-border); }
      button.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
      .rotation-list { list-style:none; padding:0; display:flex; flex-direction:column; gap:0.7rem; }
      .rotation-list li { display:flex; align-items:center; gap:0.75rem; border:1px solid var(--border); border-radius:10px; padding:0.65rem; background:var(--card); }
      .rotation-list li > .item-main { flex: 1; min-width: 0; }
      /* Long names wrap (as on the game cards) rather than being cut off, so the $ / nsfw badges are never hidden. */
      .rotation-list li > .item-main > a { display: block; overflow-wrap: break-word; }
      .rotation-list li > .item-main > a .paywall-badge, .rotation-list li > .item-main > a .nsfw-badge { white-space: nowrap; }
      .rotation-list .item-main .tag { font-size: 0.75rem; padding: 0.1rem 0.4rem; }
      .category-pills { display:flex; flex-wrap:wrap; gap:0.3rem; margin-top:0.3rem; }
      .category-pills:empty { display:none; margin-top:0; }
      .category-pills .tag { margin:0; }
      .category-pill { text-decoration:none; font-weight:700; }
      .drag { cursor: grab; font-weight: 700; color:var(--muted); touch-action: none; }
      .rotation-list li.dragging { opacity: 0.55; }
      .weekday-controls { display:flex; gap:0.4rem; flex-wrap:wrap; }
      .weekday-controls label { display:inline-flex; align-items:center; gap:0.2rem; font-size:0.85rem; color:var(--muted); }
      .reorder-controls { display:inline-flex; gap:0.35rem; }
      .reorder-controls button { padding: 0.3rem 0.45rem; font-size: 0.78rem; }
      .game-search-wrap { position: relative; width: 100%; max-width: 400px; }
      .game-search-list { position: absolute; top: 100%; left: 0; right: 0; max-height: 240px; overflow-y: auto; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 6px; z-index: 10; display: none; }
      .game-search-list.open { display: block; }
      .game-search-item { padding: 0.5rem 0.65rem; cursor: pointer; color: var(--ink); font-size: 0.9rem; }
      .game-search-item:hover, .game-search-item.active { background: var(--card); }
      .game-search-item small { color: var(--muted); }
      /* Curated list suggestions: a collapsed panel above the list on phones, a column beside it on wide screens. */
      .suggest-panel { margin: 0.75rem 0; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
      .suggest-panel > summary { cursor: pointer; padding: 0.75rem 0.85rem; font-weight: 700; }
      .suggest-count { color: var(--muted); font-weight: 600; }
      .suggest-body { padding: 0 0.85rem 0.85rem; }
      .suggest-help, .suggest-empty { color: var(--muted); font-size: 0.9rem; margin: 0 0 0.65rem; }
      .suggest-empty { margin: 0; }
      .suggest-form { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
      .suggest-form .game-search-wrap { flex: 1; min-width: 0; max-width: none; }
      .suggest-form input { width: 100%; box-sizing: border-box; }
      .suggest-list { list-style: none; padding: 0; margin: 0 0 0.25rem; display: flex; flex-direction: column; gap: 0.4rem; }
      .suggest-item { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-soft); }
      /* The buttons drop below the title when the panel is too narrow for both. */
      .suggest-main { flex: 1 1 150px; min-width: 0; }
      .suggest-actions { display: flex; align-items: center; gap: 0.4rem; margin-left: auto; }
      .suggest-main .category-pills { margin-top: 0.25rem; }
      .suggest-main .category-pill { font-size: 0.75rem; }
      .suggest-title { color: var(--ink); font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
      .suggest-title:hover { color: var(--accent); }
      .suggest-item button { padding: 0.2rem 0.5rem; font-size: 0.85rem; white-space: nowrap; position: relative; }
      .suggest-item button::after { content: ""; position: absolute; inset: -8px -2px; }
      /* Curated list pages: the list is the hero on desktop, with one sidebar (Fan-dles and Suggestions as tabs) that can
         collapse to a rail. Phones keep the List / Fan-dles / Suggestions tabs. */
      .tab-count { min-width: 1.5rem; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--bg-soft); border: 1px solid var(--border); color: var(--ink); font-size: 0.78rem; font-weight: 700; line-height: 1.35; text-align: center; font-variant-numeric: tabular-nums; }
      [aria-selected="true"] > .tab-count { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
      .tab-count:empty { display: none; }
      .list-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); margin: 0 0 var(--sp-3); }
      .list-bar-title { display: flex; align-items: center; gap: var(--sp-2); margin: 0; font-size: 1.2rem; }
      .list-bar .list-sort { margin: 0; }
      .last-stream { margin: 0.15rem 0 0; color: var(--muted); font-size: 0.85rem; }
      html.dgl-stream .last-stream { display: none; }
      .list-main .rotation-list { margin: 0; }
      .rotation-list li.card-click { transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease; }
      .rotation-list li.card-click:hover { background: var(--row-hover); border-color: var(--accent); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18); }
      .list-sidebar { border: 1px solid var(--border); border-radius: 12px; background: var(--card); padding: var(--sp-3); margin-top: var(--sp-4); }
      .side-head { display: none; }
      .list-sidebar .fandles { margin-top: 0; }
      .list-sidebar .fandles-head p { margin: 0 0 var(--sp-3); font-size: 0.88rem; }
      .list-sidebar .fandles-head h2 { margin: 0 0 var(--sp-1); font-size: 1.15rem; }
      .list-sidebar .fandles-body ul.games { margin-top: 0; }
      .list-sidebar .suggest-panel { margin: 0; border: 0; background: none; }
      .list-sidebar .suggest-panel > summary { padding: 0 0 var(--sp-2); font-size: 1.15rem; }
      .list-sidebar .suggest-body { padding: 0; }
      .suggest-list { gap: var(--sp-1); }
      .suggest-item { padding: 0.4rem 0.55rem; gap: var(--sp-2); flex-wrap: nowrap; }
      .suggest-item:has(.suggest-accept) { flex-wrap: wrap; }
      .suggest-main { flex: 1 1 8rem; }
      .suggest-sub { margin-top: 0.1rem; color: var(--muted); font-size: 0.82rem; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .suggest-more { display: block; width: 100%; min-height: 44px; margin-top: var(--sp-2); background: none; border: 1px dashed var(--border); color: var(--ink); font-weight: 700; }
      .suggest-more:hover { background: var(--bg-soft); }
      .suggest-empty { margin: 0; }
      .list-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); margin: var(--sp-5) 0 var(--sp-3); }
      .list-head h1 { margin: 0; flex: 0 1 auto; min-width: 0; font-size: clamp(1.6rem, 1.1rem + 1.2vw, 2.25rem); line-height: 1.15; overflow-wrap: anywhere; }
      .list-head .twitch-watch { margin: 0; flex: 1 1 100%; }
      .list-head-actions { display: flex; align-items: center; gap: var(--sp-2); position: relative; }
      .list-head-actions > button, .list-head-actions > .btn, .head-more > button { min-height: 44px; white-space: nowrap; }
      .head-more { position: relative; }
      .head-more-menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; min-width: 15rem; display: flex; flex-direction: column; gap: 2px; padding: 0.35rem; border: 1px solid var(--border); border-radius: 10px; background: var(--card); box-shadow: var(--shadow); }
      .head-more-menu > * { display: flex; align-items: center; justify-content: flex-start; width: 100%; min-height: 44px; padding: 0.5rem 0.75rem; border: 0; border-radius: 6px; background: none; color: var(--ink); font: inherit; font-weight: 600; text-align: left; text-decoration: none; cursor: pointer; }
      .head-more-menu > *:hover, .head-more-menu > *:focus-visible { background: var(--bg-soft); color: var(--ink); }
      .list-desc-wrap { margin: 0 0 var(--sp-4); max-width: 75ch; }
      .list-desc { margin: 0; color: var(--muted); line-height: 1.5; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
      .list-desc.expanded { display: block; }
      .list-desc-more { position: relative; padding: 0; margin-top: var(--sp-1); background: none; border: 0; color: var(--primary); font-weight: 700; cursor: pointer; text-decoration: underline; }
      .list-desc-more::after { content: ""; position: absolute; inset: -12px -10px; }
      .list-meta-line { margin: 0 0 var(--sp-3); color: var(--muted); font-size: 0.9rem; }
      .stream-bar, .stream-exit { display: none; }
      @media (min-width: 900px) {
        .list-head .twitch-watch { flex: 0 0 auto; }
        .list-head-actions { margin-left: auto; flex-wrap: nowrap; }
        main.list-page { max-width: 1180px; }
        .list-layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; column-gap: var(--sp-5); align-items: start; }
        .list-sidebar { position: sticky; top: 5rem; max-height: calc(100vh - 6rem); overflow-y: auto; margin-top: 0; }
        .side-head { display: flex; align-items: center; gap: var(--sp-2); margin: calc(var(--sp-1) * -1) 0 var(--sp-3); border-bottom: 1px solid var(--border); }
        .side-tabs { display: flex; flex: 1; min-width: 0; gap: var(--sp-1); }
        .side-tabs [role="tab"] { flex: 1 1 0; min-width: 0; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; padding: 0.4rem 0.3rem; background: none; border: 0; border-bottom: 3px solid transparent; border-radius: 0; color: var(--muted); font-weight: 700; font-size: 0.95rem; white-space: nowrap; cursor: pointer; }
        .side-tabs [role="tab"]:hover { color: var(--ink); }
        .side-tabs [role="tab"][aria-selected="true"] { color: var(--ink); border-bottom-color: var(--brand-blue); }
        .side-ico { display: none; flex: none; }
        html.dgl-sb-collapsed .side-ico { display: block; }
        .side-toggle { flex: none; min-width: 44px; min-height: 44px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: none; border: 0; color: var(--muted); border-radius: 8px; cursor: pointer; }
        .side-toggle:hover { color: var(--ink); background: var(--bg-soft); }
        .side-toggle svg { transition: transform 0.15s ease; }
        .list-layout[data-side="fandles"] .suggest-panel, .list-layout[data-side="suggest"] .fandles { display: none; }
        /* The tab names the section on desktop. */
        .list-sidebar .suggest-panel > summary, .list-sidebar .fandles-head h2 { display: none; }
        .list-main .rotation-list li { padding: 0.8rem 0.95rem; }
        .list-main .game-title { font-size: 1.2rem; }
        .rotation-list .item-main .meta { font-size: 0.9rem; }
        /* Collapsed: a slim rail with the tab icons and their counts. */
        html.dgl-sb-collapsed .list-layout { grid-template-columns: minmax(0, 1fr) 64px; }
        html.dgl-sb-collapsed .list-sidebar { padding: var(--sp-2) 0; overflow: visible; }
        html.dgl-sb-collapsed .list-sidebar .fandles, html.dgl-sb-collapsed .list-sidebar .suggest-panel { display: none !important; }
        html.dgl-sb-collapsed .side-head { flex-direction: column; align-items: stretch; gap: var(--sp-1); margin: 0; border-bottom: 0; }
        html.dgl-sb-collapsed .side-toggle { order: -1; align-self: center; }
        html.dgl-sb-collapsed .side-toggle svg { transform: rotate(180deg); }
        html.dgl-sb-collapsed .side-tabs { flex-direction: column; gap: var(--sp-1); }
        html.dgl-sb-collapsed .side-tabs [role="tab"] { flex-direction: column; gap: 0.2rem; min-height: 56px; border-bottom: 0; border-left: 3px solid transparent; padding: 0.3rem 0; }
        html.dgl-sb-collapsed .side-tabs [role="tab"][aria-selected="true"] { border-left-color: var(--brand-blue); }
        html.dgl-sb-collapsed .side-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      }
      @media (min-width: 1100px) {
        main.list-page { max-width: 1300px; }
        .list-layout { grid-template-columns: minmax(0, 1fr) 340px; }
      }
      @media (min-width: 1400px) {
        main.list-page { max-width: 1480px; }
        .list-layout { grid-template-columns: minmax(0, 1fr) 360px; }
      }
      @media (min-width: 1800px) {
        main.list-page { max-width: 1680px; }
        .list-main .rotation-list li { padding: 0.95rem 1.1rem; }
        .list-main .game-title { font-size: 1.3rem; }
      }
      /* Phones: tabs for the list, Fan-dles and suggestions (the script sets data-tab; without it everything shows). */
      .list-tabs { display: flex; gap: 0.25rem; margin: 1rem 0 0.5rem; border-bottom: 1px solid var(--border); }
      .list-tabs [role="tab"] { flex: 1 1 0; min-width: 0; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; padding: 0.4rem 0.2rem; background: none; border: 0; border-bottom: 3px solid transparent; border-radius: 0; color: var(--muted); font-weight: 700; font-size: 0.92rem; white-space: nowrap; cursor: pointer; }
      .list-tabs [role="tab"][aria-selected="true"] { color: var(--ink); border-bottom-color: var(--brand-blue); }
      /* Narrow phones: the count sits under the name so three tabs never run out of room. */
      @media (max-width: 419px) {
        .list-tabs [role="tab"] { flex-direction: column; gap: 0.15rem; min-height: 52px; padding: 0.35rem 0.1rem; }
      }
      @media (max-width: 359px) { .list-tabs [role="tab"] { font-size: 0.8rem; } }
      @media (min-width: 900px) { .list-tabs { display: none; } }
      @media (max-width: 899px) {
        .list-sidebar { display: contents; }
        .list-layout[data-tab="list"] .fandles, .list-layout[data-tab="list"] .suggest-panel,
        .list-layout[data-tab="fandles"] .list-main, .list-layout[data-tab="fandles"] .suggest-panel,
        .list-layout[data-tab="suggest"] .list-main, .list-layout[data-tab="suggest"] .fandles { display: none; }
        .list-layout[data-tab] .suggest-panel { margin-top: 0; }
        .list-layout[data-tab] .suggest-panel > summary { display: none; }
        .list-layout[data-tab] .fandles { margin-top: 0; }
        .list-bar .list-bar-title { display: none; }
        .list-bar { justify-content: flex-start; }
      }
      /* Stream mode (?view=stream, or the header toggle): large type for a scaled-down capture. No site chrome, no
         sidebar, numbered rows, prominent reset countdowns, and a footer bar with where to suggest and the top suggestions. */
      html.dgl-stream body { background: var(--stream-bg); color: var(--stream-ink); padding-bottom: 5.5rem; }
      html.dgl-stream header.site-header, html.dgl-stream body > footer, html.dgl-stream .skip-link, html.dgl-stream .list-head-actions,
      html.dgl-stream .twitch-watch, html.dgl-stream .list-desc-wrap, html.dgl-stream .list-meta-line, html.dgl-stream .creator-note,
      html.dgl-stream .list-tabs, html.dgl-stream .list-sidebar, html.dgl-stream .list-bar, html.dgl-stream .fandle-notice,
      html.dgl-stream .rotation-list .card-actions, html.dgl-stream .rotation-list .category-pills, html.dgl-stream .rotation-list .meta [data-liked],
      html.dgl-stream #list-reorder-status, html.dgl-stream #toast-stack { display: none !important; }
      html.dgl-stream main, html.dgl-stream main.narrow, html.dgl-stream main.list-page { max-width: none; margin: 0; padding: 1rem clamp(1.25rem, 3vw, 3.5rem) 2rem; }
      html.dgl-stream .list-layout { display: block; }
      html.dgl-stream .list-head { margin: 0 0 0.9rem; }
      html.dgl-stream .list-head h1 { font-size: clamp(2rem, min(3vw, 5vh), 3rem); color: var(--stream-ink); }
      html.dgl-stream .list-head .verified-badge svg { width: 0.8em; height: 0.8em; }
      html.dgl-stream .rotation-list { counter-reset: stream-row; gap: 0.33em; font-size: calc(clamp(1.5rem, min(2.1vw, 3.1vh), 2.4rem) * var(--stream-scale, 1)); }
      @media (min-width: 1100px) {
        html.dgl-stream .rotation-list:has(> li:nth-child(7)) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.33em 0.7em; }
      }
      /* JS layout (fit): column-major grid, rows container capped above the bar and scrolled by script, never the page. */
      html.dgl-stream.dgl-grid .rotation-list#list-items { display: grid; grid-auto-flow: column; grid-template-columns: repeat(var(--stream-cols, 1), minmax(0, 1fr)); grid-template-rows: repeat(var(--stream-rows, 1), auto); align-content: start; gap: 0.33em 0.7em; overflow-y: auto; scrollbar-width: none; }
      html.dgl-stream.dgl-grid .rotation-list#list-items::-webkit-scrollbar { display: none; }
      html.dgl-stream.dgl-lock, html.dgl-stream.dgl-lock body { overflow: hidden; }
      html.dgl-stream.dgl-lock body { padding-bottom: 0; }
      html.dgl-stream.dgl-lock main { padding-bottom: 0; }
      html.dgl-stream .rotation-list li { counter-increment: stream-row; gap: 0.5em; padding: 0.3em 0.7em; border: max(1.5px, 0.09em) solid var(--stream-sep); border-radius: 0.42em; background: var(--stream-row); box-shadow: none; }
      html.dgl-stream .rotation-list li::before { content: counter(stream-row); flex: none; min-width: 2.2ch; font-size: 0.9em; font-weight: 800; line-height: 1; color: var(--stream-accent); font-variant-numeric: tabular-nums; text-align: center; }
      html.dgl-stream .rotation-list li.card-click:hover { background: var(--stream-row); border-color: var(--stream-sep); box-shadow: none; }
      html.dgl-stream .played-count { display: inline-block; align-self: center; padding: 0.15em 0.7em; border: max(1.5px, 0.09em) solid var(--played-ok); border-radius: 999px; color: var(--played-ok); font-size: clamp(1.1rem, min(1.8vw, 3vh), 1.8rem); }
      html.dgl-stream .rotation-list li.stream-played .title-text, html.dgl-stream .rotation-list li.stream-played .item-main .meta { color: var(--stream-done); }
      html.dgl-stream .rotation-list li.stream-played { border-color: var(--played-ok); }
      html.dgl-stream .rotation-list li.stream-played .played-pill { margin: 0 0 0 0.35em; padding: 0; border: 0; font-size: 1.3em; line-height: 1; color: var(--played-ok); }
      html.dgl-stream .rotation-list li.stream-played .pp-text { display: none; }
      html.dgl-stream .rotation-list li.can-mark { cursor: pointer; }
      html.dgl-stream .rotation-list li.reset-bar::after { height: 6px; left: 0.7em; bottom: 0.25em; width: calc((100% - 1.4em) * var(--reset-left, 0)); }
      html.dgl-stream .rotation-list li.reset-bar { padding-bottom: 0.55em; }
      html.dgl-stream .rotation-list .game-title { font-size: 1em; line-height: 1.2; color: var(--stream-ink); text-decoration: none; }
      html.dgl-stream .rotation-list .item-main .meta { margin-top: 0.1em; font-size: 0.75em; font-weight: 800; color: var(--stream-reset); }
      html.dgl-stream .rotation-list .meta > :not([hidden]) ~ :not([hidden])::before { content: none; }
      @keyframes stream-new { 0%, 70% { box-shadow: 0 0 0 4px var(--stream-accent), 0 0 30px 8px var(--stream-accent); border-color: var(--stream-accent); } 100% { box-shadow: 0 0 0 0 transparent, 0 0 0 0 transparent; } }
      html.dgl-stream .rotation-list li.row-new { animation: stream-new 3s ease-out; }
      @media (prefers-reduced-motion: reduce) {
        html.dgl-stream .rotation-list li.row-new { animation: none; border-color: var(--stream-accent); }
      }
      html.dgl-stream .stream-bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem 2.5rem; flex-wrap: wrap; position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; padding: 0.7rem clamp(1.25rem, 3vw, 3.5rem); background: var(--stream-bar); border-top: 4px solid var(--stream-accent); color: var(--stream-ink); }
      html.dgl-stream .stream-cta { margin: 0; color: var(--stream-ink); font-size: clamp(1.2rem, 1.8vw, 1.9rem); }
      html.dgl-stream .stream-cta strong { color: var(--stream-accent); }
      html.dgl-stream .stream-top { display: flex; flex-wrap: wrap; gap: 0.5rem 1.75rem; list-style: none; margin: 0; padding: 0; font-size: clamp(1.1rem, 1.5vw, 1.6rem); font-weight: 700; }
      html.dgl-stream .stream-top:empty { display: none; }
      html.dgl-stream .stream-top li { display: flex; gap: 0.6rem; align-items: baseline; }
      html.dgl-stream .stream-top .st-votes { color: var(--stream-accent); font-variant-numeric: tabular-nums; }
      /* Stream panes: Suggestions and Fan-dles reuse the list's row look in #stream-pane. The switcher is invisible until the mouse moves. */
      .stream-pane-title, #stream-pane, .stream-panes { display: none; }
      html.dgl-stream .stream-pane-title:not(:empty) { display: inline; font-weight: inherit; }
      html.dgl-stream.dgl-pane-alt #list-items { display: none !important; }
      html.dgl-stream.dgl-pane-alt #stream-pane { display: flex; }
      html.dgl-stream.dgl-grid.dgl-pane-alt .rotation-list#stream-pane { display: grid; grid-auto-flow: column; grid-template-columns: repeat(var(--stream-cols, 1), minmax(0, 1fr)); grid-template-rows: repeat(var(--stream-rows, 1), auto); align-content: start; gap: 0.33em 0.7em; overflow-y: auto; scrollbar-width: none; }
      html.dgl-stream.dgl-grid .rotation-list#stream-pane::-webkit-scrollbar { display: none; }
      html.dgl-stream.dgl-pane-suggestions .stream-top { display: none; }
      html.dgl-stream #stream-pane .sp-votes { flex: none; margin-left: auto; padding-left: 0.5em; color: var(--stream-accent); font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
      html.dgl-stream #stream-pane .sp-dev { display: inline-flex; align-items: center; gap: 0.3em; margin-right: 0.6em; padding: 0 0.5em; border: max(1.5px, 0.07em) solid var(--stream-sep); border-radius: 999px; font-weight: 700; color: var(--stream-ink); }
      html.dgl-stream .stream-panes:not([hidden]) { display: flex; position: fixed; top: 0.75rem; right: 22.5rem; z-index: 50; gap: 0; padding: 3px; border: 2px solid var(--stream-sep); border-radius: 999px; background: var(--stream-bar); opacity: 0; pointer-events: none; transition: opacity 0.25s ease; }
      html.dgl-stream .stream-panes.show, html.dgl-stream .stream-panes:has(:focus-visible) { opacity: 1; pointer-events: auto; }
      html.dgl-stream .stream-panes button { min-height: 40px; padding: 0 1.1rem; border: 0; border-radius: 999px; background: transparent; color: var(--stream-ink); font-size: 1rem; font-weight: 700; line-height: 1; cursor: pointer; white-space: nowrap; }
      html.dgl-stream .stream-panes button[hidden] { display: none; }
      html.dgl-stream .stream-panes button[aria-pressed="true"] { background: var(--stream-accent); color: var(--stream-bg); }
      html.dgl-stream .stream-panes button:focus-visible { outline: 3px solid var(--stream-ink); outline-offset: 1px; }
      @media (prefers-reduced-motion: reduce) { html.dgl-stream .stream-panes { transition: none; } }
      html.dgl-stream .stream-exit { display: inline-flex; position: fixed; top: 0.75rem; right: 0.75rem; z-index: 50; min-height: 44px; opacity: 0; transition: opacity 0.15s ease; }
      html.dgl-stream .stream-exit:hover, html.dgl-stream .stream-exit:focus-visible { opacity: 1; }
      html.dgl-stream .stream-settings-btn { right: 11.5rem; white-space: nowrap; }
      html.dgl-stream .stream-settings-btn[aria-expanded="true"] { opacity: 1; }
      .stream-settings, .overlay-panel { display: none; }
      html.dgl-stream .stream-settings:not([hidden]) { display: block; position: fixed; top: 3.6rem; right: 0.75rem; z-index: 55; width: min(26rem, calc(100vw - 1.5rem)); max-height: calc(100vh - 5rem); overflow: auto; padding: 1rem 1.1rem; border: 3px solid var(--stream-sep); border-radius: 14px; background: var(--stream-bar); color: var(--stream-ink); font-size: 1rem; line-height: 1.4; }
      .stream-settings h2 { margin: 0 0 0.4rem; font-size: 1.2rem; }
      .stream-settings h3 { margin: 1rem 0 0.4rem; font-size: 1.05rem; }
      .stream-settings h3 span { font-weight: 400; opacity: 0.8; font-size: 0.9rem; }
      .stream-settings .ss-note { margin: 0 0 0.7rem; font-size: 0.85rem; opacity: 0.85; }
      .stream-settings label { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin: 0.4rem 0; }
      .stream-settings label.ss-check { justify-content: flex-start; }
      .stream-settings select, .stream-settings input[type="number"] { width: 9.5rem; min-height: 2.2rem; }
      .stream-settings .ss-url { display: flex; gap: 0.5rem; margin-top: 0.6rem; }
      .stream-settings .ss-url input { flex: 1; min-width: 0; min-height: 2.4rem; font-size: 0.85rem; }
      .stream-settings .ss-copy { min-height: 2.4rem; }
      /* Overlay (?view=overlay): transparent page, one dark panel (same in both themes) readable on any background. */
      html.dgl-overlay, html.dgl-overlay body { background: transparent !important; overflow: hidden; color-scheme: normal; }
      html.dgl-overlay header.site-header, html.dgl-overlay body > footer, html.dgl-overlay .skip-link, html.dgl-overlay #toast-stack,
      html.dgl-overlay main > *:not(.overlay-panel) { display: none !important; }
      html.dgl-overlay main, html.dgl-overlay main.narrow, html.dgl-overlay main.list-page { background: transparent; max-width: none; margin: 0; padding: 0; }
      html.dgl-overlay .overlay-panel { display: block; position: fixed; z-index: 60; width: max-content; max-width: min(36rem, calc(100vw - 2rem)); padding: 0.8rem 1.1rem; border: 2px solid rgba(255, 255, 255, 0.22); border-radius: 14px; background: rgba(10, 10, 14, 0.82); color: #fff; font-size: clamp(1.1rem, 1.7vw, 1.7rem); font-weight: 700; line-height: 1.3; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9), 0 0 8px rgba(0, 0, 0, 0.6); }
      html.dgl-overlay.dgl-pos-bl .overlay-panel { left: 1rem; bottom: 1rem; }
      html.dgl-overlay.dgl-pos-br .overlay-panel { right: 1rem; bottom: 1rem; }
      html.dgl-overlay.dgl-pos-tl .overlay-panel { left: 1rem; top: 1rem; }
      html.dgl-overlay.dgl-pos-tr .overlay-panel { right: 1rem; top: 1rem; }
      .overlay-panel p, .overlay-panel li { margin: 0; color: #fff; }
      .overlay-panel .ov-title { font-size: 0.8em; opacity: 0.85; text-transform: uppercase; letter-spacing: 0.04em; }
      .overlay-panel .ov-cta strong { color: #38bdf8; }
      .overlay-panel .ov-top { list-style: none; margin: 0.5rem 0 0; padding: 0; font-size: 0.85em; }
      .overlay-panel .ov-top:empty { display: none; }
      .overlay-panel .ov-top li { display: flex; justify-content: space-between; gap: 1.2rem; align-items: baseline; }
      .overlay-panel .st-votes { color: #38bdf8; font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
      .overlay-panel .ov-new { margin-top: 0.5rem; padding: 0.3rem 0.6rem; border-radius: 8px; font-size: 0.85em; color: #fde047; box-shadow: 0 0 0 2px #38bdf8, 0 0 18px 2px #38bdf8; }
      .game-search-selected { margin-top: 0.4rem; font-size: 0.9rem; color: var(--muted); }
      .game-search-selected button { background: none; border: none; color: var(--accent); cursor: pointer; text-decoration: underline; font-size: inherit; padding: 0; }
      #toast-stack {
        position: fixed;
        right: 1rem;
        bottom: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        z-index: 99;
      }
      .vote-prompt { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.6rem 0.8rem; border: 1px solid var(--border); border-radius: 10px; background: var(--card); color: var(--ink); font-weight: 600; box-shadow: var(--shadow); animation: vote-prompt-in 0.2s ease-out; }
      .vote-prompt:not(.inline) { position: fixed; left: 1rem; right: 1rem; bottom: 1rem; max-width: 420px; margin: 0 auto; z-index: 98; }
      .vote-prompt.inline { list-style: none; margin: 0.4rem 0; }
      .vote-prompt-text { flex: 1 1 100%; }
      .vote-prompt-btn, .vote-prompt-skip { min-height: 44px; min-width: 44px; padding: 0.35rem 0.8rem; border: 1px solid var(--control-border); border-radius: 8px; background: transparent; color: var(--ink); font: inherit; cursor: pointer; }
      .vote-prompt-skip { border-color: transparent; color: var(--muted); text-decoration: underline; }
      .vote-prompt button:focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 2px; }
      @keyframes vote-prompt-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .vote-prompt { animation: none; } }
      .toast {
        min-width: 220px;
        max-width: 320px;
        border-radius: 10px;
        padding: 0.7rem 0.8rem;
        border: 1px solid var(--border);
        background: var(--card);
        box-shadow: var(--shadow);
        color: var(--ink);
        font-weight: 600;
      }
      .toast { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
      .toast-action { background: none; border: 0; padding: 0.35rem 0.5rem; margin: -0.35rem -0.4rem -0.35rem 0; min-height: 44px; color: var(--brand-blue); font: inherit; font-weight: 800; cursor: pointer; }
      li[data-hide-id] { transition: opacity 0.25s ease, transform 0.25s ease; }
      li[data-hide-id].hiding { opacity: 0; transform: scale(0.97); pointer-events: none; }
      .daily-progress { margin: 0 0 1rem; padding: 0.7rem 0.85rem; border: 1px solid var(--border); border-radius: 10px; background: var(--card); display: grid; grid-template-columns: 1fr auto; gap: 0.5rem 0.75rem; align-items: center; }
      .daily-progress-head { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 0.3rem 0.8rem; align-items: baseline; font-weight: 700; color: var(--ink); }
      .daily-streak { color: var(--brand-blue); font-weight: 800; }
      .daily-progress-bar { height: 8px; border-radius: 999px; background: var(--border); overflow: hidden; }
      .daily-progress-bar span { display: block; height: 100%; width: 0; border-radius: inherit; background: var(--brand-blue); transition: width 0.3s ease; }
      .daily-progress .btn { min-height: 44px; }
      .daily-soon { grid-column: 1 / -1; margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.75rem; font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
      .daily-soon[hidden] { display: none; }
      .daily-soon-play { color: var(--brand-blue); text-decoration: underline; font-weight: 800; padding: 0.55rem 0.5rem; margin: -0.55rem -0.5rem; }
      .daily-done { color: var(--muted); font-weight: 600; }
      .daily-strip { margin: 0 0 1.25rem; }
      .daily-strip-link { position: relative; color: var(--brand-blue); font-weight: 700; margin-left: auto; }
      .daily-strip-link::after { content: ""; position: absolute; inset: -0.8rem -0.4rem; }
      .daily-strip .daily-progress-head { align-items: center; }
      /* Home page game of the day, below the rotation strip. */
      .game-of-the-day { margin: 0 0 1.25rem; padding: 0.9rem 1rem; border: 1px solid var(--border); border-radius: 12px; background: var(--card); }
      .gotd-kicker { margin: 0; color: var(--brand-blue); font-size: 0.8rem; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; }
      .game-of-the-day h2.gotd-title { margin: 0.25rem 0 0.35rem; font-size: 1.35rem; overflow-wrap: anywhere; }
      .gotd-title a { color: var(--title-ink); text-decoration: none; }
      .gotd-title a:hover { text-decoration: underline; }
      .gotd-desc { margin: 0 0 0.5rem; color: var(--muted); }
      .game-of-the-day .category-pills { margin: 0 0 0.25rem; }
      .gotd-past { font-size: 0.9rem; }
      .daily-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
      .daily-item { padding: 0.8rem 1rem; border: 1px solid var(--border); border-radius: 12px; background: var(--card); }
      .daily-item h2 { margin: 0.2rem 0 0.35rem; font-size: 1.15rem; overflow-wrap: anywhere; }
      .daily-item time { color: var(--muted); font-size: 0.85rem; font-weight: 700; }
      .daily-nav { display: flex; gap: 1rem; margin-top: 1rem; }
      .gotd-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 0.75rem; margin-top: 0.6rem; }
      .gotd-meta { color: var(--muted); font-size: 0.95rem; }
      .game-of-the-day .btn-play { font-size: 1rem; padding: 0.6rem 1rem; }
      @media (max-width: 480px) { .gotd-foot .btn-play { width: 100%; } }
      .stats-card { margin: 0 0 1rem; padding: 0.6rem 0.85rem; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
      .stats-card summary { cursor: pointer; font-weight: 600; font-size: 1rem; }
      .stats-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.5rem; margin-top: 0.6rem; }
      .stat-tile { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; padding: 0.5rem 0.6rem; border: 1px solid var(--border); border-radius: 8px; }
      .stat-tile strong { font-size: 1.05rem; overflow-wrap: anywhere; }
      .stat-tile span { color: var(--muted); font-size: 0.8rem; }
      .stats-link { margin: 0.6rem 0 0; font-size: 0.9rem; }
      .recap-nav { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin: 0 0 1rem; }
      .recap-nav h2 { margin: 0; font-size: 1.2rem; text-align: center; }
      .recap .panel, .recap .stats-tiles, .recap .heatmap { margin-bottom: 1rem; }
      .recap-delta { color: var(--brand-blue) !important; }
      .recap-cal-head, .recap-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; max-width: 420px; }
      .recap-cal-head { color: var(--muted); font-size: 0.75rem; text-align: center; margin-bottom: 3px; }
      .recap-day { display: flex; align-items: center; justify-content: center; font-size: 0.8rem; color: var(--ink); }
      .recap-day[data-level="3"], .recap-day[data-level="4"] { color: #fff; }
      .new-in-cats { margin: 0 0 1rem; }
      .new-in-cats[hidden] { display: none !important; }
      .new-in-cats h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
      .heatmap { margin: 0 0 1rem; padding: 0.7rem 0.85rem; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
      .heatmap h2 { margin: 0 0 0.5rem; font-size: 1rem; }
      .heatmap-grid { display: grid; grid-template-columns: repeat(12, 1fr); grid-template-rows: repeat(7, auto); grid-auto-flow: column; gap: 3px; width: 100%; max-width: 300px; }
      .heat-cell { aspect-ratio: 1; border-radius: 3px; background: var(--heat-0); }
      .heat-cell[data-level="1"] { background: var(--heat-1); }
      .heat-cell[data-level="2"] { background: var(--heat-2); }
      .heat-cell[data-level="3"] { background: var(--heat-3); }
      .heat-cell[data-level="4"] { background: var(--heat-4); }
      .heat-cell.heat-future { visibility: hidden; }
      .heatmap-legend { display: flex; align-items: center; gap: 3px; margin-top: 0.5rem; color: var(--muted); font-size: 0.8rem; }
      .heatmap-legend .heat-cell { width: 12px; height: 12px; aspect-ratio: auto; }
      .heatmap-legend span:first-child { margin-right: 0.3rem; }
      .heatmap-legend span:last-child { margin-left: 0.3rem; }
      .reminder-opt { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.9rem; margin: 0 0 1rem; }
      .reminder-opt label { display: inline-flex; align-items: center; gap: 0.5rem; min-height: 44px; cursor: pointer; }
      .reminder-opt input[type="checkbox"] { width: 1.15rem; height: 1.15rem; }
      .reminder-opt select { min-height: 44px; padding: 0 0.5rem; border: 1px solid var(--control-border); border-radius: 8px; background: var(--bg-soft); color: var(--ink); font: inherit; }
      .search-suggest { display: none; position: absolute; top: calc(100% + 4px); right: 0; width: max(100%, 300px); z-index: 20; max-height: 70vh; overflow-y: auto; background: var(--card); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 0.25rem; }
      .search-suggest.open { display: block; }
      .search-suggest a { display: flex; align-items: center; min-height: 44px; padding: 0.35rem 0.65rem; border-radius: 8px; color: var(--ink); text-decoration: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .search-suggest a:hover, .search-suggest a.active { background: var(--bg-soft); }
      .search-suggest a.active { outline: 2px solid var(--brand-blue); outline-offset: -2px; }
      @media (max-width: 480px) { .daily-progress { grid-template-columns: 1fr; } .daily-progress .btn { width: 100%; } }
      /* Keyboard shortcuts dialog (layout()) and the footer button that opens it. */
      .shortcuts-dialog { width: min(26rem, calc(100vw - 2rem)); max-width: calc(100vw - 2rem); padding: 1.1rem 1.2rem; border: 1px solid var(--border); border-radius: 14px; background: var(--card); color: var(--ink); box-shadow: var(--shadow); }
      .shortcuts-dialog::backdrop { background: rgba(0, 0, 0, 0.55); }
      .shortcuts-dialog h2 { margin: 0 0 0.6rem; font-size: 1.2rem; }
      .shortcut-list { margin: 0; }
      .shortcut-list > div { display: grid; grid-template-columns: minmax(7.5rem, max-content) minmax(0, 1fr); gap: 0.4rem 0.8rem; align-items: center; padding: 0.4rem 0; border-bottom: 1px solid var(--border); }
      .shortcut-list > div[hidden] { display: none; }
      .shortcut-list dt, .shortcut-list dd { margin: 0; }
      .shortcut-note { color: var(--muted); font-size: 0.9rem; margin: 0.75rem 0 0; }
      .shortcuts-dialog kbd { display: inline-block; min-width: 1.6rem; padding: 0.1rem 0.4rem; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 6px; background: var(--bg-soft); color: var(--ink); font: 700 0.9rem/1.4 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; text-align: center; }
      .shortcuts-dialog .actions { margin-top: 0.9rem; display: flex; justify-content: flex-end; }
      .footer-button { background: none; border: 0; padding: 0; color: var(--accent); font: inherit; text-decoration: underline; cursor: pointer; }
      .hide-btn { display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
      .hide-btn svg { width: 1.05rem; height: 1.05rem; }
      .hide-btn .i-show { display: none; }
      .game-row .compact-actions > .hide-btn { min-width: 2.15rem; padding-left: 0.5rem; padding-right: 0.5rem; }
      .hidden-games-list { list-style: none; padding: 0; margin: 0 0 0.8rem; display: flex; flex-direction: column; gap: 0.4rem; }
      .hidden-games-list li { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
      .hidden-games-list button { min-height: 44px; padding: 0.4rem 0.8rem; }
      .hidden-toggle { text-align: center; margin: 1.5rem 0 0; }
      .hidden-toggle button { background: none; border: 0; padding: 0.6rem 0.8rem; min-height: 44px; color: var(--muted); font: inherit; text-decoration: underline; cursor: pointer; }
      .toast.success { border-color: #666666; }
      .toast.error { border-color: #cc6666; }
      form { display:flex; gap: 0.6rem; flex-wrap:wrap; margin-bottom: 1rem; }
      input, select, button {
        padding: 0.5rem;
        border-radius: 7px;
        border: 1px solid var(--control-border);
        background: var(--bg-soft);
        color: var(--ink);
      }
      input::placeholder, textarea::placeholder { color: var(--placeholder); }
      button {
        background: var(--bg-soft);
        color: var(--ink);
        border: 1px solid var(--control-border);
        cursor: pointer;
      }
      a { color: var(--accent); }
      p { color: var(--muted); }
      /* Keyboard focus: a clear ring everywhere. Tappable cards ring the whole card, since their link is stretched over it. */
      :focus-visible { outline: 2px solid var(--brand-blue); outline-offset: 2px; }
      .card-click .card-link:focus-visible { outline: none; }
      .card-click:has(.card-link:focus-visible) { outline: 2px solid var(--brand-blue); outline-offset: 2px; border-radius: 12px; }
      .intro { color: var(--ink); font-size: 1.05rem; line-height: 1.5; margin: 0.25rem 0 1rem; }
      @media (min-width: 701px) { .intro { max-width: 62ch; margin-left: auto; margin-right: auto; text-align: center; } }
      .page-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.5rem 1rem; margin-bottom: 0.75rem; }
      .page-head h1 { margin: 0; }
      .page-head .actions { margin: 0; }
      /* Fixed column counts: an auto-fill grid inside a fieldset in a column flex form makes the fieldset twice as tall as its content. */
      .check-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 0.5rem; }
      @media (min-width: 520px) { .check-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
      .check input[type="checkbox"], .check input[type="radio"] { flex: none; }
      .check-grid .check { margin-right: 0; min-width: 0; overflow-wrap: anywhere; }
      /* A label wrapping a field: the name above the field, not squeezed beside it. */
      .stack-form > label:has(> input:not([type="checkbox"]):not([type="radio"]), > textarea, > select) { display: flex; flex-direction: column; gap: 0.25rem; }
      .reset-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.6rem 0.75rem; }
      .reset-grid label { display: flex; flex-direction: column; gap: 0.25rem; }
      .reset-grid label[hidden] { display: none; }
      form.filter-form { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; max-width: 40rem; }
      .admin-fold > summary { cursor: pointer; font-weight: 700; padding: 0.4rem 0; }
      .admin-fold[open] > summary { margin-bottom: 0.75rem; }
      .btn-play { font-size: 1.1rem; padding: 0.8rem 1.4rem; }
      /* Game page: votes and favorite in one row under the Play button, score and reset time beneath. */
      .game-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0.25rem 0 0.5rem; }
      .game-actions button { min-height: 44px; min-width: 4.2rem; font-size: 1rem; }
      .game-meta { color: var(--muted); font-size: 0.95rem; margin: 0.25rem 0; }
      /* The long "Resets daily at 4:00 PM · next in 15h 54m" must be able to wrap, or it pushes the page wider than a phone. */
      .game-meta > * { white-space: normal; }
      .game-actions-note { color: var(--muted); font-size: 0.9rem; margin: 0.25rem 0 0; }
      /* Game page: Play and the "Mark as played" toggle share a row (the toggle drops below Play on phones). */
      .play-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin: 0 0 0.5rem; }
      .played-toggle { min-height: 44px; font-size: 1rem; background: var(--bg-soft); color: var(--ink); border-color: var(--border); }
      .played-toggle.is-played { color: var(--brand-blue); border-color: var(--brand-blue); }
      #game-action-status:empty { margin: 0; }
      .report-panel > summary { cursor: pointer; font-weight: 700; }
      .report-panel[open] > summary { margin-bottom: 0.75rem; }
      .game-facts { margin-top: 1.5rem; }
      .game-faq { margin-top: 1.5rem; }
      .game-faq h3 { font-size: 1rem; margin: 1rem 0 0.25rem; }
      .game-faq p { margin: 0; color: var(--muted); }
      .related-categories { margin-top: 1.5rem; }
      .category-index { list-style: none; padding: 0; margin: 1rem 0 0; display: grid; gap: 0.75rem; }
      .category-index .panel h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
      .category-index .panel p { margin: 0.25rem 0; }
      .category-index-top { color: var(--muted); overflow-wrap: anywhere; }
      .pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 0.25rem 0.75rem; margin: 1.25rem 0; }
      .pagination [aria-current] { font-weight: 700; }
      .game-facts dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.45rem 1rem; margin: 0.75rem 0 0; }
      .game-facts dt { color: var(--muted); }
      .game-facts dd { margin: 0; }
      @media (max-width: 480px) { .game-facts dl { grid-template-columns: 1fr; gap: 0.15rem; } .game-facts dd { margin-bottom: 0.5rem; } }
      .related-games ul { columns: 2; padding-left: 1.2rem; }
      .related-games li { margin-bottom: 0.4rem; }
      .empty-state { text-align: center; padding: 1.5rem 1rem; border: 1px dashed var(--border); border-radius: 12px; }
      .rotation-list li.empty-state { display: block; }
      .empty-state p { margin-top: 0; }
      form.game-filters { flex-direction: column; flex-wrap: nowrap; align-items: stretch; }
      .search-row { display: flex; gap: 0.5rem; }
      .search-row input { flex: 1; min-width: 0; max-width: 420px; }
      /* Phones: the field gets its own row, and Search and Surprise me share the next. */
      @media (max-width: 480px) { .search-row { flex-wrap: wrap; } .search-row input { flex-basis: 100%; max-width: none; } .search-row button { flex: 1 1 0; } }
      .filters > summary { display: none; }
      .filters-body { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; }
      @media (max-width: 700px) {
        header.site-header { padding: 0.6rem 0.75rem; gap: 0.7rem; }
        .brand { font-size: 1.1rem; margin-right: 0; }
        .site-nav { gap: 0.7rem; }
        .site-nav a { font-size: 0.95rem; }
        .nav-extra, .account-desktop, .header-tools > .theme-toggle, .label-long { display: none; }
        .nav-menu { display: block; }
        /* Small buttons in cards and rows get an invisible margin that makes the tap target about 46px tall. */
        .compact-actions button, .compact-actions .btn-details, .card-actions button, .card-actions .btn-details { position: relative; min-height: 30px; }
        .compact-actions button::after, .compact-actions .btn-details::after, .card-actions button::after, .card-actions .btn-details::after { content: ""; position: absolute; inset: -9px -2px; }
        .compact-actions .hide-btn { padding-left: 0.6rem; padding-right: 0.6rem; }
        .compact-actions .hide-btn::after { inset: -9px -5px; }
        .compact-actions, .card-actions { gap: 0.3rem; }
        /* Game cards: when the name and the buttons don't both fit on the first line (long titles on 320-400px phones),
           the buttons drop to their own line instead of squeezing the name into a sliver or pushing the card wider than the screen. */
        .game-top { flex-wrap: wrap; row-gap: 0.4rem; }
        .game-name { flex: 1 1 auto; }
        .game-row .compact-actions { flex-wrap: wrap; max-width: 100%; }
        /* List and rotation rows on phones: the name, then "% liked · Resets in" across the full width, then the
           category pills with the buttons beside them (the buttons drop below the pills only if both don't fit). */
        .rotation-list li:not(.empty-state) { flex-wrap: wrap; row-gap: 0.4rem; column-gap: 0.5rem; }
        .rotation-list li > .item-main { display: contents; }
        .rotation-list li > .item-main > a { order: 1; flex: 1 1 calc(100% - 2.5rem); min-width: 0; }
        .rotation-list li > .item-main > .meta { order: 2; flex: 1 1 100%; }
        /* The pills take whatever width the buttons leave and wrap inside it, so a long set of pills never pushes the buttons onto their own line. */
        .rotation-list li > .item-main > .category-pills { order: 3; flex: 1 1 7rem; min-width: 0; }
        .rotation-list li > .item-main .category-pill { white-space: nowrap; }
        .rotation-list li > .card-actions { order: 4; align-self: flex-start; }
        /* Rows with a drag handle: line the details up under the name rather than under the handle. */
        .rotation-list li:has(> .drag) > .item-main > .meta, .rotation-list li:has(> .drag) > .item-main > .category-pills { padding-left: calc(var(--drag-width, 1rem) + 0.5rem); }
        .actions button, .actions .btn { min-height: 44px; }
        .home-actions .btn { font-size: 0.85rem; padding: 0.55rem 0.3rem; }
        .btn-play { display: block; text-align: center; }
        .play-row .btn-play, .play-row .played-toggle { flex: 1 1 100%; }
        .related-games ul { columns: 1; }
        .filters > summary { display: list-item; cursor: pointer; font-weight: 600; padding: 0.4rem 0; }
        .filters-body select { flex: 1 1 45%; }
      }
      /* Narrow phones: Submit moves from the header row into the menu so the row never overlaps. */
      @media (max-width: 369px) {
        .actions.home-actions { grid-template-columns: 1fr; max-width: 260px; }
      }
      @media (max-width: 400px) {
        .site-nav a[href="/submit"] { display: none; }
        .nav-menu-panel > a.menu-narrow-only { display: block; }
      }
      #game-results[aria-busy="true"] { opacity: 0.55; transition: opacity 0.15s; }
      .game-count { text-align: center; color: var(--muted); font-size: 1.05rem; font-weight: 400; letter-spacing: normal; line-height: 1.5; margin: 0.25rem 0 0.9rem; }
      .list-index li { margin-bottom: 0.7rem; }
      .list-index .muted { color: var(--muted); }
      .game-count strong { color: var(--brand-blue); font-size: 1.6rem; font-weight: 800; font-variant-numeric: tabular-nums; margin-right: 0.2rem; }
      /* Big screens: larger cards and text, with the name and the buttons on one row and the details beneath. */
      @media (min-width: 1200px) {
        ul.games { grid-template-columns: repeat(auto-fill, minmax(min(420px, 100%), 1fr)); gap: 1rem; }
        ul.games.compact li { padding: 0.95rem 1.05rem; border-radius: 14px; }
        ul.games.compact li.reset-bar { padding-bottom: calc(0.95rem + 6px); }
        .game-row { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto 1fr; grid-template-areas: "name actions" "sub sub"; column-gap: 0.9rem; row-gap: 0.45rem; align-items: start; }
        .game-top { display: contents; }
        .game-name { grid-area: name; padding-top: 0; }
        .game-sub { grid-area: sub; }
        .game-row .compact-actions { grid-area: actions; display: flex; flex-wrap: nowrap; gap: 0.35rem; }
        .game-row .compact-actions > * { display: inline-flex; align-items: center; justify-content: center; gap: 0.3rem; height: 2.15rem; min-width: 3.4rem; font-size: 0.95rem; padding: 0 0.6rem; }
        ul.games .game-title { font-size: 1.3rem; }
        .game-sub .tag { font-size: 0.85rem; padding: 0.15rem 0.5rem; }
        .game-row .meta { font-size: 0.9rem; }
      }
      /* Phone tap targets, last so it wins over the rules above: everything tappable reaches 44px. */
      @media (max-width: 700px) {
        /* Header, menu and footer links: the same look, but the tappable box reaches 44px. */
        .brand, .site-nav a { display: inline-flex; align-items: center; min-height: 44px; }
        .nav-menu > summary { min-height: 44px; }
        .nav-menu-panel > a, .nav-menu-panel button { min-height: 44px; display: flex; align-items: center; }
        footer a { position: relative; }
        footer a::after { content: ""; position: absolute; inset: -1.15rem -0.5rem; }
        footer .footer-button { position: relative; }
        footer .footer-button::after { content: ""; position: absolute; inset: -1.15rem -0.5rem; }
        /* Fields: 44px tall, and 16px text so iOS doesn't zoom the page on focus. */
        input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, textarea { min-height: 44px; font-size: 16px; }
        textarea { min-height: 5.5rem; }
        .stack-form button[type="submit"], .search-row button, form.game-filters button, form.filter-form button, .actions button { min-height: 44px; }
        /* Checkboxes and radios: a bigger box, and the whole label row is the tap target. */
        input[type="checkbox"], input[type="radio"] { width: 20px; height: 20px; }
        .check { min-height: 44px; }
        /* Category pills: slightly taller, plus an invisible margin like the buttons in cards. */
        .category-pill, .game-sub .tag.category-pill, button.tag.pill-more { position: relative; padding-top: 0.25rem; padding-bottom: 0.25rem; }
        .category-pill::after, .pill-more::after { content: ""; position: absolute; inset: -11px -2px; }
        /* "Similar daily games" links on game pages. */
        .related-games li { margin-bottom: 0; }
        .related-games li a { display: inline-block; padding: 0.85rem 0; }
        .game-facts summary, .report-panel > summary { min-height: 44px; display: flex; align-items: center; }
        /* Also: the Filters toggle, pagination, big buttons, and the pills in list and rotation rows. */
        .filters > summary { min-height: 44px; display: flex; align-items: center; }
        .pagination a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 0.5rem; }
        .btn { min-height: 44px; }
        .rotation-list .item-main .category-pill, .suggest-main .category-pill { padding-top: 0.25rem; padding-bottom: 0.25rem; }
      }
      /* Reduced motion: animations and transitions end at once. Their end events still fire, and the timers in the
         scripts don't depend on them, so hidden cards and removed rows still go. */
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
          scroll-behavior: auto !important;
        }
      }`;

// Reports uncaught errors to POST /api/client-errors with sendBeacon (no CSRF header possible). Same-origin scripts only,
// deduped by message+line, max 5 per page load. Mirrored (smaller) in src/lib/embed.ts.
export const ERROR_REPORT_SCRIPT = `      (() => {
        const seen = {};
        let sent = 0;
        const report = (message, source, line, col, stack) => {
          try {
            if (sent >= 5 || !navigator.sendBeacon) return;
            const o = location.origin;
            if (!source || source.indexOf(o) !== 0) return;
            const path = source.slice(o.length).split(/[?#]/)[0];
            message = String(message || "").slice(0, 500);
            if (!message || message === "Script error.") return;
            const key = message + "|" + path + "|" + line;
            if (seen[key]) return;
            seen[key] = 1;
            sent++;
            navigator.sendBeacon("/api/client-errors", JSON.stringify({ message, source: path, line: line | 0, col: col | 0, stack: String(stack || "").slice(0, 1500), page: location.pathname, version: window.DGL_VERSION || "" }));
          } catch (e) {}
        };
        window.addEventListener("error", (e) => report(e.message, e.filename || location.href, e.lineno, e.colno, e.error && e.error.stack));
        window.addEventListener("unhandledrejection", (e) => {
          const r = e.reason;
          const stack = r && r.stack ? String(r.stack) : "";
          const m = stack.match(/(https?:\\/\\/[^\\s)]+?):(\\d+):(\\d+)/);
          report("Unhandled rejection: " + (r && r.message ? r.message : String(r)), m ? m[1] : location.href, m ? m[2] : 0, m ? m[3] : 0, stack);
        });
      })()`;

// Same-origin mutating fetches carry the double-submit CSRF token. Loaded in <head> (head.js) so it is installed before
// any page script runs (app.js loads last and, uncached on a first visit, after setTimeout(0) callbacks). A new
// visitor's cookie may not be there yet: fetch /api/me/session (no-store, sets the cookie) first, and retry once on a CSRF 403.
export const CSRF_FETCH_SCRIPT = `      (() => {
        const readToken = () => {
          for (const raw of document.cookie.split(";")) {
            const part = raw.trim();
            if (part.startsWith("csrf_token=")) return decodeURIComponent(part.slice(11));
          }
          return "";
        };
        const originalFetch = window.fetch.bind(window);
        let pending = null;
        const refresh = () => originalFetch("/api/me/session", { credentials: "same-origin", cache: "no-store" }).catch(() => null);
        const ensureToken = () => {
          if (readToken()) return Promise.resolve();
          if (!pending) pending = refresh().then(() => { pending = null; });
          return pending;
        };
        window.fetch = async (input, init = {}) => {
          const isRequest = typeof input !== "string" && !(input instanceof URL);
          const requestUrl = isRequest ? input.url : input.toString();
          const method = String((init && init.method) || (isRequest ? input.method : "GET") || "GET").toUpperCase();
          const sameOrigin = requestUrl.startsWith("/") || requestUrl.startsWith(window.location.origin);
          if (!sameOrigin || method === "GET" || method === "HEAD" || method === "OPTIONS") {
            return originalFetch(input, init);
          }
          const send = () => {
            const headers = new Headers((init && init.headers) || (isRequest ? input.headers : undefined));
            const token = readToken();
            if (token) headers.set("x-csrf-token", token);
            return originalFetch(isRequest ? input.clone() : input, { ...init, headers, credentials: "same-origin" });
          };
          await ensureToken();
          const response = await send();
          if (response.status !== 403) return response;
          let invalid = false;
          try { invalid = (await response.clone().json()).error === "Invalid CSRF token"; } catch (e) {}
          if (!invalid) return response;
          await refresh();
          return send();
        };
      })();
`;

// Header search, theme toggle, toasts, share buttons (end of <body> on every page).
export const LAYOUT_SCRIPT = `      (() => {
        const buttons = document.querySelectorAll("[data-theme-toggle]");
        const root = document.documentElement;
        const render = () => buttons.forEach((btn) => { btn.textContent = root.dataset.theme === "light" ? "\u{1F319}" : "\u2600\uFE0F"; });
        buttons.forEach((btn) => btn.addEventListener("click", () => {
          const next = root.dataset.theme === "light" ? "dark" : "light";
          if (next === "light") root.dataset.theme = "light"; else delete root.dataset.theme;
          try { localStorage.setItem("dgl_theme", next); } catch (e) {}
          render();
        }));
        render();

        // Search: on narrow screens the icon opens the field over the header; Escape or the close button puts it away.
        const siteHeader = document.querySelector(".site-header");
        const searchInput = document.getElementById("header-search-input");
        const searchToggle = document.getElementById("search-toggle");
        const setSearch = (open) => {
          if (!siteHeader || !searchInput) return;
          siteHeader.classList.toggle("searching", open);
          if (searchToggle) searchToggle.setAttribute("aria-expanded", String(open));
          if (open) { if (menu) menu.open = false; searchInput.focus(); searchInput.select(); }
          else if (searchToggle && searchToggle.offsetParent !== null) searchToggle.focus();
        };
        if (searchInput && location.pathname === "/games") searchInput.value = new URLSearchParams(location.search).get("q") || "";
        searchToggle?.addEventListener("click", () => setSearch(true));
        document.getElementById("header-search-close")?.addEventListener("click", () => setSearch(false));
        // Typeahead: from 2 characters, up to 8 matching games (prefix matches first) from GET /api/games/titles,
        // fetched on first focus. Combobox pattern: arrows move, Enter opens the highlighted game, Escape closes.
        const suggestBox = document.getElementById("header-search-list");
        if (searchInput && suggestBox) {
          let titles = null;
          let loadingTitles = null;
          let shown = [];
          let active = -1;
          let timer = 0;
          const loadTitles = () => {
            if (titles) return Promise.resolve();
            try {
              const saved = JSON.parse(sessionStorage.getItem("dgl_titles_v1") || "null");
              if (saved && Array.isArray(saved.games)) { titles = saved.games; return Promise.resolve(); }
            } catch (e) {}
            if (!loadingTitles) {
              loadingTitles = fetch("/api/games/titles").then((r) => (r.ok ? r.json() : Promise.reject())).then((data) => {
                titles = (data.games || []).map((g) => ({ slug: g.slug, title: g.title, lower: String(g.title).toLowerCase() }));
                try { sessionStorage.setItem("dgl_titles_v1", JSON.stringify({ games: titles })); } catch (e) {}
              }).catch(() => { loadingTitles = null; });
            }
            return loadingTitles;
          };
          const closeSuggest = () => {
            suggestBox.classList.remove("open");
            suggestBox.replaceChildren();
            shown = [];
            active = -1;
            searchInput.setAttribute("aria-expanded", "false");
            searchInput.removeAttribute("aria-activedescendant");
          };
          const setActive = (index) => {
            active = index;
            shown.forEach((node, i) => {
              node.classList.toggle("active", i === index);
              node.setAttribute("aria-selected", String(i === index));
            });
            if (index >= 0) {
              searchInput.setAttribute("aria-activedescendant", shown[index].id);
              shown[index].scrollIntoView({ block: "nearest" });
            } else searchInput.removeAttribute("aria-activedescendant");
          };
          // Typo fallback (same rule as the server's search): optimal string alignment distance on the title and its words.
          const editDistance = (a, b) => {
            const rows = [];
            for (let j = 0; j <= b.length; j++) rows[j] = j;
            let prev2 = null;
            let prev = rows;
            for (let i = 1; i <= a.length; i++) {
              const cur = [i];
              for (let j = 1; j <= b.length; j++) {
                let best = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
                if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, prev2[j - 2] + 1);
                cur[j] = best;
              }
              prev2 = prev;
              prev = cur;
            }
            return prev[b.length];
          };
          const similarTitles = (q, list, skip) => {
            const query = q.replace(/[^a-z0-9\\u0080-\\uffff]+/g, "");
            const found = [];
            if (query.length < 3) return found;
            for (const game of list) {
              if (skip.includes(game)) continue;
              if (!game.compact) {
                game.compact = game.lower.replace(/[^a-z0-9\\u0080-\\uffff]+/g, "");
                game.words = game.lower.split(/[^a-z0-9\\u0080-\\uffff]+/).filter(Boolean);
              }
              const t = game.compact;
              // Only titles of a similar length or with the same first letter are worth the distance check.
              if (!t || (Math.abs(t.length - query.length) > 3 && t[0] !== query[0])) continue;
              const limit = Math.max(1, Math.floor(t.length / 4));
              let distance = editDistance(query, t);
              for (const word of game.words) if (distance > limit) distance = Math.min(distance, editDistance(query, word));
              if (distance <= limit) found.push({ game, distance });
            }
            found.sort((a, b) => a.distance - b.distance || a.game.title.localeCompare(b.game.title));
            return found.map((entry) => entry.game);
          };
          const showSuggest = () => {
            const q = searchInput.value.trim().toLowerCase();
            if (q.length < 2 || !titles) { closeSuggest(); return; }
            const starts = titles.filter((g) => g.lower.startsWith(q));
            const rest = titles.filter((g) => !g.lower.startsWith(q) && g.lower.includes(q));
            let matches = starts.concat(rest);
            if (matches.length < 3) matches = matches.concat(similarTitles(q, titles, matches));
            matches = matches.slice(0, 8);
            if (matches.length === 0) { closeSuggest(); return; }
            shown = matches.map((game, i) => {
              const a = document.createElement("a");
              a.id = "header-search-opt-" + i;
              a.setAttribute("role", "option");
              a.setAttribute("aria-selected", "false");
              a.href = "/games/" + encodeURIComponent(game.slug);
              a.textContent = game.title;
              return a;
            });
            suggestBox.replaceChildren(...shown);
            suggestBox.classList.add("open");
            searchInput.setAttribute("aria-expanded", "true");
            active = -1;
            searchInput.removeAttribute("aria-activedescendant");
          };
          searchInput.addEventListener("focus", () => { loadTitles().then(() => { if (document.activeElement === searchInput) showSuggest(); }); });
          searchInput.addEventListener("input", () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => { loadTitles().then(showSuggest); }, 120);
          });
          searchInput.addEventListener("keydown", (event) => {
            const open = suggestBox.classList.contains("open");
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopImmediatePropagation();
              closeSuggest();
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && open) {
              event.preventDefault();
              const last = shown.length - 1;
              setActive(event.key === "ArrowDown" ? (active >= last ? 0 : active + 1) : (active <= 0 ? last : active - 1));
            } else if (event.key === "Enter" && open && active >= 0 && !event.isComposing) {
              event.preventDefault();
              window.location.href = shown[active].href;
            }
          });
          // Keep focus in the field while tapping a suggestion; the link itself navigates on click.
          suggestBox.addEventListener("mousedown", (event) => event.preventDefault());
          searchInput.addEventListener("blur", () => window.setTimeout(closeSuggest, 100));
          document.getElementById("header-search")?.addEventListener("submit", closeSuggest);
        }
        searchInput?.addEventListener("keydown", (event) => { if (event.key === "Escape") setSearch(false); });
        document.getElementById("header-search")?.addEventListener("submit", (event) => {
          if (!searchInput.value.trim()) { event.preventDefault(); searchInput.focus(); }
        });
        // "/" jumps to the search field on wide screens, unless the visitor is already typing somewhere.
        document.addEventListener("keydown", (event) => {
          if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || !searchInput) return;
          const t = event.target;
          if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
          event.preventDefault();
          if (searchToggle && searchToggle.offsetParent !== null) setSearch(true); else searchInput.focus();
        });

        // A tap outside the open phone menu only closes it (cards are links, so it would otherwise open a game).
        const menu = document.getElementById("nav-menu");
        document.addEventListener("click", (event) => {
          if (!menu || !menu.open || menu.contains(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
          menu.open = false;
        }, true);
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && menu) menu.open = false;
        });
      })();
      (() => {
        const stack = document.getElementById("toast-stack");
        const showToast = (message, level = "success", durationMs = 2500, action) => {
          if (!stack || !message) return;
          const node = document.createElement("div");
          node.className = "toast " + level;
          node.textContent = message;
          if (action && action.label && action.onClick) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "toast-action";
            button.textContent = action.label;
            button.addEventListener("click", () => { node.remove(); action.onClick(); });
            node.appendChild(button);
          }
          stack.appendChild(node);
          window.setTimeout(() => {
            node.remove();
          }, durationMs);
        };

        window.appToast = showToast;
      })();
      // Share buttons ([data-share], data-share-title): the native share sheet where there is one, otherwise the
      // page link is copied. The URL is the canonical page URL (no query string).
      document.addEventListener("click", async (event) => {
        const button = event.target instanceof Element ? event.target.closest("[data-share]") : null;
        if (!button) return;
        // Short address: /games/x -> /g/x, /lists/x -> /c/x (the canonical link itself stays on the long host).
        const path = window.location.pathname.startsWith("/games/") ? "/g/" + window.location.pathname.slice(7) : window.location.pathname.startsWith("/lists/") ? "/c/" + window.location.pathname.slice(7) : window.location.pathname;
        const url = (window.DGL_SHORT_ORIGIN || window.location.origin) + path;
        if (navigator.share) {
          try {
            await navigator.share({ title: button.getAttribute("data-share-title") || document.title, url });
            return;
          } catch (error) {
            if (error && error.name === "AbortError") return;
          }
        }
        try {
          await navigator.clipboard.writeText(url);
          window.appToast?.("Link copied");
        } catch {
          window.appToast?.("Could not copy the link.", "error");
        }
      });`;

export const PAGE_SCRIPTS: Record<string, string> = {
  // Scripts below that start with a JSON.parse(...) read their server data from a <script type="application/json"> block;
  // /*@NAME@*/ markers are replaced with shared snippets from index.ts at registration.
  "submit-page": `
      const DATA_SUBMIT_PAGE = JSON.parse(document.getElementById("data-submit-page").textContent);
      /*@RESET_TZ@*/
      const form = document.getElementById("submission-form");
      const status = document.getElementById("submission-status");
      const signedIn = DATA_SUBMIT_PAGE.signedIn;
      const devNote = document.getElementById("dev-yes-note");
      const developerAnswer = () => (form && form.querySelector("input[name=isDeveloper]:checked") ? form.querySelector("input[name=isDeveloper]:checked").value : "");
      form?.querySelectorAll("input[name=isDeveloper]").forEach((radio) => radio.addEventListener("change", () => { if (devNote) devNote.hidden = developerAnswer() !== "yes"; }));

      // Signing in leaves this page, so the answers wait in this browser (for an hour) and come back with the visitor.
      const DRAFT_KEY = "dgl_submit_draft";
      const saveDraft = () => {
        if (!(form instanceof HTMLFormElement)) return;
        const data = new FormData(form);
        const draft = { savedAt: Date.now(), fields: {}, checked: {} };
        for (const [key, value] of data.entries()) {
          if (form.elements[key] && form.elements[key].type === "checkbox") continue;
          draft.fields[key] = String(value);
        }
        form.querySelectorAll("input[type=checkbox]").forEach((box) => { draft.checked[box.name + "=" + box.value] = box.checked; });
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {}
      };
      const restoreDraft = () => {
        let draft = null;
        try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch {}
        if (!draft || Date.now() - draft.savedAt > 3600000 || !(form instanceof HTMLFormElement)) return;
        for (const [key, value] of Object.entries(draft.fields || {})) {
          const control = form.elements[key];
          if (!control) continue;
          if (control instanceof RadioNodeList) { control.forEach((radio) => { radio.checked = radio.value === value; }); }
          else if (control.type !== "file") control.value = value;
        }
        form.querySelectorAll("input[type=checkbox]").forEach((box) => { const saved = draft.checked && draft.checked[box.name + "=" + box.value]; if (saved !== undefined) box.checked = saved; });
        form.querySelectorAll("[data-basis-select]").forEach((select) => select.dispatchEvent(new Event("change")));
        if (devNote) devNote.hidden = developerAnswer() !== "yes";
      };
      const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch {} };
      document.querySelectorAll("[data-save-draft]").forEach((link) => link.addEventListener("click", saveDraft));
      // Warn (never block) when the link or title looks like a game that is already listed or waiting for review.
      const dupNotice = document.getElementById("duplicate-notice");
      let dupTimer = 0;
      let dupSeq = 0;
      const checkDuplicates = async () => {
        if (!(form instanceof HTMLFormElement) || !dupNotice) return;
        const url = String(form.elements.url ? form.elements.url.value : "").trim();
        const title = String(form.elements.title ? form.elements.title.value : "").trim();
        const seq = ++dupSeq;
        if (url.length < 4 && title.length < 3) { dupNotice.hidden = true; return; }
        try {
          const response = await fetch("/api/games/duplicate-check?url=" + encodeURIComponent(url) + "&title=" + encodeURIComponent(title));
          if (!response.ok || seq !== dupSeq) return;
          const data = await response.json();
          const matches = data.matches || [];
          const listed = matches.find((m) => m.status === "approved");
          dupNotice.textContent = "";
          if (listed) {
            dupNotice.append("This looks like ");
            const link = document.createElement("a");
            link.href = "/games/" + encodeURIComponent(listed.slug);
            link.textContent = listed.title;
            link.target = "_blank";
            link.rel = "noopener";
            dupNotice.append(link, ", already on 0x9 dles.");
          } else if (matches.length > 0) {
            dupNotice.textContent = "A game with this link was already submitted and is waiting for review.";
          }
          dupNotice.hidden = matches.length === 0;
        } catch {}
      };
      const scheduleDupCheck = () => { clearTimeout(dupTimer); dupTimer = setTimeout(checkDuplicates, 500); };
      form?.elements.url?.addEventListener("input", scheduleDupCheck);
      form?.elements.title?.addEventListener("input", scheduleDupCheck);
      restoreDraft();
      scheduleDupCheck();
      form?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!(form instanceof HTMLFormElement)) return;
        const formData = new FormData(form);
        const resetBasis = String(formData.get("resetBasis") || "").trim();
        const resetTime = String(formData.get("resetTime") || "").trim();
        const resetTimezone = String(formData.get("resetTimezone") || "").trim();
        const payload = {
          title: String(formData.get("title") || ""),
          url: String(formData.get("url") || ""),
          description: String(formData.get("description") || "").trim() || undefined,
          howToPlay: String(formData.get("howToPlay") || "").trim() || undefined,
          categories: formData.getAll("categories").map((v) => String(v)),
          resetBasis: resetBasis || undefined,
          resetTime: resetTime || undefined,
          resetTimezone: resetBasis === "server" && resetTimezone ? resetTimezone : undefined,
          paywall: formData.has("paywall"),
          nsfw: formData.has("nsfw"),
          isDeveloper: signedIn && developerAnswer() === "yes"
        };
        if (status) status.textContent = "Submitting...";
        const response = await fetch("/api/games", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (response.ok) {
          form.reset();
          clearDraft();
          const result = await response.json().catch(() => ({}));
          if (result.claim && result.slug) {
            // Their claim is started: finish proving it on the game's page.
            if (window.appToast) window.appToast("Submitted. Now verify you're the developer.", "success");
            window.location.href = "/games/" + encodeURIComponent(result.slug);
            return;
          }
          const submittedStatus = result.status === "approved" ? "Approved and published." : "Submitted. Editors will review it shortly.";
          if (status) {
            status.textContent = submittedStatus + " ";
            if (result.slug && DATA_SUBMIT_PAGE.signedIn) {
              const link = document.createElement("a");
              link.href = "/games/" + encodeURIComponent(result.slug);
              link.textContent = "Did you make this game? Verify it.";
              status.appendChild(link);
            }
          }
          if (window.appToast) window.appToast(submittedStatus, "success");
        } else {
          const result = await response.json().catch(() => ({}));
          if (status) {
            status.textContent = (result.error || "Submission failed.") + " ";
            if (result.code === "duplicate" && result.slug) {
              // Already listed: if it's theirs, the game's page is where they claim it.
              const link = document.createElement("a");
              link.href = "/games/" + encodeURIComponent(result.slug);
              link.textContent = "It's already listed. If you made it, open its page to claim it.";
              status.appendChild(link);
            }
          }
          if (window.appToast) window.appToast(result.error || "Submission failed.", "error");
        }
      });
    `,
  "game-page": `
      const DATA_GAME_PAGE = JSON.parse(document.getElementById("data-game-page").textContent);
      // "You played this N times in the last 35 days" from the local play log (dgl_play_games_v1), viewer-local days.
      (() => {
        const el = document.getElementById("play-history-line");
        if (!el) return;
        let byDay = {};
        try { byDay = JSON.parse(window.localStorage.getItem("dgl_play_games_v1") || "{}") || {}; } catch (e) {}
        const key = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
        const now = new Date();
        const oldest = key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 35));
        let n = 0, last = "";
        Object.keys(byDay).forEach((day) => {
          if (day < oldest || !Array.isArray(byDay[day])) return;
          const c = byDay[day].filter((id) => id === DATA_GAME_PAGE.id).length;
          if (!c) return;
          n += c;
          if (day > last) last = day;
        });
        if (!n) return;
        const when = last === key(now) ? "today"
          : last === key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)) ? "yesterday"
          : new Date(+last.slice(0, 4), +last.slice(5, 7) - 1, +last.slice(8, 10)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        el.textContent = "You played this " + (n === 1 ? "once" : n + " times") + " in the last 35 days \u00b7 last played " + when;
        el.hidden = false;
      })();
      // "Recently on stream" dates: UTC text from the server, shown in the viewer's local time.
      document.querySelectorAll("time[data-local-date]").forEach((t) => {
        const d = new Date(t.getAttribute("datetime") || "");
        if (!isNaN(d.getTime())) t.textContent = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      });
      // "(8:00 PM your time)" after a server-basis reset, only when the viewer's zone differs from the reset zone.
      document.querySelectorAll("[data-reset-minutes]").forEach((node) => {
        try {
          const minutes = Number(node.getAttribute("data-reset-minutes"));
          const tz = node.getAttribute("data-reset-tz") || "UTC";
          const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (!Number.isFinite(minutes) || viewerTz === tz) return;
          const parts = (zone, at) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(at).map((x) => [x.type, Number(x.value)]));
          const offsetAt = (zone, at) => {
            const p = parts(zone, at);
            return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000) / 60000);
          };
          const now = new Date();
          const p = parts(tz, now);
          let next = new Date(Date.UTC(p.year, p.month - 1, p.day, 0, minutes) - offsetAt(tz, now) * 60000);
          if (next <= now) next = new Date(next.getTime() + 86400000);
          if (offsetAt(tz, next) === offsetAt(viewerTz, next)) return;
          node.textContent = " (" + next.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) + " your time)";
        } catch {}
      });
            const game = {
              id: DATA_GAME_PAGE.id,
              title: DATA_GAME_PAGE.title,
              slug: DATA_GAME_PAGE.slug
            };
            const gameId = game.id;
            const status = document.getElementById("game-action-status");
            const upCountNode = document.getElementById("vote-up-count");
            const downCountNode = document.getElementById("vote-down-count");
            let currentVote = DATA_GAME_PAGE.vote;
            const voteButtons = {
              up: document.getElementById("vote-up"),
              down: document.getElementById("vote-down")
            };

            const setStatus = (text) => {
              if (status) status.textContent = text;
            };
            const notify = (text, level) => {
              setStatus(text);
              if (window.appToast) window.appToast(text, level);
            };

            const setVoteState = (value) => {
              voteButtons.up?.classList.toggle("active", value === 1);
              voteButtons.down?.classList.toggle("active", value === -1);
              voteButtons.up?.setAttribute("aria-pressed", value === 1 ? "true" : "false");
              voteButtons.down?.setAttribute("aria-pressed", value === -1 ? "true" : "false");
            };

            const submitVote = async (value) => {
              const previousVote = currentVote;
              if (currentVote === value) {
                setStatus("Vote already set.");
                return;
              }
              window.dglGames.shiftVoteCounts(upCountNode, downCountNode, previousVote, value);
              currentVote = value;
              setVoteState(value);
              setStatus("Saving vote...");
              if (await window.dglGames.saveVote(gameId, value)) {
                notify("Vote saved.", "success");
                return;
              }
              window.dglGames.shiftVoteCounts(upCountNode, downCountNode, value, previousVote);
              currentVote = previousVote;
              setVoteState(previousVote);
              notify("Could not save vote.", "error");
            };

            voteButtons.up?.addEventListener("click", () => submitVote(1));
            voteButtons.down?.addEventListener("click", () => submitVote(-1));

            // Signed in: the favorite is saved to the account.
            const favoriteButton = document.getElementById("favorite-toggle");
            favoriteButton?.addEventListener("click", async () => {
              const favorited = favoriteButton.getAttribute("data-favorited") === "yes";
              favoriteButton.setAttribute("data-favorited", favorited ? "no" : "yes");
              favoriteButton.textContent = favorited ? "Add favorite" : "Remove favorite";
              setStatus("Updating favorites...");
              if (!(await window.dglGames.setAccountFavorite(gameId, !favorited))) {
                favoriteButton.setAttribute("data-favorited", favorited ? "yes" : "no");
                favoriteButton.textContent = favorited ? "Remove favorite" : "Add favorite";
                notify("Could not update favorite.", "error");
                return;
              }
              notify(favorited ? "Removed from rotation." : "Added to rotation.", "success");
            });

            // Signed out: the favorite lives in this browser's local rotation.
            const localFavoriteButton = document.getElementById("favorite-local-toggle");
            const setLocalFavoriteState = (favorited) => {
              if (!localFavoriteButton) return;
              localFavoriteButton.setAttribute("data-favorited", favorited ? "yes" : "no");
              localFavoriteButton.textContent = favorited ? "Remove favorite" : "Add favorite";
            };
            localFavoriteButton?.addEventListener("click", async () => {
              const favorited = await window.dglGames.toggleLocalFavorite(game);
              setLocalFavoriteState(favorited);
              notify(favorited ? "Added to favorites." : "Removed from favorites.", "success");
            });
            setLocalFavoriteState(window.dglGames.isLocalFavorite(gameId));

            // Deep link /games/:slug?add=1 (from a developer's "Add to my rotation" button): adds the game once the page
            // is actually shown, then drops the parameter. Client-side only because the page is edge-cached.
            (async () => {
              const params = new URLSearchParams(window.location.search);
              if (params.get("add") !== "1") return;
              // app.js (CSRF fetch wrapper, toasts) loads after page scripts: wait for it.
              await new Promise((resolve) => setTimeout(resolve, 0));
              if (document.visibilityState !== "visible") {
                // Opened in a background tab: wait until it is shown.
                await new Promise((resolve) => document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && resolve()));
              }
              params.delete("add");
              const query = params.toString();
              window.history.replaceState(null, "", window.location.pathname + (query ? "?" + query : "") + window.location.hash);
              if (favoriteButton) {
                if (favoriteButton.getAttribute("data-favorited") === "yes") { notify("Already in your rotation."); return; }
                favoriteButton.setAttribute("data-favorited", "yes");
                favoriteButton.textContent = "Remove favorite";
                if (!(await window.dglGames.setAccountFavorite(gameId, true))) {
                  favoriteButton.setAttribute("data-favorited", "no");
                  favoriteButton.textContent = "Add favorite";
                  notify("Could not add " + game.title + " to your rotation.", "error");
                  return;
                }
              } else {
                if (window.dglGames.isLocalFavorite(gameId)) { notify("Already in your rotation."); return; }
                setLocalFavoriteState(await window.dglGames.toggleLocalFavorite(game));
              }
              notify("Added " + game.title + " to your rotation", "success");
            })();

            const reportForm = document.getElementById("report-form");
            const reportStatus = document.getElementById("report-status");
            const setReportStatus = (text) => {
              if (reportStatus) reportStatus.textContent = text;
            };
            reportForm?.addEventListener("submit", async (event) => {
              event.preventDefault();
              if (!(reportForm instanceof HTMLFormElement)) return;
              const formData = new FormData(reportForm);
              const payload = {
                reason: String(formData.get("reason") || "other"),
                note: String(formData.get("note") || "").trim() || undefined
              };
              setReportStatus("Submitting report...");
              const response = await fetch("/api/games/" + gameId + "/report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
              });
              if (response.ok) {
                const body = await response.json().catch(() => ({}));
                reportForm.reset();
                setReportStatus(body && body.alreadyReported ? "You already reported this game. Thank you." : "Report submitted. Thank you.");
                if (window.appToast) window.appToast(body && body.alreadyReported ? "You already reported this game." : "Report submitted.", "success");
              } else {
                setReportStatus("Could not submit report.");
                if (window.appToast) window.appToast("Could not submit report.", "error");
              }
            });

            (() => {
              const link = document.querySelector("[data-reset-suggest-open]");
              const form = document.querySelector("[data-reset-suggest-form]");
              if (!link || !(form instanceof HTMLFormElement)) return;
              const statusNode = form.querySelector("[data-reset-suggest-status]");
              const signin = form.querySelector("[data-reset-suggest-signin]");
              const fields = form.querySelector("[data-reset-suggest-fields]");
              const zoneWrap = form.querySelector("[data-rs-zone]");
              const zoneSelect = zoneWrap.querySelector("select");
              const basis = form.elements.namedItem("reset_basis");
              const syncBasis = () => {
                zoneWrap.hidden = basis.value !== "server";
              };
              basis.addEventListener("change", syncBasis);
              let zonesLoaded = false;
              const loadZones = () => {
                if (zonesLoaded) return;
                zonesLoaded = true;
                try {
                  const common = new Set(Array.from(zoneSelect.options).map((o) => o.value));
                  const groups = {};
                  for (const zone of Intl.supportedValuesOf("timeZone")) {
                    if (common.has(zone)) continue;
                    const region = zone.indexOf("/") > 0 ? zone.split("/")[0] : "Other";
                    (groups[region] = groups[region] || []).push(zone);
                  }
                  for (const region of Object.keys(groups)) {
                    const group = document.createElement("optgroup");
                    group.label = region;
                    for (const zone of groups[region]) {
                      const option = document.createElement("option");
                      option.value = zone;
                      option.textContent = zone.replace(/_/g, " ");
                      group.appendChild(option);
                    }
                    zoneSelect.appendChild(group);
                  }
                } catch (_error) {
                  // The short list still works.
                }
              };
              const setStatus = (text) => {
                if (statusNode) statusNode.textContent = text;
              };
              link.addEventListener("click", async (event) => {
                event.preventDefault();
                if (!form.hidden) {
                  form.hidden = true;
                  return;
                }
                form.hidden = false;
                syncBasis();
                loadZones();
                const session = await fetch("/api/me/session").then((r) => (r.ok ? r.json() : null), () => null);
                const signedIn = !!(session && session.signedIn);
                signin.hidden = signedIn;
                fields.hidden = !signedIn;
              });
              form.addEventListener("submit", async (event) => {
                event.preventDefault();
                const data = new FormData(form);
                const isServer = data.get("reset_basis") === "server";
                setStatus("Sending...");
                const response = await fetch("/api/games/" + gameId + "/reset-suggestion", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    reset_basis: String(data.get("reset_basis")),
                    reset_time: String(data.get("reset_time") || ""),
                    reset_timezone: isServer ? String(data.get("reset_timezone") || "") || null : null,
                    note: String(data.get("note") || "").trim() || undefined
                  })
                });
                if (response.ok) {
                  form.hidden = true;
                  setStatus("");
                  if (window.appToast) window.appToast("Thanks! An editor will review your suggestion.", "success");
                  return;
                }
                const body = await response.json().catch(() => ({}));
                const message = response.status === 429 ? "You have sent enough suggestions for today." : (body.error || "Could not send the suggestion.");
                setStatus(message);
                if (window.appToast) window.appToast(message, "error");
              });
            })();

            const adminEditForm = document.getElementById("admin-edit-form");
            if (adminEditForm) {
              /*@RESET_TZ@*/
              const adminStatus = document.getElementById("admin-edit-status");
              const setAdminStatus = (text) => {
                if (adminStatus) adminStatus.textContent = text;
              };
              adminEditForm.addEventListener("submit", async (event) => {
                event.preventDefault();
                if (!(adminEditForm instanceof HTMLFormElement)) return;
                const formData = new FormData(adminEditForm);
                const categories = formData.getAll("categories");
                const resetBasis = formData.get("reset_basis");
                const resetTimeValue = String(formData.get("reset_time") || "").trim();
                const resetTimeParts = /^(\\d{1,2}):(\\d{2})/.exec(resetTimeValue);
                const resetTimeMinutes = resetTimeParts ? Number(resetTimeParts[1]) * 60 + Number(resetTimeParts[2]) : null;
                const resetTimezone = String(formData.get("reset_timezone") || "").trim();
                const payload = {
                  title: String(formData.get("title") || ""),
                  url: String(formData.get("url") || ""),
                  description: String(formData.get("description") || "").trim() || null,
                  status: String(formData.get("status") || "approved"),
                  reset_basis: resetBasis ? String(resetBasis) : null,
                  reset_time_minutes: resetTimeMinutes,
                  reset_timezone: resetBasis === "server" && resetTimezone ? resetTimezone : null,
                  paywall: formData.has("paywall"),
                  nsfw: formData.has("nsfw"),
                  how_to_play: String(formData.get("how_to_play") || ""),
                  category_ids: categories.map(c => String(c))
                };
                setAdminStatus("Saving changes...");
                const response = await fetch("/api/games/" + gameId + "/admin-update", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload)
                });
                if (response.ok) {
                  const result = await response.json().catch(() => null);
                  setAdminStatus("Changes saved successfully.");
                  if (window.appToast) window.appToast("Game updated.", "success");
                  setTimeout(() => {
                    if (result && result.slug) {
                      window.location.href = "/games/" + result.slug;
                    } else {
                      window.location.reload();
                    }
                  }, 1000);
                } else {
                  setAdminStatus("Could not save changes.");
                  if (window.appToast) window.appToast("Could not save changes.", "error");
                }
              });
            }

            /*@DEVELOPER@*/

            const listSelect = document.getElementById("list-select");
            const addToListForm = document.getElementById("add-to-list-form");
            const addToListStatus = document.getElementById("add-to-list-status");
            if (listSelect && addToListForm) {
              fetch("/api/lists").then(r => r.json()).then((data) => {
                for (const list of (data.results || [])) {
                  const opt = document.createElement("option");
                  opt.value = list.id;
                  opt.textContent = list.title;
                  listSelect.appendChild(opt);
                }
              }).catch(() => {});
              addToListForm.addEventListener("submit", async (e) => {
                e.preventDefault();
                const listId = listSelect.value;
                if (!listId) return;
                if (addToListStatus) addToListStatus.textContent = "Adding...";
                try {
                  const existing = await fetch("/api/lists/" + listId).then(r => r.json());
                  const nextPos = (existing.items?.length ?? 0) + 1;
                  const res = await fetch("/api/lists/" + listId + "/items", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ gameId: gameId, position: nextPos })
                  });
                  if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error || "Failed to add game");
                  }
                  if (addToListStatus) addToListStatus.textContent = "Game added to list.";
                  if (window.appToast) window.appToast("Game added to list.", "success");
                } catch (err) {
                  if (addToListStatus) addToListStatus.textContent = err.message;
                  if (window.appToast) window.appToast(err.message, "error");
                }
              });
            }
    `,
  "rotation-signed-in": `
        const list = document.getElementById("local-rotation-list");
        const listSorter = window.dglListSort.init(list, document.getElementById("list-sort-select"));
        const status = document.getElementById("rotation-status");

        const setStatus = (text) => {
          if (status) status.textContent = text;
        };

        const readFavorites = () => window.dglGames.readLocalFavorites().filter((row) => row.slug && row.title);
        const writeFavorites = window.dglGames.writeLocalFavorites;

        const moveItemByDirection = (item, direction) => {
          if (!list) return;
          if (!(item instanceof HTMLElement)) return;
          if (direction === "up") {
            const previous = item.previousElementSibling;
            if (previous) list.insertBefore(item, previous);
            return;
          }
          const next = item.nextElementSibling;
          if (next) list.insertBefore(next, item);
        };

        const persistFromDom = () => {
          if (!list) return;
          const items = Array.from(list.querySelectorAll("li[data-game-id]"));
          const next = items.map((item) => ({
            id: item.getAttribute("data-game-id") || "",
            slug: item.getAttribute("data-game-slug") || "",
            title: item.getAttribute("data-game-title") || ""
          })).filter((row) => row.id && row.slug && row.title);
          writeFavorites(next);
        };

        const removeFavorite = (gameId) => {
          const next = readFavorites().filter((row) => row.id !== gameId);
          writeFavorites(next);
          render();
          setStatus("Removed from local favorites.");
        };

        const wireInteractions = () => {
          if (!list) return;
          const items = Array.from(list.querySelectorAll("li[data-game-id]"));
          items.forEach((item) => {
            const handle = item.querySelector(".drag");
            handle?.addEventListener("pointerdown", (event) => {
              if (event.pointerType === "mouse" && event.button !== 0) return;
              event.preventDefault();
              const pointerId = event.pointerId;
              item.classList.add("dragging");

              const onPointerMove = (moveEvent) => {
                if (moveEvent.pointerId !== pointerId) return;
                const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
                const over = target && target.closest("li[data-game-id]");
                if (!over || over === item || !list.contains(over)) return;
                const rect = over.getBoundingClientRect();
                const before = moveEvent.clientY < rect.top + rect.height / 2;
                list.insertBefore(item, before ? over : over.nextSibling);
              };

              const onPointerUp = (upEvent) => {
                if (upEvent.pointerId !== pointerId) return;
                window.removeEventListener("pointermove", onPointerMove);
                window.removeEventListener("pointerup", onPointerUp);
                window.removeEventListener("pointercancel", onPointerUp);
                item.classList.remove("dragging");
                persistFromDom();
              };

              window.addEventListener("pointermove", onPointerMove);
              window.addEventListener("pointerup", onPointerUp);
              window.addEventListener("pointercancel", onPointerUp);
            });

            item.querySelectorAll("button[data-local-move]").forEach((button) => {
              button.addEventListener("click", () => {
                const direction = button.getAttribute("data-local-move");
                if (!direction) return;
                moveItemByDirection(item, direction);
                persistFromDom();
              });
            });

            item.querySelector("button[data-local-remove]")?.addEventListener("click", () => {
              const gameId = item.getAttribute("data-game-id");
              if (!gameId) return;
              removeFavorite(gameId);
            });
          });
        };

        const render = () => {
          if (!list) return;
          const favorites = readFavorites();
          const exportButton = document.getElementById("export-btn");
          const copyTextButton = document.getElementById("copy-text-btn");
          const sortControl = document.getElementById("list-sort-select")?.closest(".list-sort");
          if (exportButton) exportButton.hidden = favorites.length === 0;
          if (copyTextButton) copyTextButton.hidden = favorites.length === 0;
          if (sortControl) sortControl.hidden = favorites.length === 0;
          if (favorites.length === 0) {
            list.innerHTML = '<li class="empty-state"><p>Your rotation is empty. Tap ☆ on any game to add it here.</p><a class="btn" href="/games">Browse games</a></li>';
            return;
          }
          list.innerHTML = "";
          favorites.forEach((item) => {
            const li = document.createElement("li");
            li.className = "card-click";
            li.setAttribute("data-game-id", item.id);
            li.setAttribute("data-game-slug", item.slug);
            li.setAttribute("data-game-title", item.title);

            const drag = document.createElement("span");
            drag.className = "drag";
            drag.textContent = "::";
            li.appendChild(drag);

            const itemMain = document.createElement("div");
            itemMain.className = "item-main";

            // Points at the details page until rotation-info supplies the game's own address.
            const link = document.createElement("a");
            link.className = "game-title card-link";
            link.href = "/games/" + encodeURIComponent(item.slug);
            link.textContent = item.title;
            itemMain.appendChild(link);

            const pills = document.createElement("div");
            pills.className = "category-pills";
            pills.setAttribute("data-category-pills", item.id);
            itemMain.appendChild(pills);

            li.appendChild(itemMain);

            // Same compact controls as the signed-in rotation.
            const actions = document.createElement("div");
            actions.className = "card-actions";
            const reorder = document.createElement("div");
            reorder.className = "reorder-controls";
            const up = document.createElement("button");
            up.type = "button";
            up.setAttribute("data-local-move", "up");
            up.setAttribute("aria-label", "Move up");
            up.textContent = "↑";
            const down = document.createElement("button");
            down.type = "button";
            down.setAttribute("data-local-move", "down");
            down.setAttribute("aria-label", "Move down");
            down.textContent = "↓";
            reorder.appendChild(up);
            reorder.appendChild(down);
            actions.appendChild(reorder);

            const details = document.createElement("a");
            details.className = "btn-details";
            details.href = "/games/" + encodeURIComponent(item.slug);
            details.title = "Details";
            details.setAttribute("aria-label", item.title + " details");
            details.textContent = "…";
            actions.appendChild(details);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.setAttribute("data-local-remove", "1");
            remove.setAttribute("aria-label", "Remove from rotation");
            remove.textContent = "X";
            actions.appendChild(remove);
            li.appendChild(actions);

            list.appendChild(li);
          });
          wireInteractions();
          listSorter.refresh();
          loadCategoryPills(favorites.map((item) => item.id));
          loadGameInfo(favorites.map((item) => item.id));
        };

        const gameInfoCache = new Map();
        const applyGameInfo = () => {
          if (!list) return;
          list.querySelectorAll("li[data-game-id]").forEach((li) => {
            const info = gameInfoCache.get(li.getAttribute("data-game-id"));
            if (!info) return;
            const link = li.querySelector(".card-link");
            if (link && info.url) {
              link.href = info.url;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
            }
            const reset = info.reset;
            if (!reset) return;
            li.dataset.resetKind = reset.kind;
            li.dataset.resetMin = String(reset.min);
            const itemMain = li.querySelector(".item-main");
            if (itemMain && !itemMain.querySelector(".meta")) {
              const meta = document.createElement("div");
              meta.className = "meta";
              const label = document.createElement("span");
              label.setAttribute("data-reset-at-kind", reset.kind);
              label.setAttribute("data-reset-at", String(reset.min));
              label.textContent = reset.label;
              meta.appendChild(label);
              itemMain.appendChild(meta);
              window.dglLocalizeResets(meta);
            }
          });
          listSorter.apply();
          window.dglLocalizeResets?.();
        };

        const loadGameInfo = async (gameIds) => {
          const missing = gameIds.filter((id) => !gameInfoCache.has(id));
          if (missing.length === 0) { applyGameInfo(); return; }
          try {
            for (let i = 0; i < missing.length; i += 50) {
              const chunk = missing.slice(i, i + 50);
              const response = await fetch("/api/games/rotation-info?ids=" + chunk.map(encodeURIComponent).join(","));
              if (!response.ok) continue;
              const body = await response.json();
              chunk.forEach((id) => gameInfoCache.set(id, body[id] || null));
            }
            applyGameInfo();
          } catch {
            // Links fall back to the details page and reset times are optional; ignore failures.
          }
        };

        const categoryHue = (slug) => {
          let hash = 0;
          for (let i = 0; i < slug.length; i++) {
            hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
          }
          return hash % 360;
        };

        const DEV_CHECK_SVG = /*@CHECK_SVG_JSON@*/;
        const escapeText = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

        const loadCategoryPills = async (gameIds) => {
          if (!list || gameIds.length === 0) return;
          try {
            const response = await fetch("/api/games/categories?withDevelopers=1&ids=" + gameIds.map(encodeURIComponent).join(","));
            if (!response.ok) return;
            const payload = await response.json();
            const categoriesByGameId = payload.categories || {};
            const developersByGameId = payload.developers || {};
            Object.keys(categoriesByGameId).forEach((gameId) => {
              const container = list.querySelector('[data-category-pills="' + CSS.escape(gameId) + '"]');
              if (!container) return;
              const categories = categoriesByGameId[gameId] || [];
              const developer = developersByGameId[gameId];
              const developerChip = developer
                ? (developer.handle
                  ? '<a href="/u/' + encodeURIComponent(developer.handle) + '" class="tag category-pill dev-pill" title="Verified developer: ' + escapeText(developer.name) + '" aria-label="Verified developer: ' + escapeText(developer.name) + '">'
                  : '<span class="tag category-pill dev-pill dev-pill-static" title="Verified developer: ' + escapeText(developer.name) + '">')
                  + DEV_CHECK_SVG + '<span class="dev-pill-name">' + escapeText(developer.name) + '</span>' + (developer.handle ? '</a>' : '</span>')
                : "";
              container.innerHTML = categories
                .map((cat) => {
                  const hue = categoryHue(cat.slug);
                  const style = "color:hsl(" + hue + ", 65%, 28%); background:hsl(" + hue + ", 65%, 90%); border-color:hsl(" + hue + ", 55%, 72%);";
                  const name = cat.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                  return '<a href="/games?category=' + encodeURIComponent(cat.slug) + '" class="tag category-pill" style="' + style + '">' + name + '</a>';
                })
                .join("") + developerChip;
            });
          } catch {
            // Category pills are a non-critical enhancement; ignore failures.
          }
        };

        document.getElementById("export-btn")?.addEventListener("click", () => {
          const favorites = readFavorites();
          if (favorites.length === 0) {
            setStatus("No favorites to export.");
            return;
          }
          const exportData = { version: 1, items: favorites };
          const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "dailies-rotation.json";
          a.click();
          URL.revokeObjectURL(url);
          setStatus("Exported " + favorites.length + " favorite" + (favorites.length === 1 ? "" : "s") + ".");
        });

        document.getElementById("import-btn")?.addEventListener("click", () => {
          document.getElementById("import-file")?.click();
        });

        document.getElementById("import-file")?.addEventListener("change", (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const importStatus = document.getElementById("import-status");
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const data = JSON.parse(reader.result);
              if (!data || data.version !== 1 || !Array.isArray(data.items)) {
                if (importStatus) importStatus.textContent = "Invalid file format.";
                return;
              }
              const valid = data.items.filter((item) => item && typeof item.id === "string" && item.id.length > 0 && typeof item.slug === "string" && typeof item.title === "string");
              if (valid.length === 0) {
                if (importStatus) importStatus.textContent = "No valid items found in file.";
                return;
              }
              const existing = readFavorites();
              const existingIds = new Set(existing.map((e) => e.id));
              let added = 0;
              for (const item of valid) {
                if (!existingIds.has(item.id)) {
                  existing.push({ id: item.id, slug: item.slug, title: item.title });
                  added += 1;
                }
              }
              writeFavorites(existing);
              if (importStatus) importStatus.textContent = "Imported " + added + " new favorite" + (added === 1 ? "" : "s") + ".";
              render();
            } catch {
              if (importStatus) importStatus.textContent = "Could not read file.";
            }
          };
          reader.readAsText(file);
          event.target.value = "";
        });

        render();
      `,
  "rotation-paste": `
      (() => {
        const openBtn = document.getElementById("rotation-paste-btn");
        const panel = document.getElementById("rotation-paste-panel");
        if (!openBtn || !panel) return;
        const text = document.getElementById("rotation-paste-text");
        const previewBtn = document.getElementById("rotation-paste-preview");
        const closeBtn = document.getElementById("rotation-paste-close");
        const status = document.getElementById("rotation-paste-status");
        const results = document.getElementById("rotation-paste-results");
        const rowsEl = document.getElementById("rotation-paste-rows");
        const addBtn = document.getElementById("rotation-paste-add");
        let rows = [];
        const say = (message) => { status.textContent = message; };
        const localIds = () => new Set((window.dglGames.readLocalFavorites() || []).map((g) => g.id));
        const setOpen = (open) => {
          panel.hidden = !open;
          openBtn.setAttribute("aria-expanded", open ? "true" : "false");
          if (open) text.focus(); else openBtn.focus();
        };
        openBtn.addEventListener("click", () => setOpen(panel.hidden));
        closeBtn.addEventListener("click", () => setOpen(false));
        panel.addEventListener("keydown", (event) => { if (event.key === "Escape") setOpen(false); });
        const chosen = (index) => {
          const row = rows[index];
          const check = rowsEl.querySelector('input[type=checkbox][data-i="' + index + '"]');
          const select = rowsEl.querySelector('select[data-i="' + index + '"]');
          const id = select ? select.value : (row.match ? row.match.id : "");
          const game = [row.match].concat(row.alternatives).find((g) => g && g.id === id);
          return check && check.checked && game ? game : null;
        };
        const updateCount = () => {
          const ids = new Set();
          rows.forEach((row, i) => { const g = chosen(i); if (g) ids.add(g.id); });
          addBtn.textContent = "Add " + ids.size + (ids.size === 1 ? " game" : " games");
          addBtn.disabled = ids.size === 0;
        };
        const render = () => {
          rowsEl.textContent = "";
          const mine = localIds();
          rows.forEach((row, i) => {
            const li = document.createElement("li");
            li.className = "paste-row";
            const options = (row.match ? [row.match] : []).concat(row.alternatives);
            const isIn = (g) => g.inRotation === true || mine.has(g.id);
            if (row.match) row.match.inRotation = row.inRotation || mine.has(row.match.id);
            const check = document.createElement("input");
            check.type = "checkbox";
            check.dataset.i = String(i);
            check.id = "paste-c-" + i;
            check.disabled = options.length === 0;
            check.checked = !!row.match && !(row.match.inRotation) && row.confidence !== "none";
            check.addEventListener("change", updateCount);
            const label = document.createElement("label");
            label.htmlFor = check.id;
            label.className = "paste-input";
            label.textContent = row.input;
            li.append(check, label);
            const side = document.createElement("div");
            side.className = "paste-match";
            if (options.length === 0) {
              side.textContent = "No match";
              side.classList.add("muted");
            } else {
              if (row.confidence === "exact" && row.alternatives.length === 0 || (row.confidence !== "none" && options.length === 1)) {
                const span = document.createElement("span");
                span.textContent = row.match.title;
                side.append(span);
              } else {
                const select = document.createElement("select");
                select.dataset.i = String(i);
                select.setAttribute("aria-label", "Game for " + row.input);
                if (!row.match) {
                  const none = document.createElement("option");
                  none.value = "";
                  none.textContent = "Choose a game...";
                  select.append(none);
                }
                options.forEach((g) => {
                  const option = document.createElement("option");
                  option.value = g.id;
                  option.textContent = g.title;
                  select.append(option);
                });
                select.value = row.match ? row.match.id : "";
                select.addEventListener("change", () => {
                  const g = options.find((o) => o.id === select.value);
                  check.checked = !!g && !isIn(g);
                  updateCount();
                });
                side.append(select);
              }
              const note = document.createElement("small");
              note.className = "muted";
              note.textContent = row.match ? (row.match.inRotation ? " Already in your rotation" : (row.confidence === "fuzzy" ? " Close match" : "")) : "";
              if (note.textContent) side.append(note);
            }
            li.append(side);
            rowsEl.append(li);
          });
          results.hidden = rows.length === 0;
          updateCount();
        };
        previewBtn.addEventListener("click", async () => {
          if (!text.value.trim()) { say("Paste at least one game name or link."); return; }
          previewBtn.disabled = true;
          say("Looking up games...");
          try {
            const response = await fetch("/api/me/rotation/import-preview", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: text.value })
            });
            const body = await response.json().catch(() => null);
            if (!response.ok || !body) {
              say(response.status === 429 ? "Too many previews. Try again later." : ((body && body.error) || "Could not look up those games."));
              return;
            }
            rows = body.rows || [];
            render();
            const found = rows.filter((r) => r.match).length;
            say(rows.length === 0 ? "Nothing to import." : "Matched " + found + " of " + rows.length + ".");
          } catch {
            say("Could not look up those games.");
          } finally {
            previewBtn.disabled = false;
          }
        });
        addBtn.addEventListener("click", async () => {
          const games = [];
          rows.forEach((row, i) => { const g = chosen(i); if (g) games.push({ id: g.id, slug: g.slug, title: g.title }); });
          if (games.length === 0) return;
          addBtn.disabled = true;
          const result = await window.dglAddManyToRotation(games);
          if (result && result.ok) {
            window.setTimeout(() => window.location.reload(), 900);
          } else {
            updateCount();
          }
        });
      })();
  `,
  "rotation-share": `
      const DATA_ROTATION_SHARE = JSON.parse(document.getElementById("data-rotation-share").textContent);
      const list = document.getElementById("rotation-list");
      const status = document.getElementById("rotation-status");
      const shareStatus = document.getElementById("share-status");
      const importPanel = document.getElementById("rotation-local-import-panel");
      const importSummary = document.getElementById("rotation-local-import-summary");
      const importStatus = document.getElementById("rotation-local-import-status");
      const importButton = document.getElementById("rotation-local-import-btn");
      const importDismissButton = document.getElementById("rotation-local-import-dismiss");

      const setStatus = (text) => {
        if (status) status.textContent = text;
      };

      const setImportStatus = (text) => {
        if (importStatus) importStatus.textContent = text;
      };

      const localFavoriteCount = window.dglGames.readLocalFavorites().length;
      if (importPanel && localFavoriteCount > 0) {
        importPanel.hidden = false;
        if (importSummary) {
          importSummary.textContent = "Found " + localFavoriteCount + " local favorite" + (localFavoriteCount === 1 ? "" : "s") + ".";
        }
      }

      importDismissButton?.addEventListener("click", () => {
        if (importPanel) importPanel.hidden = true;
      });

      importButton?.addEventListener("click", async () => {
        setImportStatus("Importing local favorites...");
        const result = await window.dglGames.importLocalFavorites();
        if (result !== "imported") {
          setImportStatus(result === "empty" ? "No valid local favorites to import." : "Could not import local favorites.");
          return;
        }
        setImportStatus("Imported local favorites.");
        if (window.appToast) window.appToast("Imported local favorites.", "success");
        window.location.reload();
      });

      // Share button handlers
      const setShareStatus = (text) => {
        if (shareStatus) shareStatus.textContent = text;
      };

      document.getElementById("generate-share-btn")?.addEventListener("click", async () => {
        setShareStatus("Generating share link...");
        const response = await fetch("/api/me/rotation/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" }
        });
        if (response.ok) {
          const data = await response.json();
          if (window.appToast) window.appToast("Share link generated!", "success");
          window.location.reload();
        } else {
          setShareStatus("Could not generate share link.");
          if (window.appToast) window.appToast("Could not generate share link.", "error");
        }
      });

      document.getElementById("copy-share-btn")?.addEventListener("click", async () => {
        const shareUrl = DATA_ROTATION_SHARE.shareUrl;
        if (shareUrl) {
          try {
            await navigator.clipboard.writeText(shareUrl);
            setShareStatus("Link copied to clipboard!");
            if (window.appToast) window.appToast("Link copied!", "success");
          } catch {
            setShareStatus("Could not copy link. Please try again.");
          }
        }
      });

      document.getElementById("disable-share-btn")?.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to disable your share link? The current link will stop working.")) {
          return;
        }
        setShareStatus("Disabling share link...");
        const response = await fetch("/api/me/rotation/share", {
          method: "DELETE"
        });
        if (response.ok) {
          if (window.appToast) window.appToast("Share link disabled.", "success");
          window.location.reload();
        } else {
          setShareStatus("Could not disable share link.");
          if (window.appToast) window.appToast("Could not disable share link.", "error");
        }
      });

      const moveItemByDirection = (item, direction) => {
        if (!list) return;
        if (!(item instanceof HTMLElement)) return;
        if (direction === "up") {
          const previous = item.previousElementSibling;
          if (previous) {
            list.insertBefore(item, previous);
          }
          return;
        }
        const next = item.nextElementSibling;
        if (next) {
          list.insertBefore(next, item);
        }
      };

      const saveOrder = async () => {
        if (!list) return;
        const items = Array.from(list.querySelectorAll("li[data-game-id]"));
        const payload = {
          items: items.map((item, index) => ({
            gameId: item.getAttribute("data-game-id"),
            position: index + 1
          }))
        };
        setStatus("Saving order...");
        const response = await fetch("/api/me/favorites/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (response.ok) {
          setStatus("Order saved.");
        } else {
          setStatus("Could not save order.");
          if (window.appToast) window.appToast("Could not save order.", "error");
        }
      };

      document.getElementById("export-btn")?.addEventListener("click", async () => {
        const response = await fetch("/api/me/favorites/export");
        if (!response.ok) {
          setStatus("Could not export favorites.");
          return;
        }
        const data = await response.json();
        if (!data.items || data.items.length === 0) {
          setStatus("No favorites to export.");
          return;
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "dailies-rotation.json";
        a.click();
        URL.revokeObjectURL(url);
        setStatus("Exported " + data.items.length + " favorite" + (data.items.length === 1 ? "" : "s") + ".");
      });

      document.getElementById("import-btn")?.addEventListener("click", () => {
        document.getElementById("import-file")?.click();
      });

      document.getElementById("import-file")?.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const importFileStatus = document.getElementById("import-status");
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const data = JSON.parse(reader.result);
            if (!data || data.version !== 1 || !Array.isArray(data.items)) {
              if (importFileStatus) importFileStatus.textContent = "Invalid file format.";
              return;
            }
            if (importFileStatus) importFileStatus.textContent = "Importing...";
            const response = await fetch("/api/me/favorites/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data)
            });
            if (!response.ok) {
              if (importFileStatus) importFileStatus.textContent = "Could not import favorites.";
              return;
            }
            const result = await response.json();
            if (importFileStatus) importFileStatus.textContent = "Imported " + result.imported + " new favorite" + (result.imported === 1 ? "" : "s") + ".";
            if (window.appToast) window.appToast("Imported " + result.imported + " favorites.", "success");
            window.location.reload();
          } catch {
            if (importFileStatus) importFileStatus.textContent = "Could not read file.";
          }
        };
        reader.readAsText(file);
        event.target.value = "";
      });

      if (list) {
        const items = Array.from(list.querySelectorAll("li[data-game-id]"));
        items.forEach((item) => {
          const handle = item.querySelector(".drag");
          handle?.addEventListener("pointerdown", (event) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            event.preventDefault();
            const pointerId = event.pointerId;
            item.classList.add("dragging");

            const onPointerMove = (moveEvent) => {
              if (moveEvent.pointerId !== pointerId) return;
              const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
              const over = target && target.closest("li[data-game-id]");
              if (!over || over === item || !list.contains(over)) return;
              const rect = over.getBoundingClientRect();
              const before = moveEvent.clientY < rect.top + rect.height / 2;
              list.insertBefore(item, before ? over : over.nextSibling);
            };

            const onPointerUp = (upEvent) => {
              if (upEvent.pointerId !== pointerId) return;
              window.removeEventListener("pointermove", onPointerMove);
              window.removeEventListener("pointerup", onPointerUp);
              window.removeEventListener("pointercancel", onPointerUp);
              item.classList.remove("dragging");
              void saveOrder();
            };

            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
            window.addEventListener("pointercancel", onPointerUp);
          });

          item.querySelectorAll("button[data-move]").forEach((button) => {
            button.addEventListener("click", async () => {
              const direction = button.getAttribute("data-move");
              if (!direction) return;
              moveItemByDirection(item, direction);
              await saveOrder();
            });
          });
        });

        document.querySelectorAll("button[data-unfavorite]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const gameId = btn.getAttribute("data-unfavorite");
            if (!gameId) return;
            setStatus("Removing from rotation...");
            if (await window.dglGames.setAccountFavorite(gameId, false)) {
              btn.closest("li")?.remove();
              setStatus("Removed from rotation.");
              if (window.appToast) window.appToast("Removed from rotation.", "success");
            } else {
              setStatus("Could not remove.");
              if (window.appToast) window.appToast("Could not remove from rotation.", "error");
            }
          });
        });
      }
    `,
  "list-suggestions": `
      const DATA_LIST_SUGGESTIONS = JSON.parse(document.getElementById("data-list-suggestions").textContent);
      (() => {
        const panel = document.getElementById("suggest-panel");
        if (!panel) return;
        const listId = DATA_LIST_SUGGESTIONS.listId;
        const signedIn = DATA_LIST_SUGGESTIONS.signedIn;
        const canModerate = DATA_LIST_SUGGESTIONS.canModerate;
        let suggestions = DATA_LIST_SUGGESTIONS.suggestions;
        const listEl = document.getElementById("suggest-list");
        const countEl = document.getElementById("suggest-count");
        const emptyEl = document.getElementById("suggest-empty");
        const toast = (message, level) => window.appToast?.(message, level || "success", level === "error" ? 3500 : 2500);
        const base = "/api/lists/" + encodeURIComponent(listId) + "/suggestions";

        // Always open beside the list on wide screens; a collapsed panel above it on phones.
        const wide = window.matchMedia("(min-width: 900px)");
        const syncOpen = () => { if (wide.matches) panel.open = true; };
        wide.addEventListener("change", syncOpen);
        syncOpen();
        panel.querySelector("summary")?.addEventListener("click", (event) => { if (wide.matches) event.preventDefault(); });

        const moreBtn = document.getElementById("suggest-more");
        const streamTop = document.getElementById("stream-top");
        const TOP_N = 5;
        let showAll = false;
        const render = () => {
          countEl.textContent = suggestions.length > 0 ? "(" + suggestions.length + ")" : "";
          emptyEl.hidden = suggestions.length > 0;
          if (suggestions.length <= TOP_N) showAll = false;
          const shown = showAll ? suggestions : suggestions.slice(0, TOP_N);
          if (moreBtn) {
            moreBtn.hidden = suggestions.length <= TOP_N;
            moreBtn.textContent = showAll ? "Show top " + TOP_N : "Show all (" + suggestions.length + ")";
            moreBtn.setAttribute("aria-expanded", showAll ? "true" : "false");
          }
          // Stream bar (default 3) and overlay (default 5) show the leading suggestions; ?top=N overrides both.
          const topN = window.DGL_STREAM && window.DGL_STREAM.top >= 0 ? window.DGL_STREAM.top : -1;
          const fillTop = (el, n) => {
            if (!el) return;
            el.replaceChildren(...suggestions.slice(0, n).map((item) => {
              const li = document.createElement("li");
              const name = document.createElement("span");
              name.className = "st-title";
              name.textContent = item.title;
              const votes = document.createElement("span");
              votes.className = "st-votes";
              votes.textContent = "▲ " + item.votes;
              li.append(name, votes);
              return li;
            }));
          };
          window.dglStreamPanes?.suggestions(suggestions);
          fillTop(streamTop, topN < 0 ? 3 : topN);
          fillTop(document.getElementById("ov-top"), topN < 0 ? 5 : topN);
          const rows = shown.map((item) => {
            const li = document.createElement("li");
            li.className = "suggest-item";
            li.dataset.gameId = item.gameId;
            // The title opens the game itself in a new tab (counted as a click and a play, like a list row).
            const main = document.createElement("div");
            main.className = "suggest-main";
            const link = document.createElement("a");
            link.className = "suggest-title";
            link.href = item.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.dataset.playId = item.gameId;
            link.title = "Play " + item.title + " (opens in a new tab)";
            link.textContent = item.title;
            if (item.paywall) {
              const badge = document.createElement("span");
              badge.className = "paywall-badge";
              badge.title = "This game requires payment to play";
              badge.textContent = "$";
              link.appendChild(badge);
            }
            if (item.nsfw) {
              const badge = document.createElement("span");
              badge.className = "nsfw-badge";
              badge.textContent = "nsfw";
              link.appendChild(badge);
            }
            main.appendChild(link);
            // One muted line instead of a pill per category: the rows stay short.
            const sub = [...item.categories.slice(0, 2).map((cat) => cat.name), ...(item.developer ? ["by " + item.developer.name] : [])].join(" · ");
            if (sub) {
              const line = document.createElement("div");
              line.className = "suggest-sub";
              line.textContent = sub;
              main.appendChild(line);
            }
            const vote = document.createElement("button");
            vote.type = "button";
            vote.className = "suggest-vote" + (item.voted ? " active" : "");
            vote.dataset.action = "vote";
            vote.setAttribute("aria-pressed", item.voted ? "true" : "false");
            vote.title = item.voted ? (item.votes === 1 ? "Only your vote. Tap to take it back and withdraw the suggestion." : "You agree. Tap to take it back.") : "Agree with this suggestion";
            vote.textContent = "▲ " + item.votes;
            vote.setAttribute("aria-label", item.votes + (item.votes === 1 ? " vote" : " votes") + (item.voted ? ", including yours" : "") + ". Agree with " + item.title);
            const actions = document.createElement("div");
            actions.className = "suggest-actions";
            actions.appendChild(vote);
            li.append(main, actions);
            if (canModerate) {
              const accept = document.createElement("button");
              accept.type = "button";
              accept.className = "suggest-accept";
              accept.dataset.action = "accept";
              accept.textContent = "Add";
              accept.title = "Add to the list";
              accept.setAttribute("aria-label", "Add " + item.title + " to the list");
              const dismiss = document.createElement("button");
              dismiss.type = "button";
              dismiss.className = "suggest-dismiss";
              dismiss.dataset.action = "dismiss";
              dismiss.textContent = "✕";
              dismiss.title = "Remove suggestion (it can't be suggested again)";
              dismiss.setAttribute("aria-label", "Remove suggestion " + item.title);
              actions.append(accept, dismiss);
            }
            return li;
          });
          listEl.replaceChildren(...rows);
        };
        render();

        let busy = false;
        const send = async (method, url, body) => {
          busy = true;
          try {
            const response = await fetch(url, {
              method,
              headers: body ? { "Content-Type": "application/json" } : undefined,
              body: body ? JSON.stringify(body) : undefined
            });
            const data = await response.json().catch(() => ({}));
            if (Array.isArray(data.suggestions)) {
              suggestions = data.suggestions;
              render();
            }
            if (data.code === "disabled") window.setTimeout(hidePanel, 1500);
            return { ok: response.ok, status: response.status, data };
          } catch {
            return { ok: false, status: 0, data: {} };
          } finally {
            busy = false;
          }
        };

        moreBtn?.addEventListener("click", () => { showAll = !showAll; render(); });

        listEl.addEventListener("click", async (event) => {
          const button = event.target.closest("button[data-action]");
          if (!button || busy) return;
          const gameId = button.closest("li")?.dataset.gameId;
          const item = suggestions.find((entry) => entry.gameId === gameId);
          if (!item) return;
          const action = button.dataset.action;
          if (action === "vote") {
            const result = await send(item.voted ? "DELETE" : "PUT", base + "/" + encodeURIComponent(gameId) + "/vote");
            if (!result.ok) toast(result.data.error || "Could not save your vote.", "error");
            else if (result.data.withdrawn) toast(item.title + " had no other votes, so the suggestion was withdrawn.");
          } else if (action === "accept") {
            const result = await send("POST", base + "/" + encodeURIComponent(gameId) + "/accept");
            if (result.ok) {
              toast(item.title + " added to the list.");
              window.dglListRefresh?.();
            } else {
              toast(result.data.error || "Could not add it to the list.", "error");
            }
          } else if (action === "dismiss") {
            if (!window.confirm("Remove the suggestion " + item.title + "? It can't be suggested for this list again.")) return;
            const result = await send("DELETE", base + "/" + encodeURIComponent(gameId));
            if (result.ok) toast("Suggestion removed."); else toast(result.data.error || "Could not remove it.", "error");
          }
        });

        // Keeps counts current while the page is open (and refreshes a cached page's copy on load).
        const refresh = async () => {
          if (document.visibilityState !== "visible" || busy) return;
          try {
            const response = await fetch(base, { cache: "no-store" });
            if (!response.ok || busy) return;
            const data = await response.json();
            if (data.enabled === false) hidePanel();
            else if (Array.isArray(data.suggestions)) {
              const now = new Set(data.suggestions.map((item) => item.gameId));
              const gone = suggestions.some((item) => !now.has(item.gameId));
              suggestions = data.suggestions;
              render();
              // A suggestion that disappeared may have been added to the list.
              if (gone) window.dglListRefresh?.();
            }
          } catch {
            // Try again next time.
          }
        };
        window.dglSuggestRefresh = refresh;
        if (!signedIn) void refresh();
        const timer = window.setInterval(refresh, 30000);
        document.addEventListener("visibilitychange", refresh);
        // Turned off while the page is open: back to the list alone, in a single column.
        const hidePanel = () => {
          window.clearInterval(timer);
          window.dglStreamPanes?.suggestions([]);
          document.removeEventListener("visibilitychange", refresh);
          document.getElementById("ov-top")?.remove();
          const ovLabel = document.getElementById("ov-label");
          if (ovLabel) ovLabel.textContent = "";
          const layout = panel.closest(".list-layout");
          const main = layout?.querySelector(".list-main");
          if (layout && main) layout.replaceWith(...Array.from(main.childNodes));
          document.querySelector("main.list-page")?.classList.remove("list-page");
        };

        const form = document.getElementById("suggest-form");
        if (!form) return;
        const input = document.getElementById("suggest-input");
        const options = document.getElementById("suggest-options");
        const submit = document.getElementById("suggest-submit");
        let games = null;
        let loading = null;
        let picked = null;
        let active = -1;
        const loadGames = () => {
          loading = loading || fetch("/api/games/titles").then((r) => r.json()).then((data) => { games = data.games || []; }).catch(() => { loading = null; });
          return loading;
        };
        const close = () => { options.classList.remove("open"); input.setAttribute("aria-expanded", "false"); active = -1; };
        const pick = (game) => {
          picked = game;
          input.value = game.title;
          submit.disabled = false;
          close();
        };
        const showMatches = async () => {
          const query = input.value.trim().toLowerCase();
          if (!query) { close(); return; }
          if (!games) await loadGames();
          if (!games || input.value.trim().toLowerCase() !== query) return;
          const onList = new Set(Array.from(document.querySelectorAll("#list-items > li[data-game-id]")).map((li) => li.getAttribute("data-game-id")));
          const suggested = new Set(suggestions.map((item) => item.gameId));
          const matches = games
            .filter((game) => game.title.toLowerCase().includes(query))
            .sort((a, b) => Number(!a.title.toLowerCase().startsWith(query)) - Number(!b.title.toLowerCase().startsWith(query)))
            .slice(0, 12);
          options.replaceChildren(...matches.map((game, index) => {
            const option = document.createElement("div");
            option.className = "game-search-item";
            option.id = "suggest-option-" + index;
            option.setAttribute("role", "option");
            option.textContent = game.title;
            const note = onList.has(game.id) ? "on the list" : suggested.has(game.id) ? "suggested" : "";
            if (note) {
              const small = document.createElement("small");
              small.textContent = " · " + note;
              option.appendChild(small);
            }
            option.addEventListener("mousedown", (event) => { event.preventDefault(); pick(game); });
            return option;
          }));
          if (matches.length === 0) {
            const none = document.createElement("div");
            none.className = "game-search-item";
            none.textContent = "No games match.";
            options.replaceChildren(none);
          }
          options.classList.add("open");
          input.setAttribute("aria-expanded", "true");
          active = -1;
          options._matches = matches;
        };
        input.addEventListener("focus", () => { void loadGames(); });
        input.addEventListener("input", () => {
          if (picked && input.value !== picked.title) { picked = null; submit.disabled = true; }
          void showMatches();
        });
        input.addEventListener("blur", () => window.setTimeout(close, 150));
        input.addEventListener("keydown", (event) => {
          const matches = options._matches || [];
          if (!options.classList.contains("open") || matches.length === 0) {
            if (event.key === "Escape") close();
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            active = event.key === "ArrowDown" ? Math.min(active + 1, matches.length - 1) : Math.max(active - 1, 0);
            Array.from(options.children).forEach((el, i) => el.classList.toggle("active", i === active));
            input.setAttribute("aria-activedescendant", "suggest-option-" + active);
          } else if (event.key === "Enter" && active >= 0) {
            event.preventDefault();
            pick(matches[active]);
          } else if (event.key === "Escape") {
            close();
          }
        });
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!picked || busy) return;
          submit.disabled = true;
          const game = picked;
          const result = await send("POST", base, { gameId: game.id });
          if (result.ok) {
            picked = null;
            input.value = "";
            const messages = {
              suggested: "Suggested " + game.title + ".",
              voted: game.title + " was already suggested, so it counts as your vote.",
              already_voted: "You've already voted for " + game.title + "."
            };
            toast(messages[result.data.result] || "Suggested.");
          } else {
            submit.disabled = false;
            toast(result.data.error || "Could not suggest that game.", "error");
          }
        });
      })();
    `,
  "list-live": `
      const DATA_LIST_LIVE = JSON.parse(document.getElementById("data-list-live").textContent);
      (() => {
        const list = document.getElementById("list-items");
        if (!list) return;
        const sorter = window.dglListSort.init(list, document.getElementById("list-sort-select"));
        const rows = () => Array.from(list.children).filter((li) => li.getAttribute("data-game-id"));
        // The list's own (manual) order, as last rendered.
        let manualIds = rows().map((li) => li.getAttribute("data-game-id"));
        if (list.querySelector("li[data-default-index]")) {
          manualIds = rows().sort((a, b) => Number(a.dataset.defaultIndex) - Number(b.dataset.defaultIndex)).map((li) => li.getAttribute("data-game-id"));
        }
        // Live updates: when an editor adds, removes or reorders games, update this page in place. The list is
        // checked every 30s while the tab is visible; on a change the new rows come from a fresh render of this page.
        let checking = false;
        let again = false;
        const sortWrap = document.getElementById("list-sort-wrap");
        const check = async () => {
          if (document.visibilityState !== "visible") return;
          // A change made while a check is running (say, two quick adds) gets its own check straight after.
          if (checking) { again = true; return; }
          checking = true;
          try {
            const response = await fetch("/api/lists/" + encodeURIComponent(DATA_LIST_LIVE.slug), { cache: "no-store" });
            if (!response.ok) return;
            const apiItems = (await response.json()).items || [];
            const ids = apiItems.map((item) => item.id);
            // Played-on-stream marks: patch the rows' data-last-played-at in place (skipped while this page is saving one).
            const patchPlayed = () => {
              // Without Played on stream the API has no lastPlayedAt, and the rows get no marks.
              if (!apiItems.some((item) => "lastPlayedAt" in item)) return;
              if (window.dglPlayedBusy && window.dglPlayedBusy()) return;
              const marks = new Map(apiItems.map((item) => [item.id, item.lastPlayedAt || ""]));
              let changed = false;
              rows().forEach((li) => {
                const mark = marks.get(li.getAttribute("data-game-id"));
                if (mark !== undefined && li.getAttribute("data-last-played-at") !== mark) { li.setAttribute("data-last-played-at", mark); changed = true; }
              });
              if (changed && window.dglApplyPlayed) window.dglApplyPlayed();
            };
            if (ids.join(",") === manualIds.join(",")) { patchPlayed(); return; }
            // A unique query string skips the edge page cache, which can be up to a minute behind the API.
            const page = await fetch(window.location.pathname + "?live=" + Date.now(), { cache: "no-store" });
            if (!page.ok) return;
            const doc = new DOMParser().parseFromString(await page.text(), "text/html");
            const fresh = new Map(Array.from(doc.querySelectorAll("#list-items > li[data-game-id]")).map((li) => [li.getAttribute("data-game-id"), li]));
            if (!ids.every((id) => fresh.has(id))) return;
            const current = new Map(rows().map((li) => [li.getAttribute("data-game-id"), li]));
            const removed = [...current.keys()].filter((id) => !ids.includes(id));
            removed.forEach((id) => current.get(id).classList.add("row-leave"));
            const added = new Map();
            const incoming = document.createDocumentFragment();
            ids.filter((id) => !current.has(id)).forEach((id) => {
              const li = document.importNode(fresh.get(id), true);
              li.classList.add("row-enter");
              li.addEventListener("animationend", () => li.classList.remove("row-enter"), { once: true });
              added.set(id, li);
              incoming.appendChild(li);
            });
            window.dglBindGameRows?.(incoming);
            window.dglLocalizeResets?.(incoming);
            window.setTimeout(() => {
              removed.forEach((id) => current.get(id).remove());
              ids.forEach((id) => list.appendChild(current.get(id) || added.get(id)));
              sorter.refresh();
              manualIds = ids;
              patchPlayed();
              if (window.dglApplyPlayed) window.dglApplyPlayed();
              if (sortWrap) sortWrap.hidden = ids.length < 2;
              document.querySelectorAll("[data-list-count]").forEach((node) => { node.textContent = String(ids.length); });
            }, removed.length > 0 ? 350 : 0);
            // A game that joined (or left) the list has left the suggestions too.
            window.dglSuggestRefresh?.();
          } catch {
            // Offline or a failed request: try again next time.
          } finally {
            checking = false;
            if (again) { again = false; void check(); }
          }
        };
        window.setInterval(check, 30000);
        document.addEventListener("visibilitychange", check);
        window.dglListRefresh = check;
        // A logged-out page can come from the edge cache (up to a minute old); bring it up to date straight away.
        if (DATA_LIST_LIVE.loggedOut) void check();
      })();
    `,
  "list-edit": `
      const DATA_LIST_EDIT = JSON.parse(document.getElementById("data-list-edit").textContent);
      (() => {
        const listId = DATA_LIST_EDIT.listId;
        const status = document.getElementById("list-edit-status");
        const setStatus = (t) => { if (status) status.textContent = t; };

        document.getElementById("list-edit-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          setStatus("Saving...");
          const res = await fetch("/api/lists/" + listId, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: fd.get("title"),
              ...(fd.get("slug") ? { slug: fd.get("slug") } : {}),
              description: fd.get("description") || undefined
            })
          });
          if (res.ok) {
            setStatus("Saved.");
            window.location.href = "/lists/" + encodeURIComponent(String(fd.get("slug") || DATA_LIST_EDIT.slug)) + "?edit=1";
          } else {
            const body = await res.json().catch(() => ({}));
            setStatus(body.error || "Could not save.");
          }
        });

        document.getElementById("list-suggestions-toggle")?.addEventListener("change", async (e) => {
          const box = e.target;
          box.disabled = true;
          setStatus("Saving...");
          const res = await fetch("/api/lists/" + listId, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ suggestionsEnabled: box.checked })
          }).catch(() => null);
          box.disabled = false;
          if (res && res.ok) {
            setStatus(box.checked ? "Suggestions are on." : "Suggestions are off.");
          } else {
            box.checked = !box.checked;
            setStatus("Could not save.");
          }
        });

        document.getElementById("list-fandles-toggle")?.addEventListener("change", async (e) => {
          const box = e.target;
          box.disabled = true;
          setStatus("Saving...");
          const res = await fetch("/api/lists/" + listId, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fandlesEnabled: box.checked })
          }).catch(() => null);
          box.disabled = false;
          if (res && res.ok) {
            setStatus(box.checked ? "Fan-dles are on." : "Fan-dles are off.");
          } else {
            box.checked = !box.checked;
            setStatus("Could not save.");
          }
        });

        const fandleStatus = (text) => { const node = document.getElementById("fandle-status"); if (node) node.textContent = text; };
        document.querySelectorAll("[data-fandle-member-remove]").forEach((button) => {
          button.addEventListener("click", async () => {
            const userId = button.closest("[data-member-id]").getAttribute("data-member-id");
            const res = await fetch("/api/lists/" + listId + "/fandle-members/" + encodeURIComponent(userId), { method: "DELETE" }).catch(() => null);
            if (res && res.ok) window.location.reload(); else fandleStatus("Could not remove that member.");
          });
        });
        const devSearch = document.getElementById("fandle-dev-search");
        const devResults = document.getElementById("fandle-dev-results");
        let devTimer = 0;
        const closeDevResults = () => { devResults.classList.remove("open"); };
        devSearch?.addEventListener("input", () => {
          window.clearTimeout(devTimer);
          devTimer = window.setTimeout(async () => {
            const q = devSearch.value.trim();
            devResults.replaceChildren();
            if (q.length < 2) { closeDevResults(); return; }
            const res = await fetch("/api/admin/developers?q=" + encodeURIComponent(q)).catch(() => null);
            const data = res && res.ok ? await res.json() : { results: [] };
            if (!res || !res.ok) fandleStatus("Could not search developers.");
            if (data.results.length === 0) {
              const none = document.createElement("div");
              none.className = "game-search-item";
              none.textContent = res && res.ok ? "No verified developers found." : "Search failed.";
              devResults.appendChild(none);
            }
            for (const dev of data.results) {
              const row = document.createElement("div");
              row.className = "game-search-item";
              row.textContent = dev.name + (dev.handle ? " (@" + dev.handle + ")" : "") + " · " + dev.games + " verified game" + (dev.games === 1 ? "" : "s");
              // mousedown, like the game search above, so the pick lands before the box loses focus.
              row.addEventListener("mousedown", async (event) => {
                event.preventDefault();
                closeDevResults();
                fandleStatus("Adding " + dev.name + "...");
                const add = await fetch("/api/lists/" + listId + "/fandle-members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: dev.id }) }).catch(() => null);
                if (add && add.ok) window.location.reload();
                else { const body = add ? await add.json().catch(() => ({})) : {}; fandleStatus(body.error || "Could not add that developer."); }
              });
              devResults.appendChild(row);
            }
            devResults.classList.add("open");
          }, 250);
        });
        devSearch?.addEventListener("blur", () => window.setTimeout(closeDevResults, 150));

        document.querySelectorAll("[data-fandle-hidden]").forEach((button) => {
          button.addEventListener("click", async () => {
            const hide = button.getAttribute("data-fandle-hidden") === "1";
            const res = await fetch("/api/lists/" + listId + "/fandles/" + button.getAttribute("data-game-id") + "/hidden", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ hidden: hide })
            }).catch(() => null);
            if (res && res.ok) window.location.reload();
            else { const node = document.getElementById("fandle-status"); if (node) node.textContent = "Could not save."; }
          });
        });

        document.getElementById("list-twitch-form")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const login = String(new FormData(e.target).get("login") || "").trim();
          const twitchStatus = document.getElementById("list-twitch-status");
          if (twitchStatus) twitchStatus.textContent = "Saving...";
          const res = await fetch("/api/lists/" + listId + "/twitch", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ login: login || null })
          });
          if (res.ok) {
            window.location.reload();
          } else {
            const body = await res.json().catch(() => ({}));
            if (twitchStatus) twitchStatus.textContent = body.error || "Could not save.";
          }
        });

        document.getElementById("list-visibility-toggle")?.addEventListener("click", async () => {
          setStatus("Updating visibility...");
          const res = await fetch("/api/lists/" + listId + "/visibility", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ visibility: DATA_LIST_EDIT.nextVisibility })
          });
          if (res.ok) { window.location.reload(); } else { setStatus("Could not update visibility."); }
        });

        document.getElementById("list-delete-btn")?.addEventListener("click", async () => {
          if (!confirm("Delete this list?")) return;
          setStatus("Deleting...");
          const res = await fetch("/api/lists/" + listId, { method: "DELETE" });
          if (res.ok) { window.location.href = "/lists"; } else { setStatus("Could not delete."); }
        });

        document.querySelectorAll(".list-remove-game").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const gameId = btn.getAttribute("data-game-id");
            setStatus("Removing game...");
            const res = await fetch("/api/lists/" + listId + "/items/" + gameId, { method: "DELETE" });
            if (res.ok) { window.location.reload(); } else { setStatus("Could not remove game."); }
          });
        });

        const listEl = document.getElementById("list-items");
        const reorderStatus = document.getElementById("list-reorder-status");
        const setReorderStatus = (t) => { if (reorderStatus) reorderStatus.textContent = t; };
        let dragItem = null;

        const saveOrder = async () => {
          if (!listEl) return;
          const items = Array.from(listEl.querySelectorAll("li[data-game-id]"));
          const payload = {
            items: items.map((item, index) => ({
              gameId: item.getAttribute("data-game-id"),
              position: index + 1
            }))
          };
          setReorderStatus("Saving order...");
          const res = await fetch("/api/lists/" + listId + "/items/reorder", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (res.ok) {
            setReorderStatus("Order saved.");
            items.forEach((item, i) => {
              item.querySelectorAll(".position-label").forEach(el => el.textContent = String(i + 1));
            });
          } else {
            setReorderStatus("Could not save order.");
            if (window.appToast) window.appToast("Could not save order.", "error");
          }
        };

        const moveItem = (item, direction) => {
          if (!listEl) return;
          if (direction === "up" && item.previousElementSibling) {
            listEl.insertBefore(item, item.previousElementSibling);
          } else if (direction === "down" && item.nextElementSibling) {
            listEl.insertBefore(item, item.nextElementSibling.nextSibling);
          }
        };

        if (listEl) {
          Array.from(listEl.querySelectorAll("li[data-game-id]")).forEach((item) => {
            item.addEventListener("dragstart", () => {
              dragItem = item;
              item.classList.add("dragging");
            });
            item.addEventListener("dragend", () => {
              item.classList.remove("dragging");
              dragItem = null;
              void saveOrder();
            });
            item.addEventListener("dragover", (event) => {
              event.preventDefault();
            });
            item.addEventListener("drop", (event) => {
              event.preventDefault();
              if (!dragItem || dragItem === item) return;
              const rect = item.getBoundingClientRect();
              const before = event.clientY < rect.top + rect.height / 2;
              if (before) {
                listEl.insertBefore(dragItem, item);
              } else {
                listEl.insertBefore(dragItem, item.nextSibling);
              }
            });
            item.querySelectorAll("button[data-move]").forEach((button) => {
              button.addEventListener("click", async () => {
                const direction = button.getAttribute("data-move");
                if (!direction) return;
                moveItem(item, direction);
                await saveOrder();
              });
            });
          });
        }

        const allGames = DATA_LIST_EDIT.allGames;
        const searchInput = document.getElementById("game-search-input");
        const searchList = document.getElementById("game-search-list");
        const selectedInput = document.getElementById("game-search-selected");
        const addStatus = document.getElementById("list-add-status");
        let selectedGame = null;
        let activeIdx = -1;

        const renderFilter = (q) => {
          const query = q.toLowerCase();
          const matches = allGames.filter(g => !query || g.title.toLowerCase().includes(query) || g.slug.toLowerCase().includes(query)).slice(0, 20);
          searchList.innerHTML = "";
          activeIdx = -1;
          if (matches.length === 0 || !query) { searchList.classList.remove("open"); return; }
          matches.forEach((g, i) => {
            const div = document.createElement("div");
            div.className = "game-search-item";
            div.textContent = g.title;
            div.dataset.idx = i;
            div.dataset.gameId = g.id;
            div.dataset.gameTitle = g.title;
            div.addEventListener("mousedown", (e) => {
              e.preventDefault();
              pickGame(g);
            });
            searchList.appendChild(div);
          });
          searchList.classList.add("open");
        };

        const pickGame = (g) => {
          selectedGame = g;
          selectedInput.value = g.id;
          searchInput.value = g.title;
          searchList.classList.remove("open");
          const tag = document.createElement("div");
          tag.className = "game-search-selected";
          const strong = document.createElement("strong");
          strong.textContent = g.title;
          const clearButton = document.createElement("button");
          clearButton.type = "button";
          clearButton.id = "clear-game-selection";
          clearButton.textContent = "change";
          tag.append("Selected: ", strong, " ", clearButton);
          searchList.parentNode.appendChild(tag);
          document.getElementById("clear-game-selection")?.addEventListener("click", () => {
            selectedGame = null;
            selectedInput.value = "";
            searchInput.value = "";
            tag.remove();
            searchInput.focus();
          });
        };

        searchInput?.addEventListener("input", () => { renderFilter(searchInput.value); });
        searchInput?.addEventListener("focus", () => { renderFilter(searchInput.value); });
        searchInput?.addEventListener("blur", () => { setTimeout(() => searchList.classList.remove("open"), 150); });
        searchInput?.addEventListener("keydown", (e) => {
          const items = searchList.querySelectorAll(".game-search-item");
          if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle("active", i === activeIdx)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); items.forEach((el, i) => el.classList.toggle("active", i === activeIdx)); }
          else if (e.key === "Enter" && activeIdx >= 0 && items[activeIdx]) { e.preventDefault(); const g = allGames.find(x => x.id === items[activeIdx].dataset.gameId); if (g) pickGame(g); }
        });

        document.getElementById("list-add-game-btn")?.addEventListener("click", async () => {
          if (!selectedGame) { if (addStatus) addStatus.textContent = "Select a game first."; return; }
          if (addStatus) addStatus.textContent = "Adding game...";
          const nextPos = DATA_LIST_EDIT.itemCount + 1;
          const res = await fetch("/api/lists/" + listId + "/items", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: selectedGame.id, position: nextPos })
          });
          if (res.ok) { window.location.reload(); } else {
            const body = await res.json().catch(() => ({}));
            if (addStatus) addStatus.textContent = body.error || "Could not add game.";
          }
        });
      })();
    `,
  "admin-resets": `
    document.querySelectorAll("[data-reset-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const card = button.closest("[data-reset-suggestion-id]");
        const res = await fetch("/api/admin/reset-suggestions/" + card.getAttribute("data-reset-suggestion-id") + "/" + button.getAttribute("data-reset-action"), { method: "POST" });
        if (res.ok) {
          window.location.reload();
          return;
        }
        const data = await res.json().catch(() => ({}));
        const message = data.error || "Could not update the suggestion.";
        document.getElementById("resets-status").textContent = message;
        if (window.appToast) window.appToast(message, "error");
      });
    });
  `,
  "submit-reset-tz": `
      /*@RESET_TZ@*/
      const statusNode = document.getElementById("admin-submissions-status");
      const setStatus = (text) => {
        if (statusNode) statusNode.textContent = text;
      };

      const runAction = async (gameId, action) => {
        const payload = action === "reject" ? { note: window.prompt("Reject note (optional):") || "" } : {};
        setStatus("Running " + action + "...");
        const response = await fetch("/api/admin/games/" + gameId + "/" + action, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          setStatus("Action failed.");
          return;
        }
        setStatus("Action complete. Refreshing...");
        window.location.reload();
      };

      const collectSelectedIds = () => {
        const checks = Array.from(document.querySelectorAll("input[type=checkbox][data-game-select]"));
        return checks
          .filter((box) => box instanceof HTMLInputElement && box.checked)
          .map((box) => box.getAttribute("value"))
          .filter((id) => typeof id === "string" && id.length > 0);
      };

      const runBulkAction = async (action) => {
        const ids = collectSelectedIds();
        if (ids.length === 0) {
          setStatus("Select at least one submission first.");
          return;
        }
        const note = action === "reject" ? window.prompt("Reject note for selected submissions (optional):") || "" : "";
        setStatus("Running bulk " + action + " on " + ids.length + " item(s)...");
        const response = await fetch("/api/admin/games/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ids, note })
        });
        if (!response.ok) {
          setStatus("Bulk action failed.");
          return;
        }
        setStatus("Bulk action complete. Refreshing...");
        window.location.reload();
      };

      document.querySelectorAll("button[data-action][data-game-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const gameId = button.getAttribute("data-game-id");
          const action = button.getAttribute("data-action");
          if (!gameId || !action) return;
          void runAction(gameId, action);
        });
      });

      document.querySelectorAll("button[data-bulk-game-action]").forEach((button) => {
        button.addEventListener("click", () => {
          const action = button.getAttribute("data-bulk-game-action");
          if (!action) return;
          void runBulkAction(action);
        });
      });

      document.querySelector("button[data-select-all-games]")?.addEventListener("click", () => {
        const checks = Array.from(document.querySelectorAll("input[type=checkbox][data-game-select]"));
        const allChecked = checks.every((box) => box instanceof HTMLInputElement && box.checked);
        checks.forEach((box) => {
          if (box instanceof HTMLInputElement) {
            box.checked = !allChecked;
          }
        });
      });

      document.querySelectorAll("button[data-reset-save]").forEach((button) => {
        button.addEventListener("click", async () => {
          const gameId = button.getAttribute("data-reset-save");
          if (!gameId) return;
          const basisNode = document.querySelector("select[data-reset-basis='" + gameId + "']");
          const timeNode = document.querySelector("input[data-reset-time='" + gameId + "']");
          const zoneNode = document.querySelector("[data-reset-timezone='" + gameId + "']");
          if (!(basisNode instanceof HTMLSelectElement) || !(timeNode instanceof HTMLInputElement) || !(zoneNode instanceof HTMLInputElement)) {
            return;
          }
          setStatus("Saving reset settings...");
          const response = await fetch("/api/admin/games/" + gameId + "/reset", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resetBasis: basisNode.value || null,
              resetTime: timeNode.value || null,
              resetTimezone: basisNode.value === "server" ? (zoneNode.value.trim() || null) : null
            })
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setStatus(body.error || "Could not save reset settings.");
            return;
          }
          setStatus("Reset settings saved.");
        });
      });
    `,
  // Reads data-prompt-from-query / data-include-import-panel from its own <script> tag (document.currentScript).
  "game-list": `    (() => {
      const games = window.dglGames;
      const promptFromQuery = document.currentScript?.dataset.promptFromQuery === "1";
      const includeImportPanel = document.currentScript?.dataset.includeImportPanel === "1";
      if (includeImportPanel && promptFromQuery) {
        const panel = document.getElementById("local-favorites-import-panel");
        const summary = document.getElementById("local-favorites-import-summary");
        const status = document.getElementById("local-favorites-import-status");
        const importButton = document.getElementById("local-favorites-import-btn");
        const dismissButton = document.getElementById("local-favorites-import-dismiss");
        const setStatus = (text) => {
          if (status) status.textContent = text;
        };
        const favoriteCount = games.readLocalFavorites().length;
        if (panel && favoriteCount > 0) {
          panel.hidden = false;
          if (summary) {
            summary.textContent = "Found " + favoriteCount + " local favorite" + (favoriteCount === 1 ? "" : "s") + ".";
          }
          const dismiss = () => {
            panel.hidden = true;
            const url = new URL(window.location.href);
            url.searchParams.delete("importLocal");
            window.history.replaceState({}, "", url.toString());
          };
          dismissButton?.addEventListener("click", dismiss);
          importButton?.addEventListener("click", async () => {
            setStatus("Importing favorites...");
            const result = await games.importLocalFavorites();
            if (result !== "imported") {
              setStatus(result === "empty" ? "No valid local favorites to import." : "Could not import local favorites.");
              return;
            }
            setStatus("Imported. Redirecting to your rotation...");
            if (window.appToast) window.appToast("Imported local favorites.", "success");
            window.setTimeout(() => {
              window.location.href = "/me/rotation";
            }, 500);
          });
        }
      }

      // Wires up vote/favorite buttons on every game row under root. Exposed so pages that swap in new rows
      // (live search on /games) can wire those too.
      const bindRows = (root) => root.querySelectorAll("[data-game-row]").forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const gameId = node.getAttribute("data-game-row");
        if (!gameId) return;
        const upButton = node.querySelector("button[data-list-vote='up']");
        const downButton = node.querySelector("button[data-list-vote='down']");
        const favoriteButton = node.querySelector("button[data-list-favorite]");
        const localFavoriteButton = node.querySelector("button[data-local-favorite]");
        const upCount = node.querySelector("[data-up-count]");
        const downCount = node.querySelector("[data-down-count]");
        let currentVote = Number(node.getAttribute("data-vote") || "0");

        const setVoteState = (value) => {
          upButton?.classList.toggle("active", value === 1);
          downButton?.classList.toggle("active", value === -1);
          upButton?.setAttribute("aria-pressed", value === 1 ? "true" : "false");
          downButton?.setAttribute("aria-pressed", value === -1 ? "true" : "false");
        };

        const submitVote = async (value) => {
          const previous = currentVote;
          if (currentVote === value) return;
          currentVote = value;
          setVoteState(value);
          games.shiftVoteCounts(upCount, downCount, previous, value);
          if (await games.saveVote(gameId, value)) return;
          currentVote = previous;
          setVoteState(previous);
          games.shiftVoteCounts(upCount, downCount, value, previous);
          if (window.appToast) window.appToast("Could not save vote.", "error");
        };

        upButton?.addEventListener("click", () => submitVote(1));
        downButton?.addEventListener("click", () => submitVote(-1));

        favoriteButton?.addEventListener("click", async () => {
          const favorited = favoriteButton.getAttribute("data-list-favorite") === "yes";
          favoriteButton.setAttribute("data-list-favorite", favorited ? "no" : "yes");
          favoriteButton.textContent = favorited ? "☆" : "★";
          if (!(await games.setAccountFavorite(gameId, !favorited))) {
            favoriteButton.setAttribute("data-list-favorite", favorited ? "yes" : "no");
            favoriteButton.textContent = favorited ? "★" : "☆";
            if (window.appToast) window.appToast("Could not update favorite.", "error");
          }
        });

        if (localFavoriteButton) {
          const game = { id: gameId, slug: node.getAttribute("data-game-slug") || "", title: node.getAttribute("data-game-title") || "" };
          const setLocalFavoriteState = (favorited) => {
            localFavoriteButton.setAttribute("data-local-favorite", favorited ? "yes" : "no");
            localFavoriteButton.textContent = favorited ? "★" : "☆";
          };
          localFavoriteButton.addEventListener("click", async () => {
            setLocalFavoriteState(await games.toggleLocalFavorite(game));
          });
          setLocalFavoriteState(games.isLocalFavorite(gameId));
        }
      });
      bindRows(document);
      window.dglBindGameRows = bindRows;
    })();
  `,
  "home-strip": `      // Today's rotation strip: needs the visitor's own data, so it is filled in the browser (edge-cache safe).
      (() => {
        let rows = [];
        const widget = window.dglProgressWidget(document.getElementById("daily-progress"), () => rows);
        window.dglTodayRotation.get(0).then((items) => { rows = items || []; widget.update(); });
      })();
      document.getElementById("feeling-auspicious-btn")?.addEventListener("click", async () => {
        // Open the tab synchronously (within the click handler) so browsers don't block it as a popup;
        // the fetch below happens after an await, by which point window.open would no longer count as user-initiated.
        const newTab = window.open("", "_blank");
        if (newTab) newTab.opener = null;
        const game = await window.dglRandomGame();
        if (!game) {
          if (newTab) newTab.close();
          if (window.appToast) window.appToast("No games available.", "error");
          return;
        }
        if (newTab) newTab.location = game.url;
        fetch("/api/games/" + game.id + "/click", { method: "POST" }).catch(() => {});
        window.dglMarkPlayed?.(game.id);
        window.location.href = "/games/" + game.slug;
      });
    `,
  "home-new-cats": `      // "New in your categories": games added in the last 14 days in the categories most common in the visitor's
      // rotation, minus rotation and hidden games. Filled in the browser after load (edge-cache safe); hidden until
      // there is something to show, so nothing above the fold moves.
      (() => {
        const box = document.getElementById("new-in-cats");
        const listEl = document.getElementById("new-in-cats-list");
        if (!box || !listEl) return;
        box.hidden = true;
        const run = async () => {
          try {
            const items = await window.dglTodayRotation.get(0);
            if (!items || items.length === 0) return;
            const own = new Set(items.map((g) => g.id));
            try { window.dglGames.readLocalFavorites().forEach((g) => own.add(g.id)); } catch {}
            const ids = [...own].slice(0, 100);
            const cats = await fetch("/api/games/categories?ids=" + ids.map(encodeURIComponent).join(",")).then((r) => (r.ok ? r.json() : null));
            if (!cats) return;
            const counts = {};
            ids.forEach((id) => (cats[id] || []).forEach((c) => { counts[c.slug] = (counts[c.slug] || 0) + 1; }));
            const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1)).slice(0, 5);
            if (top.length === 0) return;
            const data = await fetch("/api/games/new?days=14&limit=12&categories=" + top.map(encodeURIComponent).join(",")).then((r) => (r.ok ? r.json() : null));
            const hidden = new Set(window.dglHidden ? window.dglHidden.read() : []);
            const games = ((data && data.games) || []).filter((g) => !own.has(g.id) && !hidden.has(g.id)).slice(0, 6);
            if (games.length === 0) return;
            listEl.replaceChildren(...games.map((g) => {
              const li = document.createElement("li");
              li.className = "card-click";
              li.setAttribute("data-hide-id", g.id);
              const row = document.createElement("div");
              row.className = "game-row";
              const head = document.createElement("div");
              head.className = "game-top";
              const name = document.createElement("div");
              name.className = "game-name";
              const a = document.createElement("a");
              a.className = "game-title card-link";
              a.href = g.url;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              a.textContent = g.title;
              name.append(a);
              if (g.paywall) {
                const p = document.createElement("span");
                p.className = "paywall-badge";
                p.title = "This game requires payment to play";
                p.textContent = "$";
                name.append(" ", p);
              }
              const actions = document.createElement("div");
              actions.className = "compact-actions";
              const details = document.createElement("a");
              details.className = "btn-details";
              details.href = "/games/" + encodeURIComponent(g.slug);
              details.textContent = "Details";
              details.setAttribute("aria-label", "Details for " + g.title);
              actions.append(details);
              head.append(name, actions);
              const sub = document.createElement("div");
              sub.className = "game-sub";
              const meta = document.createElement("span");
              meta.className = "meta";
              meta.textContent = (g.categories || []).map((c) => c.name).join(", ");
              sub.append(meta);
              row.append(head, sub);
              li.append(row);
              return li;
            }));
            box.hidden = listEl.children.length === 0;
          } catch { box.hidden = true; }
        };
        run();
      })();
    `,
  "games-page": `        (() => {
          const form = document.getElementById("game-filters");
          const panel = document.getElementById("filters-panel");
          // Filters are always shown on wider screens; on phones they fold away behind the "Filters" toggle.
          if (panel && window.matchMedia("(min-width: 701px)").matches) panel.open = true;
          form?.querySelectorAll("select, input[type=checkbox]").forEach((control) => {
            control.addEventListener("change", () => form.requestSubmit());
          });
          // Surprise me: a random game matching the current category and paywall filter (hidden games are skipped).
          document.getElementById("surprise-btn")?.addEventListener("click", async () => {
            const values = new FormData(form);
            const game = await window.dglRandomGame({
              category: values.get("category") || "",
              hidePaywall: values.get("hidePaywall") === "1",
              hideNsfw: values.get("hideNsfw") === "1"
            });
            if (!game) {
              window.appToast?.("No games match these filters.", "error");
              return;
            }
            window.location.href = "/games/" + encodeURIComponent(game.slug);
          });

          // Live search: as the user types, fetch this page for the new query and swap in its results (all games,
          // not just this page's), keeping the address bar in step. Enter/Search still does a normal submit.
          const input = form?.querySelector("input[name=q]");
          if (!form || !input) return;
          let timer = 0;
          let controller = null;
          const search = async () => {
            const params = new URLSearchParams(new FormData(form));
            for (const [key, value] of [...params]) if (!value) params.delete(key);
            if (params.get("sort") === "top") params.delete("sort");
            const url = "/games" + (params.toString() ? "?" + params.toString() : "");
            // Looked up here: this script runs before the results container further down the page exists.
            const results = document.getElementById("game-results");
            if (!results) return;
            controller?.abort();
            controller = new AbortController();
            results.setAttribute("aria-busy", "true");
            try {
              const response = await fetch(url, { signal: controller.signal });
              if (!response.ok) throw new Error("search failed");
              const next = new DOMParser().parseFromString(await response.text(), "text/html").getElementById("game-results");
              if (!next) throw new Error("no results");
              results.replaceChildren(...[...next.childNodes].map((node) => document.importNode(node, true)));
              window.dglBindGameRows?.(results);
              window.dglLocalizeResets?.(results);
              // Typo-fallback games sit in .similar-results and are not counted.
              const found = [...results.querySelectorAll("[data-game-row]")].filter((row) => !row.closest(".similar-results")).length;
              const status = document.getElementById("search-status");
              if (status) status.textContent = found === 0 ? "No games found" : found + (results.querySelector(".pagination a[href*='page=']") ? "+" : "") + " games found";
              window.history.replaceState(null, "", url);
            } catch (error) {
              if (error.name !== "AbortError") form.requestSubmit();
            } finally {
              results.removeAttribute("aria-busy");
            }
          };
          input.addEventListener("input", () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(search, 250);
          });
        })();
      `,
  "settings-hidden": `      (() => {
        const panel = document.getElementById("hidden-games-panel");
        const list = document.getElementById("hidden-games-list");
        if (!panel || !list || !window.dglHidden) return;
        let titles = null;
        const render = () => {
          const ids = window.dglHidden.read();
          panel.hidden = ids.length === 0;
          list.replaceChildren();
          ids.forEach((id) => {
            const game = titles && titles.get(id);
            const li = document.createElement("li");
            const name = document.createElement(game ? "a" : "span");
            if (game) name.href = "/games/" + encodeURIComponent(game.slug);
            name.textContent = game ? game.title : "Unknown game";
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Unhide";
            button.setAttribute("aria-label", "Unhide " + (game ? game.title : "game"));
            button.addEventListener("click", () => window.dglHidden.unhide(id));
            li.append(name, button);
            list.appendChild(li);
          });
        };
        document.getElementById("hidden-games-clear")?.addEventListener("click", () => window.dglHidden.clear());
        window.addEventListener("dglhiddenchange", render);
        render();
        if (window.dglHidden.read().length > 0) {
          fetch("/api/games/titles").then((r) => r.json()).then((data) => {
            titles = new Map((data.games || []).map((g) => [g.id, g]));
            render();
          }).catch(() => undefined);
        }
      })();
    `,
  "settings-page": `      const statusNode = document.getElementById("me-settings-status");
      const setStatus = (text) => {
        if (statusNode) statusNode.textContent = text;
      };

      const clearPlays = document.getElementById("plays-clear");
      clearPlays?.addEventListener("click", async () => {
        if (!window.confirm("This removes your play history, streak and recap data on every device. Your rotation stays.")) return;
        setStatus("Clearing play history...");
        try {
          const response = await fetch("/api/me/plays", { method: "DELETE" });
          if (!response.ok) throw new Error("clear");
          const data = await response.json();
          ["dgl_played_v1", "dgl_play_log_v1", "dgl_play_games_v1", "dgl_streak_v1", "dgl_streak_best_v1", "dgl_skipped_v1", "dgl_plays_pending_v1"].forEach((k) => {
            try { window.localStorage.removeItem(k); } catch {}
          });
          try { window.localStorage.setItem("dgl_plays_reset_seen_v1", String(data.resetAt || "")); } catch {}
          setStatus("Play history cleared.");
          if (window.appToast) window.appToast("Play history cleared.", "success");
        } catch {
          setStatus("Could not clear play history.");
        }
      });

      (async () => {
        const panel = document.getElementById("push-devices-panel");
        const list = document.getElementById("push-devices-list");
        if (!panel || !list) return;
        try {
          const cfg = await fetch("/api/me/push/config").then((r) => (r.ok ? r.json() : null));
          if (!cfg || !cfg.publicKey) return;
          let localSub = null;
          let currentId = null;
          try {
            if ("serviceWorker" in navigator && "PushManager" in window) {
              const reg = await navigator.serviceWorker.ready;
              localSub = await reg.pushManager.getSubscription();
              if (localSub) {
                const cur = await fetch("/api/me/push/subscriptions/current", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: localSub.endpoint }) }).then((r) => (r.ok ? r.json() : null));
                currentId = cur && cur.id;
              }
            }
          } catch {}
          const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
          const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
          const dayKey = (d) => d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
          const lastText = (iso) => {
            if (!iso) return "no reminders sent yet";
            const d = new Date(iso);
            if (isNaN(d.getTime())) return "no reminders sent yet";
            const now = new Date();
            const yest = new Date(now.getTime() - 86400000);
            const day = dayKey(d) === dayKey(now) ? "today" : dayKey(d) === dayKey(yest) ? "yesterday" : dateFmt.format(d);
            return "last reminder " + day + " at " + timeFmt.format(d);
          };
          let items = [];
          const render = () => {
            list.textContent = "";
            if (items.length === 0) {
              const li = document.createElement("li");
              li.className = "muted";
              li.textContent = "No devices yet.";
              list.appendChild(li);
              return;
            }
            items.forEach((item) => {
              const li = document.createElement("li");
              const text = document.createElement("span");
              const added = new Date(item.createdAt);
              text.textContent = (item.label || "Unknown device") + (item.id === currentId ? " (This device)" : "") + " · added " + (isNaN(added.getTime()) ? "" : dateFmt.format(added)) + " · " + lastText(item.lastSentAt) + " ";
              const btn = document.createElement("button");
              btn.type = "button";
              btn.textContent = "Remove";
              btn.addEventListener("click", async () => {
                btn.disabled = true;
                try {
                  const res = await fetch("/api/me/push/subscriptions/" + encodeURIComponent(item.id), { method: "DELETE" });
                  if (!res.ok && res.status !== 404) throw new Error("remove");
                  if (item.id === currentId && localSub) {
                    try { await localSub.unsubscribe(); } catch {}
                    try { window.localStorage.removeItem("dgl_push_v1"); } catch {}
                    currentId = null;
                  }
                  items = items.filter((x) => x.id !== item.id);
                  render();
                  if (window.appToast) window.appToast("Device removed.", "success");
                } catch {
                  btn.disabled = false;
                  setStatus("Could not remove device.");
                }
              });
              li.append(text, btn);
              list.appendChild(li);
            });
          };
          items = await fetch("/api/me/push/subscriptions").then((r) => (r.ok ? r.json() : []));
          panel.hidden = false;
          render();
        } catch {}
      })();

      const profileForm = document.getElementById("profile-form");
      profileForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!(profileForm instanceof HTMLFormElement)) return;
        const fd = new FormData(profileForm);
        const displayName = String(fd.get("displayName") || "").trim();
        setStatus("Saving profile...");
        const response = await fetch("/api/me/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName })
        });
        if (!response.ok) {
          setStatus("Could not save profile.");
          return;
        }
        setStatus("Profile updated.");
        if (window.appToast) window.appToast("Profile updated.", "success");
      });

      const publicProfileForm = document.getElementById("public-profile-form");
      publicProfileForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const fd = new FormData(publicProfileForm);
        setStatus("Saving public profile...");
        const response = await fetch("/api/me/public-profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            public: fd.has("public"),
            handle: String(fd.get("handle") || "").trim() || null,
            showRotation: fd.has("showRotation"),
            showTwitch: fd.has("showTwitch"),
            showStreak: fd.has("showStreak"),
            avatarProvider: String(fd.get("avatarProvider") || "") || null
          })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = body.error || "Could not save public profile.";
          setStatus(message);
          if (window.appToast) window.appToast(message, "error");
          return;
        }
        setStatus("Public profile saved.");
        if (window.appToast) window.appToast("Public profile saved.", "success");
        window.setTimeout(() => window.location.reload(), 600);
      });

      document.querySelectorAll("button[data-unlink]").forEach((button) => {
        button.addEventListener("click", async () => {
          const provider = button.getAttribute("data-unlink");
          const name = provider === "twitch" ? "Twitch" : "Discord";
          if (!provider || !window.confirm("Unlink " + name + "? You won't be able to sign in with it until you link it again.")) return;
          setStatus("Unlinking " + name + "...");
          const response = await fetch("/api/me/accounts/" + encodeURIComponent(provider), { method: "DELETE" });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setStatus(body.error || "Could not unlink " + name + ".");
            return;
          }
          window.location.href = "/me/settings";
        });
      });

      document.querySelectorAll("button[data-session-revoke]").forEach((button) => {
        button.addEventListener("click", async () => {
          const sessionId = button.getAttribute("data-session-revoke");
          if (!sessionId) return;
          setStatus("Revoking session...");
          const response = await fetch("/api/me/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
          if (!response.ok) {
            setStatus("Could not revoke session.");
            return;
          }
          setStatus("Session revoked.");
          window.location.reload();
        });
      });

      const deleteInput = document.getElementById("delete-account-confirm");
      const deleteButton = document.getElementById("delete-account-button");
      if (deleteInput && deleteButton) {
        deleteInput.addEventListener("input", () => {
          deleteButton.disabled = deleteInput.value !== "DELETE";
        });
        const clearPages = () => {
          try { if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: "clear-pages" }); } catch (e) {}
          if (!window.caches) return Promise.resolve();
          return caches.keys().then((names) => Promise.all(names.filter((n) => n.indexOf("dgl-pages-") === 0).map((n) => caches.delete(n)))).catch(() => {});
        };
        const dropPush = () => {
          try { window.localStorage.removeItem("dgl_push_v1"); } catch (e) {}
          if (!("serviceWorker" in navigator) || !("PushManager" in window)) return Promise.resolve();
          return navigator.serviceWorker.getRegistration().then((reg) => (reg ? reg.pushManager.getSubscription() : null)).then((sub) => (sub ? sub.unsubscribe() : null)).catch(() => {});
        };
        deleteButton.addEventListener("click", async () => {
          if (deleteInput.value !== "DELETE") return;
          if (!window.confirm("Delete your account for good? This can't be undone.")) return;
          deleteButton.disabled = true;
          setStatus("Deleting your account...");
          try {
            const response = await fetch("/api/me", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: deleteInput.value }) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
              const message = data.error || "Could not delete your account.";
              setStatus(message);
              if (window.appToast) window.appToast(message, "error");
              deleteButton.disabled = deleteInput.value !== "DELETE";
              return;
            }
            await Promise.race([Promise.all([clearPages(), dropPush()]), new Promise((resolve) => setTimeout(resolve, 1500))]);
            window.location.assign("/");
          } catch (error) {
            setStatus("Could not delete your account.");
            if (window.appToast) window.appToast("Could not delete your account.", "error");
            deleteButton.disabled = deleteInput.value !== "DELETE";
          }
        });
      }
    `,
  "lists-page": `      (() => {
        const form = document.getElementById("create-list-form");
        if (!form) return;
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          const status = document.getElementById("create-list-status");
          try {
            const res = await fetch("/api/lists", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              body: JSON.stringify({
                title: fd.get("title"),
                description: fd.get("description") || undefined,
                visibility: fd.get("visibility"),
              }),
            });
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(body.error || "Failed to create list");
            }
            window.location.reload();
          } catch (err) {
            if (status) status.textContent = err.message;
          }
        });
      })();
    `,
  "list-layout": `      // Phones: the list, Fan-dles and suggestions are tabs (.list-tabs). From 900px the list stands alone and Fan-dles and
      // suggestions are tabs in the right-hand sidebar (.side-tabs), which can collapse to a rail (dgl_list_sidebar_v1).
      (() => {
        const layout = document.querySelector(".list-layout");
        const tabs = [...document.querySelectorAll(".list-tabs [role=tab]")];
        const sideTabs = [...document.querySelectorAll(".side-tabs [role=tab]")];
        const toggle = document.getElementById("side-toggle");
        if (!layout || tabs.length === 0) return;
        const root = document.documentElement;
        const names = tabs.map((tab) => tab.dataset.tab);
        const sideNames = sideTabs.map((tab) => tab.dataset.side);
        const wide = window.matchMedia("(min-width: 900px)");
        const panel = document.getElementById("suggest-panel");
        const selectPhone = (name, focus) => {
          layout.dataset.tab = name;
          tabs.forEach((tab) => {
            const on = tab.dataset.tab === name;
            tab.setAttribute("aria-selected", on ? "true" : "false");
            tab.tabIndex = on ? 0 : -1;
            if (on && focus) tab.focus();
          });
          if (name === "suggest" && panel) panel.open = true;
        };
        const selectSide = (name, focus) => {
          layout.dataset.side = name;
          sideTabs.forEach((tab) => {
            const on = tab.dataset.side === name;
            tab.setAttribute("aria-selected", on ? "true" : "false");
            tab.tabIndex = on ? 0 : -1;
            if (on && focus) tab.focus();
          });
          if (name === "suggest" && panel) panel.open = true;
        };
        const select = (name, focus, byUser) => {
          if (names.includes(name)) selectPhone(name, focus && !wide.matches);
          if (sideNames.includes(name)) selectSide(name, focus && wide.matches);
          if (byUser && !wide.matches) { try { history.replaceState(null, "", "#" + name); } catch {} }
        };
        tabs.forEach((tab, index) => {
          tab.addEventListener("click", () => select(tab.dataset.tab, false, true));
          tab.addEventListener("keydown", (event) => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            select(names[(index + step + names.length) % names.length], true, true);
          });
        });
        // Collapse to a rail; the choice is remembered in this browser.
        const setCollapsed = (on, persist) => {
          root.classList.toggle("dgl-sb-collapsed", on);
          if (toggle) {
            toggle.setAttribute("aria-expanded", on ? "false" : "true");
            toggle.setAttribute("aria-label", on ? "Expand sidebar" : "Collapse sidebar");
            toggle.title = on ? "Expand sidebar" : "Collapse sidebar";
          }
          if (persist) { try { window.localStorage.setItem("dgl_list_sidebar_v1", on ? "collapsed" : "expanded"); } catch {} }
        };
        setCollapsed(root.classList.contains("dgl-sb-collapsed"), false);
        toggle?.addEventListener("click", () => setCollapsed(!root.classList.contains("dgl-sb-collapsed"), true));
        sideTabs.forEach((tab, index) => {
          tab.addEventListener("click", () => {
            // A tab in the rail opens the sidebar on that tab.
            if (root.classList.contains("dgl-sb-collapsed")) setCollapsed(false, true);
            select(tab.dataset.side, false, true);
          });
          tab.addEventListener("keydown", (event) => {
            const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            select(sideNames[(index + step + sideNames.length) % sideNames.length], true, true);
          });
        });
        const fromHash = window.location.hash.slice(1);
        const start = names.includes(fromHash) ? fromHash : names.includes(layout.dataset.defaultTab) ? layout.dataset.defaultTab : "list";
        select(start);
        if (!sideNames.includes(start)) selectSide(sideNames[0]);
        if (fromHash && sideNames.includes(fromHash) && wide.matches) setCollapsed(false, false);
        // Keep the tabs' Suggestions numbers in step with the panel's own count.
        const count = document.getElementById("suggest-count");
        const tabCounts = [...document.querySelectorAll("[data-tab-count=suggest]")];
        if (count && tabCounts.length > 0) {
          const sync = () => { const text = count.textContent.replace(/[()]/g, "").trim(); tabCounts.forEach((node) => { node.textContent = text; }); };
          new MutationObserver(sync).observe(count, { childList: true, characterData: true, subtree: true });
        }
      })();
    `,
  "admin-settings": `      const settingsForm = document.getElementById("settings-form");
      const playedCheck = document.getElementById("played-on-stream");
      const playedNote = document.getElementById("played-on-stream-note");
      playedCheck?.addEventListener("change", () => {
        playedNote.textContent = playedCheck.checked ? "On: everyone sees and uses Played on stream on lists." : "Off: only admins see and use it on lists.";
      });
      settingsForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = new FormData(settingsForm);
        const num = (name) => { const raw = String(data.get(name) || "").trim(); return raw === "" ? null : Number(raw); };
        const statusNode = document.getElementById("settings-status");
        statusNode.textContent = "Saving...";
        const res = await fetch("/api/admin/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fandleMaxPerDeveloper: num("perDeveloper"), fandleMaxShown: num("shown"), fandleMembershipDays: num("membershipDays"), playedOnStream: playedCheck.checked ? "on" : "off" })
        });
        const body = await res.json().catch(() => ({}));
        statusNode.textContent = res.ok ? "Saved." : body.error || "Could not save.";
        if (window.appToast) window.appToast(statusNode.textContent, res.ok ? "success" : "error");
      });
    `,
  "admin-creators": `      const failWith = (message) => {
        document.getElementById("creators-status").textContent = message;
        if (window.appToast) window.appToast(message, "error");
      };
      document.getElementById("allowlist-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const login = String(new FormData(event.target).get("login") || "").trim();
        const res = await fetch("/api/admin/creators/twitch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login }) });
        const data = await res.json().catch(() => ({}));
        if (res.ok) window.location.href = "/admin/creators";
        else failWith(data.error || "Could not verify that streamer.");
      });
      document.querySelectorAll("[data-allowlist-remove]").forEach((button) => {
        button.addEventListener("click", async () => {
          const id = button.closest("[data-twitch-id]").getAttribute("data-twitch-id");
          const res = await fetch("/api/admin/creators/twitch/" + encodeURIComponent(id), { method: "DELETE" });
          if (res.ok) window.location.href = "/admin/creators";
          else failWith("Could not remove that streamer.");
        });
      });
      document.querySelectorAll("[data-creator-action]").forEach((button) => {
        button.addEventListener("click", async () => {
          const card = button.closest("[data-user-id]");
          const res = await fetch("/api/admin/users/" + card.getAttribute("data-user-id") + "/creator", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grant: button.getAttribute("data-creator-action") === "grant" })
          });
          if (res.ok) {
            window.location.href = "/admin/creators";
            return;
          }
          const data = await res.json().catch(() => ({}));
          const message = data.error || "Could not update.";
          document.getElementById("creators-status").textContent = message;
          if (window.appToast) window.appToast(message, "error");
        });
      });
    `,
  "admin-reports": `      const statusNode = document.getElementById("admin-reports-status");
      const setStatus = (text) => {
        if (statusNode) statusNode.textContent = text;
      };

      const confirmations = {
        delete: "Permanently delete the reported game(s)? This also removes votes, favorites and all reports for them. This cannot be undone."
      };

      const runAction = async (reportId, action) => {
        if (confirmations[action] && !window.confirm(confirmations[action])) return;
        setStatus("Running " + action + "...");
        const response = await fetch("/api/admin/reports/" + reportId + "/" + action, { method: "POST" });
        if (!response.ok) {
          setStatus("Action failed.");
          return;
        }
        setStatus("Action complete. Refreshing...");
        window.location.reload();
      };

      const collectSelectedIds = () => {
        const checks = Array.from(document.querySelectorAll("input[type=checkbox][data-report-select]"));
        return checks
          .filter((box) => box instanceof HTMLInputElement && box.checked)
          .map((box) => box.getAttribute("value"))
          .filter((id) => typeof id === "string" && id.length > 0);
      };

      const runBulkAction = async (action) => {
        const ids = collectSelectedIds();
        if (ids.length === 0) {
          setStatus("Select at least one report first.");
          return;
        }
        if (confirmations[action] && !window.confirm(confirmations[action])) return;
        setStatus("Running bulk " + action + " on " + ids.length + " item(s)...");
        const response = await fetch("/api/admin/reports/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ids })
        });
        if (!response.ok) {
          setStatus("Bulk action failed.");
          return;
        }
        setStatus("Bulk action complete. Refreshing...");
        window.location.reload();
      };

      document.querySelectorAll("button[data-report-action][data-report-id]").forEach((button) => {
        button.addEventListener("click", () => {
          const reportId = button.getAttribute("data-report-id");
          const action = button.getAttribute("data-report-action");
          if (!reportId || !action) return;
          void runAction(reportId, action);
        });
      });

      document.querySelectorAll("button[data-bulk-report-action]").forEach((button) => {
        button.addEventListener("click", () => {
          const action = button.getAttribute("data-bulk-report-action");
          if (!action) return;
          void runBulkAction(action);
        });
      });

      document.querySelector("button[data-select-all-reports]")?.addEventListener("click", () => {
        const checks = Array.from(document.querySelectorAll("input[type=checkbox][data-report-select]"));
        const allChecked = checks.every((box) => box instanceof HTMLInputElement && box.checked);
        checks.forEach((box) => {
          if (box instanceof HTMLInputElement) {
            box.checked = !allChecked;
          }
        });
      });
    `,
  "admin-categories": `      const statusNode = document.getElementById("admin-categories-status");
      const setStatus = (text) => {
        if (statusNode) statusNode.textContent = text;
      };

      const createForm = document.getElementById("create-category-form");
      createForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!(createForm instanceof HTMLFormElement)) return;
        const fd = new FormData(createForm);
        const payload = {
          slug: String(fd.get("slug") || ""),
          name: String(fd.get("name") || ""),
          description: String(fd.get("description") || "").trim() || undefined,
          isActive: fd.get("isActive") === "on"
        };
        setStatus("Creating category...");
        const response = await fetch("/api/admin/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          setStatus("Could not create category.");
          return;
        }
        setStatus("Category created.");
        window.location.reload();
      });

      document.querySelectorAll("button[data-category-toggle]").forEach((button) => {
        button.addEventListener("click", async () => {
          const categoryId = button.getAttribute("data-category-toggle");
          const nextActive = button.getAttribute("data-next-active") === "1";
          if (!categoryId) return;
          setStatus("Updating category...");
          const response = await fetch("/api/admin/categories/" + categoryId, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive: nextActive })
          });
          if (!response.ok) {
            setStatus("Could not update category.");
            return;
          }
          setStatus("Category updated.");
          window.location.reload();
        });
      });

      document.querySelectorAll("button[data-category-delete]").forEach((button) => {
        button.addEventListener("click", async () => {
          const categoryId = button.getAttribute("data-category-delete");
          if (!categoryId) return;
          if (!window.confirm("Delete this category?")) return;
          setStatus("Deleting category...");
          const response = await fetch("/api/admin/categories/" + categoryId, { method: "DELETE" });
          if (!response.ok) {
            setStatus("Could not delete category.");
            return;
          }
          setStatus("Category deleted.");
          window.location.reload();
        });
      });
    `,
  "admin-lists": `      const statusNode = document.getElementById("admin-lists-status");
      const setStatus = (text) => {
        if (statusNode) statusNode.textContent = text;
      };

      const createForm = document.getElementById("create-list-form");
      createForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!(createForm instanceof HTMLFormElement)) return;
        const fd = new FormData(createForm);
        const payload = {
          title: String(fd.get("title") || ""),
          description: String(fd.get("description") || "").trim() || undefined,
          visibility: String(fd.get("visibility") || "private")
        };
        setStatus("Creating list...");
        const response = await fetch("/api/lists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          setStatus("Could not create list.");
          return;
        }
        setStatus("List created.");
        window.location.reload();
      });

      document.querySelectorAll("button[data-list-visibility]").forEach((button) => {
        button.addEventListener("click", async () => {
          const listId = button.getAttribute("data-list-visibility");
          const visibility = button.getAttribute("data-next-visibility");
          if (!listId || !visibility) return;
          setStatus("Updating visibility...");
          const response = await fetch("/api/lists/" + listId + "/visibility", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ visibility })
          });
          if (!response.ok) {
            setStatus("Could not update visibility.");
            return;
          }
          setStatus("Visibility updated.");
          window.location.reload();
        });
      });

      document.querySelectorAll("button[data-list-delete]").forEach((button) => {
        button.addEventListener("click", async () => {
          const listId = button.getAttribute("data-list-delete");
          if (!listId) return;
          if (!window.confirm("Delete this list?")) return;
          setStatus("Deleting list...");
          const response = await fetch("/api/lists/" + listId, { method: "DELETE" });
          if (!response.ok) {
            setStatus("Could not delete list.");
            return;
          }
          setStatus("List deleted.");
          window.location.reload();
        });
      });

      document.querySelectorAll("form[data-list-add-item]").forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!(form instanceof HTMLFormElement)) return;
          const listId = form.getAttribute("data-list-add-item");
          if (!listId) return;
          const fd = new FormData(form);
          const payload = {
            gameId: String(fd.get("gameId") || ""),
            position: Number(fd.get("position") || 1)
          };
          setStatus("Adding item...");
          const response = await fetch("/api/lists/" + listId + "/items", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            setStatus("Could not add list item.");
            return;
          }
          setStatus("Item added.");
          window.location.reload();
        });
      });

      document.querySelectorAll("form[data-list-edit]").forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!(form instanceof HTMLFormElement)) return;
          const listId = form.getAttribute("data-list-edit");
          if (!listId) return;
          const fd = new FormData(form);
          const payload = {
            title: String(fd.get("title") || ""),
            slug: String(fd.get("slug") || ""),
            description: String(fd.get("description") || "")
          };
          setStatus("Saving list details...");
          const response = await fetch("/api/lists/" + listId, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            setStatus("Could not save list details.");
            return;
          }
          setStatus("List details saved.");
          if (window.appToast) window.appToast("List details updated.", "success");
          window.location.reload();
        });
      });

      document.querySelectorAll("button[data-list-remove-item][data-game-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          const listId = button.getAttribute("data-list-remove-item");
          const gameId = button.getAttribute("data-game-id");
          if (!listId || !gameId) return;
          setStatus("Removing item...");
          const response = await fetch("/api/lists/" + listId + "/items/" + gameId, { method: "DELETE" });
          if (!response.ok) {
            setStatus("Could not remove item.");
            return;
          }
          setStatus("Item removed.");
          window.location.reload();
        });
      });

      document.querySelectorAll("ul[data-sortable-list]").forEach((listNode) => {
        let dragItem = null;
        const listId = listNode.getAttribute("data-sortable-list");
        const items = () => Array.from(listNode.querySelectorAll("li[data-game-id]"));

        const moveItemByDirection = (item, direction) => {
          if (!(item instanceof HTMLElement)) return;
          if (direction === "up") {
            const previous = item.previousElementSibling;
            if (previous) {
              listNode.insertBefore(item, previous);
            }
            return;
          }
          const next = item.nextElementSibling;
          if (next) {
            listNode.insertBefore(next, item);
          }
        };

        const relabel = () => {
          items().forEach((item, index) => {
            const label = item.querySelector(".position-label");
            if (label) label.textContent = String(index + 1);
          });
        };

        relabel();

        items().forEach((item) => {
          item.addEventListener("dragstart", () => {
            dragItem = item;
            item.classList.add("dragging");
          });

          item.addEventListener("dragend", () => {
            item.classList.remove("dragging");
            dragItem = null;
            relabel();
            if (listId) {
              void saveListOrder(listId, false);
            }
          });

          item.addEventListener("dragover", (event) => {
            event.preventDefault();
          });

          item.addEventListener("drop", (event) => {
            event.preventDefault();
            if (!dragItem || dragItem === item) return;
            const rect = item.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (before) {
              listNode.insertBefore(dragItem, item);
            } else {
              listNode.insertBefore(dragItem, item.nextSibling);
            }
            relabel();
          });

          item.querySelectorAll("button[data-list-move]").forEach((button) => {
            button.addEventListener("click", () => {
              const direction = button.getAttribute("data-list-move");
              if (!direction) return;
              moveItemByDirection(item, direction);
              relabel();
              if (listId) {
                void saveListOrder(listId, false);
              }
            });
          });
        });
      });

      const saveListOrder = async (listId, reloadAfterSave) => {
        const listNode = document.querySelector("ul[data-sortable-list='" + listId + "']");
        if (!listNode) return;
        const items = Array.from(listNode.querySelectorAll("li[data-game-id]"));
        const payload = {
          items: items.map((item, index) => ({
            gameId: item.getAttribute("data-game-id"),
            position: index + 1
          }))
        };
        setStatus("Saving item order...");
        const response = await fetch("/api/lists/" + listId + "/items/reorder", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          setStatus("Could not save item order.");
          if (window.appToast) window.appToast("Could not save item order.", "error");
          return;
        }
        setStatus("Item order saved.");
        if (window.appToast) window.appToast("List order saved.", "success");
        if (reloadAfterSave) {
          window.location.reload();
        }
      };

      document.querySelectorAll("button[data-save-list-order]").forEach((button) => {
        button.addEventListener("click", async () => {
          const listId = button.getAttribute("data-save-list-order");
          if (!listId) return;
          await saveListOrder(listId, true);
        });
      });
    `,
};
