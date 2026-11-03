// Duplicate game detection: normalized URL and title keys, plus an in-memory index over a few thousand games.
import { damerauLevenshtein } from "./search";

const TRACKING_PARAMS = new Set(["ref", "fbclid", "gclid"]);

/** Host (no www.), non-default port, path without trailing slash, and the remaining query params sorted. Null if unparsable. */
export function normalizeUrlKey(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  const port = url.port && url.port !== "80" && url.port !== "443" ? `:${url.port}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  const params = [...url.searchParams.entries()]
    .filter(([key]) => {
      const k = key.toLowerCase();
      return !k.startsWith("utm_") && !TRACKING_PARAMS.has(k);
    })
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const query = params.map(([k, v]) => `${k}=${v}`).join("&");
  return `${host}${port}${path}${query ? `?${query}` : ""}`;
}

/** Lowercase, diacritics and punctuation removed, a leading "the " dropped, spaces collapsed. */
export function normalizeTitle(input: string): string {
  const text = input
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return text.replace(/^the /, "");
}

/** Near-identical titles: distance of at most 1 (insert, delete, replace, adjacent swap), for titles of 6+ characters. */
export function titlesSimilar(a: string, b: string): boolean {
  if (a === b || a.length < 6 || b.length < 6) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  return damerauLevenshtein(a, b) <= 1;
}

export type DuplicateReason = "url" | "title" | "similar-title";
export type DuplicateGame = { id: string; title: string; slug: string; status: string; url: string };
export type DuplicateMatch = { game: DuplicateGame; reason: DuplicateReason };

type Entry = { game: DuplicateGame; titleKey: string };

export class DuplicateIndex {
  private byUrl = new Map<string, Entry[]>();
  private byTitle = new Map<string, Entry[]>();
  private entries: Entry[] = [];

  constructor(games: DuplicateGame[]) {
    for (const game of games) {
      const entry = { game, titleKey: normalizeTitle(game.title) };
      this.entries.push(entry);
      const urlKey = normalizeUrlKey(game.url);
      if (urlKey) push(this.byUrl, urlKey, entry);
      if (entry.titleKey) push(this.byTitle, entry.titleKey, entry);
    }
  }

  /** Games matching a url and/or title, one match per game (url beats title beats similar-title), never `excludeId`. */
  find(input: { url?: string | null; title?: string | null }, excludeId?: string): DuplicateMatch[] {
    const found = new Map<string, DuplicateMatch>();
    const add = (entry: Entry, reason: DuplicateReason) => {
      if (entry.game.id !== excludeId && !found.has(entry.game.id)) found.set(entry.game.id, { game: entry.game, reason });
    };
    const urlKey = input.url ? normalizeUrlKey(input.url) : null;
    if (urlKey) for (const entry of this.byUrl.get(urlKey) ?? []) add(entry, "url");
    const titleKey = input.title ? normalizeTitle(input.title) : "";
    if (titleKey) {
      for (const entry of this.byTitle.get(titleKey) ?? []) add(entry, "title");
      if (titleKey.length >= 6) {
        for (const entry of this.entries) if (titlesSimilar(titleKey, entry.titleKey)) add(entry, "similar-title");
      }
    }
    return [...found.values()];
  }

  /** Groups of games sharing a normalized URL or title (exact only, no fuzzy pass). */
  exactGroups(): Array<{ reason: "url" | "title"; games: DuplicateGame[] }> {
    const groups: Array<{ reason: "url" | "title"; games: DuplicateGame[] }> = [];
    const seen = new Set<string>();
    for (const [reason, map] of [["url", this.byUrl], ["title", this.byTitle]] as const) {
      for (const entries of map.values()) {
        if (entries.length < 2) continue;
        const key = `${reason}:${entries.map((e) => e.game.id).sort().join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        groups.push({ reason, games: entries.map((e) => e.game) });
      }
    }
    return groups;
  }
}

function push(map: Map<string, Entry[]>, key: string, entry: Entry): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}
