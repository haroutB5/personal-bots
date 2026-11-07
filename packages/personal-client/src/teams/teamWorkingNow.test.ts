import type { PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkingNow, formatWorkingFor } from "./teamWorkingNow.ts";

function task(input: {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly botId?: string;
  readonly status?: PersonalTask["status"];
  readonly threadId?: string | null;
  readonly startedAt?: string | null;
}): PersonalTask {
  return {
    taskId: input.taskId,
    parentTaskId: input.parentTaskId ?? null,
    botId: input.botId ?? "bot-a",
    threadId: input.threadId === undefined ? `thread-${input.taskId}` : input.threadId,
    title: `Task ${input.taskId}`,
    status: input.status ?? "running",
    createdAt: DateTime.makeUnsafe("2026-09-29T10:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-09-29T10:00:00.000Z"),
    startedAt: DateTime.makeUnsafe(input.startedAt ?? "2026-09-29T10:00:00.000Z"),
    completedAt: null,
  } as unknown as PersonalTask;
}

describe("deriveWorkingNow", () => {
  it("lists running handoffs between listed bots, oldest first", () => {
    const root = task({ taskId: "root", status: "running" });
    const items = deriveWorkingNow(
      [
        root,
        task({
          taskId: "later",
          parentTaskId: "root",
          botId: "bot-b",
          startedAt: "2026-09-29T11:00:00.000Z",
        }),
        task({
          taskId: "done",
          parentTaskId: "root",
          botId: "bot-b",
          status: "completed",
        }),
        task({ taskId: "stranger", parentTaskId: "root", botId: "bot-z" }),
      ],
      new Set(["bot-a", "bot-b"]),
    );
    expect(items.map((item) => [item.taskId, item.from, item.to])).toEqual([
      ["later", "bot-a", "bot-b"],
    ]);
  });

  it("keeps a task with no chat addressable and reads the run time", () => {
    const [item] = deriveWorkingNow(
      [
        task({ taskId: "root", status: "running" }),
        task({
          taskId: "queued",
          parentTaskId: "root",
          botId: "bot-b",
          startedAt: "2026-09-29T10:00:00.000Z",
          threadId: null,
        }),
      ],
      new Set(["bot-a", "bot-b"]),
    );
    expect(item?.threadId).toBeNull();
    expect(item?.sinceMs).toBe(Date.parse("2026-09-29T10:00:00.000Z"));
    const start = Date.parse("2026-09-29T10:00:00.000Z");
    expect(formatWorkingFor(start, start + 20_000)).toBe("Just now");
    expect(formatWorkingFor(start, start + 5 * 60_000)).toBe("5 min");
    expect(formatWorkingFor(start, start + 69 * 60_000)).toBe("1 h 9 min");
  });
});
