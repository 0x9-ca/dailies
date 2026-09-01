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
