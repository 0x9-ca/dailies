# API Reference (Current)

## Public

- `GET /api/games?sort=top|new|trending|reset&category=<slug>&q=<query>&page=<n>&perPage=<n>`
- `GET /c/:slug`, `/g/:slug`, `/r/:token` → 301 (relative `Location`, query string kept) to `/lists/:slug`, `/games/:slug`, `/rotation/:token`. Every request to `SHORT_URL`'s host (e.g. `d.0x9.ca`) is redirected to `APP_URL` (301 for GET/HEAD, else 308; absolute `Location`; short paths expanded).
- `GET /api/version` → `{ version }`, the deployed Worker version id (pages reload when it changes).
- `GET /api/games/vote-counts?ids=<id>,<id>,...` (up to 98 approved game ids) → `{ counts: { <id>: [up, down] } }`. Edge-cached for 10 seconds per id set; polled by pages for live vote counts.
- `GET /categories` (HTML index of categories with games) and `GET /categories/:slug?page=<n>` (HTML landing page: intro, ranked game grid, related categories, FAQ with FAQPage and BreadcrumbList JSON-LD; 404 for unknown, inactive or empty categories). Both are edge-cached for logged-out visitors. `/games?category=<slug>` with no other filter has `/categories/<slug>` as its canonical URL.
- `GET /feed.xml` → Atom feed of the 50 most recently listed approved games (`COALESCE(approved_at, created_at)`), `application/atom+xml`, cached 10 minutes.
- `GET /feed.xml?category=<slug>` → the same feed limited to approved games in that active category. Unknown or inactive slugs get a 404 `application/xml` error.
- `GET /badge/c/:slug.svg` → 320×60 SVG for a public list with games: "0x9 dles", "N dailies" and the list's short address (`<short host>/c/<slug>`). Private, unknown or empty lists get a 404 SVG. Cached an hour; for Twitch panels and socials (snippets in the list's Stream settings).
- `GET /badge/:slug.svg` → 220×40 SVG for an approved game: "0x9 dles" and the upvote share ("N% liked", or "Play daily" before any votes). Unknown or unapproved slugs get a 404 SVG. Cached an hour; meant for `<img>` on developers' own sites.
- `GET /new` (HTML: games approved in the last 30 days grouped by week, Monday start in US/Eastern, newest first; falls back to the 12 most recent when none; BreadcrumbList and ItemList JSON-LD; edge-cached for logged-out visitors; links `/feed.xml`).
- `GET /embed/lists/:slug?theme=dark|light|auto&limit=1-50&title=0&transparent=1` → standalone HTML widget of a public list for iframes (numbered games linking out in a new tab, paywall badge, reset countdown, suggest/footer links). Framing allowed anywhere (`frame-ancestors *`, no `X-Frame-Options`), `X-Robots-Tag: noindex`, canonical to `/lists/:slug`, no cookies, edge-cached 60s (`Cache-Control: public, max-age=60`). Skips unapproved and NSFW games. Private or unknown lists get an embed-styled 404. The list page's Embed menu item builds the snippet.
- `GET /api/categories`
- `GET /api/lists`
- `GET /lists/:slug/history[?before=<ISO>]` -> HTML "Stream history" page for a public list with at least one `list_play_history` row (else 404): 30 days per page, newest day first, grouped client-side in the viewer's time zone, "Show older" via `before`. noindex; not in the edge cache; signed-out `Cache-Control: public, max-age=60`, signed-in `private, no-cache` (editors see x buttons and Clear history).
- `GET /api/lists/live` -> `{ live: { <listSlug>: { title, startedAt, viewerCount } } }` for public lists whose Twitch channel is live right now (empty on any Twitch error). `Cache-Control: public, max-age=60`; 300 requests an hour per visitor (429). Twitch is asked at most once per 90s (one shared KV key, `src/lib/twitch-live.ts`). Must stay above `/api/lists/:slug` in routing.
- `GET /api/lists/:slug/now-playing` -> `{ gameId, title, startedAt }` or `{ gameId: null }` (null once set over 6 hours ago; 404 for a missing or unviewable list). `Cache-Control: no-store`; public lists are read through a ~10s KV cache (`np:v1:<slug>`)
- `GET /api/lists/:slug` (items carry `lastPlayedAt`, a UTC ISO time or null: when the list's editors last marked the game played on stream; omitted unless Played on stream applies to the viewer, see the played route)
- `GET /api/games/random?category=<slug>&hidePaywall=1&hideNsfw=1&exclude=<id>,<id>,...` → one random approved game `{ id, slug, url }`, or 404 `{ error }` when none match. Never returns NSFW games, so `hideNsfw=1` changes nothing. `exclude` takes up to 200 game ids (400 otherwise). Not cached.
- `GET /api/games/new?days=14&categories=a,b,c&limit=12` → `{ games: [{ id, slug, title, url, paywall, categories: [{ slug, name }], listedAt }] }`: approved, non-NSFW games listed in the last `days` (1-60) in any of up to 5 categories, newest first (`limit` up to 24). Empty without valid categories. KV-cached for 5 minutes; used by the home page's "New in your categories" row.
- `GET /api/games/duplicate-check?url=<url>&title=<title>` → `{ matches: [{ id, title, slug, status: "approved", reason } | { status: "pending", reason }] }`: listed games that share the link (`reason: "url"`: scheme, `www.`, default port, trailing slash, fragment and utm_*/ref/fbclid/gclid ignored), the title (`"title"`: case, punctuation, accents and a leading "the" ignored) or a near-identical title (`"similar-title"`, one edit, titles of 6+ characters). Pending games only appear as `{ status: "pending", reason }` with no id, title or slug (at most one). Up to 10 matches, `no-store`, 240 an hour per user or IP (429 beyond). `POST /api/games` returns 409 `code: "duplicate"` with a readable `error` for a normalized-link match with a non-rejected game (`slug` when it is listed).
- `GET /api/games/titles` → `{ games: [{ id, slug, title }] }` for every approved game (the list suggestion search). Edge-cached for 5 minutes.
- `GET /api/lists/:id/suggestions` → `{ suggestions: [{ gameId, slug, title, url, paywall, nsfw, categories: [{ slug, name, hue }], votes, voted }] }`, most votes first, plus `enabled` (false, with no suggestions, when the list has suggestions turned off; suggesting and voting then return 403 `code: "disabled"`) (`voted`: whether this visitor, signed in or by hashed IP, agreed).

## Anonymous-capable

- `POST /api/games/:id/vote` (anonymous by IP hash or authenticated by user ID; repeat vote updates existing value)
- `POST /api/me/rotation/import-preview` (`{ text }`, up to 200 non-empty lines and 10 KB; 400 otherwise). Works signed in or logged out. 30 an hour per user or IP. Splits the text into entries (lines, or commas/semicolons when a line has no link), strips numbering, bullets, emoji, check marks and trailing scores (`3/6`), then matches approved games by link (host when unique among games, else host plus path), exact title (case and punctuation ignored), then fuzzy title. Returns `{ rows: [{ input, match: { id, slug, title } | null, confidence: "exact" | "fuzzy" | "none", inRotation, alternatives: [{ id, slug, title, inRotation }] }] }` (up to 3 alternatives; `inRotation` is only ever true for signed-in users, the client checks local favorites otherwise). Adding the chosen games uses `POST /api/me/favorites/import` (or local favorites).
- `POST /api/games/:id/favorite-anon`
- `DELETE /api/games/:id/favorite-anon`
- `POST /api/lists/:id/suggestions` (`{ gameId }`; 409 `code: "on_list"` when the game is already on the list, 409 `code: "blocked"` when it was removed or dismissed; a game already suggested counts as a vote: `result` is `suggested`, `voted` or `already_voted`). 30 an hour per user or IP. Logged-out visitors are identified by hashed IP.
- `PUT /api/lists/:id/suggestions/:gameId/vote`, `DELETE /api/lists/:id/suggestions/:gameId/vote` (agree, or take it back; taking back the last vote withdraws the suggestion, `withdrawn: true`, and the game can still be suggested again)
- `POST /api/embed/click/:gameId` (what the embed widget sends with `navigator.sendBeacon`; same counting and per-IP-and-game rate limit as the click above, no cookies, exempt from CSRF; always `{ ok: true }`)
- `POST /api/games/:id/click` (increments click count for scoring and the game's daily plays (US/Eastern day, `game_click_days`); capped per visitor per game. The client script sends it for every outbound game open)

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
- `GET /api/me/plays?since=<ISO>` (signed in, 600/hour; default last 100 days): `{ userId, plays: [{ gameId, playedAt }], streak: { last, count }, log: { "YYYY-MM-DD": games }, skips: { "YYYY-MM-DD": [gameId] } }`. `skips` are Skip today entries for the last 2 days. `playedAt` is a UTC instant; `last` and `log` days are the player's local dates.
- `GET /api/me/recap?month=YYYY-MM&tz=<IANA zone>` (signed in, 300/hour, `no-store`; 400 for a bad month or zone, 401 signed out): the month of `user_plays` in the given time zone. `{ month, days: { "YYYY-MM-DD": [gameIds] }, games: [{ id, title, slug, plays }], available: { from: "YYYY-MM" } }`. A game counts once per local day; `games` is sorted by plays; `available.from` is the month of the first stored play. Used by `/me/recap`.
- `POST /api/me/plays` (signed in, CSRF, 600/hour): `{ plays?: [{ gameId, playedAt }], unplayed?: [{ gameId, since }], skipped?: [{ day, gameId }], unskipped?: [{ day, gameId }], streak?: { last, count }, log?: { day: games } }`, max 200 skipped and 200 unskipped (`day` is the viewer-local date, accepted from yesterday to tomorrow in UTC, else 400; unskipped runs first; rows older than 3 days are pruned), max 200 plays and 200 unplayed. `playedAt` is clamped to 100 days ago..now; a play within 10 minutes of an existing one for the same game is ignored. `unplayed` deletes that game's plays at or after `since` (its last reset) and runs before `plays`. `streak` keeps the later `last` (larger `count` on a tie); `log` keeps the larger count per day. Rows older than 120 days are pruned on write. The favorites export also carries `plays` and `streak`.
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
- `GET /api/admin/developers?q=` (admin only: verified developers by name or handle), `POST /api/lists/:id/fandle-members` (`{ userId }`) and `DELETE /api/lists/:id/fandle-members/:userId` (admin only: add or remove a Fan-dles member by hand)
- `PUT /api/lists/:id/fandles/:gameId/hidden` (`{ hidden }`; the list's owner or staff)
- `PATCH /api/lists/:id` also takes `fandlesEnabled`

## Developer claims (signed-in user)

- `POST /api/games` also takes `isDeveloper: true` (signed-in submitters: starts a developer claim on the new game, response `claim: true`); a duplicate URL returns 409 with `code: "duplicate"` and the listed game's `slug`
- `POST /api/games/:id/claim` (starts a claim and returns `{ claim: { status, token } }`; a listed game, or a pending one the user submitted; 409 if the game already has a verified developer; rejected claims can't be refiled)
- `POST /api/games/:id/claim/verify` (fetches the game's URL for `<meta name="0x9dles-verify" content="TOKEN">`, then `/.well-known/0x9dles.txt` on its origin. Staging uses `0x9dles-stg-verify` and `0x9dles-stg.txt`, dev `-dev`; 422 token not found, 502 site unreachable)
- `POST /api/games/:id/claim/evidence` (`{ evidence }`, 10-500 chars: asks an editor to confirm instead; claim becomes `review`)
- `DELETE /api/games/:id/claim` (withdraw, or release a verified game)
- `GET /api/games/:id/developer-stats` (the game's verified developer or an admin; 401/403/404 otherwise. Last 30 days in US/Eastern: `days`, `rotationAddsPerDay`, `votesUpPerDay`, `votesDownPerDay`, `playsPerDay` (daily plays, counted from 2026-11-02), plus `totals` (`clicks` all-time, `rotations`, `lists`, `publicLists`, `votesUp`, `votesDown`, `ratingPercent`, `rank`/`rankOf` in the top ranking, `score`) and `lists` (public ones: `title`, `slug`). `totals.clicks` includes plays from before daily counting. KV-cached 10 minutes per game)
- `PUT /api/games/:id/developer-update` (verified developer only: title, url, description, reset metadata, paywall, `how_to_play`; never status, NSFW or categories. Changing the URL needs the token on the new address first, else 422)

## Editor/Admin

- `PUT /api/admin/settings` (admin only: `{ fandleMaxPerDeveloper, fandleMaxShown, fandleMembershipDays }`: games 1-100, days 1-3650, each `null` for no limit; optional `playedOnStream: "on" | "off"` (Played on stream for everyone, or admins only). A change purges the cached list pages)
- `POST /api/admin/creators/twitch` (admin only; `{ login }`: verifies a Twitch streamer by username; `DELETE /api/admin/creators/twitch/:twitchUserId` removes them)
- `POST /api/admin/users/:id/creator` (admin only; `{ grant }`: makes a user a verified creator with a list of their own, or removes a status granted by staff; Twitch-derived statuses follow Twitch)
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
- `POST /api/games/:id/reset-suggestion` (signed in; 10/day per user). Body `{ reset_basis: "local"|"server", reset_time: "HH:MM", reset_timezone?: IANA name or null (server only; null = UTC), note?: string (max 200) }`. One open suggestion per user per game (a new one replaces it). 409 if it equals the current reset, 403 for staff and the game's verified developer (they edit directly).
- `POST /api/admin/reset-suggestions/:id/apply` (editor/admin): writes the reset to the game, closes all identical open suggestions as applied, logs `reset_update` in the mod log.
- `POST /api/admin/reset-suggestions/:id/dismiss` (editor/admin): dismisses the identical open suggestions. Reviewed at `/admin/resets`.
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
- `PUT /api/lists/:id/items/:gameId/played` (`{ played: boolean }`; the list's editors, same as the item routes. Sets or clears `last_played_at`; returns `{ ok, lastPlayedAt }`; 404 when the game isn't on the list. Not in the mod log. Played on stream applies to a viewer when the site setting `played_on_stream` is `on` or they are an admin; otherwise 403 `code: "disabled"`)
- `DELETE /api/lists/:id/history/:entryId` and `DELETE /api/lists/:id/history` (remove one Stream history entry / clear all; list editors via `requireListEditor`, CSRF). `PUT .../now-playing` with a game also records a history row (skipped if the same game is the latest row under 30 minutes old; rows over 90 days are pruned).
- `PUT /api/lists/:id/now-playing` (`{ gameId: string | null }`; the list's editors, CSRF, 300/hour per user. The game must be on the list: main list, a suggestion or a Fan-dles game, else 400. `null` clears. Returns `{ gameId, title, startedAt }` or `{ gameId: null }`; drops the KV cache. Not in the mod log)
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
