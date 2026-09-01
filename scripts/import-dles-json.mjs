#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

function parseArgs(argv) {
  const args = {
    file: "dles.json",
    database: "daily-game-list",
    local: true,
    remote: false,
    env: "",
    dryRun: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--file" && argv[i + 1]) {
      args.file = argv[i + 1];
      i += 1;
      continue;
    }
    if (value === "--db" && argv[i + 1]) {
      args.database = argv[i + 1];
      i += 1;
      continue;
    }
    if (value === "--env" && argv[i + 1]) {
      args.env = argv[i + 1];
      i += 1;
      continue;
    }
    if (value === "--remote") {
      args.remote = true;
      args.local = false;
      continue;
    }
    if (value === "--local") {
      args.local = true;
      args.remote = false;
      continue;
    }
    if (value === "--dry-run") {
      args.dryRun = true;
      continue;
    }
  }

  return args;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function canonicalizeUrl(input) {
  const url = new URL(String(input || "").trim());
  const normalizedProtocol = url.protocol.toLowerCase();
  if (normalizedProtocol !== "https:" && normalizedProtocol !== "http:") {
    throw new Error("Only http/https URLs are allowed");
  }
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();

  const params = new URLSearchParams(url.search);
  for (const key of Array.from(params.keys())) {
    if (key.toLowerCase().startsWith("utm_") || key === "ref" || key === "source") {
      params.delete(key);
    }
  }
  url.search = params.toString();

  if (url.pathname.endsWith("/") && url.pathname.length > 1) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function makeUniqueSlug(base, used) {
  let candidate = base || "category";
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base || "category"}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function buildImportRows(rawEntries) {
  const rows = [];
  const categoriesByName = new Map();
  const usedCategorySlugs = new Set();
  let skipped = 0;

  for (const entry of rawEntries) {
    const title = String(entry?.name || "").trim();
    const url = String(entry?.url || "").trim();
    if (!title || !url) {
      skipped += 1;
      continue;
    }

    let canonicalUrl;
    try {
      canonicalUrl = canonicalizeUrl(url);
    } catch {
      skipped += 1;
      continue;
    }

    const categoryName = String(entry?.category || "Misc").trim() || "Misc";
    if (!categoriesByName.has(categoryName)) {
      const baseSlug = slugify(categoryName) || "misc";
      categoriesByName.set(categoryName, makeUniqueSlug(baseSlug, usedCategorySlugs));
    }

    rows.push({
      title,
      url,
      canonicalUrl,
      description: String(entry?.description || "").trim() || null,
      categoryName,
      categorySlug: categoriesByName.get(categoryName)
    });
  }

  return { rows, categoriesByName, skipped };
}

function buildSql({ rows, categoriesByName }, useTransaction) {
  const lines = [];
  lines.push("PRAGMA foreign_keys = ON;");
  if (useTransaction) {
    lines.push("BEGIN TRANSACTION;");
  }
  lines.push(
    `INSERT OR IGNORE INTO users (id, email, display_name, role) VALUES (${sqlString(
      SYSTEM_USER_ID
    )}, 'system@dailygamelist.local', 'System', 'admin');`
  );

  for (const [categoryName, categorySlug] of categoriesByName.entries()) {
    lines.push(
      `INSERT OR IGNORE INTO categories (id, slug, name, description, created_by_user_id) VALUES (${sqlString(
        randomUUID()
      )}, ${sqlString(categorySlug)}, ${sqlString(categoryName)}, 'Imported from dles.json', ${sqlString(SYSTEM_USER_ID)});`
    );
  }

  for (const row of rows) {
    const gameId = randomUUID();
    const slugBase = slugify(row.title) || "game";
    const slug = `${slugBase}-${gameId.slice(0, 8)}`;
    lines.push(
      `INSERT OR IGNORE INTO games (id, title, slug, url, canonical_url, description, source_name, source_url, submitted_by_user_id, status, approved_at, approved_by_user_id, created_at, updated_at)`
    );
    lines.push(
      `VALUES (${sqlString(gameId)}, ${sqlString(row.title)}, ${sqlString(slug)}, ${sqlString(row.url)}, ${sqlString(
        row.canonicalUrl
      )}, ${sqlString(row.description)}, 'dles.json', 'https://raw.githubusercontent.com/aukspot/dles/refs/heads/main/src/lib/data/dles.json', ${sqlString(
        SYSTEM_USER_ID
      )}, 'approved', datetime('now'), ${sqlString(SYSTEM_USER_ID)}, datetime('now'), datetime('now'));`
    );
    lines.push(
      `INSERT OR IGNORE INTO game_categories (game_id, category_id, assigned_by_user_id)`
    );
    lines.push(
      `SELECT games.id, categories.id, ${sqlString(SYSTEM_USER_ID)}`
    );
    lines.push("FROM games, categories");
    lines.push(
      `WHERE games.canonical_url = ${sqlString(row.canonicalUrl)} AND categories.slug = ${sqlString(row.categorySlug)};`
    );
  }

  if (useTransaction) {
    lines.push("COMMIT;");
  }
  return lines.join("\n");
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = resolve(process.cwd(), args.file);
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("Input JSON must be an array");
  }

  const prepared = buildImportRows(raw);
  const sql = buildSql(prepared, !args.remote);
  const sqlPath = "/tmp/opencode/dles-import.sql";
  writeFileSync(sqlPath, sql, "utf8");

  console.log(
    JSON.stringify(
      {
        file: filePath,
        totalEntries: raw.length,
        preparedGames: prepared.rows.length,
        skippedEntries: prepared.skipped,
        categoriesPrepared: prepared.categoriesByName.size,
        sqlPath,
        mode: args.remote ? "remote" : "local",
        env: args.env || "default"
      },
      null,
      2
    )
  );

  if (args.dryRun) {
    return;
  }

  const wranglerArgs = ["wrangler", "d1", "execute", args.database, "--file", sqlPath];
  if (args.remote) {
    wranglerArgs.push("--remote");
  } else {
    wranglerArgs.push("--local");
  }
  if (args.env) {
    wranglerArgs.push("--env", args.env);
  }

  const result = spawnSync("npx", wranglerArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run();
