import { describe, expect, it } from "vite-plus/test";

import { BOTS_BEHIND_STATE_KEY, TEAM_BEHIND_STATE_KEY } from "./botsBackStack";
import {
  chatSwipeBackEnabled,
  EdgeSwipeTracker,
  NATIVE_SWIPE_STORAGE_KEY,
  nativeSwipeForced,
  swipeLayerGeometry,
} from "./edgeSwipeBack";

const CHAT = "/bots/bot-planner/thread-1";
const behind = { [BOTS_BEHIND_STATE_KEY]: true };
const enabled = (overrides: Partial<Parameters<typeof chatSwipeBackEnabled>[0]>) =>
  chatSwipeBackEnabled({
    pathname: CHAT,
    state: behind,
    standalone: true,
    wide: false,
    nativeForced: false,
    ...overrides,
  });

describe("chatSwipeBackEnabled", () => {
  // The iOS swipe drew a snapshot of whatever was last painted for the /bots
  // entry behind the chat (task page, bot's chat list, blank after a cold
  // open), so on chats in the installed phone app the swipe is the app's own.
  it("takes over the edge swipe on bot and group chats in the installed phone app", () => {
    expect(enabled({})).toBe(true);
    expect(enabled({ pathname: "/bots/groups/group-1" })).toBe(true);
  });

  it("also takes it over on a chat opened from the Team screen, which goes back there", () => {
    expect(enabled({ state: { [TEAM_BEHIND_STATE_KEY]: true } })).toBe(true);
  });

  it("leaves the native swipe everywhere else", () => {
    expect(enabled({ standalone: false })).toBe(false);
    expect(enabled({ wide: true })).toBe(false);
    expect(enabled({ nativeForced: true })).toBe(false);
    expect(enabled({ state: {} })).toBe(false);
    expect(enabled({ state: undefined })).toBe(false);
    for (const pathname of [
      "/bots",
      "/tasks/task-1",
      "/bots/bot-planner",
      "/bots/groups/new",
      "/bots/teams/new",
    ]) {
      expect(enabled({ pathname })).toBe(false);
    }
  });

  it("reads the per-device kill switch", () => {
    expect(
      nativeSwipeForced({ getItem: (key) => (key === NATIVE_SWIPE_STORAGE_KEY ? "1" : null) }),
    ).toBe(true);
    expect(nativeSwipeForced({ getItem: () => null })).toBe(false);
    expect(nativeSwipeForced(null)).toBe(false);
    expect(
      nativeSwipeForced({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(false);
  });
});

describe("EdgeSwipeTracker", () => {
  const WIDTH = 390;
  const start = () => new EdgeSwipeTracker({ x: 5, y: 400, t: 0 }, WIDTH);

  it("a touch that barely moves is a tap for whatever is under the edge", () => {
    const tracker = start();
    expect(tracker.move({ x: 8, y: 402, t: 40 })).toEqual({ kind: "undecided" });
    expect(tracker.end(80)).toEqual({ kind: "tap", x: 5, y: 400 });
  });

  it("drags the chat with the finger and completes past a third of the width", () => {
    const tracker = start();
    expect(tracker.move({ x: 60, y: 404, t: 50 })).toEqual({ kind: "drag", offset: 55 });
    expect(tracker.move({ x: 200, y: 410, t: 400 })).toEqual({ kind: "drag", offset: 195 });
    expect(tracker.end(900)).toEqual({ kind: "complete", offset: 195 });
  });

  it("snaps back when let go early and slowly", () => {
    const tracker = start();
    tracker.move({ x: 40, y: 400, t: 100 });
    tracker.move({ x: 80, y: 400, t: 400 });
    expect(tracker.end(420)).toEqual({ kind: "cancel", offset: 75 });
  });

  it("a quick flick completes from a short drag", () => {
    const tracker = start();
    tracker.move({ x: 30, y: 400, t: 16 });
    tracker.move({ x: 70, y: 400, t: 32 });
    expect(tracker.end(40)).toEqual({ kind: "complete", offset: 65 });
  });

  it("a drag pulled back to the left does not complete", () => {
    const tracker = start();
    tracker.move({ x: 250, y: 400, t: 200 });
    tracker.move({ x: 200, y: 400, t: 216 });
    expect(tracker.end(220)).toEqual({ kind: "cancel", offset: 195 });
  });

  it("never moves the chat left of its place or past the width", () => {
    const tracker = start();
    tracker.move({ x: 30, y: 400, t: 16 });
    expect(tracker.move({ x: 1, y: 400, t: 32 })).toEqual({ kind: "drag", offset: 0 });
    expect(tracker.move({ x: 900, y: 400, t: 48 })).toEqual({ kind: "drag", offset: WIDTH });
  });

  it("a mostly vertical touch scrolls the chat under the edge instead", () => {
    const tracker = start();
    expect(tracker.move({ x: 7, y: 380, t: 16 })).toEqual({ kind: "scroll", dx: 2, dy: -20 });
    expect(tracker.move({ x: 60, y: 370, t: 32 })).toEqual({ kind: "scroll", dx: 53, dy: -10 });
    expect(tracker.end(48)).toEqual({ kind: "scroll" });
  });
});

describe("swipeLayerGeometry", () => {
  const WIDTH = 390;

  // Harout's iPhone, 1.66.54: the list under the chat rode along with the chat
  // and was clipped at the chat's left edge, leaving a black strip. The layers
  // are viewport-fixed now, so the list's left edge is the parallax alone.
  it("starts the list 30% to the left and settles it flush with the screen", () => {
    expect(swipeLayerGeometry(0, WIDTH).underlayShiftPercent).toBeCloseTo(-30);
    expect(swipeLayerGeometry(0, WIDTH).underlayX).toBeCloseTo(-117);
    expect(swipeLayerGeometry(WIDTH / 2, WIDTH).underlayShiftPercent).toBeCloseTo(-15);
    expect(swipeLayerGeometry(WIDTH, WIDTH).underlayX).toBeCloseTo(0);
  });

  it("moves the chat with the finger and clamps it to the screen", () => {
    expect(swipeLayerGeometry(120, WIDTH).chatX).toBe(120);
    expect(swipeLayerGeometry(-10, WIDTH).chatX).toBe(0);
    expect(swipeLayerGeometry(WIDTH + 50, WIDTH).chatX).toBe(WIDTH);
  });

  it("always covers the screen from x = 0 up to the chat's left edge", () => {
    for (let offset = 0; offset <= WIDTH; offset += 13) {
      const layers = swipeLayerGeometry(offset, WIDTH);
      expect(layers.underlayX).toBeLessThanOrEqual(0);
      expect(layers.underlayX + WIDTH).toBeGreaterThanOrEqual(layers.chatX - 1e-9);
    }
  });

  it("fades the dimming out as the chat leaves", () => {
    expect(swipeLayerGeometry(0, WIDTH).shade).toBeCloseTo(0.12);
    expect(swipeLayerGeometry(WIDTH, WIDTH).shade).toBe(0);
  });

  it("survives a zero width", () => {
    expect(swipeLayerGeometry(10, 0)).toMatchObject({ progress: 0, chatX: 0, underlayX: -0 });
  });
});
