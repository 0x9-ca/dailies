// Matches pasted game names and links (e.g. copied from Discord) to approved games, for the rotation's Import panel.
import { compactSearchText, damerauLevenshtein, fuzzyTitleMatch, trigramSimilarity, typoLimit } from "./search";
import { urlLocationKey } from "./url";

export const IMPORT_MAX_LINES = 200;
export const IMPORT_MAX_BYTES = 10 * 1024;

export type ImportGame = { id: string; slug: string; title: string; url: string };
export type ImportMatchGame = { id: string; slug: string; title: string };
export type ImportRow = {
  input: string;
  match: ImportMatchGame | null;
  confidence: "exact" | "fuzzy" | "none";
  alternatives: ImportMatchGame[];
};
export type ParsedLine = { input: string; name: string; urls: string[] };

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Strips numbering, bullets, emoji, check marks, markdown and trailing scores ("3/6", "#1234", "X/6") from one entry. */
export function cleanName(raw: string): string {
  let s = raw.replace(URL_RE, " ");
  s = s.replace(/[*_`~|<>]+/g, " ");
  s = s.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0e\ufe0f\u20e3\u2713\u2714\u2715\u2716\u2717\u2718]/gu, " ");
  s = s.replace(/^\s*(?:[-+*\u2022\u25cf\u25aa>]+|\(?\d{1,3}[.):]|#\d{1,3}[.):])\s+/u, "");
  s = s.replace(/^\s*\d{1,3}\s*[.)]\s*/, "");
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/[\s:\-\u2013\u2014|,;]*(?:\b[\dX]{1,2}\s*\/\s*\d{1,3}\*?|#\s?\d[\d,]*|\b(?:puzzle|day|no\.?)\s*#?\s*\d[\d,]*|\b\d{1,2}:\d{2}(?::\d{2})?|\(\s*\)|\[\s*\])\s*$/iu, "")
      .replace(/[\s:\-\u2013\u2014|,;.]+$/u, "");
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Splits pasted text into entries (one per line; commas and semicolons also split a line that has no link). */
export function parseImportText(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const urls = trimmed.match(URL_RE) ?? [];
    const parts = urls.length === 0 && /[,;]/.test(trimmed) ? trimmed.split(/[,;]/) : [trimmed];
    for (const part of parts) {
      const input = part.trim();
      if (!input) continue;
      const partUrls = input.match(URL_RE) ?? [];
      const name = cleanName(input);
      if (!name && partUrls.length === 0) continue;
      out.push({ input, name, urls: partUrls });
    }
  }
  return out;
}

const toMatch = (g: ImportGame): ImportMatchGame => ({ id: g.id, slug: g.slug, title: g.title });

export function matchImportLines(lines: ParsedLine[], games: ImportGame[]): ImportRow[] {
  const byHost = new Map<string, ImportGame[]>();
  const byLocation = new Map<string, ImportGame>();
  const byTitle = new Map<string, ImportGame>();
  const prepared = games.map((g) => ({ g, compact: compactSearchText(g.title) }));
  for (const { g, compact } of prepared) {
    const key = urlLocationKey(g.url);
    if (key) {
      const host = key.split("/")[0];
      byHost.set(host, [...(byHost.get(host) ?? []), g]);
      if (!byLocation.has(key)) byLocation.set(key, g);
    }
    if (compact && !byTitle.has(compact)) byTitle.set(compact, g);
  }

  return lines.map((line): ImportRow => {
    for (const url of line.urls) {
      const key = urlLocationKey(url);
      if (!key) continue;
      const host = key.split("/")[0];
      const onHost = byHost.get(host) ?? [];
      const hit = onHost.length === 1 ? onHost[0] : byLocation.get(key);
      if (hit) return { input: line.input, match: toMatch(hit), confidence: "exact", alternatives: [] };
    }
    const q = compactSearchText(line.name);
    const exact = q ? byTitle.get(q) : undefined;
    if (exact) return { input: line.input, match: toMatch(exact), confidence: "exact", alternatives: [] };

    // Fuzzy: whole-title typo or trigram similarity picks the match; word-level hits only suggest alternatives.
    const scored: { g: ImportGame; rank: number; whole: boolean }[] = [];
    if (q.length >= 3) {
      for (const { g, compact } of prepared) {
        const fz = fuzzyTitleMatch(line.name, g.title);
        if (!fz) continue;
        const sim = trigramSimilarity(q, compact);
        const whole = damerauLevenshtein(q, compact) <= typoLimit(compact.length) || sim >= 0.6;
        const lenGap = Math.abs(q.length - compact.length) / Math.max(q.length, compact.length);
        scored.push({ g, rank: fz.score - lenGap * 0.5 + (whole ? 1 : 0), whole });
      }
      scored.sort((a, b) => b.rank - a.rank || a.g.title.length - b.g.title.length);
    }
    const best = scored[0];
    if (best && best.whole) {
      return { input: line.input, match: toMatch(best.g), confidence: "fuzzy", alternatives: scored.slice(1, 4).map((s) => toMatch(s.g)) };
    }
    return { input: line.input, match: null, confidence: "none", alternatives: scored.slice(0, 3).map((s) => toMatch(s.g)) };
  });
}
