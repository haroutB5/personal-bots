import type { ConversationItem } from "@hbots/personal-client/conversation/conversationModel";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createRowReverser,
  rowInputs,
  sameRowProps,
  type Row,
  type RowContext,
  type RowProps,
} from "./messageRows";

type Item = ConversationItem;

function message(id: string, role: "user" | "assistant", text: string, extra = {}): Item {
  return {
    kind: "message",
    id,
    message: { id, role, text, streaming: false, createdAt: "2026-11-16T10:00:00.000Z", ...extra },
  } as unknown as Item;
}

/** A 150-turn chat: user, assistant, user, assistant, ... Built fresh on every call. */
function chat(turns: number, overrides: Record<string, string> = {}): Item[] {
  const items: Item[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    items.push(message(`u${turn}`, "user", `question ${turn}`));
    items.push(message(`a${turn}`, "assistant", overrides[`a${turn}`] ?? `answer ${turn}`));
  }
  return items;
}

function rowsOf(items: ReadonlyArray<Item>): Row[] {
  return items.map((item): Row => ({ kind: "item", key: item.id, item }));
}

const noCards = undefined;

function context(over: Partial<RowContext> = {}): RowContext {
  return {
    choiceStates: new Map(),
    contextTurns: new Map(),
    latestMessageStatus: null,
    cardContext: noCards,
    dayLabel: (at) => `day ${at.toISOString().slice(0, 10)}`,
    groupSpeaker: undefined,
    ...over,
  };
}

const shared = { name: "shared" };

/** What React.memo does for one row: render it again unless its props are the same. */
function paint(
  screen: Map<string, RowProps>,
  rows: ReadonlyArray<Row>,
  ctx: RowContext,
  sharedProps: object = shared,
): number {
  let renders = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    const next: RowProps = { inputs: rowInputs(row, ctx), shared: sharedProps };
    const before = screen.get(row.key);
    if (before === undefined || !sameRowProps(before, next)) {
      renders += 1;
      screen.set(row.key, next);
    }
    seen.add(row.key);
  }
  for (const key of screen.keys()) if (!seen.has(key)) screen.delete(key);
  return renders;
}

describe("row memo", () => {
  it("paints every row once, then one changed row paints one row", () => {
    const screen = new Map<string, RowProps>();

    expect(paint(screen, rowsOf(chat(150)), context())).toBe(300);

    // A streamed update: every wrapper, row object, map and array is new; one reply grew.
    const next = rowsOf(chat(150, { a149: "answer 149, and more words arrived" }));
    expect(paint(screen, next, context({ choiceStates: new Map(), contextTurns: new Map() }))).toBe(
      1,
    );
  });

  it("paints no row when a rebuilt list holds the same rows", () => {
    const screen = new Map<string, RowProps>();
    paint(screen, rowsOf(chat(40)), context());

    expect(paint(screen, rowsOf(chat(40)), context())).toBe(0);
  });

  it("paints one row for one new row at the end", () => {
    const screen = new Map<string, RowProps>();
    paint(screen, rowsOf(chat(40)), context());

    expect(paint(screen, rowsOf([...chat(40), message("u40", "user", "hello")]), context())).toBe(
      1,
    );
  });

  it("paints every row again when the shared inputs change", () => {
    const screen = new Map<string, RowProps>();
    paint(screen, rowsOf(chat(10)), context());

    expect(paint(screen, rowsOf(chat(10)), context(), { name: "another bot" })).toBe(20);
  });

  it("repaints a row whose attachments changed, even with the same text", () => {
    const screen = new Map<string, RowProps>();
    const withImage = (name: string) => [
      message("u0", "user", "look", { attachments: [{ type: "image", id: "i1", name }] }),
    ];
    paint(screen, rowsOf(withImage("a.png")), context());

    expect(paint(screen, rowsOf(withImage("a.png")), context())).toBe(0);
    expect(paint(screen, rowsOf(withImage("b.png")), context())).toBe(1);
  });

  it("repaints the replies whose choices state or context line changed, and only those", () => {
    const screen = new Map<string, RowProps>();
    const open = { kind: "open", disabled: false } as const;
    paint(
      screen,
      rowsOf(chat(20)),
      context({ choiceStates: new Map([["a19", open]]), contextTurns: new Map() }),
    );

    expect(
      paint(
        screen,
        rowsOf(chat(20)),
        context({
          choiceStates: new Map([["a19", { kind: "used", picked: "Yes" }]]),
          contextTurns: new Map(),
        }),
      ),
    ).toBe(1);
    expect(
      paint(
        screen,
        rowsOf(chat(20)),
        context({
          choiceStates: new Map([["a19", { kind: "used", picked: "Yes" }]]),
          contextTurns: new Map([["a3", "u3"]]),
        }),
      ),
    ).toBe(1);
  });

  it("moves the read line from one user message to the next: two rows", () => {
    const screen = new Map<string, RowProps>();
    const status = (messageId: string) =>
      ({ messageId, status: "read" }) as unknown as RowContext["latestMessageStatus"];
    paint(screen, rowsOf(chat(20)), context({ latestMessageStatus: status("u18") }));

    expect(paint(screen, rowsOf(chat(20)), context({ latestMessageStatus: status("u19") }))).toBe(
      2,
    );
  });

  it("repaints a day divider when its label changes at midnight, and no other row", () => {
    const screen = new Map<string, RowProps>();
    const items = [
      { kind: "divider", id: "d1", at: new Date("2026-11-16T10:00:00Z") } as unknown as Item,
      ...chat(5),
    ];
    paint(screen, rowsOf(items), context({ dayLabel: () => "Today, 10:00" }));

    expect(paint(screen, rowsOf(items), context({ dayLabel: () => "Today, 10:00" }))).toBe(0);
    expect(paint(screen, rowsOf(items), context({ dayLabel: () => "Yesterday, 10:00" }))).toBe(1);
  });
});

