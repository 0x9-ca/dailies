#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

const WRANGLER_CONFIG_PATH = new URL("../wrangler.jsonc", import.meta.url);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function get(obj, keyPath) {
  return keyPath.split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), obj);
}

const raw = readFileSync(WRANGLER_CONFIG_PATH, "utf8");
const config = parse(raw);

if (!config || typeof config !== "object") {
  console.error("Invalid wrangler.jsonc: could not parse config");
  process.exit(1);
}

const checks = [
  { path: "vars.APP_URL", env: "default" },
  { path: "vars.SESSION_COOKIE_NAME", env: "default" },
  { path: "env.staging.vars.APP_URL", env: "staging" },
  { path: "env.staging.vars.SESSION_COOKIE_NAME", env: "staging" },
  { path: "env.production.vars.APP_URL", env: "production" },
  { path: "env.production.vars.SESSION_COOKIE_NAME", env: "production" }
];

const failures = [];

for (const check of checks) {
  const value = get(config, check.path);
  if (!isNonEmptyString(value)) {
    failures.push(`Missing or empty ${check.path} (${check.env})`);
  }
}

const bindingChecks = [
  "d1_databases",
  "kv_namespaces",
  "env.staging.d1_databases",
  "env.staging.kv_namespaces",
  "env.production.d1_databases",
  "env.production.kv_namespaces"
];

for (const keyPath of bindingChecks) {
  const value = get(config, keyPath);
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`Missing or empty ${keyPath}`);
  }
}

const envUrls = [
  { name: "default", url: get(config, "vars.APP_URL") },
  { name: "staging", url: get(config, "env.staging.vars.APP_URL") },
  { name: "production", url: get(config, "env.production.vars.APP_URL") }
];

for (const envUrl of envUrls) {
  if (!isNonEmptyString(envUrl.url)) {
    continue;
  }
  try {
    const parsed = new URL(envUrl.url);
    if (envUrl.name !== "default" && parsed.protocol !== "https:") {
      failures.push(`APP_URL for ${envUrl.name} must use https`);
    }
  } catch {
    failures.push(`APP_URL for ${envUrl.name} is not a valid URL`);
  }
}

for (const name of ["staging", "production"]) {
  const appUrl = get(config, `env.${name}.vars.APP_URL`);
  const shortUrl = get(config, `env.${name}.vars.SHORT_URL`);
  if (!isNonEmptyString(shortUrl)) {
    failures.push(`Missing or empty env.${name}.vars.SHORT_URL`);
    continue;
  }
  try {
    const parsed = new URL(shortUrl);
    if (parsed.protocol !== "https:") failures.push(`SHORT_URL for ${name} must use https`);
    if (isNonEmptyString(appUrl) && parsed.host === new URL(appUrl).host) failures.push(`SHORT_URL for ${name} must differ from APP_URL`);
    const patterns = (get(config, `env.${name}.routes`) ?? []).map((r) => r.pattern);
    for (const host of [new URL(appUrl).host, parsed.host]) {
      if (!patterns.includes(host)) failures.push(`env.${name}.routes is missing a custom domain for ${host}`);
    }
  } catch {
    failures.push(`SHORT_URL for ${name} is not a valid URL`);
  }
}

// Per-env deployed bindings, routes, crons and workers_dev.
for (const name of ["staging", "production"]) {
  const e = `env.${name}`;
  const has = (list, key, val) => Array.isArray(list) && list.some((x) => x && x[key] === val);
  if (!has(get(config, `${e}.d1_databases`), "binding", "DB")) failures.push(`${e}.d1_databases needs a DB binding`);
  if (!has(get(config, `${e}.kv_namespaces`), "binding", "CACHE")) failures.push(`${e}.kv_namespaces needs a CACHE binding`);
  const dos = get(config, `${e}.durable_objects.bindings`);
  for (const b of ["ANNOUNCER", "ROLE_SYNC"]) {
    if (!has(dos, "name", b)) failures.push(`${e}.durable_objects.bindings needs ${b}`);
  }
  if (get(config, `${e}.workers_dev`) !== false) failures.push(`${e}.workers_dev must be false`);
  const routes = get(config, `${e}.routes`);
  if (!Array.isArray(routes) || routes.length < 2 || !routes.every((r) => r.custom_domain === true)) {
    failures.push(`${e}.routes needs two custom domains`);
  }
  // Crons: the env's own triggers, else the top-level ones (checked against the dry-run output, see wrangler docs).
  const crons = get(config, `${e}.triggers.crons`) ?? get(config, "triggers.crons");
  for (const cron of ["15 8 * * *", "*/15 * * * *"]) {
    if (!Array.isArray(crons) || !crons.includes(cron)) failures.push(`${e} is missing cron "${cron}"`);
  }
}

if (failures.length > 0) {
  console.error("wrangler.jsonc validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("wrangler.jsonc validation passed");
