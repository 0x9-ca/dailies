// Embeddable list widget (GET /embed/lists/:slug): a minimal standalone page for iframes on other sites, plus the
// script for the "Embed" dialog on the list page.

export type EmbedOptions = { theme: "dark" | "light" | "auto"; limit: number | null; showTitle: boolean; transparent: boolean };

export type EmbedItem = {
  id: string;
  title: string;
  url: string;
  paywall: boolean;
  resetKind: string | null;
  resetMin: number | null;
  resetLabel: string;
};

export function parseEmbedOptions(query: (name: string) => string | undefined): EmbedOptions {
  const theme = query("theme");
  const limit = Number.parseInt(query("limit") ?? "", 10);
  return {
    theme: theme === "dark" || theme === "light" ? theme : "auto",
    limit: Number.isFinite(limit) && limit >= 1 ? Math.min(limit, 50) : null,
    showTitle: query("title") !== "0",
    transparent: query("transparent") === "1"
  };
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const EMBED_CSS = `
:root{--bg:#121212;--ink:#e0e0e0;--muted:#b0b0b0;--border:#444;--link:#f2f2f2;--brand:#00a4fc;--paywall:#4ade80}
html[data-theme=light]{--bg:#fff;--ink:#1c1c1c;--muted:#5c5c5c;--border:#d4d4d4;--link:#111;--brand:#006db3;--paywall:#15803d}
@media (prefers-color-scheme:light){html[data-theme=auto]{--bg:#fff;--ink:#1c1c1c;--muted:#5c5c5c;--border:#d4d4d4;--link:#111;--brand:#006db3;--paywall:#15803d}}
html[data-theme=dark]{color-scheme:dark}html[data-theme=light]{color-scheme:light}html[data-theme=auto]{color-scheme:dark light}
html.transparent,html.transparent body{background:transparent}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:12px 14px;overflow-wrap:anywhere}
h1{font-size:1.15rem;margin:0 0 8px;display:flex;align-items:center;gap:6px;line-height:1.25}
h1 svg{flex:none;width:1em;height:1em}
ol{list-style:none;margin:0;padding:0;counter-reset:n}
li{counter-increment:n;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;padding:7px 0;border-top:1px solid var(--border)}
li:first-child{border-top:0}
li::before{content:counter(n);flex:none;min-width:1.4em;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
.name{flex:1 1 9rem;min-width:0}
a{color:var(--link);font-weight:600;text-decoration:none}
a:hover,a:focus-visible{text-decoration:underline}
.badge{display:inline-block;margin-left:5px;padding:0 5px;border:1px solid var(--paywall);border-radius:5px;color:var(--paywall);font-size:.75rem;font-weight:700;line-height:1.35}
.reset{flex:none;margin-left:auto;color:var(--muted);font-size:.82rem;white-space:nowrap}
.empty{color:var(--muted);margin:6px 0}
footer{margin-top:10px;padding-top:8px;border-top:1px solid var(--border);color:var(--muted);font-size:.78rem;display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px}
footer a{color:var(--brand);font-weight:600}
`;

// Tiny copy of dglResetCountdown: "Resets in 3h 12m". "utc" minutes are a UTC time of day, "local" ones the viewer's clock.
// Clicks on a game are sent with sendBeacon: the embed is a cross-site iframe, so the site's CSRF-aware fetch isn't there.
const EMBED_SCRIPT = `
(function () {
  function tick() {
    var els = document.querySelectorAll("[data-kind]");
    for (var i = 0; i < els.length; i++) {
      var m = Number(els[i].getAttribute("data-min"));
      if (!isFinite(m)) continue;
      var now = new Date(), next = new Date(now);
      if (els[i].getAttribute("data-kind") === "utc") next.setUTCHours(Math.floor(m / 60), m % 60, 0, 0);
      else next.setHours(Math.floor(m / 60), m % 60, 0, 0);
      if (next <= now) next.setTime(next.getTime() + 864e5);
      var left = Math.ceil((next - now) / 6e4), h = Math.floor(left / 60);
      els[i].textContent = "Resets in " + (h > 0 ? h + "h " : "") + (left % 60) + "m";
    }
  }
  tick();
  setInterval(tick, 6e4);
  var lastSent = {};
  function click(e) {
    if (e.type === "auxclick" && e.button !== 1) return;
    var a = e.target.closest && e.target.closest("a[data-game]");
    if (!a || !navigator.sendBeacon) return;
    var id = a.getAttribute("data-game"), now = Date.now();
    if (lastSent[id] && now - lastSent[id] < 2000) return;
    lastSent[id] = now;
    navigator.sendBeacon("/api/embed/click/" + encodeURIComponent(id));
  }
  document.addEventListener("click", click);
  document.addEventListener("auxclick", click);
})();
`;

export function renderEmbedPage(args: {
  title: string;
  verified: boolean;
  items: EmbedItem[];
  options: EmbedOptions;
  canonicalUrl: string;
  suggestLabel: string;
  siteUrl: string;
  checkSvg: string;
}): string {
  const { options } = args;
  const rows = args.items.map((item) => {
    const reset = item.resetKind && item.resetMin !== null && item.resetLabel
      ? `<span class="reset" data-kind="${esc(item.resetKind)}" data-min="${item.resetMin}">${esc(item.resetLabel)}</span>`
      : "";
    return `<li><span class="name"><a href="${esc(item.url)}" target="_blank" rel="noopener" data-game="${esc(item.id)}">${esc(item.title)}</a>${item.paywall ? `<span class="badge" title="This game requires payment to play">$</span>` : ""}</span>${reset}</li>`;
  }).join("");
  const heading = options.showTitle
    ? `<h1><span>${esc(args.title)}</span>${args.verified ? `<span title="Verified content creator" aria-label="Verified">${args.checkSvg}</span>` : ""}</h1>`
    : "";
  return `<!doctype html>
<html lang="en" data-theme="${options.theme}"${options.transparent ? ` class="transparent"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(args.title)} | 0x9 dles</title>
<link rel="canonical" href="${esc(args.canonicalUrl)}">
<style>${EMBED_CSS}</style>
</head>
<body>
<main>${heading}${rows ? `<ol>${rows}</ol>` : `<p class="empty">No games in this list yet.</p>`}</main>
<footer><span>Suggest a game at <a href="${esc(args.canonicalUrl)}" target="_blank" rel="noopener">${esc(args.suggestLabel)}</a></span><a href="${esc(args.siteUrl)}" target="_blank" rel="noopener">via 0x9 dles</a></footer>
<script>${EMBED_SCRIPT}</script>
</body>
</html>`;
}

export function renderEmbedNotFound(siteUrl: string): string {
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>List not found | 0x9 dles</title><style>${EMBED_CSS}</style></head>
<body><main><p class="empty">This list isn't available. It may be private or removed.</p></main><footer><span></span><a href="${esc(siteUrl)}" target="_blank" rel="noopener">via 0x9 dles</a></footer></body>
</html>`;
}

