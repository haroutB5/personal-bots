// @effect-diagnostics-next-line nodeBuiltinImport:off - reads shipped source off disk.
import * as NodeFS from "node:fs";

import {
  motionDuration,
  motionEase,
  motionPress,
  motionPulse,
  motionRing,
  motionRise,
  motionSheet,
} from "@hbots/personal-client/motion/motionTokens";
import { describe, expect, it } from "vite-plus/test";

const read = (relative: string) => NodeFS.readFileSync(new URL(relative, import.meta.url), "utf8");

const css = read("./personal.css");
const sheet = read("../../components/ui/sheet.tsx");
const swipeBack = read("./useChatSwipeBack.tsx");
const inAppBanner = read("./InAppNotifications.tsx");
const tailwindTheme = read("../../../node_modules/tailwindcss/theme.css");

function match(source: string, pattern: RegExp): RegExpMatchArray {
  const found = source.match(pattern);
  if (found === null) throw new Error(`no match for ${pattern}`);
  return found;
}

function bezier(source: string, pattern: RegExp): number[] {
  return match(source, pattern).slice(1).map(Number);
}

describe("motion tokens against the web CSS", () => {
  const durations: ReadonlyArray<readonly [keyof typeof motionDuration, string, number]> = [
    ["press", match(css, /transform (\d+)ms ease-out,\s*opacity \1ms ease-out/)[1]!, 1],
    ["stepFade", match(css, /animation: personal-sheet-step (\d+)ms/)[1]!, 1],
    ["chipIn", match(css, /animation: personal-chip-in (\d+)ms/)[1]!, 1],
    ["chipHoldDelay", match(css, /transform (\d+)ms cubic-bezier\([\d., ]+\) (\d+)ms/)[2]!, 1],
    ["chipHold", match(css, /transform (\d+)ms cubic-bezier\([\d., ]+\) (\d+)ms/)[1]!, 1],
    [
      "chipHeld",
      match(
        css,
        /data-held="true"\] \.personal-chip \{\s*transform: scale\(1\.04\);\s*transition: transform (\d+)ms ease-out/,
      )[1]!,
      1,
    ],
    ["pulse", match(tailwindTheme, /--animate-pulse: pulse (\d+)s/)[1]!, 1000],
    ["chevron", match(tailwindTheme, /--default-transition-duration: (\d+)ms/)[1]!, 1],
    ["rise", match(css, /animation: personal-chat-enter (\d+)ms/)[1]!, 1],
    ["banner", match(css, /animation: personal-in-app-in (\d+)ms/)[1]!, 1],
    ["bannerSnap", match(inAppBanner, /touch-none[^"]*transition-transform duration-(\d+)/)[1]!, 1],
    ["sheet", match(sheet, /transition-\[opacity,translate\] duration-(\d+)/)[1]!, 1],
    ["swipeSettle", match(swipeBack, /SETTLE_MS = (\d+)/)[1]!, 1],
    ["callIn", match(css, /animation: voice-call-in (\d+)ms/)[1]!, 1],
    ["callRing", match(css, /animation: voice-call-ring ([\d.]+)s ease-in-out infinite/)[1]!, 1000],
    ["callCard", match(css, /animation: voice-call-card (\d+)ms ease-out/)[1]!, 1],
    ["replyHighlight", match(css, /animation: personal-reply-highlight ([\d.]+)s/)[1]!, 1000],
  ];

  it.each(durations)("%s duration is the one the web ships", (name, found, scale) => {
    expect(motionDuration[name]).toBe(Number(found) * scale);
  });

  it("covers every duration token", () => {
    expect(durations.map(([name]) => name).toSorted()).toEqual(
      Object.keys(motionDuration).toSorted(),
    );
  });

  it("the reduced-motion chip fade lasts as long as the step fade", () => {
    expect(
      Number(match(css, /\.personal-chip-in \{\s*animation: personal-chip-fade (\d+)ms/)[1]),
    ).toBe(motionDuration.stepFade);
  });

  it("the chip press, hold cue and held pop scale to the web values", () => {
    const scaleOf = (selector: RegExp) => Number(match(css, selector)[1]);
    expect(
      scaleOf(/\.personal-chip-hit:active \.personal-chip \{\s*transform: scale\(([\d.]+)\)/),
    ).toBe(motionPress.chip);
    expect(
      scaleOf(
        /\.personal-chip-hit\[data-holding="true"\] \.personal-chip \{\s*transform: scale\(([\d.]+)\)/,
      ),
    ).toBe(motionPress.chipHold);
    expect(
      scaleOf(
        /\.personal-chip-hit\[data-held="true"\] \.personal-chip \{\s*transform: scale\(([\d.]+)\)/,
      ),
    ).toBe(motionPress.chipHeld);
  });

  it("push easing is the voice call curve", () => {
    expect(
      bezier(css, /voice-call-in \d+ms cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/),
    ).toEqual([...motionEase.push]);
  });

  it("in easing is the chip hold curve", () => {
    expect(
      bezier(css, /transform 350ms cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\) 150ms/),
    ).toEqual([...motionEase.in]);
  });

  it("the connecting ring breathes between the web keyframe scale and opacity", () => {
    const frames = match(css, /@keyframes voice-call-ring \{([\s\S]*?)\n\}/)[1]!;
    const low = match(frames, /0%,\s*100% \{\s*transform: scale\(1\);\s*opacity: ([\d.]+)/)[1];
    const high = match(frames, /50% \{\s*transform: scale\(([\d.]+)\);\s*opacity: ([\d.]+)/);
    expect(motionRing).toEqual({
      scale: Number(high[1]),
      opacityLow: Number(low),
      opacityHigh: Number(high[2]),
    });
  });

  it("pulse easing is the Tailwind animate-pulse curve", () => {
    expect(
      bezier(
        tailwindTheme,
        /--animate-pulse: pulse \d+s cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/,
      ),
    ).toEqual([...motionEase.pulse]);
  });

  it("the pulse dips to the Tailwind keyframe opacity", () => {
    expect(
      Number(match(tailwindTheme, /@keyframes pulse \{\s*50% \{\s*opacity: ([\d.]+)/)[1]),
    ).toBe(motionPulse.low);
  });

  it("chevron easing is the Tailwind default transition curve", () => {
    expect(
      bezier(
        tailwindTheme,
        /--default-transition-timing-function: cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/,
      ),
    ).toEqual([...motionEase.inOut]);
  });

  it("out easing is the team rise curve", () => {
    expect(
      bezier(
        css,
        /personal-team-rise 180ms cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/,
      ),
    ).toEqual([...motionEase.out]);
  });

  it("the chat rise moves 8 px with the CSS ease-out keyword", () => {
    expect(match(css, /animation: personal-chat-enter \d+ms (ease-out)/)[1]).toBe("ease-out");
    expect(
      match(css, /@keyframes personal-chat-enter \{\s*from \{[^}]*translateY\((\d+)px\)/)[1],
    ).toBe(String(motionRise.translateY));
    expect(motionEase.cssEaseOut).toEqual([0, 0, 0.58, 1]);
  });

  it("the sheet moves 32 px with the Tailwind ease-in-out curve", () => {
    expect(sheet).toContain("data-starting-style:translate-y-8");
    expect(motionSheet.translateY).toBe(8 * 4);
    expect(sheet).toMatch(/duration-200 ease-in-out/);
    expect(motionEase.inOut).toEqual([0.4, 0, 0.2, 1]);
  });
});
