# Agent Guide

This file helps coding agents quickly understand the repository.

## Product summary

Cloudflare Worker app for discovering daily games. Users can submit links, vote, favorite, report issues, and browse curated lists. Voting works for both authenticated and anonymous users. Editor/admin users moderate content and manage taxonomy/lists. Games have a `paywall` flag indicated by a green `$` badge on cards.

## Core files

- `src/index.ts`: routes, API handlers, SSR rendering, scheduled link check, and client-side inline scripts.
- `src/lib/auth.ts`: session creation/destruction, session middleware, role/auth guards.
- `src/lib/cache.ts`: KV JSON cache helpers and invalidation.
- `src/lib/ranking.ts`: Wilson + freshness/penalty/click/list score helper.
- `src/lib/url.ts`: URL canonicalization and slug helper.
- `src/env.ts`: Env type definitions.
- `migrations/*.sql`: D1 schema and seeds.

## Runtime model

- Server: Cloudflare Worker (Hono)
- DB: D1
- Cache: KV
- Background: scheduled handler (`scheduled`, daily cron `15 8 * * *`) for link-health checks, score recalculation and a backstop flush of the Discord announcement queue; the `AnnouncementScheduler` Durable Object's alarm sends the announcements

## Security model

- Cookie sessions (`SESSION_SECRET` hashed session tokens in D1)
- Role checks (`user`, `editor`, `admin`)
- CSRF enforcement on mutating `/api/*` requests with double-submit cookie (`csrf_token` + `x-csrf-token`)
- D1-backed fixed-window rate limiting for submit/vote/report (submissions: 10/hour per user or anonymous visitor; admins are exempt)

## Key behaviors

