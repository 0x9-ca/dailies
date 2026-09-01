# Daily Game List (Cloudflare Worker)

Daily game directory and aggregator built on Cloudflare Workers + D1 + KV.

**Live site:** [https://dailies.0x9.ca](https://dailies.0x9.ca)  
**Discord:** [https://discord.gg/uRApjQJ4vh](https://discord.gg/uRApjQJ4vh)

## Features

- **Public directory** - Browse, search, and sort games by top, new, trending, or reset time
- **Category filters** - Seeded category taxonomy for easy discovery
- **Discord authentication** - Secure login with Discord OAuth
- **Submission workflow** - Submit games with pending approval, voting, and reporting
- **Anonymous voting** - Track votes by hashed client IP (one vote per game per IP)
- **Favorites & rotation** - Manual ordering with weekday masks for daily game routines
- **Rotation sharing** - Generate shareable links to let others view your daily rotation
- **Rotation export/import** - Export your rotation as JSON and import it on any device (works for both logged-in and anonymous users)
- **Anonymous favorites** - Browser localStorage with post-login import into account
- **Game reset tracking** - Local vs server time support with reset-soon sorting
- **Curated lists** - Public/private visibility with admin/editor management and drag-and-drop reordering
- **Moderation tools** - Editor/admin roles with bulk actions and queue search
- **Link health checks** - Daily cron job with auto-broken reporting threshold
- **Account settings** - Display name updates and session revocation
- **Compact design** - Clean game cards with bold titles and metadata
- **Paywall indicator** - Editors/admins can mark games as paywall; green `$` badge on cards
- **Click tracking** - Open-game clicks are tracked and factored into scoring

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
wrangler secret put OAUTH_DISCORD_CLIENT_SECRET
```

4. Set Discord configuration in `wrangler.jsonc` (`vars`).

   - Staging URL: `https://dailies-stg.0x9.ca`
   - Production URL: `https://dailies.0x9.ca`

   Discord redirect URLs:

   - Dev: `http://192.168.17.2:8787/auth/discord/callback`
   - Staging: `https://dailies-stg.0x9.ca/auth/discord/callback`
   - Production: `https://dailies.0x9.ca/auth/discord/callback`

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
- `src/env.ts` - Env type definitions
- `migrations/0001_initial.sql` - schema
- `migrations/0002_seed_categories.sql` - seed categories + system user
- `migrations/0005_game_reset_metadata.sql` - reset basis/time metadata
- `migrations/0006_anonymous_favorites.sql` - anonymous favorites table
- `migrations/0007_anonymous_votes.sql` - anonymous vote table (IP-hash keyed)
- `migrations/0008_add_discord_provider.sql` - Discord OAuth provider
- `migrations/0009_add_rotation_share_token.sql` - rotation sharing tokens
- `migrations/0010_game_click_count.sql` - click count column for scoring
- `migrations/0011_game_paywall.sql` - paywall flag for games

## License and Attribution

This project is licensed under the **GNU General Public License v3.0** (GPLv3). See the [LICENSE](LICENSE) file for full details.

### Attribution

The base list of daily games is sourced from [aukspot/dles](https://github.com/aukspot/dles). We are grateful for their comprehensive collection of daily puzzle games.

## Additional docs

- `CONTRIBUTING.md` - contributor workflow and checks
- `AGENTS.md` - coding-agent focused architecture and guardrails
- `docs/API.md` - endpoint inventory
- `docs/ARCHITECTURE.md` - request flows and sequence diagrams
