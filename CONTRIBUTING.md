# Contributing

Thanks for contributing to Daily Game List.

## Local setup

1. Install dependencies: `npm install`
2. Ensure `.secrets.env` is filled for your environment.
3. Sync Wrangler config, generate `.dev.vars`, and upload secrets: `./scripts/set-secrets.sh`
4. Apply local migrations: `npx wrangler d1 migrations apply daily-game-list --local`
5. Run dev server: `npm run dev`

## Required checks

- Type check: `npm run typecheck`
- Config validation: `npm run validate:config`

## Development conventions

- Keep business logic server-side in `src/index.ts` and helper modules under `src/lib`.
- Use `zod` schemas for mutating API request validation.
- All mutating `/api/*` endpoints require CSRF header; browser JS fetch wrapper injects it.
- Keep role checks explicit (`requireAuth`, `requireRole`).
- Prefer adding small helpers over duplicating SQL blocks.

## Data and migrations

- Add new schema changes in `migrations/*.sql` only.
- Apply migrations in local first, then remote.
- Do not edit historical migration files after they are applied remotely.

## Manual test checklist

- Browse pages as anonymous and logged-in users.
- Submit a game and confirm moderation behavior by role.
- Vote/favorite/report from game detail page (verify both anonymous and logged-in voting behavior).
- Reorder rotation and curated lists; confirm persistence.
- Exercise admin pages (`/admin/*`) as editor/admin.
