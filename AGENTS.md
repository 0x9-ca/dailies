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
- Login supports OAuth and email code/magic-link flows via `/login`.

## Safe editing notes for agents

- Keep SQL parameterized with D1 prepared statements.
- Update both server route behavior and inline client script behavior together.
- If adding mutating APIs, ensure CSRF and auth/role checks are included.
- If adding public list queries, consider cache invalidation with `invalidateGameCaches`.
