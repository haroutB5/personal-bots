// @effect-diagnostics-next-line nodeBuiltinImport:off - reads the checked-in generated stylesheet off disk.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { AVATAR_COMETS } from "../avatarComet";
import { AVATAR_MOTIONS } from "../avatarMotion";
import { avatarKeyframesName, avatarMotionCss } from "./avatarKeyframes";
import { avatarStateTiming } from "./avatarStates";

const cssUrl = new URL("../avatarMotion.generated.css", import.meta.url);
const css = NodeFS.readFileSync(cssUrl, "utf8");

function ruleFor(selector: string): string | undefined {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return undefined;
  return css.slice(start, css.indexOf("}", start) + 1);
}

/**
 * The app ships the motion as CSS sampled from `avatarStates.ts` and
 * `avatarComet.ts`, never Remotion itself. These tests are what keeps that one
 * copy rather than two: retouch a pose and forget to regenerate, and the suite
 * says so.
 */
describe("avatarMotion.generated.css", () => {
  it("matches the motion modules byte for byte (run scripts/generate-avatar-keyframes.ts)", () => {
    expect(css).toBe(avatarMotionCss());
  });

  it("animates every non-idle state and leaves idle static", () => {
    for (const state of AVATAR_MOTIONS) {
      const selector = `.bot-avatar[data-motion="${state}"]`;
      if (state === "idle") {
        expect(css).not.toContain(selector);
        continue;
      }
      expect(ruleFor(selector)).toContain(avatarKeyframesName(state, "body"));
      expect(css).toContain(`@keyframes ${avatarKeyframesName(state, "body")} {`);
    }
  });

  it("loops thinking and working after a spring-in; one-shots play once and hold", () => {
    for (const state of AVATAR_MOTIONS) {
      if (state === "idle") continue;
      const rule = ruleFor(`.bot-avatar[data-motion="${state}"]`)!;
      const name = avatarKeyframesName(state, "body");
      if (avatarStateTiming(state).loop) {
        expect(rule).toContain(`${name}-in 1.2s linear 1,`);
        expect(rule).toMatch(new RegExp(`${name} [\\d.]+s linear 1\\.2s infinite;`));
      } else {
        expect(rule).toMatch(new RegExp(`animation: ${name} [\\d.]+s linear 1 both;`));
      }
    }
  });

  it("ends done's every layer at rest", () => {
    const done = css.slice(css.indexOf(`@keyframes ${avatarKeyframesName("done", "body")}`));
    const body = done.slice(0, done.indexOf("\n}\n"));
    expect(body).toMatch(
      /100% \{\s*transform: translate\(0, 0\) rotate\(0deg\) scale\(1, 1\);\s*\}$/,
    );
    expect(css).toContain(`@keyframes ${avatarKeyframesName("done", "arc")} {`);
  });

  it("spins and recolours each comet, starting it part-way round", () => {
    AVATAR_COMETS.forEach((spec, index) => {
      expect(ruleFor(`.bot-avatar-comet-${index}`)).toContain(
        `animation-duration: ${spec.orbitSeconds}s;`,
      );
      expect(ruleFor(`.bot-avatar-comet-stop-${index}-0`)).toMatch(/infinite;/);
    });
    expect(css).toContain("@keyframes bot-avatar-comet-orbit {");
  });

  it("animates only transform, opacity and gradient stop colours; no filters", () => {
    const keyframes = css.slice(css.indexOf("@keyframes"));
    const declarations = [...keyframes.matchAll(/^\s{4}([a-z-]+):/gm)].map((match) => match[1]);
    expect(new Set(declarations)).toEqual(new Set(["transform", "opacity", "stop-color"]));
    expect(css).not.toMatch(/filter|box-shadow|width:|height:|top:|left:/);
  });
});
