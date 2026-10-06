export function canonicalizeUrl(input: string): string {
  // Canonicalization improves duplicate detection and ranking consistency.
  const url = new URL(input.trim());
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

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Be forgiving about hand-typed URLs: trim, and assume https:// when the scheme is missing
// but the rest clearly looks like a host (has a dot, no credentials). Anything else is
// returned trimmed so strict validation rejects it.
export function normalizeUrlInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  const candidate = `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!url.username && !url.password && /^[^.]+(\.[^.]+)+$/.test(url.hostname)) {
      return candidate;
    }
  } catch {
    // Fall through to the unmodified input.
  }
  return trimmed;
}

// Accept H:MM, HH:MM and HH:MM:SS(.sss) and pad to HH:MM. Blank strings become undefined.
export function normalizeTimeInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(trimmed);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : trimmed;
}
