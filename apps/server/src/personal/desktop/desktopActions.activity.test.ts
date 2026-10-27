// @effect-diagnostics globalTimers:off - the tool layer's settle wait is a real timer.
import { describe, expect, it } from "@effect/vitest";

import type { DesktopActionContext } from "./PersonalDesktop.ts";
import type { ScreenFrame } from "./desktopGeometry.ts";
import {
  click,
  holdKey,
  pressKeys,
  scroll,
  captureShot,
  typeText,
  zoomShot,
} from "./desktopActions.ts";

const frame: ScreenFrame = {
  region: { x: 0, y: 0, width: 1536, height: 960 },
  imageWidth: 1536,
  imageHeight: 960,
  monitor: 0,
};

const makeContext = (overrides: Partial<DesktopActionContext> = {}) => {
  const calls: Array<{ cmd: string; params: Readonly<Record<string, unknown>> }> = [];
  const context: DesktopActionContext = {
    driver: {
      request: (cmd, params = {}) => {
        calls.push({ cmd, params });
        if (cmd === "info") {
          return Promise.resolve({
            monitors: [
              {
                index: 0,
                primary: true,
                x: 0,
                y: 0,
                width: 1536,
                height: 960,
                dpi: 192,
                name: "eDP-1",
              },
            ],
            locked: false,
          });
        }
        if (cmd === "screenshot") {
          return Promise.resolve({ mimeType: "image/jpeg", data: "abc" });
        }
        if (cmd === "cursor") return Promise.resolve({ x: 0, y: 0 });
        return Promise.resolve({ ok: true });
      },
      onKill: () => undefined,
      dispose: () => undefined,
    },
    frame,
    setFrame: () => undefined,
    stillHeld: () => true,
    heldButtons: () => new Set<string>(),
    markButton: () => undefined,
    markKeysHeld: () => undefined,
    ...overrides,
  };
  return { context, calls };
};

describe("desktop action activity", () => {
  it("reports a click's fraction of the screenshot", async () => {
    const { context } = makeContext();
    const shot = await click(context, { x: 768, y: 480, screenshot: false });
    expect(shot.activity).toEqual({
      summary: "clicked at 50%, 50%",
      x: 0.5,
      y: 0.5,
      monitor: 0,
    });
  });

  it("counts characters and never carries the text", async () => {
    const { context } = makeContext();
    const shot = await typeText(context, { text: "correct horse battery", screenshot: false });
    expect(shot.activity?.chars).toBe(21);
    expect(shot.activity?.summary).toBe("typed 21 characters");
    expect(shot.activity?.summary).not.toContain("correct");
  });

  it("counts a typed-looking key sequence instead of naming the keys", async () => {
    const { context } = makeContext();
    const typed = await pressKeys(context, { keys: "p a s s w o r d", screenshot: false });
    expect(typed.activity?.summary).toBe("pressed 8 keys");
    const chord = await pressKeys(context, { keys: "ctrl+a", screenshot: false });
    expect(chord.activity?.summary).toBe("pressed ctrl+a");
  });

  it("names a held named key but not a held character", async () => {
    const { context } = makeContext();
    const arrow = await holdKey(context, { keys: "Right", durationMs: 1_200, screenshot: false });
    expect(arrow.activity?.summary).toBe("held Right 1.2 s");
    const letter = await holdKey(context, { keys: "a", durationMs: 1_000, screenshot: false });
    expect(letter.activity?.summary).toBe("held a key 1.0 s");
  });

  it("describes scrolling and the captured monitor", async () => {
    const { context } = makeContext();
    const scrolled = await scroll(context, { direction: "down", amount: 3, screenshot: false });
    expect(scrolled.activity?.summary).toBe("scrolled down 3");
    const shot = await captureShot(context, 0);
    expect(shot.activity?.summary).toBe("screenshot of eDP-1");
    const zoom = await zoomShot(context, { x: 10, y: 10, width: 100, height: 100 });
    expect(zoom.activity?.summary).toBe("zoomed in");
  });
});
