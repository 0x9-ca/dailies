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

### OAuth (Google/GitHub)

- Browser visits `/auth/google` or `/auth/github`.
- State cookie is set and user is redirected to provider.
- Callback validates state, exchanges code, fetches user profile.
- GitHub callback prefers verified email and falls back to the account noreply address when email APIs do not provide one.
- User record is upserted in D1 and session is created.

## Voting and favorites

- Authenticated votes are stored in `votes` keyed by `(user_id, game_id)`.
- Anonymous votes are stored in `anonymous_votes` keyed by `(anon_ip_hash, game_id)`.
- `anon_ip_hash` is derived from client IP plus `SESSION_SECRET`; raw IP is not persisted.
- Re-voting updates the same row, preventing duplicate vote rows per game identity.
- Game vote counters (`vote_up_count`, `vote_down_count`) are computed from both vote tables.
- Authenticated favorites are stored in `favorites`; anonymous favorites are stored in `anonymous_favorites` and merged into score computation.

### Email sign-in (code and magic link)

- User submits email on `/login` -> `POST /auth/email/request`.
- Server validates email and rate limits by email/IP.
  - Burst and hourly thresholds are configured with `EMAIL_AUTH_RATE_*` vars.
  - Verify-code and magic-link attempts use dedicated fixed-window limits.
- Optional Turnstile challenge can be enforced on email auth form submissions.
- Server generates:
  - 6-digit code
  - random magic token
- Server stores only token/code hashes in `email_login_tokens`.
- Email is delivered using webhook config (`EMAIL_AUTH_WEBHOOK_URL`) or logged in dev fallback.
- Delivery provider precedence:
  1. Cloudflare Email Service binding (`env.EMAIL.send`)
  2. Resend (`RESEND_API_KEY`)
  3. Postmark (`POSTMARK_SERVER_TOKEN`)
  4. Generic webhook (`EMAIL_AUTH_WEBHOOK_URL`)
  5. Development log fallback
- User signs in via:
  - `POST /auth/email/verify-code` (email + code), or
  - `GET /auth/email/verify?token=...` (magic link).
- Token is single-use via `consumed_at` and expires after 15 minutes.

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

### Email magic-link sign-in

```text
Browser -> Worker: POST /auth/email/request (email)
Worker -> D1: upsert user, store hashed code/token
Worker -> Email provider webhook: send code + magic link
Email provider -> User inbox: message delivered
Browser -> Worker: GET /auth/email/verify?token=...
Worker -> D1: validate hash + expiry + unused
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
