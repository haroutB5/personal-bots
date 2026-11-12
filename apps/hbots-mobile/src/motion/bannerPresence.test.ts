import { describe, expect, it } from "vite-plus/test";

import {
  BANNER_DRAG_START,
  autoHideDelay,
  bannerReducer,
  dragTo,
  type BannerState,
} from "./bannerPresence";

const first = { id: "n1", title: "Ada replied" };
const second = { id: "n2", title: "Grace replied" };
const hidden: BannerState<typeof first> = { phase: "hidden" };

describe("bannerReducer", () => {
  it("shows an arriving notification", () => {
    expect(bannerReducer(hidden, { kind: "arrive", notification: first })).toEqual({
      phase: "shown",
      notification: first,
    });
  });

  it("keeps the notification on screen while it leaves", () => {
    const shown = bannerReducer(hidden, { kind: "arrive", notification: first });
    expect(bannerReducer(shown, { kind: "dismiss" })).toEqual({
      phase: "leaving",
      notification: first,
    });
  });

  it("unmounts when the leave motion reports the same notification", () => {
    const leaving = bannerReducer(bannerReducer(hidden, { kind: "arrive", notification: first }), {
      kind: "dismiss",
    });
    expect(bannerReducer(leaving, { kind: "exited", id: "n1" })).toEqual({ phase: "hidden" });
  });

  it("ignores the leave completion of a notification that was replaced", () => {
    const leaving = bannerReducer(bannerReducer(hidden, { kind: "arrive", notification: first }), {
      kind: "dismiss",
    });
    const replaced = bannerReducer(leaving, { kind: "arrive", notification: second });
    expect(replaced).toEqual({ phase: "shown", notification: second });
    expect(bannerReducer(replaced, { kind: "exited", id: "n1" })).toEqual(replaced);
  });

  it("does not unmount a banner that is still shown when an exit completes", () => {
    const shown = bannerReducer(hidden, { kind: "arrive", notification: first });
    expect(bannerReducer(shown, { kind: "exited", id: "n1" })).toEqual(shown);
  });

  it("dismissing nothing leaves nothing", () => {
    expect(bannerReducer(hidden, { kind: "dismiss" })).toEqual(hidden);
  });

  it("a second dismiss does not restart the leave", () => {
    const leaving = bannerReducer(bannerReducer(hidden, { kind: "arrive", notification: first }), {
      kind: "dismiss",
    });
    expect(bannerReducer(leaving, { kind: "dismiss" })).toEqual(leaving);
  });
});

describe("opening the banner", () => {
  it("closes it at once, without a leave", () => {
    const shown = bannerReducer(hidden, { kind: "arrive", notification: first });
    expect(bannerReducer(shown, { kind: "close" })).toEqual({ phase: "hidden" });
  });
});

describe("autoHideDelay", () => {
  it("starts the leave early so the banner is gone after the same 6 s as the web", () => {
    expect(autoHideDelay(false)).toBe(5_820);
  });

  it("waits the full 6 s under reduced motion, where the hide is instant", () => {
    expect(autoHideDelay(true)).toBe(6_000);
  });
});

describe("dragTo", () => {
  it("follows an upward drag", () => {
    expect(dragTo(BANNER_DRAG_START, -10)).toEqual({ offset: -10, swiped: false });
  });

  it("never moves down", () => {
    expect(dragTo(BANNER_DRAG_START, 40)).toEqual({ offset: 0, swiped: false });
  });

  it("24 px up is a tap-sized drag, 25 px up dismisses", () => {
    expect(dragTo(BANNER_DRAG_START, -24).swiped).toBe(false);
    expect(dragTo(BANNER_DRAG_START, -25).swiped).toBe(true);
  });

  it("stays dismissed when the finger comes back", () => {
    const far = dragTo(BANNER_DRAG_START, -60);
    expect(dragTo(far, -5)).toEqual({ offset: -5, swiped: true });
  });
});
