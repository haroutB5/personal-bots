import { describe, expect, it } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel";
import {
  BUBBLE_REPLY_MAX_CHARS,
  buildTranscriptRows,
  isBubbleReplyText,
  type TranscriptRunRow,
} from "./messageRows";

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  at = "2026-10-06T10:00:00.000Z",
): ConversationItem =>
  ({
    kind: "message",
    id,
    message: { id, role, text, createdAt: at, streaming: false },
  }) as never;

const work = (id: string): ConversationItem => ({ kind: "work", id, entries: [] }) as never;
const divider = (at: Date): ConversationItem =>
  ({ kind: "divider", id: `divider:${at.toISOString()}`, at }) as never;

describe("isBubbleReplyText", () => {
  it("keeps short plain replies in bubbles", () => {
    expect(isBubbleReplyText("On it. Pulling main first.")).toBe(true);
    expect(isBubbleReplyText("Done, all green.")).toBe(true);
    expect(isBubbleReplyText("**Done.**")).toBe(true);
    expect(isBubbleReplyText("a".repeat(BUBBLE_REPLY_MAX_CHARS))).toBe(true);
  });

  it("sends anything rich or long full width", () => {
    expect(isBubbleReplyText("")).toBe(false);
    expect(isBubbleReplyText("a".repeat(BUBBLE_REPLY_MAX_CHARS + 1))).toBe(false);
    expect(isBubbleReplyText("Two paragraphs.\n\nSecond one.")).toBe(false);
    expect(isBubbleReplyText("Here:\n- one\n- two")).toBe(false);
    expect(isBubbleReplyText("1. first")).toBe(false);
    expect(isBubbleReplyText("| a | b |\n| - | - |")).toBe(false);
    expect(isBubbleReplyText("```\ncode\n```")).toBe(false);
    expect(isBubbleReplyText("## Heading")).toBe(false);
    expect(isBubbleReplyText("> quoted")).toBe(false);
  });
});

describe("buildTranscriptRows", () => {
  it("groups back-to-back messages from one sender into one run", () => {
    const rows = buildTranscriptRows([
      message("u1", "user", "One"),
      message("u2", "user", "Two"),
      message("b1", "assistant", "Got it."),
      message("b2", "assistant", "Working on it."),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["u1", "b1"]);
    const [user, bot] = rows as [TranscriptRunRow, TranscriptRunRow];
    expect(user.sender).toBe("user");
    expect(user.items.map((item) => item.id)).toEqual(["u1", "u2"]);
    expect(bot.sender).toBe("bot");
    expect(bot.items.map((item) => item.id)).toEqual(["b1", "b2"]);
  });

  it("keeps a rich or long bot reply out of the run, as its own full-width row", () => {
    const rows = buildTranscriptRows([
      message("b1", "assistant", "On it."),
      message("b2", "assistant", "Here:\n- one\n- two"),
      message("b3", "assistant", "Finishing up."),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["run", "block", "run"]);
    expect(rows.map((row) => row.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("takes a reply with tap-to-answer options out of its bubble", () => {
    const rows = buildTranscriptRows(
      [message("b1", "assistant", "Pick one:"), message("b2", "assistant", "On it.")],
      { hasChoices: (id) => id === "b1" },
    );
    expect(rows.map((row) => row.kind)).toEqual(["block", "run"]);
  });

  it("gives a full-width reply the work rows right before it as its footer", () => {
    const rows = buildTranscriptRows([
      message("u1", "user", "Ship it"),
      work("w1"),
      work("w2"),
      message("b1", "assistant", "Here:\n- one\n- two"),
      message("b2", "assistant", "Also a bubble."),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["run", "block", "run"]);
    const block = rows[1];
    if (block === undefined || block.kind !== "block") throw new Error("expected the block row");
    expect(block.id).toBe("b1");
    expect(block.footerWork.map((item) => item.id)).toEqual(["w1", "w2"]);
  });

  it("leaves a work row alone when the reply after it is a bubble", () => {
    const rows = buildTranscriptRows([work("w1"), message("b1", "assistant", "Done.")]);
    expect(rows.map((row) => row.kind)).toEqual(["block", "run"]);
    expect(rows.map((row) => row.id)).toEqual(["w1", "b1"]);
  });

  it("drops a row's time when the divider right above shows the same minute", () => {
    const rows = buildTranscriptRows([
      divider(new Date("2026-10-06T10:00:00.000Z")),
      message("u1", "user", "One", "2026-10-06T10:00:30.000Z"),
      divider(new Date("2026-10-06T10:02:00.000Z")),
      message("u2", "user", "Two", "2026-10-06T10:03:30.000Z"),
      divider(new Date("2026-10-06T10:05:00.000Z")),
      message("u3", "user", "Three", "2026-10-06T10:05:10.000Z"),
    ]);
    const runs = rows.filter((row): row is TranscriptRunRow => row.kind === "run");
    expect(runs[0]?.timeSuppressed).toBe(true);
    // The run's last message is a minute past the divider's own: its time still says something.
    expect(runs[1]?.timeSuppressed).toBe(false);
    expect(runs[2]?.timeSuppressed).toBe(true);
  });
});
