// @effect-diagnostics-next-line nodeBuiltinImport:off - reads shipped source off disk.
import * as NodeFS from "node:fs";

import {
  motionDuration,
  motionEase,
  motionRise,
  motionSheet,
} from "@hbots/personal-client/motion/motionTokens";
import { describe, expect, it } from "vite-plus/test";

const read = (relative: string) => NodeFS.readFileSync(new URL(relative, import.meta.url), "utf8");

const css = read("./personal.css");
const sheet = read("../../components/ui/sheet.tsx");
const swipeBack = read("./useChatSwipeBack.tsx");

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
    ["rise", match(css, /animation: personal-chat-enter (\d+)ms/)[1]!, 1],
    ["banner", match(css, /animation: personal-in-app-in (\d+)ms/)[1]!, 1],
    ["sheet", match(sheet, /transition-\[opacity,translate\] duration-(\d+)/)[1]!, 1],
    ["swipeSettle", match(swipeBack, /SETTLE_MS = (\d+)/)[1]!, 1],
    ["callIn", match(css, /animation: voice-call-in (\d+)ms/)[1]!, 1],
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
