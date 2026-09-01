# API Reference (Current)

## Public

- `GET /api/games?sort=top|new|trending|reset&category=<slug>&q=<query>&page=<n>&perPage=<n>`
- `GET /api/categories`
- `GET /api/lists`
- `GET /api/lists/:slug`

## Anonymous-capable

- `POST /api/games/:id/vote` (anonymous by IP hash or authenticated by user ID; repeat vote updates existing value)
- `POST /api/games/:id/favorite-anon`
- `DELETE /api/games/:id/favorite-anon`

## Auth pages/routes

- `GET /login`
- `GET /auth/google`
- `GET /auth/github`
- `POST /auth/email/request`
- `POST /auth/email/verify-code`
- `GET /auth/email/verify?token=...`
- `GET /auth/logout`

## Authenticated user

- `POST /api/games`
- `POST /api/games/:id/favorite`
- `DELETE /api/games/:id/favorite`
- `POST /api/games/:id/report`
- `POST /api/me/favorites/import-local`
- `POST /api/me/favorites/reorder`
- `PATCH /api/me/favorites/:gameId`
- `GET /api/me/rotation?weekday=1..7`
- `PATCH /api/me/profile`
- `DELETE /api/me/sessions/:id`

## Editor/Admin

- `GET /api/admin/submissions?status=pending|rejected|disabled|approved&q=<query>`
- `PATCH /api/admin/games/:id/reset`
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
- `PATCH /api/lists/:id`
- `PATCH /api/lists/:id/visibility`
- `DELETE /api/lists/:id`
- `POST /api/lists/:id/items`
- `DELETE /api/lists/:id/items/:gameId`
- `PATCH /api/lists/:id/items/reorder`

## Security notes

- Mutating `/api/*` endpoints require `x-csrf-token` matching `csrf_token` cookie.
- User/session checks are enforced by `requireAuth` and `requireRole` where required (for example, favorites/report/admin endpoints).
- Anonymous vote identity is derived server-side from client IP and stored as a hash (`anon_ip_hash`).
