import type { PersonalBot, PersonalBotThread, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { SETTLED_TASK_MS, unknownTaskThreadsKey } from "./useRefreshBotsForTaskThreads";

const NOW = Date.parse("2026-09-25T08:00:00.000Z");
const bots = [{ botId: "bot-a" }] as unknown as ReadonlyArray<PersonalBot>;
const links = [
  { botId: "bot-a", threadId: "known" },
] as unknown as ReadonlyArray<PersonalBotThread>;

function task(threadId: string | null, status: string, msAgo: number, botId = "bot-a") {
  return {
    taskId: `task-${threadId}-${status}`,
    botId,
    threadId,
    status,
    updatedAt: DateTime.makeUnsafe(NOW - msAgo),
  } as unknown as PersonalTask;
}

describe("unknownTaskThreadsKey", () => {
  it("names a chat the list does not know yet", () => {
    const key = unknownTaskThreadsKey({
      bots,
      links,
      tasks: [task("new", "running", 60_000), task("known", "running", 0)],
      now: NOW,
    });
    expect(key).toMatch(/^new@/);
  });

  it("still refetches for a task that finished moments ago (a routine run's new chat)", () => {
    expect(
      unknownTaskThreadsKey({ bots, links, tasks: [task("new", "completed", 5_000)], now: NOW }),
    ).not.toBeNull();
  });

  it("ignores long-finished tasks whose chat is gone, however old or active the bot", () => {
    const tasks = ["completed", "failed", "interrupted", "cancelled"].map((status) =>
      task(`gone-${status}`, status, SETTLED_TASK_MS + 1),
    );
    expect(unknownTaskThreadsKey({ bots, links, tasks, now: NOW })).toBeNull();
    // An old task that is still running keeps counting.
    expect(
      unknownTaskThreadsKey({
        bots,
        links,
        tasks: [task("slow", "running", 86_400_000)],
        now: NOW,
      }),
    ).not.toBeNull();
  });

  it("ignores deleted bots, thread-less tasks and a list that has not landed", () => {
    const tasks = [task("x", "running", 0, "bot-gone"), task(null, "running", 0)];
    expect(unknownTaskThreadsKey({ bots, links, tasks, now: NOW })).toBeNull();
    expect(
      unknownTaskThreadsKey({ bots: null, links, tasks: [task("x", "running", 0)], now: NOW }),
    ).toBeNull();
  });
});
