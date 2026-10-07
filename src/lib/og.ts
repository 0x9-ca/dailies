// Social preview images for game pages (/og/games/<slug>.png), drawn in the Worker with satori + resvg (WASM).
// The look follows the site-wide image in assets-src/og-image.html: dark background, blue glow, "0x9 dles" wordmark.
import { render } from "@cf-wasm/og/workerd";
import { MANROPE_500_WOFF, MANROPE_800_WOFF } from "./og-fonts";

type Node = { type: string; props: Record<string, unknown>; key: null };

// Minimal element builder for satori (it takes React-like objects; no JSX in this project).
function h(type: string, style: Record<string, unknown>, ...children: Array<Node | string | false | null>): Node {
  const kids = children.filter((child): child is Node | string => child !== false && child !== null);
  return { type, key: null, props: { style: { display: "flex", ...style }, children: kids.length === 1 ? kids[0] : kids } };
}

const fontCache = new Map<string, ArrayBuffer>();
function font(name: string, base64: string): ArrayBuffer {
  let data = fontCache.get(name);
  if (!data) {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    data = bytes.buffer;
    fontCache.set(name, data);
  }
  return data;
}

// Category pill colour (also used by the site's own pills, so they match).
export function categoryHue(slug: string): number {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

// Shortens at a word boundary where there is one.
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}

export interface GameOgInput {
  title: string;
  description: string | null;
  categories: Array<{ slug: string; name: string }>;
  paywall: boolean;
}

export async function renderGameOgPng(game: GameOgInput): Promise<Uint8Array> {
  const title = clip(game.title, 48);
  const titleSize = title.length <= 14 ? 104 : title.length <= 24 ? 84 : 64;

  const tree = h(
    "div",
    {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: "64px 80px 56px",
      fontFamily: "Manrope",
      color: "#f2f2f2",
      backgroundColor: "#0e1013",
      backgroundImage: "radial-gradient(circle at 0% 0%, rgba(0,164,252,0.26), rgba(14,16,19,0) 55%), radial-gradient(circle at 100% 100%, rgba(125,211,252,0.12), rgba(14,16,19,0) 55%)"
    },
    h("div", { alignItems: "center", fontSize: 40, fontWeight: 800 }, "0", h("span", { color: "#00a4fc" }, "x"), "9 dles"),
    h(
      "div",
      { flexDirection: "column", flexGrow: 1, justifyContent: "center" },
      h("div", { fontSize: titleSize, fontWeight: 800, lineHeight: 1.05, letterSpacing: -1, flexShrink: 0 }, title),
      game.categories.length > 0 &&
        h(
          "div",
          { marginTop: 28, gap: 14, flexShrink: 0 },
          ...game.categories.slice(0, 3).map((cat) => {
            const value = categoryHue(cat.slug);
            return h(
              "div",
              {
                padding: "6px 20px",
                borderRadius: 999,
                fontSize: 28,
                fontWeight: 800,
                color: `hsl(${value}, 65%, 28%)`,
                backgroundColor: `hsl(${value}, 65%, 90%)`,
                border: `2px solid hsl(${value}, 55%, 72%)`
              },
              cat.name
            );
          })
        ),
      game.description
        ? h("div", { marginTop: 28, fontSize: 32, fontWeight: 500, lineHeight: 1.35, color: "#c4c8ce", maxWidth: 1040 }, clip(game.description, title.length > 24 ? 100 : 150))
        : null
    ),
    h(
      "div",
      { justifyContent: "space-between", alignItems: "center", fontSize: 28, fontWeight: 800 },
      h("div", { color: "#a8adb5" }, game.paywall ? "Daily game · requires payment" : "Free daily game · play in your browser"),
      h("div", { color: "#7dd3fc" }, "dailies.0x9.ca")
    )
  );

  const result = await render(tree as never, {
    width: 1200,
    height: 630,
    defaultFont: { data: font("500", MANROPE_500_WOFF) },
    fonts: [
      { name: "Manrope", data: font("500", MANROPE_500_WOFF), weight: 500, style: "normal" },
      { name: "Manrope", data: font("800", MANROPE_800_WOFF), weight: 800, style: "normal" }
    ]
  }).asPng();
  return result.image;
}
