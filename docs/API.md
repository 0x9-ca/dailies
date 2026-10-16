# API Reference (Current)

## Public

- `GET /api/games?sort=top|new|trending|reset&category=<slug>&q=<query>&page=<n>&perPage=<n>`
- `GET /api/version` → `{ version }`, the deployed Worker version id (pages reload when it changes).
- `GET /api/games/vote-counts?ids=<id>,<id>,...` (up to 98 approved game ids) → `{ counts: { <id>: [up, down] } }`. Edge-cached for 10 seconds per id set; polled by pages for live vote counts.
- `GET /api/categories`
- `GET /api/lists`
- `GET /api/lists/:slug`
- `GET /api/games/titles` → `{ games: [{ id, slug, title }] }` for every approved game (the list suggestion search). Edge-cached for 5 minutes.
- `GET /api/lists/:id/suggestions` → `{ suggestions: [{ gameId, slug, title, url, paywall, nsfw, categories: [{ slug, name, hue }], votes, voted }] }`, most votes first, plus `enabled` (false, with no suggestions, when the list has suggestions turned off; suggesting and voting then return 403 `code: "disabled"`) (`voted`: whether this visitor, signed in or by hashed IP, agreed).

## Anonymous-capable

- `POST /api/games/:id/vote` (anonymous by IP hash or authenticated by user ID; repeat vote updates existing value)
- `POST /api/games/:id/favorite-anon`
- `DELETE /api/games/:id/favorite-anon`
- `POST /api/lists/:id/suggestions` (`{ gameId }`; 409 `code: "on_list"` when the game is already on the list, 409 `code: "blocked"` when it was removed or dismissed; a game already suggested counts as a vote: `result` is `suggested`, `voted` or `already_voted`). 30 an hour per user or IP. Logged-out visitors are identified by hashed IP.
- `PUT /api/lists/:id/suggestions/:gameId/vote`, `DELETE /api/lists/:id/suggestions/:gameId/vote` (agree, or take it back; taking back the last vote withdraws the suggestion, `withdrawn: true`, and the game can still be suggested again)
- `POST /api/games/:id/click` (increments click count for scoring; capped per visitor per game)

## Auth pages/routes

- `GET /login`
- `GET /auth/discord`, `GET /auth/discord/callback`
- `GET /auth/twitch`, `GET /auth/twitch/callback`
- `POST /auth/discord/link`, `POST /auth/twitch/link` (signed in: link that provider to the current account; an existing separate account for it is merged in)
- `POST /auth/logout`

## Authenticated user

- `POST /api/games`
- `POST /api/games/:id/favorite`
- `DELETE /api/games/:id/favorite`
- `POST /api/games/:id/report`
- `GET /api/me/favorites/export` (JSON export of rotation)
- `POST /api/me/favorites/import` (JSON import of rotation)
- `POST /api/me/favorites/import-local` (sync localStorage favorites to account)
- `POST /api/me/favorites/reorder`
- `PATCH /api/me/favorites/:gameId`
- `GET /api/me/rotation?weekday=1..7`
- `PATCH /api/me/profile`
- `DELETE /api/me/sessions/:id`
- `DELETE /api/me/accounts/:provider` (unlink `discord` or `twitch`; refused for the last sign-in; unlinking Discord drops editor/admin)

## Public profile (signed-in user)

- `PUT /api/me/public-profile` (`{ public, handle, showRotation, showTwitch, avatarProvider }`; the profile page `GET /u/:handle` is a 404 unless `public` is on, except for its owner. 409 handle taken, 400 invalid or reserved handle, or Twitch/avatar provider not linked)

## Fan-dles (signed-in user)

