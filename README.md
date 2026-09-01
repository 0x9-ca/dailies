# Daily Game List (Cloudflare Worker)

Daily game directory and aggregator built on Cloudflare Workers + D1 + KV.

## Features in this implementation

- Public directory browse/search/sort (`top`, `new`, `trending`, `reset`)
- Category filters and seeded category taxonomy
- Login page with Google/GitHub OAuth plus email code/magic-link sign-in (plus dev mock login)
- Submission workflow (`pending`), votes, favorites, reports
- Anonymous voting tracked by hashed client IP (one active vote per game per IP)
- Manual favorites ordering and weekday mask rotation
- Anonymous local favorites via browser localStorage, with post-login import into account
- Game reset metadata (`local` vs `server` time, reset time) with reset-soon sorting
- Curated lists with `public/private` visibility
- Editor/admin moderation and category management endpoints
- Bulk moderation actions and queue search for submissions/reports
- Daily cron link checker and auto-broken reporting threshold
- Email code + magic-link auth delivery via Cloudflare Email binding, Resend, Postmark, or webhook fallback
- Account settings page for display name updates and session revocation

## Tech stack

- Cloudflare Workers
- Hono
- D1 (SQL)
- KV (short-lived listing cache)
- Zod validation

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Create a D1 database + KV namespace and update `wrangler.jsonc` IDs.

   This repo already has:

   - D1 ID: `9e1124fc-5f00-4c21-a100-b807d8d46925`
   - KV ID: `59fe208f58e2486884a6f2460f415b7a`

3. Set secrets:

```bash
wrangler secret put SESSION_SECRET
wrangler secret put OAUTH_GOOGLE_CLIENT_SECRET
wrangler secret put OAUTH_GITHUB_CLIENT_SECRET
wrangler secret put OAUTH_DISCORD_CLIENT_SECRET
```

**Note:** Email authentication has been disabled. Login is available through GitHub and Discord OAuth only.

4. Set OAuth client IDs and Discord configuration in `wrangler.jsonc` (`vars`).

   - Staging URL: `https://dailies-stg.0x9.ca`
   - Production URL: `https://dailies.0x9.ca`

   Redirect URLs:

   - GitHub dev: `http://192.168.17.2:8787/auth/github/callback`
   - GitHub staging: `https://dailies-stg.0x9.ca/auth/github/callback`
   - GitHub prod: `https://dailies.0x9.ca/auth/github/callback`
   - Discord dev: `http://192.168.17.2:8787/auth/discord/callback`
   - Discord staging: `https://dailies-stg.0x9.ca/auth/discord/callback`
   - Discord prod: `https://dailies.0x9.ca/auth/discord/callback`

   Discord Configuration:
   - Set `OAUTH_DISCORD_CLIENT_ID` to your Discord OAuth2 application client ID
   - Set `DISCORD_GUILD_ID` to your Discord server ID
   - Set `DISCORD_ROLE_ADMIN` to the role ID for "Dailies Admin"
   - Set `DISCORD_ROLE_EDITOR` to the role ID for "Dailies Editor"
   - Put the client secret with: `wrangler secret put OAUTH_DISCORD_CLIENT_SECRET --env production`

   Users who log in with Discord and are members of your server with the "Dailies Admin" or "Dailies Editor" roles will automatically receive the corresponding application role.

5. Fill in local secret notes in `.secrets.env` (ignored by git).

   You can sync OAuth client IDs/APP_URL into `wrangler.jsonc`, generate `.dev.vars` for local `wrangler dev`, and upload secrets for default + staging + production in one step:

```bash
./scripts/set-secrets.sh
```

   Or pass a custom secrets file path:

```bash
./scripts/set-secrets.sh /path/to/secrets.env
```

6. Apply migrations locally:

```bash
wrangler d1 migrations apply daily-game-list --local
```

7. Run dev server:

```bash
npm run dev
```

8. Validate Wrangler config before deploy:

```bash
npm run validate:config
```

Email auth rate-limit vars are configurable in `wrangler.jsonc` (or via `.secrets.env` + `./scripts/set-secrets.sh`):

- `EMAIL_AUTH_RATE_EMAIL_BURST_MAX` / `EMAIL_AUTH_RATE_EMAIL_BURST_WINDOW_SEC`
- `EMAIL_AUTH_RATE_IP_BURST_MAX` / `EMAIL_AUTH_RATE_IP_BURST_WINDOW_SEC`
- `EMAIL_AUTH_RATE_EMAIL_HOURLY_MAX` / `EMAIL_AUTH_RATE_EMAIL_HOURLY_WINDOW_SEC`
- `EMAIL_AUTH_RATE_IP_HOURLY_MAX` / `EMAIL_AUTH_RATE_IP_HOURLY_WINDOW_SEC`
- `EMAIL_AUTH_RATE_VERIFY_EMAIL_MAX` / `EMAIL_AUTH_RATE_VERIFY_EMAIL_WINDOW_SEC`
- `EMAIL_AUTH_RATE_VERIFY_IP_MAX` / `EMAIL_AUTH_RATE_VERIFY_IP_WINDOW_SEC`
- `EMAIL_AUTH_RATE_MAGIC_IP_MAX` / `EMAIL_AUTH_RATE_MAGIC_IP_WINDOW_SEC`

Optional Turnstile protection for email auth routes:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY` (secret)
- `TURNSTILE_ENFORCE_EMAIL_AUTH=1`

Use mock login during local development:

- `/auth/mock-login/user`
- `/auth/mock-login/editor`
- `/auth/mock-login/admin`

After adding migrations, apply them locally and remotely:

```bash
npx wrangler d1 migrations apply daily-game-list --local
npx wrangler d1 migrations apply daily-game-list --remote --env staging
npx wrangler d1 migrations apply daily-game-list --remote --env production
```

## Important files

- `src/index.ts` - app routes, APIs, SSR pages, scheduled job
- `src/lib/auth.ts` - session middleware and role checks
- `src/lib/cache.ts` - KV cache helpers
- `migrations/0001_initial.sql` - schema
- `migrations/0002_seed_categories.sql` - seed categories + system user
- `migrations/0005_game_reset_metadata.sql` - reset basis/time metadata
- `migrations/0006_anonymous_favorites.sql` - anonymous favorites table
- `migrations/0007_anonymous_votes.sql` - anonymous vote table (IP-hash keyed)

## Additional docs

- `CONTRIBUTING.md` - contributor workflow and checks
- `AGENTS.md` - coding-agent focused architecture and guardrails
- `docs/API.md` - endpoint inventory
- `docs/ARCHITECTURE.md` - request flows and sequence diagrams
