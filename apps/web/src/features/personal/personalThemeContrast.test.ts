// @effect-diagnostics nodeBuiltinImport:off - reads the shipped stylesheet off disk.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

// Read, not imported: a `?raw` import of a stylesheet resolves to "" under the
// test config, which would have made every assertion below pass vacuously.
// Same approach as `src/destructiveContrast.test.ts`.
const CSS = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("./personal.css", import.meta.url)),
  "utf8",
);

/**
 * The contrast bar for `personal.css`, enforced rather than commented.
 *
 * A dark mode does not break loudly when a token drifts — the text just gets
 * harder to read, and nobody notices until they are reading in a dark room. So
 * every text token is pinned here against the surfaces it is actually painted
 * on, in BOTH appearances: the light set is included so the dark work cannot
 * quietly regress it.
 *
 * WCAG AA: 4.5:1 for body text, 3:1 for large text and for non-text indicators
 * (the status dots). Nothing on the personal surface is large enough to claim
 * the 3:1 body exemption, so 4.5:1 is the floor for anything with glyphs.
 */
function tokensIn(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  expect(start, `selector ${selector} missing from personal.css`).toBeGreaterThan(-1);
  const block = CSS.slice(start, CSS.indexOf("}", start));
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--personal-[a-z-]+):\s*([^;]+);/g)) {
    tokens[name!] = value!.trim();
  }
  return tokens;
}

const light = tokensIn(".personal-app {");
const dark = { ...light, ...tokensIn(":root.dark .personal-app {") };

