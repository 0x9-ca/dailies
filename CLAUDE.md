# CLAUDE.md

Guide for working on **0x9 dles** (https://dailies.0x9.ca): a Cloudflare Worker (Hono + D1 + KV) directory of daily games. Product behaviour, data model and feature details live in AGENTS.md, imported here:

@AGENTS.md

## Commands

```bash
npm run typecheck                 # tsc --noEmit; also run with --noUnusedLocals before committing
npm run dev                       # wrangler dev on the LAN IP (192.168.17.2:8787), local D1/KV
npm run deploy:staging            # dailies-stg.0x9.ca
npm run deploy:production         # dailies.0x9.ca
npm run schema:dump               # regenerate docs/schema.sql from migrations (never touches a real DB)
npm run validate:config           # sanity-check wrangler.jsonc
```

There is no test runner in the repo. Verify changes by running the app (see Testing).

## Environments and data safety

| Env | Worker | D1 | KV | URL |
|---|---|---|---|---|
| default (dev) | `wrangler dev` only, **never deploy** | `daily-game-list-staging` | staging KV | local |
| staging | `daily-game-list-staging` | `daily-game-list-staging` | staging KV | dailies-stg.0x9.ca |
| production | `daily-game-list-production` | `daily-game-list` | production KV | dailies.0x9.ca |

- Production has its own D1 and KV. Staging holds a copy of the public catalog only (no users, votes or lists).
- **Never run `wrangler deploy` without `--env`.** The default config has `APP_ENV=development`, which enables `/auth/mock-login/:role` (instant admin). The route also checks that the request host matches `APP_URL`, but don't rely on that.
- In `wrangler d1` commands use the **`DB` binding plus `--env`**, never the database name. A name such as `daily-game-list` resolves to production regardless of `--env`:
  ```bash
  npx wrangler d1 execute DB --env staging --remote --command "SELECT ..."
  npx wrangler d1 migrations apply DB --env production --remote
  ```
- workers.dev and preview URLs are disabled for staging and production (`workers_dev: false`).
- `scripts/set-secrets.sh` only pushes secrets to staging and production. Per-env binding IDs: `D1_DATABASE_ID`/`KV_NAMESPACE_ID` (production) and `*_STAGING` (staging and dev).

## Deploying

1. `npm run typecheck`, commit to `main`.
2. **If the change touches data (migrations, data fixes), back up first:**
   `npx wrangler d1 export DB --env production --remote --output backups/daily-game-list-<UTC timestamp>-<reason>.sql`
   (`backups/` is git-ignored; `chmod 600` the file.)
3. Apply pending migrations to staging, then production: `npx wrangler d1 migrations list DB --env <env> --remote`, then `... migrations apply ...`.
4. `npm run deploy:staging`, check https://dailies-stg.0x9.ca, then `npm run deploy:production`.
5. `git push origin main`.

After deploying, logged-out pages can serve the previous HTML for up to 60s (edge cache, see below). Wait for the new markup before verifying.

## Testing locally

Use a throwaway local D1 so dev state and the real DBs are never touched:

```bash
P=/tmp/dles-state
npx wrangler d1 migrations apply DB --local --persist-to $P
npx wrangler dev --ip 127.0.0.1 --port 8799 --persist-to $P --var APP_URL:http://127.0.0.1:8799
```

- Log in instantly with `/auth/mock-login/user|editor|admin` (development only). To exercise the real sign-in, link and merge code without Discord/Twitch, use `/auth/mock-oauth/<discord|twitch>/<made-up id>` (add `?link=1` to link to the signed-in user, `&role=editor|admin` for Discord). Seed games as admin through `POST /api/games` (send the `x-csrf-token` header equal to the `csrf_token` cookie); admin submissions are auto-approved.
- The edge cache is off in development. To exercise it, add `--var APP_ENV:staging` (mock login is then disabled) and watch the `X-Page-Cache: HIT|MISS` header.
- Check UI changes in a real browser at phone (≈375–390px) and desktop widths: no horizontal overflow, no page errors, and both themes (`localStorage.dgl_theme = "light"`). Real Discord/Twitch login can only be tested on staging or production.

## Code map

Nearly everything is in `src/index.ts` (routes, SSR templates, inline client scripts, CSS in `layout()`):

- Top of file: middleware (noindex for non-production, edge cache, CSRF), OAuth routes and helpers (`beginOAuth`, `readOAuthCallback`, `exchangeOAuthCode`, `revokeOAuthToken`, `upsertOAuthUser`).
- Page routes, then `/api/*` routes, then the `scheduled` handler (link checks, score recalculation, expired-session cleanup).
- Rendering helpers: `layout()`, `renderCompactGameList()` (game cards), `renderDetailsLink()`, `renderGameMeta()`, `renderResetSpan()`, `getViewerGameState()`.
- Shared client scripts (template strings injected by `layout()`): `GAME_ACTIONS_SCRIPT` (`window.dglGames`: votes, favorites, local favorites, import), `RESET_LOCALIZE_SCRIPT` (countdowns and the card reset line, refreshed every minute), `LIST_SORT_SCRIPT`.
- `src/lib/`: `auth.ts` (sessions, role guards), `cache.ts` (KV JSON cache), `ranking.ts` (score), `url.ts` (URL canonicalisation), `assets.ts` (base64 PNGs, generated), `og.ts` (per-game social images), `og-fonts.ts` (base64 fonts, generated).
- `migrations/` (append-only), `docs/schema.sql` (generated), `docs/API.md`, `assets-src/` (image sources).

## Rules that matter

**Security**
- Embed server values in inline `<script>` with `scriptJson(value)`, never raw `JSON.stringify` (a `</script>` in a game title would break out). In client code, put user text in the DOM with `textContent`, not `innerHTML`.
- `escapeHtml()` every user-controlled value in HTML and attributes.
- Mutating `/api/*` routes need CSRF (automatic) plus `requireAuth`/`requireRole`/`requireListEditor` as appropriate. Keep SQL parameterised.
- OAuth stores only the provider user id, a placeholder email (`<provider>-<id>@users.noreply.dailies`, never shown to anyone) and the initial display name. Provider tokens are revoked right after the profile read. Discord roles are re-synced on every login.

**Edge cache**
- Logged-out GETs of `/`, `/games`, `/games/:slug`, `/lists`, `/lists/:slug` and `/mod-log` are cached for 60s. Sessions and the `dgl_voted` cookie (set after a vote) bypass it.
- A cached page is shown to every visitor, so **never render per-visitor state when `c.get("publicCache")` is true**. Use `getViewerGameState()` for votes and favorites; it already handles this.

**UI conventions**
- Game cards and rows are tappable: container `card-click`, game-name link `card-link` (its `::after` covers the card). Other controls inside (buttons, `.btn-details`, `.category-pill`, `.drag`) must stay above it via the `.card-click` CSS. Don't use it on rows dragged as a whole (list edit mode).
- Game names use `.game-title`. Links to a game's page use `renderDetailsLink()`, a real `<a>` so crawlers can follow it.
- Page routes return `notFoundPage(c)` for missing content, never `c.text("Not found", 404)` (that leaves visitors on a bare text page and Google sees a soft 404).
- Text and list pages use `<main class="narrow">`. Grid pages use the full 1200px.
- Phones: small buttons in cards get an invisible ≥44px tap area (`::after` with negative inset), not a bigger visual size. Test at 320–430px widths. The header moves Submit into the ☰ menu at ≤400px.
- Colours are CSS variables in `layout()` with dark (default) and `html[data-theme="light"]` values. Add both when adding a colour.
- The brand is **"0x9 dles"** (page titles get the `| 0x9 dles` suffix automatically), with the "x" in `--brand-blue`.

**Data**
- Migrations are append-only. Never edit a file that has been applied. (Production's `games` table already lacks the `reset_basis`/`reset_time_minutes` CHECK constraints that today's `0012` creates, because that file was edited after it ran. The app validates both fields itself.) Run `npm run schema:dump` after adding one.
- `game_categories.assigned_by_user_id` is required. Use the system user `00000000-0000-0000-0000-000000000001` for automated rows.
- Call `invalidateGameCaches()` after changing anything shown in game lists.

## Social image

`/og.png` is `OG_IMAGE_PNG` in `src/lib/assets.ts`, rendered from `assets-src/og-image.html`:
1. Edit the HTML. Render it in a headless browser at exactly 1200×630 (wait for `document.fonts.ready`; it loads Manrope from Google Fonts) and save `assets-src/og-image.png`.
2. Replace the base64 in `OG_IMAGE_PNG`.
3. Bump the `?v=` on the `og:image`/`twitter:image` URLs in `layout()` so social platforms refetch it.

Game pages have their own image, drawn on request by `src/lib/og.ts` (no build step). Its layout uses satori's CSS subset: every element is a flex container, and there's no grid or `position: sticky`. Check a change by fetching `/og/games/<slug>.png` from `wrangler dev`. The fonts are Manrope 500/800 WOFF (satori can't read WOFF2) from `assets-src/fonts/`, base64-encoded into `src/lib/og-fonts.ts`.
