export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  APP_ENV: string;
  EMAIL?: {
    send: (message: {
      to: string;
      from: { email: string; name?: string };
      subject: string;
      text?: string;
      html?: string;
    }) => Promise<unknown>;
  };
  APP_URL: string;
  SESSION_COOKIE_NAME: string;
  OAUTH_GOOGLE_CLIENT_ID: string;
  OAUTH_GITHUB_CLIENT_ID: string;
  OAUTH_DISCORD_CLIENT_ID: string;
  OAUTH_GOOGLE_CLIENT_SECRET: string;
  OAUTH_GITHUB_CLIENT_SECRET: string;
  OAUTH_DISCORD_CLIENT_SECRET: string;
  DISCORD_GUILD_ID: string;
  DISCORD_ROLE_ADMIN: string;
  DISCORD_ROLE_EDITOR: string;
  EMAIL_AUTH_WEBHOOK_URL: string;
  EMAIL_AUTH_WEBHOOK_TOKEN: string;
  EMAIL_AUTH_FROM: string;
  EMAIL_AUTH_RATE_EMAIL_BURST_MAX: string;
  EMAIL_AUTH_RATE_EMAIL_BURST_WINDOW_SEC: string;
  EMAIL_AUTH_RATE_IP_BURST_MAX: string;
  EMAIL_AUTH_RATE_IP_BURST_WINDOW_SEC: string;
  EMAIL_AUTH_RATE_EMAIL_HOURLY_MAX: string;
  EMAIL_AUTH_RATE_EMAIL_HOURLY_WINDOW_SEC: string;
  EMAIL_AUTH_RATE_IP_HOURLY_MAX: string;
  EMAIL_AUTH_RATE_IP_HOURLY_WINDOW_SEC: string;
  EMAIL_AUTH_RATE_VERIFY_EMAIL_MAX: string;
  EMAIL_AUTH_RATE_VERIFY_EMAIL_WINDOW_SEC: string;
  EMAIL_AUTH_RATE_VERIFY_IP_MAX: string;
  EMAIL_AUTH_RATE_VERIFY_IP_WINDOW_SEC: string;
  EMAIL_AUTH_RATE_MAGIC_IP_MAX: string;
  EMAIL_AUTH_RATE_MAGIC_IP_WINDOW_SEC: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_ENFORCE_EMAIL_AUTH: string;
  RESEND_API_KEY: string;
  POSTMARK_SERVER_TOKEN: string;
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
