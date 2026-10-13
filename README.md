# 0x9 dles

A community-run directory of 800+ daily games: Wordle, Connections, and the hundreds of "-dle" puzzles that followed. Browse by category, vote, build your own daily rotation, and follow curated lists from editors and Twitch streamers.

**[dailies.0x9.ca](https://dailies.0x9.ca)** · [Discord](https://discord.gg/uRApjQJ4vh) · [Changelog](https://dailies.0x9.ca/changelog)

## Features

- **Browse and discover:** search, filter by category, and sort by popularity, newest, trending or next reset. Each game has its own page with a description, "How to play" text and a share image.
- **Vote and rank:** anyone can vote, signed in or not. Rankings combine votes, freshness, clicks and list appearances, and vote counts update live.
- **Daily rotation:** favorite games, order them and pick the weekdays you play them, with or without an account. Share, export or import your rotation.
- **Reset tracking:** live countdowns in your own time zone. Cards fade once you've played since the last reset and warn when an unplayed game is about to reset.
- **Curated lists:** editor-made lists, optionally tagged with a Twitch streamer (verified badge, live indicator, streamer editing). Visitors can suggest games and vote on suggestions.
- **Community moderation:** submissions are reviewed by editors, reports and daily link checks catch broken games, and every change is recorded in a public mod log. New games are announced on Discord.
- **Sign in with Discord or Twitch:** only the account ID and username are stored, and provider tokens are revoked right after sign-in. Discord server roles grant editor and admin access.

## Tech stack

[Cloudflare Workers](https://developers.cloudflare.com/workers/) with [Hono](https://hono.dev/), server-rendered HTML with small inline scripts, D1 (SQLite) for data, KV for caching, a Durable Object for batching Discord announcements, and a daily cron for link checks and score updates. TypeScript and Zod throughout. There is no front-end build step.

## Getting started

Requires Node.js 22 or newer. Local development runs entirely on your machine, with no Cloudflare account needed.

```bash
npm install
npx wrangler d1 migrations apply DB --local --persist-to /tmp/dles-state
npx wrangler dev --ip 127.0.0.1 --port 8799 --persist-to /tmp/dles-state --var APP_URL:http://127.0.0.1:8799
```

Open http://127.0.0.1:8799 and sign in instantly at `/auth/mock-login/user`, `/auth/mock-login/editor` or `/auth/mock-login/admin`. This only works in development. Games can be added from the Submit page as admin, where they are approved straight away.

Before committing, run:

```bash
npm run typecheck
npm run validate:config
```

## Configuration

| Setting | Kind | Purpose |
|---|---|---|
| `APP_URL` | var | Public base URL |
| `OAUTH_DISCORD_CLIENT_ID` / `OAUTH_DISCORD_CLIENT_SECRET` | var / secret | Discord sign-in |
| `OAUTH_TWITCH_CLIENT_ID` / `OAUTH_TWITCH_CLIENT_SECRET` | var / secret | Twitch sign-in (hidden when unset) |
| `DISCORD_GUILD_ID`, `DISCORD_ROLE_ADMIN`, `DISCORD_ROLE_EDITOR` | var | Discord server roles that map to admin and editor |
| `DISCORD_NEW_GAME_WEBHOOK_URL`, `DISCORD_ROLE_DLE_ENJOYER` | secret / var | New-game announcements (off when unset) |
| `SESSION_SECRET` | secret | Session token hashing |

OAuth redirect URLs are `<APP_URL>/auth/discord/callback` and `<APP_URL>/auth/twitch/callback`. Keep secrets in `.secrets.env` (git-ignored). `./scripts/set-secrets.sh` syncs the vars into `wrangler.jsonc`, writes `.dev.vars` and uploads the secrets to staging and production.

## Deploying

Staging (`dailies-stg.0x9.ca`) and production (`dailies.0x9.ca`) each have their own D1 database and KV namespace. Always pass `--env`, and use the `DB` binding name in D1 commands so the command can't reach the wrong database:

```bash
npx wrangler d1 migrations apply DB --env staging --remote
npm run deploy:staging
npx wrangler d1 migrations apply DB --env production --remote
npm run deploy:production
```

Migrations are append-only. After adding one, run `npm run schema:dump` to regenerate `docs/schema.sql`.

## Documentation

- [`AGENTS.md`](AGENTS.md): product behaviour and architecture in detail
- [`CLAUDE.md`](CLAUDE.md): working conventions, environments and data safety
- [`CONTRIBUTING.md`](CONTRIBUTING.md): contributor workflow and manual test checklist
- [`docs/API.md`](docs/API.md): API endpoints
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): request flows
- [`docs/schema.sql`](docs/schema.sql): current database schema (generated)

## License and attribution

Licensed under the [GNU General Public License v3.0](LICENSE).

The original list of daily games came from [aukspot/dles](https://github.com/aukspot/dles). Many thanks for their collection.
