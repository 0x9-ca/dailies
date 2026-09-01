# Agent Guide

This file helps coding agents quickly understand the repository.

## Product summary

Cloudflare Worker app for discovering daily games. Users can submit links, vote, favorite, report issues, and browse curated lists. Voting works for both authenticated and anonymous users. Editor/admin users moderate content and manage taxonomy/lists.

## Core files

- `src/index.ts`: routes, API handlers, SSR rendering, scheduled link check, and client-side inline scripts.
- `src/lib/auth.ts`: session creation/destruction, session middleware, role/auth guards.
- `src/lib/cache.ts`: KV JSON cache helpers and invalidation.
- `src/lib/ranking.ts`: Wilson + freshness/penalty score helper.
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
- Private curated lists are visible to owner + editor/admin only.
- Favorites support manual ordering and weekday masks.
- Anonymous favorites are local-first and can sync after login; anonymous votes are limited to one vote per game per IP hash.
- Login supports Discord OAuth only via `/login`.

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
