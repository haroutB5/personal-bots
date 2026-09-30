import type { PersonalBot, PersonalBotThread, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  archivedLiveThreadsKey,
  SETTLED_TASK_MS,
  unknownTaskBotsKey,
  unknownTaskThreadsKey,
} from "./useRefreshBotsForTaskThreads";

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

describe("unknownTaskBotsKey", () => {
  it("names a bot the list has never had, such as one a team lead just created", () => {
    expect(
      unknownTaskBotsKey({
        bots,
        tasks: [task("t1", "running", 0, "bot-new"), task("t2", "queued", 0, "bot-new")],
        now: NOW,
      }),
    ).toBe("bots:bot-new");
  });

  it("ignores known bots, long-finished tasks and a list that has not landed", () => {
    expect(unknownTaskBotsKey({ bots, tasks: [task("t1", "running", 0)], now: NOW })).toBeNull();
    expect(
      unknownTaskBotsKey({
        bots,
        tasks: [task("t3", "completed", SETTLED_TASK_MS + 1, "bot-gone")],
        now: NOW,
      }),
    ).toBeNull();
    expect(
      unknownTaskBotsKey({ bots: null, tasks: [task("t4", "running", 0, "bot-new")], now: NOW }),
    ).toBeNull();
  });
});

describe("archivedLiveThreadsKey", () => {
  const chats = [
    { botId: "bot-a", threadId: "open", archivedAt: null },
    { botId: "bot-a", threadId: "put-away", archivedAt: "2026-09-25T07:00:00.000Z" },
  ] as unknown as ReadonlyArray<PersonalBotThread>;
  const shell = (id: string, state: string | null, turnId = "turn-1") =>
    ({
      id,
      latestTurn: state === null ? null : { state, turnId },
      session: null,
    }) as unknown as EnvironmentThreadShell;

  it("names an archived chat a turn is running in, once per turn", () => {
    expect(
      archivedLiveThreadsKey({
        links: chats,
        shells: [shell("open", "running"), shell("put-away", "running")],
      }),
    ).toBe("archived:put-away@turn-1");
    expect(
      archivedLiveThreadsKey({ links: chats, shells: [shell("put-away", "running", "turn-2")] }),
    ).toBe("archived:put-away@turn-2");
  });

  it("is null when no archived chat is working, or without shells", () => {
    expect(
      archivedLiveThreadsKey({
        links: chats,
        shells: [shell("open", "running"), shell("put-away", "completed")],
      }),
    ).toBeNull();
    expect(archivedLiveThreadsKey({ links: chats, shells: undefined })).toBeNull();
    expect(archivedLiveThreadsKey({ links: null, shells: [] })).toBeNull();
  });
});
