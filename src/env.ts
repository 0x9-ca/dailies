import type { AnnouncementScheduler } from "./index";

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
  SESSION_SECRET: string;
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
