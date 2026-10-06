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
- Background: scheduled handler (`scheduled`) for link-health checks

## Security model

- Cookie sessions (`SESSION_SECRET` hashed session tokens in D1)
- Role checks (`user`, `editor`, `admin`)
- CSRF enforcement on mutating `/api/*` requests with double-submit cookie (`csrf_token` + `x-csrf-token`)
- D1-backed fixed-window rate limiting for submit/vote/report

## Key behaviors

- Editor/admin submissions are auto-approved.
- Standard user submissions are `pending` until moderated.
- Private curated lists are visible to owner + editor/admin only (and the list's tagged Twitch user).
- Curated lists can be tagged with a Twitch user by editors/admins (`PATCH /api/lists/:id/twitch`, resolved via Helix to a stable `twitch_user_id`). Tagged lists show a blue verified check and a Twitch channel button. The matching Twitch-login user (via `oauth_accounts`) can edit the list's games, title and description (`requireListEditor`), but not slug, visibility, deletion, or the tag itself.
- Favorites support manual ordering and weekday masks.
- Anonymous favorites are local-first and can sync after login; anonymous votes are limited to one vote per game per IP hash.
- Login supports Discord and Twitch OAuth via `/login`. Twitch requests no scopes (no email) and always yields role `user`; each provider creates its own separate account with a placeholder email. Twitch needs `OAUTH_TWITCH_CLIENT_ID` (var) and `OAUTH_TWITCH_CLIENT_SECRET` (secret); the button is hidden when the client ID is unset.
- Games can be marked as `paywall` by editors/admins; a green `$` badge renders after the title on all card views.
- Server-time resets can carry a `reset_timezone` (IANA name; only kept when `reset_basis = server`, null means UTC). Reset sort converts via per-zone UTC offsets computed in the Worker.
- Click tracking: `POST /api/games/:id/click` increments `click_count`; score computation factors in click count and list membership.

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
- Update both server route behavior and inline client script behavior together.
- If adding mutating APIs, ensure CSRF and auth/role checks are included.
- If adding public list queries, consider cache invalidation with `invalidateGameCaches`.
- The `/me/rotation` page has separate rendering paths for anonymous (localStorage) and authenticated (DB) users — update both if changing rotation UI.
- Inline `<script>` blocks in `src/index.ts` handle client-side rendering for rotation and game list pages. These are not separate files.
- The `game_categories` table has a required `assigned_by_user_id` column — always include it in INSERT statements.
