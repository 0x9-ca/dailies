// Typo-tolerant game title matching, the fallback for /games?q= when the plain search finds (almost) nothing.

/** Lowercase, every run of non-letters/digits becomes one space. */
export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Normalized text with the spaces removed, for whole-title comparisons. */
export function compactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/ /g, "");
}

/** Optimal string alignment distance: insert, delete, replace and swap of adjacent characters each cost 1. */
export function damerauLevenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = [];
  for (let i = 0; i < rows; i++) {
    d.push(new Array<number>(cols).fill(0));
    d[i][0] = i;
  }
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2][j - 2] + 1);
      }
      d[i][j] = best;
    }
  }
  return d[rows - 1][cols - 1];
}

export function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/** Jaccard similarity of the padded trigram sets, 0 to 1. */
export function trigramSimilarity(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared++;
  const union = ga.size + gb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Largest distance that still counts as a typo for a title of this (compact) length. */
export function typoLimit(compactLength: number): number {
  return Math.max(1, Math.floor(compactLength / 4));
}

export type FuzzyMatch = {
  /** 0 (no resemblance) to 1 (identical). Used for ranking. */
  score: number;
  /** Smallest distance between the query and the whole title or any one of its words. */
  distance: number;
  /** Strong enough for a "Did you mean" suggestion: a one-letter typo, or a very similar title. */
  strong: boolean;
};

/** Compares a query with one title. Null when the query is too short to match fuzzily (under 3 characters). */
export function fuzzyTitleMatch(query: string, title: string): FuzzyMatch | null {
  const q = compactSearchText(query);
  const t = compactSearchText(title);
  if (q.length < 3 || t.length === 0) return null;
  const limit = typoLimit(t.length);
  let distance = damerauLevenshtein(q, t);
  for (const word of normalizeSearchText(title).split(" ")) {
    if (word.length === 0) continue;
    distance = Math.min(distance, damerauLevenshtein(q, word));
  }
  const similarity = trigramSimilarity(q, t);
  if (distance > limit && similarity < 0.4) return null;
  return {
    score: Math.max(1 - distance / Math.max(q.length, t.length), similarity),
    distance,
    strong: distance <= 1 || similarity >= 0.5
  };
}
