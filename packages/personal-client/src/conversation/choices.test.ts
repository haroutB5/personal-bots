import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel.ts";
import { CHOICE_MAX_CHARS, choicesStates, splitChoices } from "./choices.ts";

const block = (...lines: string[]) => ["```choices", ...lines, "```"].join("\n");

const message = (id: string, role: "user" | "assistant", text: string): ConversationItem => ({
  kind: "message",
  id,
  message: {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-11-09T08:00:00.000Z",
    updatedAt: "2026-11-09T08:00:00.000Z",
  } as never,
});

describe("splitChoices", () => {
  it("turns a closing block into options and drops it from the text", () => {
    const text = `Which one?\n\n${block("Yes, ship it", "Not yet", "Show me the diff")}`;
    expect(splitChoices(text)).toEqual({
      body: "Which one?",
      options: ["Yes, ship it", "Not yet", "Show me the diff"],
    });
  });

  it("allows a reply that is only the block", () => {
    expect(splitChoices(block("A", "B"))).toEqual({ body: "", options: ["A", "B"] });
  });

  it("trims lines, skips blanks, drops repeats and tolerates a bullet or number", () => {
    const text = block("  - Option one ", "", "2. Option two", "• Option three", "Option one");
    expect(splitChoices(text).options).toEqual(["Option one", "Option two", "Option three"]);
  });

  it("accepts trailing whitespace after the closing fence", () => {
    expect(splitChoices(`${block("A", "B")}\n\n  \n`).options).toEqual(["A", "B"]);
  });

  describe("malformed blocks stay plain code", () => {
    const plain = (text: string, streaming = false) =>
      expect(splitChoices(text, streaming)).toEqual({ body: text, options: null });

    it("with one option", () => plain(`Pick:\n${block("Only one")}`));
    it("with seven options", () =>
      plain(`Pick:\n${block("1a", "2b", "3c", "4d", "5e", "6f", "7g")}`));
    it("with an empty block", () => plain(`Pick:\n${block()}`));
    it("with a line too long to be a button", () =>
      plain(`Pick:\n${block("Short", "x".repeat(CHOICE_MAX_CHARS + 1))}`));
    it("when text follows the closing fence", () =>
      plain(`${block("A", "B")}\nAnd one more thing.`));
    it("when the fence is not on its own line", () => plain("Pick ```choices\nA\nB\n```"));
    it("when the tag line carries more than the tag", () => plain("```choices extra\nA\nB\n```"));
    it("without a closing fence once the reply is done", () => plain("Pick:\n```choices\nA\nB"));
    it("when the block is an ordinary code fence", () => plain("```js\nA\nB\n```"));
  });

  it("holds back a block that is still being written, so it never flashes as code", () => {
    const partial = "Pick one:\n\n```choices\nYes\nN";
    expect(splitChoices(partial, true)).toEqual({ body: "Pick one:", options: null });
    expect(splitChoices("Pick one:\n\n```choices", true)).toEqual({
      body: "Pick one:",
      options: null,
    });
    // The same text from a finished reply is left alone.
    expect(splitChoices(partial, false)).toEqual({ body: partial, options: null });
  });

  it("uses the last block of the reply", () => {
    const text = `${block("Old 1", "Old 2")}\nMore text.\n${block("New 1", "New 2")}`;
    expect(splitChoices(text)).toEqual({
      body: `${block("Old 1", "Old 2")}\nMore text.`,
      options: ["New 1", "New 2"],
    });
  });

  it("leaves text without a block untouched", () => {
    expect(splitChoices("Just words.")).toEqual({ body: "Just words.", options: null });
  });
});

describe("choicesStates", () => {
  const reply = `Ship it?\n\n${block("Yes, ship it", "Not yet")}`;

  it("opens the latest reply and greys an earlier one once the owner spoke", () => {
    const states = choicesStates(
      [
        message("bot-1", "assistant", reply),
        message("user-1", "user", "Yes, ship it"),
        message("bot-2", "assistant", block("A", "B")),
      ],
      false,
    );
    expect(states.get("bot-1")).toEqual({ kind: "used", picked: "Yes, ship it" });
    expect(states.get("bot-2")).toEqual({ kind: "open", disabled: false });
  });

  it("marks a different owner message as no pick and waits while busy", () => {
    const states = choicesStates(
      [message("bot-1", "assistant", reply), message("user-1", "user", "Something else")],
      true,
    );
    expect(states.get("bot-1")).toEqual({ kind: "used", picked: null });
    expect(choicesStates([message("bot-1", "assistant", reply)], true).get("bot-1")).toEqual({
      kind: "open",
      disabled: true,
    });
  });

  it("leaves malformed blocks out of the map", () => {
    const states = choicesStates(
      [message("bot-1", "assistant", `Pick:\n${block("Only one")}`)],
      false,
    );
    expect(states.size).toBe(0);
  });
});
