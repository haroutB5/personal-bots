// @effect-diagnostics nodeBuiltinImport:off - reads the shipped stylesheet and the Tailwind theme off disk.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * `variant="destructive"` buttons print `text-white` on `bg-destructive`
 * (`components/ui/button.tsx`), and they carry the most consequential labels in
 * the app (Delete chat, Delete bot, Delete memory). The fill therefore has to
 * clear WCAG 1.4.3 AA on its own, which red-500 does not.
 */
const AA_NORMAL_TEXT = 4.5;

const indexCss = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("./index.css", import.meta.url)),
  "utf8",
);
const themeCss = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("../node_modules/tailwindcss/theme.css", import.meta.url)),
  "utf8",
);

/** The `--destructive` declaration inside the light `:root` block. */
function lightDestructiveToken(): string {
  const root = indexCss.slice(indexCss.indexOf(":root {\n  color-scheme: light;"));
  const match = /--destructive:\s*([^;]+);/.exec(root);
  if (match === null) throw new Error("no --destructive in the light :root block");
  return match[1]!.trim();
}

function tailwindOklch(name: string): readonly [number, number, number] {
  const match = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`).exec(
    themeCss,
  );
  if (match === null) throw new Error(`no oklch value for --${name}`);
  return [Number(match[1]) / 100, Number(match[2]), Number(match[3])];
}

/** Oklch -> linear sRGB (Ottosson's matrices), clamped to gamut. */
function oklchToLinearSrgb([lightness, chroma, hueDeg]: readonly [
  number,
  number,
  number,
]): readonly [number, number, number] {
  const hue = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** WCAG 2.x relative luminance of a linear-sRGB triple. */
function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastWithWhite(color: readonly [number, number, number]): number {
  return 1.05 / (relativeLuminance(color) + 0.05);
}

describe("destructive button fill", () => {
  it("is red-600, not the red-500 that shipped at 3.81:1", () => {
    expect(lightDestructiveToken()).toBe("var(--color-red-600)");
  });

  it("clears AA for white 16px labels, where red-500 does not", () => {
    const red600 = contrastWithWhite(oklchToLinearSrgb(tailwindOklch("color-red-600")));
    const red500 = contrastWithWhite(oklchToLinearSrgb(tailwindOklch("color-red-500")));

    // Runtime-measured in the pass-2 audit: 4.77:1 and 3.81:1.
    expect(red600).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(red600).toBeCloseTo(4.77, 1);
    expect(red500).toBeLessThan(AA_NORMAL_TEXT);
  });
});
