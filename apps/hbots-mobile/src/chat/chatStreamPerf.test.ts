import { describe, expect, it } from "vite-plus/test";

import type { ConversationItem } from "@hbots/personal-client/conversation/conversationModel";

import { createStreamPerf, replyIsStreaming } from "./chatStreamPerf";

describe("streamed update timings", () => {
  it("logs one line per update that lands while a reply streams", () => {
    const perf = createStreamPerf();

    expect(perf.note({ ms: 12.4, rows: 301, streaming: true })).toEqual({
      line: "[perf] stream-commit-ms 12 rows 301",
      body: null,
    });
  });

  it("says nothing about a commit that is not part of a streamed reply", () => {
    const perf = createStreamPerf();

    expect(perf.note({ ms: 9, rows: 40, streaming: false })).toEqual({ line: null, body: null });
    expect(perf.flush()).toBeNull();
  });

  it("sends the a-stream beacon when the reply ends: count, median, max, rows", () => {
    const perf = createStreamPerf();
    for (const ms of [40, 10, 30, 20, 50]) perf.note({ ms, rows: 150, streaming: true });
    perf.note({ ms: 7, rows: 152, streaming: true });

    const end = perf.note({ ms: 5, rows: 152, streaming: false });

    expect(end.line).toBeNull();
    expect(end.body).toEqual({
      event: "perf",
      journey: "a-stream",
      updates: 6,
      commitMsP50: 20,
      commitMsMax: 50,
      rows: 152,
    });
  });

  it("starts the next reply from nothing", () => {
    const perf = createStreamPerf();
    perf.note({ ms: 100, rows: 10, streaming: true });
    perf.note({ ms: 1, rows: 10, streaming: false });
    perf.note({ ms: 8, rows: 12, streaming: true });

    expect(perf.note({ ms: 1, rows: 12, streaming: false }).body).toEqual({
      event: "perf",
      journey: "a-stream",
      updates: 1,
      commitMsP50: 8,
      commitMsMax: 8,
      rows: 12,
    });
  });

  it("flushes a reply cut short, once", () => {
    const perf = createStreamPerf();
    perf.note({ ms: 14.6, rows: 90, streaming: true });

    expect(perf.flush()).toMatchObject({ journey: "a-stream", updates: 1, commitMsMax: 15 });
    expect(perf.flush()).toBeNull();
  });

  it("carries whole numbers and no text", () => {
    const perf = createStreamPerf();
    perf.note({ ms: 3.3, rows: 5, streaming: true });
    const body = perf.note({ ms: 0, rows: 5, streaming: false }).body ?? {};

    for (const [key, value] of Object.entries(body)) {
      if (key === "event" || key === "journey") expect(typeof value).toBe("string");
      else expect(Number.isInteger(value)).toBe(true);
    }
  });
});

function message(id: string, role: "user" | "assistant", streaming: boolean): ConversationItem {
  return {
    kind: "message",
    id,
    message: { id, role, text: "x", streaming, createdAt: "2026-11-16T10:00:00.000Z" },
  } as unknown as ConversationItem;
}

describe("replyIsStreaming", () => {
  it("is true while a message near the end is still being written", () => {
    expect(replyIsStreaming([message("a", "user", false), message("b", "assistant", true)])).toBe(
      true,
    );
  });

  it("is false for a settled chat, an empty one, and a streaming row far up the list", () => {
    expect(replyIsStreaming([])).toBe(false);
    expect(replyIsStreaming([message("a", "assistant", false)])).toBe(false);
    const old = [message("s", "assistant", true)];
    for (let index = 0; index < 6; index += 1) old.push(message(`m${index}`, "user", false));
    expect(replyIsStreaming(old)).toBe(false);
  });
});