- Editor/admin submissions are auto-approved.
- Standard user submissions are `pending` until moderated.
- Private curated lists are visible to owner + editor/admin only (and the list's tagged Twitch user).
- Curated lists can be tagged with a Twitch user by editors/admins (`PATCH /api/lists/:id/twitch`, resolved via Helix to a stable `twitch_user_id`). Tagged lists show a blue verified check and a Twitch channel button. The matching Twitch-login user (via `oauth_accounts`) can edit the list's games, title and description (`requireListEditor`), but not slug, visibility, deletion, or the tag itself.
- Favorites support manual ordering and weekday masks.
- Anonymous favorites are local-first and can sync after login; anonymous votes are limited to one vote per game per IP hash.
- Login supports Discord and Twitch OAuth via `/login` (shared helpers `beginOAuth`/`readOAuthCallback`/`exchangeOAuthCode`/`revokeOAuthToken`). Provider access tokens are revoked right after the profile read and never stored. Discord roles are re-synced on every login. Logout is `POST /auth/logout`. Twitch requests no scopes (no email) and always yields role `user`. A first sign-in creates an account with a placeholder email; from Settings, a signed-in user can link the other provider (`POST /auth/:provider/link`, intent carried in the OAuth state cookie). If that provider account already has its own user, `mergeUsers()` moves everything onto the signed-in user and deletes the other. Unlink is `DELETE /api/me/accounts/:provider` (never the last one; unlinking Discord resets the role to `user`). Twitch needs `OAUTH_TWITCH_CLIENT_ID` (var) and `OAUTH_TWITCH_CLIENT_SECRET` (secret); the button is hidden when the client ID is unset.
- Games can be marked as `paywall` by editors/admins; a green `$` badge renders after the title on all card views.
- Server-time resets can carry a `reset_timezone` (IANA name; only kept when `reset_basis = server`, null means UTC). Reset sort converts via per-zone UTC offsets computed in the Worker.
- Click tracking: `POST /api/games/:id/click` increments `click_count`; score computation factors in click count and list membership.
- Logged-out views of `/`, `/games`, `/games/:slug`, `/lists`, `/lists/:slug` and `/mod-log` are cached at the edge for 60s (`PUBLIC_CACHE_PATHS`, `X-Page-Cache: HIT|MISS`). Requests with a session cookie or the `dgl_voted` cookie (set after a vote) bypass it. Not in development.
- Open pages reload themselves after a deploy: every page has `<meta name="app-version">` (the Cloudflare version id from the `CF_VERSION_METADATA` binding, see `appVersion()`), and `APP_UPDATE_SCRIPT` polls `GET /api/version` once a minute while visible (and on tab focus). It never reloads while a text field is focused (waits until it's left) or after the visitor typed into a form (shows a notice instead), and reloads at most once per new version per tab. The edge page cache is keyed by version, so the reload always gets new HTML. Any version change counts, including `wrangler secret put` and trigger changes.
- Curated list pages (view mode) update live: every 30s while visible they compare `GET /api/lists/:slug` with the rendered order; on a change they fetch a fresh render of the page (unique `?live=` query, so not the edge cache), fade out removed rows (`.row-leave`), add new ones (`.row-enter`, bound via `dglBindGameRows`) and re-apply the chosen sort. The list sort (`LIST_SORT_SCRIPT`, `renderListSortControl({ votes: true })` on curated lists only) offers default, resetting soonest, highest % upvoted and most upvotes; vote orders read the counts shown in each row.
- Vote counts update live: `GAME_ACTIONS_SCRIPT` polls `GET /api/games/vote-counts` every 20s while the tab is visible for every `[data-game-row]`/`[data-vote-counts]` on the page and updates `[data-up-count]`, `[data-down-count]`, `[data-liked]` and `[data-rating]` in place with a short `.count-bump` pulse. Games the visitor voted on in the last 30s are skipped so a cached answer can't undo their vote. Keep those data attributes on any new place that shows counts.
- Curated lists take suggestions (`list_suggestions`, `list_suggestion_votes`, `list_blocked_games`): viewers (signed in, or logged out and counted by hashed IP like anonymous game votes; `list_suggestion_votes.voter_key` is `user:<id>` or `anon:<hash>`) suggest a game from the panel on the list page (a collapsed `<details>` above the list on phones, a column to its right at ≥900px) and agree with others' suggestions, one vote each (the suggester's included); suggesting an already-suggested game counts as a vote, and a game already on the list is refused with an error toast. Ordered by votes, then age. Editors, admins and the list's Twitch owner can turn suggestions off per list (`curated_lists.suggestions_enabled`, the "Allow suggestions" checkbox in edit mode, `PATCH /api/lists/:id { suggestionsEnabled }`): the panel disappears (open pages drop it on their next refresh), suggesting and voting return 403 `code: "disabled"`, and existing suggestions are kept for when it's turned back on. They also add a suggestion to the end of the list or dismiss it. A dismissed suggestion, or a game removed from the list, goes into `list_blocked_games` and can't be suggested there again until it's added to the list directly. The edge-cached logged-out page carries no per-visitor vote state, so it loads the visitor's own votes from `GET /api/lists/:id/suggestions` on load; the panel refreshes every 30s. Anyone can take their vote back; taking back a suggestion's last vote deletes the suggestion without blocking the game. As with game votes, anonymous votes stay separate from an account after login. `mergeUsers()` moves suggestion votes.
- Cards with a reset time show whether this browser has played the game since its last reset: opening a game (a card's game link, or the Play button on its page, to the game's own site) is stored in localStorage `dgl_played_v1` (`{ gameId: epoch ms }`, pruned after 3 days; `window.dglMarkPlayed(id)`). `RESET_LOCALIZE_SCRIPT` then adds `.played` (faded card) when that time is after the last reset, and `.reset-soon` (red reset bar, `--reset-bar-soon`) when it isn't and the reset is under two hours away. Recomputed every minute, on tab focus and when another tab records a play. Games without a reset time are never marked. It's per browser, not synced to the account.
- Cards show "N% liked" (upvote share) and a live reset countdown ("Resets in 3h 12m") instead of the internal score; the score is still used for sorting.
- Non-production environments send `X-Robots-Tag: noindex` and a `Disallow: /` robots.txt; workers.dev and preview URLs are off for staging and production.
- Deployed environments redirect plain HTTP to HTTPS (301, or 308 for non-GET) and every response carries HSTS (not in dev), `nosniff`, `Referrer-Policy` and `frame-ancestors 'none'`/`X-Frame-Options: DENY` (first middleware in `src/index.ts`).
- Missing pages (unknown game, list, category slug, page number past the end, unmatched route) render `notFoundPage()`, an HTML 404 with `noindex`; unmatched `/api/*` routes return JSON 404.
- SEO data per page: game pages carry `VideoGame` JSON-LD and an "About" facts section (category descriptions, rating, public lists featuring the game, listed-since date); category and list pages carry an `ItemList` (`gameItemListLd()`); every page carries `WebSite` and `Organization`. List meta descriptions fall back to `listMetaDescription()` when a list has no description.
- Games have an optional editor-written `how_to_play` (plain text, max 2000 chars, blank line = new paragraph), edited in the game page's admin form and shown at the top of its "About" section.
- Each game page's `og:image` is `/og/games/<slug>.png?v=<hash>`, drawn on demand by `src/lib/og.ts` (satori + resvg WASM via `@cf-wasm/og`, Manrope from `src/lib/og-fonts.ts`) and edge-cached for a day. `v` changes when the title, description, categories or paywall flag change. A render failure falls back to the site image.
- When a game becomes public for the first time (editor/admin submission, single or bulk approve, or a status change to approved in the edit form; not a restore of a disabled game), `announceNewGames()` posts "New game: **Title**" plus its page link to Discord #dailies via the `DISCORD_NEW_GAME_WEBHOOK_URL` secret, pinging role `DISCORD_ROLE_DLE_ENJOYER` (`allowed_mentions` limits pings to that role). Announcements are batched: approvals add the game to `announcement_queue` (`queueNewGameAnnouncements()`), which sets the alarm of the `AnnouncementScheduler` Durable Object (binding `ANNOUNCER`, one instance named `new-games`) to 3 minutes after the latest approval, capped at 15 minutes after the first of the batch. The alarm runs `flushAnnouncementQueue()`, which posts the whole queue as one message. A failed send is retried every minute and dropped after an hour; the daily cron also flushes anything left over, and an editor or admin opening any `/admin` page starts the timer if games are queued without one. (An every-minute cron was tried first and Cloudflare never ran it on this account.) Nothing is queued when the webhook is unset (staging and dev by default). New approval paths must pass the ids `logGameEvents()` returns to `queueNewGameAnnouncements()`.
- `/llms.txt` is a generated Markdown overview (categories, public lists, top 30 games) for AI assistants.

## Scoring

Game score is computed from: Wilson lower bound of vote ratio, freshness bonus, click boost (+0.003/click, max +0.30), and list membership boost (+0.10/list, max +0.20). Penalties apply for reports and link failures.

## Rotation export/import

- **Export** downloads a JSON file with `{ version: 1, items: [{ id, slug, title }] }`.
- **Import** reads a JSON file, validates format, and adds non-duplicate games.
- **Logged-in users:** export/import via `GET /api/me/favorites/export` and `POST /api/me/favorites/import`. Server-side DB queries. Export also includes `position` and `weekdayMask` per item.
- **Anonymous users:** export/import is entirely client-side via localStorage. No API calls.
- Both flows are additive (duplicates are skipped by `INSERT OR IGNORE`).

## Favorites data model

- `favorites` table: `user_id`, `game_id`, `position`, `weekday_mask` (bitmask, 127=all days).
- `anonymous_favorites` table: `anon_id`, `game_id` (no position or weekday_mask).
- Local favorites in localStorage key `dgl_local_favorites_v1`: `[{ id, slug, title }]`.

## Safe editing notes for agents

- Keep SQL parameterized with D1 prepared statements.
- Handlers for edge-cached pages must not render per-visitor state for logged-out requests when `c.get("publicCache")` is true; use `getViewerGameState()` for votes/favorites, which already handles this.
- Use `renderDetailsLink()` for links to game pages from cards (a real `<a>`, so crawlers can follow it) and `class="narrow"` on `<main>` for text/list pages.
- Game cards and rows are tappable: the container has `card-click` and the game-name link `card-link`, whose overlay covers the card. Anything else clickable inside (buttons, `.btn-details`, `.category-pill`, `.drag`) must sit above it (see the `.card-click` CSS). Don't use it where rows are dragged by the whole row (list edit mode). The logged-out rotation gets game links from `GET /api/games/rotation-info`.
- Embed server values in inline `<script>` blocks with `scriptJson(...)`, never raw `JSON.stringify(...)`; in client code, put user text in the DOM with `textContent`, not `innerHTML`.
- Mock login (`/auth/mock-login/:role`) only works when `APP_ENV` is development and the request host matches `APP_URL`. Production has its own D1/KV; staging and the default (dev) config use a separate staging D1/KV. In `wrangler d1` commands use the `DB` binding with `--env`, never the database name (a name can resolve to production).
- Update both server route behavior and inline client script behavior together.
- If adding mutating APIs, ensure CSRF and auth/role checks are included.
- If adding public list queries, consider cache invalidation with `invalidateGameCaches`.
- The `/me/rotation` page has separate rendering paths for anonymous (localStorage) and authenticated (DB) users — update both if changing rotation UI.
- Inline `<script>` blocks in `src/index.ts` handle client-side rendering for rotation and game list pages. These are not separate files.
- Client-side voting and favoriting (account and local/anonymous), the local favorites store, and the local-to-account import all go through `window.dglGames` (`GAME_ACTIONS_SCRIPT`, loaded in `<head>` by `layout()`). Use it rather than calling those APIs or touching `dgl_local_favorites_v1` directly.
- The `game_categories` table has a required `assigned_by_user_id` column — always include it in INSERT statements.
