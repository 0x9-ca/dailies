// Offline support. buildServiceWorker() returns the text of GET /sw.js; OFFLINE_SCRIPT is the client part (in app.js):
// registers the worker, shows the offline banner and wipes the cached pages on sign-out.
// Cached pages can hold a signed-in user's rotation, so they are deleted on logout (cache names are unversioned so they survive deploys).

export function buildServiceWorker(version: string, precache: string[]): string {
  return `"use strict";
// Deploy version (makes this file differ per deploy so the browser installs the new worker). Cache names are NOT
// versioned: saved pages must survive deploys, and their hashed assets stay in the static cache (capped below).
const VERSION = ${JSON.stringify(version)};
const STATIC = "dgl-static-v1";
const PAGES = "dgl-pages-v1";
const MAX_STATIC = 40;
const PRECACHE = ${JSON.stringify(["/offline", ...precache])};
const KEEP_NO_STORE = ["/", "/me/rotation"];
const SKIP = /^\\/(api|auth|admin|embed)\\//;

async function trimStatic(cache) {
  const keys = await cache.keys();
  let extra = keys.length - MAX_STATIC;
  for (const req of keys) {
    if (extra <= 0) break;
    const u = new URL(req.url);
    if (PRECACHE.includes(u.pathname)) continue;
    await cache.delete(req);
    extra--;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC)
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { credentials: "omit" })).catch(() => {}))).then(() => cache))
      .then((cache) => trimStatic(cache))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("dgl-") && n !== STATIC && n !== PAGES).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "clear-pages") {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith("dgl-pages-")).map((n) => caches.delete(n)))));
  }
});

function storable(response, path) {
  if (!response || !response.ok || response.type !== "basic") return false;
  const cc = (response.headers.get("Cache-Control") || "").toLowerCase();
  if (cc.includes("no-store") && !KEEP_NO_STORE.includes(path)) return false;
  return true;
}

async function offlinePage() {
  return (await caches.match("/offline")) || new Response("You're offline.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function navigate(request, url) {
  try {
    const response = await fetch(request);
    if (storable(response, url.pathname)) {
      const copy = response.clone();
      const cache = await caches.open(PAGES);
      await cache.put(url.pathname + url.search, copy);
    }
    return response;
  } catch (err) {
    const cache = await caches.open(PAGES);
    const hit = (await cache.match(url.pathname + url.search)) || (await cache.match(url.pathname, { ignoreSearch: true }));
    return hit || offlinePage();
  }
}

async function assetFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const copy = response.clone();
    caches.open(STATIC).then((cache) => cache.put(request, copy).then(() => trimStatic(cache))).catch(() => {});
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw.js" || SKIP.test(url.pathname)) return;
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(assetFirst(request));
  } else if (request.mode === "navigate") {
    event.respondWith(navigate(request, url));
  }
});
`;
}

export const OFFLINE_SCRIPT = `      (() => {
        if ("serviceWorker" in navigator) {
          window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
        }
        const clearPages = () => {
          try { if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: "clear-pages" }); } catch (e) {}
          if (!window.caches) return Promise.resolve();
          return caches.keys().then((names) => Promise.all(names.filter((n) => n.indexOf("dgl-pages-") === 0).map((n) => caches.delete(n)))).catch(() => {});
        };
        document.addEventListener("submit", (event) => {
          const form = event.target;
          if (!form || !form.matches || !form.matches('form[action="/auth/logout"]') || form.dataset.cleared) return;
          event.preventDefault();
          form.dataset.cleared = "1";
          const submit = () => { if (form.requestSubmit) form.requestSubmit(); else form.submit(); };
          Promise.race([clearPages(), new Promise((resolve) => setTimeout(resolve, 1500))]).then(submit, submit);
        }, true);
        document.addEventListener("click", (event) => {
          if (event.target && event.target.closest && event.target.closest("[data-offline-retry]")) window.location.reload();
        });
        if (document.querySelector("[data-offline-page]")) return;
        let banner = null;
        const sync = () => {
          if (!navigator.onLine) {
            if (banner) return;
            banner = document.createElement("div");
            banner.className = "offline-banner";
            banner.setAttribute("role", "status");
            banner.textContent = "You're offline. Showing your last saved copy.";
            document.body.insertBefore(banner, document.body.firstChild);
          } else if (banner) {
            banner.remove();
            banner = null;
          }
        };
        window.addEventListener("online", sync);
        window.addEventListener("offline", sync);
        sync();
      })();
`;
