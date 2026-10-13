import { describe, expect, it } from "vite-plus/test";

import {
  clampHomeWindow,
  firstHomeWindow,
  HOME_ROW_OVERSCAN,
  HOME_ROW_PITCH,
  homeWindowRange,
  homeWindowSpacers,
  sameHomeWindow,
} from "./homeWindow";

const rangeAt = (hiddenAbove: number, count = 60, viewport = 576, overscan = HOME_ROW_OVERSCAN) =>
  homeWindowRange({ count, pitch: HOME_ROW_PITCH, hiddenAbove, viewport, overscan });

const rangeAfter = (previous: { start: number; end: number }, hiddenAbove: number) =>
  homeWindowRange({
    count: 60,
    pitch: HOME_ROW_PITCH,
    hiddenAbove,
    viewport: 576,
    overscan: HOME_ROW_OVERSCAN,
    previous,
  });

const rangeMoved = (
  previous: { start: number; end: number },
  hiddenAbove: number,
  direction: "up" | "down",
) =>
  homeWindowRange({
    count: 60,
    pitch: HOME_ROW_PITCH,
    hiddenAbove,
    viewport: 576,
    overscan: HOME_ROW_OVERSCAN,
    previous,
    direction,
  });

describe("homeWindowRange", () => {
  it("draws the top of the list plus the overscan band before any scrolling", () => {
    // 576 px of viewport shows rows 0..8; 8 rows of band below.
    expect(rangeAt(0)).toEqual({ start: 0, end: 16 });
  });

  it("anchors the band on both sides wherever the scroll starts", () => {
    expect(rangeAt(720)).toEqual({ start: 2, end: 26 });
    expect(rangeAt(1440)).toEqual({ start: 12, end: 36 });
  });

  it("keeps its size when the list is scrolled past it (the snoozed section below)", () => {
    expect(rangeAt(5000)).toEqual({ start: 52, end: 60 });
  });

  it("holds the drawn slice still while the band stays comfortable (no DOM work)", () => {
    // Anchored at row 10 with eight rows of band above and below. Scrolling on
    // until the band either side is down to four rows draws exactly the same
    // slice again, so the list touches no DOM.
    const slice = { start: 2, end: 26 };
    for (const row of [10, 11, 12, 13, 14]) {
      expect(rangeAfter(slice, row * 72)).toEqual(slice);
    }
  });

  it("moves the slice once the visible rows reach its edge, leaving a band again", () => {
    const slice = { start: 2, end: 26 };
    // Row 15 visible: the band below is down to three rows; re-anchor.
    expect(rangeAfter(slice, 15 * 72)).toEqual({ start: 7, end: 31 });
    // And the new slice is then held for the next four rows of travel.
    const next = { start: 7, end: 31 };
    for (const row of [16, 17, 18, 19]) {
      expect(rangeAfter(next, row * 72)).toEqual(next);
    }
    expect(rangeAfter(next, 20 * 72)).toEqual({ start: 12, end: 36 });
  });

  it("follows a jump (the rail journey's scroll to top, a restored position)", () => {
    expect(rangeAfter({ start: 40, end: 60 }, 0)).toEqual({ start: 0, end: 16 });
  });

  it("keeps the band wide towards the way the person is scrolling", () => {
    const down = rangeMoved({ start: 2, end: 26 }, 15 * 72, "down");
    expect(down).toEqual({ start: 11, end: 35 });
    const up = rangeMoved({ start: 2, end: 26 }, 2 * 72, "up");
    expect(up).toEqual({ start: 0, end: 14 });
  });

  it("then lets the scroll run nine rows before it has to move again", () => {
    const slice = rangeMoved({ start: 2, end: 26 }, 15 * 72, "down");
    for (const row of [15, 16, 17, 18, 19, 20, 21, 22, 23]) {
      expect(rangeMoved(slice, row * 72, "down")).toEqual(slice);
    }
    expect(rangeMoved(slice, 24 * 72, "down")).not.toEqual(slice);
  });

  it("draws a list shorter than the viewport whole", () => {
    expect(rangeAt(0, 3)).toEqual({ start: 0, end: 3 });
    expect(rangeAt(300, 5)).toEqual({ start: 0, end: 5 });
  });

  it("has nothing to draw for an empty list", () => {
    expect(rangeAt(0, 0)).toEqual({ start: 0, end: 0 });
    expect(rangeAt(500, 0)).toEqual({ start: 0, end: 0 });
  });

  it("survives nonsense inputs (a list above the viewport, a zero pitch)", () => {
    expect(rangeAt(-400)).toEqual({ start: 0, end: 16 });
    const flat = homeWindowRange({
      count: 60,
      pitch: 0,
      hiddenAbove: 720,
      viewport: 576,
      overscan: HOME_ROW_OVERSCAN,
    });
    expect(flat).toEqual({ start: 2, end: 26 });
  });

  it("narrows the band with the overscan the caller asks for", () => {
    expect(rangeAt(720, 60, 576, 0)).toEqual({ start: 10, end: 18 });
    expect(rangeAt(720, 60, 576, 4)).toEqual({ start: 6, end: 22 });
  });

  it("keeps the spacers' heights plus the drawn rows equal to the whole list", () => {
    // The invariant that keeps the scroll position exact on Back: whatever the
    // window, the list's height is count * pitch.
    for (const scroll of [0, 72, 720, 2520, 5000]) {
      const range = rangeAt(scroll);
      const spacers = homeWindowSpacers(range, 60);
      const drawn = (range.end - range.start) * HOME_ROW_PITCH;
      expect(spacers.above + drawn + spacers.below).toBe(60 * HOME_ROW_PITCH);
    }
  });

  it("reads a restored scroll position as the slice that position had before", () => {
    // Back restores scrollTop; the same measurement gives the same slice.
    expect(rangeAt(1000)).toEqual(rangeAt(1000));
  });
});

describe("firstHomeWindow", () => {
  it("draws a screenful when the layout cannot be measured (test renderer, no DOM)", () => {
    expect(firstHomeWindow(60)).toEqual({ start: 0, end: HOME_ROW_OVERSCAN + 8 });
    expect(firstHomeWindow(4)).toEqual({ start: 0, end: 4 });
    expect(firstHomeWindow(0)).toEqual({ start: 0, end: 0 });
  });
});

describe("clampHomeWindow", () => {
  it("pulls a slice back inside a list that shrank (a filter, a search)", () => {
    expect(clampHomeWindow({ start: 40, end: 56 }, 10)).toEqual({ start: 0, end: 10 });
    expect(clampHomeWindow({ start: 0, end: 17 }, 12)).toEqual({ start: 0, end: 12 });
  });

  it("returns the same slice when it still fits, so a render does not churn", () => {
    const slice = { start: 2, end: 26 };
    expect(clampHomeWindow(slice, 60)).toBe(slice);
    expect(clampHomeWindow(slice, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("sameHomeWindow", () => {
  it("compares by value", () => {
    expect(sameHomeWindow({ start: 1, end: 2 }, { start: 1, end: 2 })).toBe(true);
    expect(sameHomeWindow({ start: 1, end: 2 }, { start: 1, end: 3 })).toBe(false);
  });
});