- `POST /auth/twitch/fandle` (form field `list` = creator list slug; verified developers only. Starts a Twitch authorization with the `user:read:follows` and `user:read:subscriptions` scopes, then redirects back to the list with `?fandle=joined|not_following|too_new|cancelled|conflict|need_claim|self|error`)
- `DELETE /api/lists/:id/fandle-membership` (leave a list's Fan-dles)
- `PUT /api/lists/:id/fandles/:gameId/hidden` (`{ hidden }`; the list's owner or staff)
- `PATCH /api/lists/:id` also takes `fandlesEnabled`

## Developer claims (signed-in user)

- `POST /api/games` also takes `isDeveloper: true` (signed-in submitters: starts a developer claim on the new game, response `claim: true`); a duplicate URL returns 409 with `code: "duplicate"` and the listed game's `slug`
- `POST /api/games/:id/claim` (starts a claim and returns `{ claim: { status, token } }`; a listed game, or a pending one the user submitted; 409 if the game already has a verified developer; rejected claims can't be refiled)
- `POST /api/games/:id/claim/verify` (fetches the game's URL for `<meta name="0x9dles-verify" content="TOKEN">`, then `/.well-known/0x9dles.txt` on its origin. Staging uses `0x9dles-stg-verify` and `0x9dles-stg.txt`, dev `-dev`; 422 token not found, 502 site unreachable)
- `POST /api/games/:id/claim/evidence` (`{ evidence }`, 10-500 chars: asks an editor to confirm instead; claim becomes `review`)
- `DELETE /api/games/:id/claim` (withdraw, or release a verified game)
- `PUT /api/games/:id/developer-update` (verified developer only: title, url, description, reset metadata, paywall, `how_to_play`; never status, NSFW or categories. Changing the URL needs the token on the new address first, else 422)

## Editor/Admin

- `PUT /api/admin/settings` (admin only: `{ fandleMaxPerDeveloper, fandleMaxShown }`, each a whole number 1-100 or `null` for no limit)
- `POST /api/admin/users/:id/creator` (`{ grant }`: makes a user a verified creator with a list of their own, or removes a status granted by staff; Twitch-derived statuses follow Twitch)
- `POST /api/admin/claims/:claimId` (`{ action: "approve" | "reject" | "revoke" }`; approve verifies a manual claim)

- `GET /api/admin/submissions?status=pending|rejected|disabled|approved&q=<query>`
- `PUT /api/games/:id/admin-update` (title, url, description, status, reset metadata incl. `reset_timezone`, paywall, categories, optional `how_to_play`: omitted keeps the stored text, null or blank clears it)
- `PATCH /api/admin/games/:id/reset` (`resetBasis`, `resetTime`, `resetTimezone`)
- `POST /api/admin/games/bulk`
- `POST /api/admin/games/:id/approve`
- `POST /api/admin/games/:id/reject`
- `POST /api/admin/games/:id/disable`
- `POST /api/admin/games/:id/restore`
- `GET /api/admin/reports?status=open|resolved|dismissed&q=<query>`
- `POST /api/admin/reports/bulk`
- `POST /api/admin/reports/:id/resolve`
- `POST /api/admin/reports/:id/dismiss`
- `GET /api/admin/categories`
- `POST /api/admin/categories`
- `PATCH /api/admin/categories/:id`
- `DELETE /api/admin/categories/:id`
- `POST /api/lists`
- `PATCH /api/lists/:id` (`title`, `description`, `slug` (staff only), `suggestionsEnabled`)
- `PATCH /api/lists/:id/visibility` (staff, or the owner of their own creator list)
- `DELETE /api/lists/:id`
- `POST /api/lists/:id/items`
- `DELETE /api/lists/:id/items/:gameId`
- `PATCH /api/lists/:id/items/reorder`
- `POST /api/lists/:id/suggestions/:gameId/accept` (moves a suggestion to the end of the list)
- `DELETE /api/lists/:id/suggestions/:gameId` (dismisses a suggestion; the game can't be suggested for that list again)

The list item and suggestion routes (`PATCH /api/lists/:id`, `/items*`, `/suggestions/:gameId/accept`, `DELETE /suggestions/:gameId`) are also open to the list's tagged Twitch user. Removing a game from a list (`DELETE /items/:gameId`) blocks it from being suggested there again; adding it directly (`POST /items`) lifts the block. Suggestion mutations return the updated `suggestions`.

## Security notes

- Mutating `/api/*` endpoints require `x-csrf-token` matching `csrf_token` cookie.
- User/session checks are enforced by `requireAuth` and `requireRole` where required (for example, favorites/report/admin endpoints).
- Anonymous vote identity is derived server-side from client IP and stored as a hash (`anon_ip_hash`).
- OAuth logins check a per-provider `state` cookie, revoke the provider access token right after reading the profile, and store only the provider user id and initial display name.
- Discord editor/admin roles are re-synced from the guild on every Discord login (losing the Discord role demotes the user).
- Games can have a `paywall` flag set via admin update; rendered as a green `$` badge on cards.