/** Markup of the Embed dialog on the list page (opened by #embed-btn). */
export function renderEmbedDialog(): string {
  return `<dialog id="embed-dialog" class="shortcuts-dialog embed-dialog" aria-labelledby="embed-title" style="width:min(34rem,calc(100vw - 2rem))">
  <h2 id="embed-title">Embed this list</h2>
  <p class="muted" style="margin:0 0 .6rem">Paste a small widget of this list on your own site, Notion or stream page.</p>
  <div style="display:flex;flex-wrap:wrap;gap:.5rem .9rem;align-items:center;margin-bottom:.6rem">
    <label>Theme <select id="embed-theme"><option value="auto">Auto</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
    <label>Games <input type="number" id="embed-limit" min="1" max="50" placeholder="All" style="width:4.5rem"></label>
    <label class="check"><input type="checkbox" id="embed-title-on" checked> Title</label>
    <label class="check"><input type="checkbox" id="embed-transparent"> Transparent</label>
  </div>
  <iframe id="embed-preview" title="Embed preview" height="300" style="width:100%;border:1px solid var(--border);border-radius:8px;background:repeating-conic-gradient(#8884 0 25%,transparent 0 50%) 0 0/16px 16px"></iframe>
  <label for="embed-code" style="display:block;margin:.6rem 0 .2rem">Embed code</label>
  <textarea id="embed-code" rows="4" readonly style="width:100%;font:.8rem ui-monospace,Menlo,Consolas,monospace"></textarea>
  <div class="actions"><button type="button" id="embed-copy">Copy code</button><button type="button" class="secondary" id="embed-close">Close</button></div>
</dialog>`;
}

export const EMBED_DIALOG_SCRIPT = `
(() => {
  const tag = document.currentScript;
  const origin = tag.dataset.origin, slug = tag.dataset.slug, listTitle = tag.dataset.title;
  const dialog = document.getElementById("embed-dialog");
  const btn = document.getElementById("embed-btn");
  if (!dialog || !btn) return;
  const $ = (id) => document.getElementById(id);
  const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const query = () => {
    const p = new URLSearchParams();
    if ($("embed-theme").value !== "auto") p.set("theme", $("embed-theme").value);
    const n = parseInt($("embed-limit").value, 10);
    if (n >= 1) p.set("limit", String(Math.min(n, 50)));
    if (!$("embed-title-on").checked) p.set("title", "0");
    if ($("embed-transparent").checked) p.set("transparent", "1");
    const q = p.toString();
    return q ? "?" + q : "";
  };
  const path = "/embed/lists/" + encodeURIComponent(slug);
  const update = () => {
    const q = query();
    $("embed-preview").src = path + q;
    $("embed-code").value = '<iframe src="' + attr(origin + path + q) + '" width="100%" height="600" style="border:0" title="' + attr(listTitle + " on 0x9 dles") + '" loading="lazy"></iframe>';
  };
  btn.addEventListener("click", () => { update(); if (!dialog.open) dialog.showModal(); });
  ["embed-theme", "embed-limit", "embed-title-on", "embed-transparent"].forEach((id) => { $(id).addEventListener("input", update); $(id).addEventListener("change", update); });
  $("embed-close").addEventListener("click", () => dialog.close());
  $("embed-copy").addEventListener("click", async () => {
    const code = $("embed-code");
    try { await navigator.clipboard.writeText(code.value); } catch { code.select(); document.execCommand("copy"); }
    $("embed-copy").textContent = "Copied";
    setTimeout(() => { $("embed-copy").textContent = "Copy code"; }, 1500);
  });
})();
`;
