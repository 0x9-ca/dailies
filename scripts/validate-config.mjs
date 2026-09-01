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

if (failures.length > 0) {
  console.error("wrangler.jsonc validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("wrangler.jsonc validation passed");
