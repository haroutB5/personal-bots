// @effect-diagnostics-next-line nodeBuiltinImport:off - reads the checked-in generated stylesheet off disk.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { AVATAR_MOTIONS } from "../avatarMotion";
import { avatarKeyframesName, avatarMotionCss } from "./avatarKeyframes";
import { AVATAR_STATE_SPECS } from "./avatarStates";

const cssUrl = new URL("../avatarMotion.generated.css", import.meta.url);
const css = NodeFS.readFileSync(cssUrl, "utf8");

/**
 * The app ships the poses as CSS sampled from `avatarStates.ts`, never
 * Remotion itself. These tests are what keeps that one copy rather than two:
 * retouch a pose and forget to regenerate, and the suite says so.
 */
describe("avatarMotion.generated.css", () => {
  it("matches the pose functions byte for byte (run scripts/generate-avatar-keyframes.ts)", () => {
    expect(css).toBe(avatarMotionCss());
  });

  it("animates every non-idle state and leaves idle static", () => {
    for (const state of AVATAR_MOTIONS) {
      const selector = `.bot-avatar[data-motion="${state}"]`;
      if (state === "idle") {
        expect(css).not.toContain(selector);
        continue;
      }
      expect(css).toContain(`${selector} .bot-avatar-body`);
      expect(css).toContain(`@keyframes ${avatarKeyframesName(state, "body")} {`);
    }
  });

  it("loops only thinking and working; one-shots play once and hold", () => {
    for (const state of AVATAR_MOTIONS) {
      if (state === "idle") continue;
      const rules = css.match(
        new RegExp(`data-motion="${state}"\\][^{]*\\{\\s*animation: [^;]+;`, "g"),
      );
      expect(rules?.length).toBeGreaterThan(0);
      for (const rule of rules ?? []) {
        if (AVATAR_STATE_SPECS[state].loop) expect(rule).toMatch(/ infinite;$/);
        else expect(rule).toMatch(/ 1 both;$/);
      }
    }
  });

  it("gives done's happy squint its arc layer and ends every layer at rest", () => {
    expect(css).toContain(`@keyframes ${avatarKeyframesName("done", "arc")} {`);
    const done = css.slice(css.indexOf(`@keyframes ${avatarKeyframesName("done", "body")}`));
    expect(done).toMatch(
      /100% \{\s*transform: translate\(0, 0\) rotate\(0deg\) scale\(1, 1\);\s*\}/,
    );
  });

  it("animates only transform and opacity", () => {
    const declarations = [...css.matchAll(/^\s{4}([a-z-]+):/gm)].map((match) => match[1]);
    expect(new Set(declarations)).toEqual(new Set(["transform", "opacity"]));
  });
});
