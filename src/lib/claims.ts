// Developer claims: proof that a signed-in user runs a game. The user puts a per-claim token on the game's page
// (a <meta> tag) or on its site (/.well-known/0x9dles.txt) and the Worker fetches it. See migrations/0025.

/**
 * The meta tag name and well-known file a developer must publish. Production uses the plain names; other
 * environments add a suffix (staging: 0x9dles-stg-verify, /.well-known/0x9dles-stg.txt) so a token proven against
 * staging can never be mistaken for one proven against production.
 */
export function claimNames(appEnv: string): { metaName: string; filePath: string } {
  const env = (appEnv || "").trim().toLowerCase();
  if (env === "production") return { metaName: "0x9dles-verify", filePath: "/.well-known/0x9dles.txt" };
  const suffix = env === "staging" ? "stg" : env === "development" ? "dev" : env.replace(/[^a-z0-9]/g, "") || "dev";
  return { metaName: `0x9dles-${suffix}-verify`, filePath: `/.well-known/0x9dles-${suffix}.txt` };
}

const CLAIM_FETCH_TIMEOUT_MS = 8_000;
const CLAIM_MAX_BYTES = 512 * 1024;
const CLAIM_FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; DailyGameVerifier/1.0; +https://dailies.0x9.ca)",
  Accept: "text/html,text/plain,*/*;q=0.8"
};

/** "meta"/"file": the token is there. "absent": the site answered and it isn't. "unreachable": couldn't tell. */
export type ClaimCheck = "meta" | "file" | "absent" | "unreachable";

export function newClaimToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function claimMetaSnippet(token: string, appEnv: string): string {
  return `<meta name="${claimNames(appEnv).metaName}" content="${token}">`;
}

/** Reads at most CLAIM_MAX_BYTES of a response body as text, so a huge page can't cost us memory or time. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  while (received < CLAIM_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

function attributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of tag.matchAll(/([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

export function htmlHasClaimMeta(html: string, token: string, metaName: string): boolean {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (attrs.get("name")?.toLowerCase() === metaName && attrs.get("content")?.trim() === token) return true;
  }
  return false;
}

type FetchOutcome = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "unreachable" };

async function fetchText(url: string): Promise<FetchOutcome> {
  try {
    const res = await fetch(url, { redirect: "follow", headers: CLAIM_FETCH_HEADERS, signal: AbortSignal.timeout(CLAIM_FETCH_TIMEOUT_MS) });
    if (res.ok) return { kind: "ok", text: await readCapped(res) };
    // Only a definitive "no such page" says the token isn't there; bot walls and 5xx say nothing.
    return res.status === 404 || res.status === 410 ? { kind: "missing" } : { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}

/** Looks for the token on the game's own page (meta tag), then at the site's well-known file. */
export async function checkClaimToken(gameUrl: string, token: string, appEnv: string): Promise<ClaimCheck> {
  const { metaName, filePath } = claimNames(appEnv);
  let origin: string;
  try {
    const parsed = new URL(gameUrl);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) return "absent";
    origin = parsed.origin;
  } catch {
    return "absent";
  }

  const page = await fetchText(gameUrl);
  if (page.kind === "ok" && htmlHasClaimMeta(page.text, token, metaName)) return "meta";
  const file = await fetchText(origin + filePath);
  if (file.kind === "ok" && file.text.slice(0, 4096).split(/\s+/).includes(token)) return "file";
  // A page we could read (or know is gone) without the token is a definite "absent"; a bot wall or outage isn't.
  return page.kind === "unreachable" ? "unreachable" : "absent";
}
