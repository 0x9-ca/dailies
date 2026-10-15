import type { AnnouncementScheduler, DeveloperRoleSync } from "./index";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  APP_ENV: string;
  EMAIL?: SendEmail;
  NOTIFY_EMAIL_TO?: string;
  NOTIFY_EMAIL_FROM?: string;
  APP_URL: string;
  SESSION_COOKIE_NAME: string;
  OAUTH_DISCORD_CLIENT_ID: string;
  OAUTH_DISCORD_CLIENT_SECRET: string;
  OAUTH_TWITCH_CLIENT_ID?: string;
  OAUTH_TWITCH_CLIENT_SECRET?: string;
  DISCORD_GUILD_ID: string;
  DISCORD_ROLE_ADMIN: string;
  DISCORD_ROLE_EDITOR: string;
  /** #dailies channel webhook for new-game announcements (secret). Unset = no announcements (e.g. staging, dev). */
  DISCORD_NEW_GAME_WEBHOOK_URL?: string;
  /** Role pinged by new-game announcements (@Dle Enjoyer). */
  DISCORD_ROLE_DLE_ENJOYER?: string;
  /** Durable Object that times batched new-game announcements (see AnnouncementScheduler). */
  ANNOUNCER: DurableObjectNamespace<AnnouncementScheduler>;
  /** The "Dle Developer" role given to verified developers who are in our server. */
  DISCORD_ROLE_DLE_DEVELOPER?: string;
  /**
   * Bot token (secret) used to give that role. A bot with Manage Roles, above the role in the server's role list, is
   * the only way to grant a role to someone else. Unset = the feature is off (staging, dev).
   */
  DISCORD_BOT_TOKEN?: string;
  /** Overrides https://discord.com/api/v10, so a local test can point the bot at a fake Discord. */
  DISCORD_API_BASE?: string;
  /** Overrides how long (seconds) to wait between checks of a developer who has not joined the server yet. */
  DEVELOPER_ROLE_RECHECK_SECONDS?: string;
  /** Durable Object that keeps checking for verified developers who join the server later (see DeveloperRoleSync). */
  ROLE_SYNC: DurableObjectNamespace<DeveloperRoleSync>;
  SESSION_SECRET: string;
  /** Cloudflare's metadata for the running Worker version (version_metadata binding); id changes on every deploy. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export type AppVariables = {
  user: AppUser | null;
  requestId: string;
  /** True when this is a logged-out page view that may be stored in the edge cache, so it must not show per-visitor state. */
  publicCache: boolean;
};

export interface AppUser {
  id: string;
  email: string;
  displayName: string | null;
  role: "user" | "editor" | "admin";
}
