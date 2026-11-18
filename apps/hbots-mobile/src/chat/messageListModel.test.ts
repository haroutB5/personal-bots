import { describe, expect, it } from "vite-plus/test";

import type { MarkdownTable } from "./markdown";
import {
  claimsReplySwipe,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  opensMessageMenu,
  pendingNotArrived,
  scrollIndexForItem,
  TABLE_CELL_MAX_WIDTH,
  tableColumnWidths,
  touchStep,
  type TouchEffect,
  type TouchEvent,
  type TouchState,
} from "./messageListModel";

describe("scrollIndexForItem", () => {
  const rows = [{ key: "older" }, { key: "middle" }, { key: "newest" }];

  it("mirrors the transcript position into the reversed list", () => {
    expect(scrollIndexForItem(rows, "newest")).toBe(0);
    expect(scrollIndexForItem(rows, "middle")).toBe(1);
    expect(scrollIndexForItem(rows, "older")).toBe(2);
  });

  it("returns null for a row the list does not hold", () => {
    expect(scrollIndexForItem(rows, "secret:missing")).toBeNull();
  });
});

describe("pendingNotArrived", () => {
  const pending = [{ id: "sent-1" }, { id: "sending-2" }];

  it("keeps a send out of the list until the transcript shows it", () => {
    expect(pendingNotArrived(pending, new Set())).toEqual(pending);
  });

  it("drops the send in the same render that shows its message", () => {
    expect(pendingNotArrived(pending, new Set(["sent-1"]))).toEqual([{ id: "sending-2" }]);
  });
});

describe("claimsReplySwipe", () => {
  it("takes a horizontal drag that began on the message", () => {
    expect(claimsReplySwipe(40, 8, false)).toBe(true);
  });

  it("leaves a vertical drag to the list", () => {
    expect(claimsReplySwipe(8, 40, false)).toBe(false);
  });

  it("leaves a horizontal drag that began in a scroller", () => {
    expect(claimsReplySwipe(60, 2, true)).toBe(false);
  });

  it("ignores a drag under the slop", () => {
    expect(claimsReplySwipe(9, 0, false)).toBe(false);
  });

  it("ignores a drag that is more diagonal than horizontal", () => {
    expect(claimsReplySwipe(10, 9, false)).toBe(false);
  });
});

describe("opensMessageMenu", () => {
  it("opens on a still finger that began on the message body", () => {
    expect(opensMessageMenu(false, 0, 0)).toBe(true);
    expect(opensMessageMenu(false, LONG_PRESS_SLOP, -LONG_PRESS_SLOP)).toBe(true);
  });

  it("stays shut when the touch began on a link or a choice button", () => {
    expect(opensMessageMenu(true, 0, 0)).toBe(false);
    expect(opensMessageMenu(true, 2, 3)).toBe(false);
  });

  it("stays shut when the finger moved past the slop", () => {
    expect(opensMessageMenu(false, LONG_PRESS_SLOP + 1, 0)).toBe(false);
    expect(opensMessageMenu(false, 0, -LONG_PRESS_SLOP - 1)).toBe(false);
  });
});

function tableOf(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): MarkdownTable {
  const cell = (text: string) => ({ text, spans: [{ kind: "text" as const, text }] });
  return {
    header: header.map(cell),
    aligns: header.map(() => "left" as const),
    rows: rows.map((row) => row.map(cell)),
  };
}

describe("tableColumnWidths", () => {
  it("keeps a bold header word whole instead of breaking it mid-word", () => {
    const [width] = tableColumnWidths(tableOf(["Command"], [["ls"]]));
    // The 13 px bold header glyph advances about 9 px, plus 20 px cell padding.
    expect(width).toBeGreaterThanOrEqual(7 * 9 + 20);
  });

  it("holds the maximum width for a word longer than the cap", () => {
    const [width] = tableColumnWidths(tableOf(["Command"], [["x".repeat(120)]]));
    expect(width).toBe(TABLE_CELL_MAX_WIDTH);
  });
});

describe("touchStep", () => {
  /** Plays a script of events and returns every effect it produced, in order. */
  function play(events: ReadonlyArray<TouchEvent>): {
    readonly effects: ReadonlyArray<TouchEffect>;
    readonly state: TouchState;
  } {
    let state: TouchState = { kind: "idle" };
    const effects: TouchEffect[] = [];
    for (const event of events) {
      const step = touchStep(state, event);
      state = step.state;
      if (step.effect.kind !== "none") effects.push(step.effect);
    }
    return { effects, state };
  }
  const down = (at: number, x = 100, y = 200): TouchEvent => ({
    kind: "down",
    at,
    point: { x, y },
  });
  const up = (at: number): TouchEvent => ({ kind: "up", at });

  it("A1 two taps 120 ms and 8 dp apart select at the second point", () => {
    const { effects } = play([down(0), up(40), down(160, 108, 200), up(200)]);
    expect(effects).toEqual([{ kind: "select", point: { x: 108, y: 200 } }]);
  });

  it("A2 two taps 400 ms apart do nothing", () => {
    expect(play([down(0), up(40), down(440), up(480)]).effects).toEqual([]);
  });

  it("A3 two taps 40 dp apart do nothing", () => {
    expect(play([down(0), up(40), down(160, 140, 200), up(200)]).effects).toEqual([]);
  });

  it("A3b two taps 40 dp apart vertically do nothing", () => {
    expect(play([down(0), up(40), down(160, 100, 240), up(200)]).effects).toEqual([]);
  });

  it("A3c two taps 20 dp apart vertically select at the second point", () => {
    const { effects } = play([down(0), up(40), down(160, 100, 220), up(200)]);
    expect(effects).toEqual([{ kind: "select", point: { x: 100, y: 220 } }]);
  });

  it("A4 a first tap on a link never counts toward a double tap", () => {
    const events: TouchEvent[] = [down(0), { kind: "interactive" }, up(40), down(160), up(200)];
    expect(play(events).effects).toEqual([]);
  });

  it("A5 a second touch held to the long press opens the menu, not the reader", () => {
    const { effects } = play([down(0), up(40), down(160), { kind: "held" }, up(560)]);
    expect(effects).toEqual([{ kind: "menu" }]);
  });

  it("A6 a second touch that moves 12 dp does nothing", () => {
    const events: TouchEvent[] = [
      down(0),
      up(40),
      down(160),
      { kind: "move", point: { x: 100, y: 212 } },
      up(200),
    ];
    expect(play(events).effects).toEqual([]);
  });

  it("A7 a single tap gives no effect and waits for a second one", () => {
    const { effects, state } = play([down(0), up(40)]);
    expect(effects).toEqual([]);
    expect(state.kind).toBe("tapped");
  });

  it("A8 a tap that lasts as long as a long press is not a tap", () => {
    const { state } = play([down(0), up(LONG_PRESS_MS + 1)]);
    expect(state.kind).toBe("idle");
  });

  it("A9 a cancelled first touch forgets the tap", () => {
    expect(
      play([down(0), up(40), down(160), { kind: "cancel" }, down(200), up(240)]).effects,
    ).toEqual([]);
  });
});
