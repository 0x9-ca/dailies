# Architecture

## Overview

Daily Game List is a Cloudflare Worker app with server-rendered pages and JSON APIs.

- Runtime: Cloudflare Workers + Hono
- Data: Cloudflare D1
- Cache: Cloudflare KV
- Jobs: Worker scheduled handler (cron)

## Request flow

1. Request enters Worker.
2. `sessionMiddleware` loads the authenticated user from cookie session.
3. CSRF middleware ensures a `csrf_token` cookie exists.
4. Mutating `/api/*` requests require `x-csrf-token` header that matches cookie.
5. Route handlers execute role checks, validation, and D1 queries.
6. Cache invalidation runs for game/list write paths.

## Auth flows

### Discord OAuth

- Browser visits `/login` which redirects to Discord OAuth2.
- Callback validates state, exchanges code, fetches user profile and guild membership.
- Discord guild roles (admin/editor) are mapped to application roles.
- User record is upserted in D1 and session is created.

## Voting and favorites

- Authenticated votes are stored in `votes` keyed by `(user_id, game_id)`.
- Anonymous votes are stored in `anonymous_votes` keyed by `(anon_ip_hash, game_id)`.
- `anon_ip_hash` is derived from client IP plus `SESSION_SECRET`; raw IP is not persisted.
- Re-voting updates the same row, preventing duplicate vote rows per game identity.
- Game vote counters (`vote_up_count`, `vote_down_count`) are computed from both vote tables.
- Authenticated favorites are stored in `favorites`; anonymous favorites are stored in `anonymous_favorites` and merged into score computation.

## Click tracking

- `POST /api/games/:id/click` increments `click_count` on the game row.
- Clicks are triggered from the "Open game" link on game detail pages.
- Click count feeds into the game score computation (+0.003/click, capped at +0.30).

## Scoring

Game score is computed from: Wilson lower bound of vote ratio, freshness bonus, click boost, and list membership boost (+0.10/list, max +0.20). Penalties apply for reports and link failures. Score is recomputed on vote changes, link check results, and manual admin recalculation.

## Paywall flag

- Games can be marked as `paywall` (boolean) by editors/admins via the game detail page edit form.
- A green `$` badge renders after the game title on all card views (homepage, browse, rotation, lists, game detail).

## Submission and moderation flow

1. Logged-in user submits game via `/api/games`.
2. URL is canonicalized and checked for duplicates.
3. Category suggestions are attached when valid.
4. Optional reset metadata can be included (`resetBasis`, `resetTime`).
5. Role behavior:
   - `user`: created as `pending`
   - `editor/admin`: auto-approved and scored immediately
6. Moderators use `/admin/submissions` and `/admin/reports` to manage states.

## Rotation and curated list ordering

- Personal rotation uses `favorites.position` and `weekday_mask`.
- Curated lists use `curated_list_items.position`.
- Both drag/drop and keyboard up/down controls are supported.
- Order changes persist through reorder endpoints.

## Reset metadata and sorting

- Games can store `reset_basis` (`local` or `server`) and `reset_time_minutes`.
- Browse and API support `sort=reset` to order by next reset time (soonest first).
- Admin moderation page can update reset metadata per game.

## Scheduled jobs

- `scheduled` handler runs link checks for approved games.
- Uses `HEAD`, fallback `GET`, increments `link_fail_count` on failures.
- After threshold, auto-creates open `broken` report.
- Also cleans stale rate-limit rows.

## Security controls

- Session tokens stored as hashes in D1.
- CSRF double-submit cookie pattern for mutating APIs.
- Role-based access controls at route level.
- Fixed-window rate limiting stored in D1.

## Sequence diagrams

### Discord OAuth sign-in

```text
Browser -> Worker: GET /login
Worker -> Browser: redirect to Discord OAuth2
Browser -> Discord: authorize
Discord -> Worker: GET /auth/discord/callback (code)
Worker -> Discord: exchange code for token + fetch user/guild
Worker -> D1: upsert user, map guild roles
Worker -> Browser: set session cookie, redirect /
```

### Standard user submission

```text
Browser -> Worker: POST /api/games
Worker -> D1: insert game status=pending
Worker -> D1: insert suggested categories
Worker -> KV: invalidate game caches
Worker -> Browser: 201 { status: "pending" }
```
