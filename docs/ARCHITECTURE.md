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

Sign-in uses Discord or Twitch OAuth. `/login` shows the buttons (signed-in visitors are sent to `/`); `/auth/discord` and `/auth/twitch` start the flow, and `/auth/<provider>/callback` finishes it. Shared helpers: `beginOAuth`, `readOAuthCallback`, `exchangeOAuthCode`, `revokeOAuthToken`, `upsertOAuthUser`.

- Each provider's callback checks a `state` cookie. The provider access token is revoked right after the profile read and never stored. Only the provider user id, the initial display name and the avatar URL are kept.
- A first sign-in creates a user with a placeholder email (`<provider>-<id>@users.noreply.dailies`, never shown).
- **Discord:** guild roles map to `editor`/`admin`, re-synced on every Discord login (losing the role demotes the user).
- **Twitch:** no scopes are requested and sign-in always yields role `user`. Twitch's broadcaster type sets creator status.
- **Linking:** from Settings, a signed-in user links the other provider with `POST /auth/:provider/link` (intent carried in the state cookie). If that provider account already belongs to another user, `mergeUsers()` moves everything onto the signed-in user and deletes the other. Unlinking is `DELETE /api/me/accounts/:provider` and is refused for the last account.
- **Logout:** `POST /auth/logout`.
- Fan-dles uses a separate Twitch authorization (`POST /auth/twitch/fandle`) that asks for follow and subscription scopes, checks one channel relationship and revokes the token. It never creates a session.

## Voting and favorites

- Authenticated votes are stored in `votes` keyed by `(user_id, game_id)`.
- Anonymous votes are stored in `anonymous_votes` keyed by `(anon_ip_hash, game_id)`.
- `anon_ip_hash` is derived from client IP plus `SESSION_SECRET`; raw IP is not persisted.
- Re-voting updates the same row, preventing duplicate vote rows per game identity.
- Game vote counters (`vote_up_count`, `vote_down_count`) are computed from both vote tables.
- Authenticated favorites are stored in `favorites`; anonymous favorites are stored in `anonymous_favorites` and merged into score computation.

## Click tracking

- `POST /api/games/:id/click` increments `click_count` on the game row.
- The client sends a click for every outbound game open (card game links and the Play button). Embeds send the same count through `POST /api/embed/click/:gameId`.
- Click count feeds into the game score computation (+0.003/click, capped at +0.30).

## Scoring

Game score is computed from: Wilson lower bound of vote ratio, freshness bonus, click boost, and list membership boost (+0.10/list, max +0.20). Penalties apply for reports and link failures. The daily cron recalculates all scores.

## Paywall flag

- Games can be marked as `paywall` (boolean) by editors/admins via the game detail page edit form, or by a verified developer.
- A green `$` badge renders after the game title on all card views (homepage, browse, rotation, lists, game detail).

## Submission and moderation flow

1. A visitor submits a game via `POST /api/games`: signed in or anonymous, rate limited (10 an hour; admins exempt).
2. URL is canonicalized and checked for duplicates (a normalized-URL match with a non-rejected game returns 409).
3. Category suggestions are attached when valid.
4. Optional reset metadata can be included (`resetBasis`, `resetTime`, `resetTimezone`).
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
- Server-time resets can also store `reset_timezone`, an IANA zone name such as `America/New_York` (validated with `Intl`). It is cleared when the basis is not `server`; a `server` game with no zone is treated as UTC.
- Browse and API support `sort=reset` to order by next reset time (soonest first). Each zone's current UTC offset (DST-aware) is computed in the Worker and applied in the SQL ordering.
- Admin moderation page can update reset metadata per game. Signed-in users can also suggest a reset (`POST /api/games/:id/reset-suggestion`), which editors apply or dismiss at `/admin/resets`.

## Scheduled jobs

The daily cron (`15 8 * * *`) runs in the `scheduled` handler, and each job has its own try/catch:

- Link checks for approved games: uses `HEAD`, falls back to `GET`, increments `link_fail_count` on failures, and after the threshold auto-creates an open `broken` report.
- Score recalculation, cleanup of stale rate-limit and session rows, developer claim re-checks and Dle Developer role maintenance.
- A backstop flush of the Discord new-game announcement queue. The `AnnouncementScheduler` Durable Object normally sends it.

A separate `*/15` cron sends push reminders (`runPushReminders()`).

## Security controls

- Session tokens stored as hashes in D1.
- CSRF double-submit cookie pattern for mutating APIs.
- Role-based access controls at route level.
- Fixed-window rate limiting stored in D1.
- OAuth tokens are revoked right after the profile read and never stored (see Auth flows).

## Sequence diagrams

### Discord OAuth sign-in

```text
Browser -> Worker: GET /auth/discord (sets state cookie)
Worker -> Browser: redirect to Discord OAuth2
Browser -> Discord: authorize
Discord -> Worker: GET /auth/discord/callback (code, state)
Worker -> Discord: exchange code for token, fetch profile and guild roles, revoke token
Worker -> D1: upsert user, map guild roles
Worker -> Browser: set session cookie, redirect to the page they came from (or /)
```

### Standard user submission

```text
Browser -> Worker: POST /api/games
Worker -> D1: insert game status=pending
Worker -> D1: insert suggested categories
Worker -> KV: invalidate game caches
Worker -> Browser: 201 { status: "pending" }
```