describe("rows that read the card context", () => {
  const card = (id: string): Item =>
    ({ kind: "question", id, card: { requestId: id } }) as unknown as Item;
  const ctxA = { nowMs: 1 } as unknown as NonNullable<RowContext["cardContext"]>;
  const ctxB = { nowMs: 2 } as unknown as NonNullable<RowContext["cardContext"]>;

  it("repaints every card row, and no message row, when the card context changes", () => {
    const screen = new Map<string, RowProps>();
    const items = () => [...chat(10), card("q1"), card("q2")];
    paint(screen, rowsOf(items()), context({ cardContext: ctxA }));

    expect(paint(screen, rowsOf(items()), context({ cardContext: ctxA }))).toBe(0);
    expect(paint(screen, rowsOf(items()), context({ cardContext: ctxB }))).toBe(2);
  });

  it("paints a card row that was waiting for its context", () => {
    const screen = new Map<string, RowProps>();
    paint(screen, rowsOf([card("q1")]), context({ cardContext: undefined }));

    expect(paint(screen, rowsOf([card("q1")]), context({ cardContext: ctxA }))).toBe(1);
  });

  it("repaints a card row whose own data changed", () => {
    const screen = new Map<string, RowProps>();
    paint(screen, rowsOf([card("q1")]), context({ cardContext: ctxA }));
    const changed = { kind: "question", id: "q1", card: { requestId: "q1", answer: "x" } };

    expect(
      paint(screen, rowsOf([changed as unknown as Item]), context({ cardContext: ctxA })),
    ).toBe(1);
  });
});

describe("the reversed list", () => {
  it("is not computed again for the same rows", () => {
    const reverse = createRowReverser<Row>();
    const rows = rowsOf(chat(30));
    const spy = vi.spyOn(rows, "toReversed");

    const first = reverse(rows);
    const second = reverse(rows);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first[0]).toBe(rows[rows.length - 1]);
  });

  it("is computed again when the rows change", () => {
    const reverse = createRowReverser<Row>();
    const first = reverse(rowsOf(chat(3)));
    const second = reverse(rowsOf(chat(4)));

    expect(second).not.toBe(first);
    expect(second).toHaveLength(8);
  });
});
