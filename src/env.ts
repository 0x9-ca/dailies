export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  APP_ENV: string;
  APP_URL: string;
  SESSION_COOKIE_NAME: string;
  OAUTH_DISCORD_CLIENT_ID: string;
  OAUTH_DISCORD_CLIENT_SECRET: string;
  DISCORD_GUILD_ID: string;
  DISCORD_ROLE_ADMIN: string;
  DISCORD_ROLE_EDITOR: string;
  SESSION_SECRET: string;
}

export type AppVariables = {
  user: AppUser | null;
  requestId: string;
  csrfToken: string;
};

export interface AppUser {
  id: string;
  email: string;
  displayName: string | null;
  role: "user" | "editor" | "admin";
}