function channels(hex: string): [number, number, number] {
  const value = hex.trim().replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  expect(full, `not a hex colour: ${hex}`).toMatch(/^[0-9a-fA-F]{6}$/);
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** [foreground token, background token, minimum ratio, what it is]. */
const PAIRS: ReadonlyArray<readonly [string, string, number, string]> = [
  ["--personal-text", "--personal-bg", 4.5, "body text on the page"],
  ["--personal-text", "--personal-surface", 4.5, "body text on a card"],
  ["--personal-text", "--personal-fill-muted", 4.5, "body text on a muted fill"],
  ["--personal-text-secondary", "--personal-bg", 4.5, "secondary text on the page"],
  ["--personal-text-secondary", "--personal-surface", 4.5, "secondary text on a card"],
  ["--personal-text-secondary", "--personal-fill-muted", 4.5, "secondary text on a fill"],
  ["--personal-text-tertiary", "--personal-bg", 4.5, "tertiary text on the page"],
  ["--personal-text-tertiary", "--personal-surface", 4.5, "tertiary text on a card"],
  ["--personal-text-preview", "--personal-bg", 4.5, "chat preview line"],
  ["--personal-text-preview", "--personal-surface", 4.5, "chat preview in the pinned box"],
  ["--personal-error", "--personal-bg", 4.5, "inline error text on the page"],
  ["--personal-error", "--personal-surface", 4.5, "inline error text on a card"],
  ["--personal-danger", "--personal-danger-bg", 4.5, "danger card text"],
  ["--personal-text", "--personal-danger-bg", 4.5, "body text on a danger card"],
  // Amber GLYPHS ("Needs you" on BotRow/GroupRow, the usage strip's binding
  // window, "Update available", the New group cap) use the text-safe token.
  ["--personal-review-text", "--personal-review-bg", 4.5, "amber text on a review card"],
  ["--personal-review-text", "--personal-bg", 4.5, "amber status label on the page"],
  ["--personal-review-text", "--personal-surface", 4.5, "amber status label on a card"],
  ["--personal-review-text", "--personal-fill-muted", 4.5, "amber label on a muted fill"],
  // The bright amber is a non-text indicator only: status dots and usage bars.
  ["--personal-review", "--personal-review-bg", 3, "amber dot on a review card"],
  ["--personal-review", "--personal-bg", 3, "amber status dot on the page"],
  ["--personal-review", "--personal-surface", 3, "amber status dot on a card"],
  ["--personal-text", "--personal-review-bg", 4.5, "body text on a review card"],
  ["--personal-section-label", "--personal-bg", 4.5, "uppercase section label on the page"],
  ["--personal-section-label", "--personal-surface", 4.5, "uppercase section label in a card"],
  ["--personal-primary-text", "--personal-primary", 4.5, "primary button label"],
  ["--personal-destructive-text", "--personal-destructive", 4.5, "destructive button label"],
  // The quieter swipe action beside Pin ("Mute"/"Unmute" on a Chats row).
  ["--personal-primary-text", "--personal-text-secondary", 4.5, "Mute swipe action label"],
  // The bell-slash beside a muted bot's name, on the page and on the selected row.
  ["--personal-text-secondary", "--personal-fill-muted", 3, "muted bell on the selected row"],
  // Non-text indicators: the status dots and the team diagram's lines.
  ["--personal-live", "--personal-bg", 3, "live status dot"],
  ["--personal-live", "--personal-surface", 3, "live status dot on a card"],
  ["--personal-team-live", "--personal-bg", 3, "team diagram live node"],
  ["--personal-team-line", "--personal-bg", 3, "team diagram connector"],
  // The filled part of a usage bar against its own track. This, not the track
  // against the page, is the ratio that carries "how much is used".
  ["--personal-text-tertiary", "--personal-track", 3, "usage bar fill on its track"],
  // The selected row/tile in the desktop bot list sits on --personal-fill-muted
  // (SELECTED_ROW_CLASS). Name, secondary, amber status (above), timestamp and
  // preview all have to hold there, and so do its bar and the live dot.
  ["--personal-text-tertiary", "--personal-fill-muted", 4.5, "timestamp on the selected row"],
  ["--personal-text-preview", "--personal-fill-muted", 4.5, "preview on the selected row"],
  ["--personal-primary", "--personal-fill-muted", 3, "selected row's accent bar"],
  ["--personal-live", "--personal-fill-muted", 3, "live dot on the selected row"],
];

/**
 * Pairs asserted in the dark appearance only.
 *
 * Not an exception list: these tokens are deliberately set to their existing
 * light-palette neighbours in light (`--personal-border-strong` is literally
 * `--personal-border`'s value, `--personal-avatar-halo` is `transparent`), so
 * there is nothing new to measure there. Asserting them against the light page
 * would be asserting the *pre-existing* light hairline, which is a light-palette
 * decision this change does not own and must not silently alter.
 *
 * `--personal-track` gets a visibility floor rather than an AA bar: it is the
 * unfilled remainder of a bar, not a boundary you have to see to operate the
 * control, so the bar it has to clear is "reads as a groove", not 3:1.
 */
const DARK_ONLY_PAIRS: ReadonlyArray<readonly [string, string, number, string]> = [
  ["--personal-border-strong", "--personal-bg", 3, "control boundary on the page"],
  ["--personal-border-strong", "--personal-surface", 3, "control boundary on a card"],
  ["--personal-avatar-halo", "--personal-bg", 3, "avatar contrast halo on the page"],
  ["--personal-avatar-halo", "--personal-surface", 3, "avatar contrast halo on a card"],
  ["--personal-track", "--personal-bg", 1.75, "usage bar track on the page"],
];

/**
 * Pairs that sit below the bar in the light theme, with their measured ratio
 * pinned so they cannot quietly get worse.
 *
 * Only non-text indicators are left here. Amber TEXT moved to the text-safe
 * `--personal-review-text` token (appreview 2026-09-22, pass 2 #1), so the
 * bright amber now only paints dots, bars and borders, where it is the
 * product's recognisable attention colour. It still misses the 3:1 non-text
 * bar in light; the dark values clear it comfortably.
 */
const LIGHT_EXCEPTIONS: Readonly<Record<string, number>> = {
  // The bright amber status dot.
  "--personal-review on --personal-bg": 2.27,
  "--personal-review on --personal-surface": 2.38,
  "--personal-review on --personal-review-bg": 2.24,
  // The green "live" dot, a hair under the 3:1 non-text bar.
  "--personal-live on --personal-bg": 2.92,
  "--personal-live on --personal-fill-muted": 2.75,
};

describe.each([
  ["light", light],
  ["dark", dark],
])("personal.css contrast (%s)", (appearance, tokens) => {
  it.each(PAIRS)("%s on %s is at least %s:1 (%s)", (foreground, background, minimum) => {
    const ratio = Number(contrast(tokens[foreground]!, tokens[background]!).toFixed(2));
    const detail = `${foreground} (${tokens[foreground]}) on ${background} (${tokens[background]})`;
    const known =
      appearance === "light" ? LIGHT_EXCEPTIONS[`${foreground} on ${background}`] : undefined;
    if (known !== undefined) {
      // Pinned, not waived: a regression below the recorded value fails here.
      expect(
        ratio,
        `${detail} regressed below its recorded light-theme value`,
      ).toBeGreaterThanOrEqual(known);
      return;
    }
    expect(ratio, detail).toBeGreaterThanOrEqual(minimum);
  });

  it("has no stale exceptions", () => {
    if (appearance !== "light") return;
    for (const key of Object.keys(LIGHT_EXCEPTIONS)) {
      const [foreground, background] = key.split(" on ") as [string, string];
      const ratio = Number(contrast(tokens[foreground]!, tokens[background]!).toFixed(2));
      const pair = PAIRS.find(([f, b]) => f === foreground && b === background);
      expect(pair, `exception ${key} is not in PAIRS`).toBeDefined();
      // Once a pair clears its real bar, the exception has to go.
      expect(ratio, `${key} now passes - delete it from LIGHT_EXCEPTIONS`).toBeLessThan(pair![2]);
    }
  });
});

describe("personal.css contrast (dark only)", () => {
  it.each(DARK_ONLY_PAIRS)("%s on %s is at least %s:1 (%s)", (foreground, background, minimum) => {
    const ratio = Number(contrast(dark[foreground]!, dark[background]!).toFixed(2));
    expect(
      ratio,
      `${foreground} (${dark[foreground]}) on ${background} (${dark[background]})`,
    ).toBeGreaterThanOrEqual(minimum);
  });

  it("keeps the light values of the dark-only tokens untouched", () => {
    // The whole point of the dark-only list: these tokens exist so DARK can be
    // raised. If a value here ever changes, the light surface changed with it.
    expect(light["--personal-border-strong"]).toBe(light["--personal-border"]);
    expect(light["--personal-avatar-halo"]).toBe("transparent");
    expect(light["--personal-track"]).toBe(light["--personal-fill-muted"]);
    // Section labels were --personal-text-secondary before the token existed.
    expect(light["--personal-section-label"]).toBe(light["--personal-text-secondary"]);
  });
});

describe("personal.css appearances", () => {
  it("overrides every colour token in the dark block", () => {
    // A token defined only in the light block keeps its light value on a dark
    // surface — the exact failure mode this file exists to catch. Non-colour
    // tokens (radii, font stack) are shared on purpose.
    // --personal-destructive is one saturated red in both appearances on
    // purpose: it is the delete colour, and it reads on either surface.
    // The desktop column widths are layout, not colour.
    const shared = new Set([
      "--personal-font",
      "--personal-destructive",
      "--personal-destructive-text",
      "--personal-reading-column",
      "--personal-form-column",
    ]);
    const darkOnly = tokensIn(":root.dark .personal-app {");
    const missing = Object.keys(light).filter(
      (name) => !name.startsWith("--personal-radius") && !shared.has(name) && !(name in darkOnly),
    );
    expect(missing).toEqual([]);
  });
});
