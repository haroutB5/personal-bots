import type { PersonalWorkEvent, WorkTaskRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildWorkDigest, workDigestView } from "./workDigest.ts";

const BOTS: Readonly<Record<string, string>> = {
  "bot-developer": "Developer",
  "bot-builder": "Builder",
  "bot-poteto": "Poteto",
};

const botName = (botId: string) => BOTS[botId] ?? "Removed bot";

const task = (taskId: string, botId: string, title: string): WorkTaskRef => ({
  taskId,
  botId,
  threadId: null,
  source: "delegation",
  parentTaskId: null,
  title,
});

const failed = (
  at: string,
  ref: WorkTaskRef,
  status: "failed" | "interrupted",
): PersonalWorkEvent => ({ kind: "taskFailed", at, task: ref, status });

const done = (at: string, ref: WorkTaskRef): PersonalWorkEvent => ({
  kind: "taskDone",
  at,
  task: ref,
});

const started = (at: string, ref: WorkTaskRef): PersonalWorkEvent => ({
  kind: "taskStarted",
  at,
  task: ref,
});

const digestOf = (
  events: ReadonlyArray<PersonalWorkEvent>,
  options: {
    readonly omitted?: number;
    readonly seenAt?: string;
    readonly asOf?: string;
    readonly chatTitles?: ReadonlyMap<string, string>;
  } = {},
) =>
  buildWorkDigest({
    events,
    omitted: options.omitted ?? 0,
    seenAt: options.seenAt ?? "2026-11-14T10:00:00.000Z",
    asOf: options.asOf ?? "2026-11-14T10:40:00.000Z",
    chatTitles: options.chatTitles ?? new Map(),
    botName,
  });

const fullLine = (symbol: string, text: string) => `${symbol} ${text}`;

describe("buildWorkDigest", () => {
  it("names what happened since the last look in the design's order", () => {
    const digest = digestOf([
      {
        kind: "goalClosed",
        at: "2026-11-14T10:30:00.000Z",
        projectId: "goal-1",
        name: "hbots 1.67.22",
        outcome: "done",
      },
      done("2026-11-14T10:20:00.000Z", task("task-apk", "bot-builder", "Projects APK")),
      failed(
        "2026-11-14T10:10:00.000Z",
        task("task-runner", "bot-developer", "Runner tests"),
        "interrupted",
      ),
      started("2026-11-14T10:09:00.000Z", task("task-chip", "bot-developer", "Archived chip check")),
      started("2026-11-14T10:08:00.000Z", task("task-image", "bot-builder", "Image speed")),
    ]);

    expect(digest?.lines.map((line) => fullLine(line.symbol, line.text))).toEqual([
      "✕ Runner tests stopped · Developer",
      "✓ hbots 1.67.22 is done",
      "✓ Projects APK · Builder",
      "+ 2 tasks started · Archived chip check, Image speed",
    ]);
    expect(digest?.span).toBe("40 min");
    expect(digest?.omitted).toBe(0);
  });

  it("shows no box when nothing happened", () => {
    expect(digestOf([])).toBeNull();
  });

  it("keeps the five newest failures and folds the other two behind +2 more", () => {
    const events = Array.from({ length: 7 }, (_, index) => {
      const minute = String(10 + index).padStart(2, "0");
      return failed(
        `2026-11-14T11:${minute}:00.000Z`,
        task(`task-${index}`, "bot-developer", `Failure ${index + 1}`),
        "failed",
      );
    });
    const digest = digestOf(events);
    if (digest === null) throw new Error("expected a digest");

    const folded = workDigestView(digest, false);
    expect(folded.lines.map((line) => line.text)).toEqual([
      "Failure 7 failed · Developer",
      "Failure 6 failed · Developer",
      "Failure 5 failed · Developer",
      "Failure 4 failed · Developer",
      "Failure 3 failed · Developer",
    ]);
    expect(folded.moreLabel).toBe("+2 more");

    const expanded = workDigestView(digest, true);
    expect(expanded.lines).toHaveLength(7);
    expect(expanded.moreLabel).toBeNull();
  });

  it("reads a single start in the singular", () => {
    const digest = digestOf([
      started("2026-11-14T10:08:00.000Z", task("task-image", "bot-builder", "Image speed")),
    ]);

    expect(digest?.lines.map((line) => fullLine(line.symbol, line.text))).toEqual([
      "+ 1 task started · Image speed",
    ]);
  });

  it("titles a user's task after its chat and passes the server's omitted count through", () => {
    const request: WorkTaskRef = {
      taskId: "task-owner",
      botId: "bot-builder",
      threadId: "thread-1",
      source: "user",
      parentTaskId: null,
      title: "MCPONCE delegate_task {...}",
    };
    const digest = digestOf([done("2026-11-14T10:20:00.000Z", request)], {
      omitted: 7,
      chatTitles: new Map([["thread-1", "Image speed"]]),
    });

    expect(digest?.lines[0]?.text).toBe("Image speed · Builder");
    expect(digest?.omitted).toBe(7);
  });
});
