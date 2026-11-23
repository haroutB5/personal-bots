import type { EnvironmentThreadShell } from "./threadShell.ts";
import {
  PersonalBot,
  type PersonalBotThread,
  type PersonalTask,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveDelegationCard,
  threadIdsWaitingOnBackground,
  WORKING_IN_BACKGROUND_LABEL,
} from "../conversation/delegationModel.ts";
import { botStatus, buildBotSummaries, isBotWorking } from "./botSummaries.ts";

// 1.67.55, Harout's screenshots of 23 Nov: Opuser's task was `running` with
// `waitingOnBackgroundSince` set (gates in the background). The task card said
// "Working", the Bots row said "Ready". Row, card and header now share one label.

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const makeBot = (botId: string, name: string, sortOrder: number) =>
  decodeBot({
    botId,
    name,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId: "codex", model: "some-model" },
    enabled: true,
    sortOrder,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  });
const opuser = makeBot("opuser", "Opuser", 1);
const idle = makeBot("idle", "Idle bot", 0);

const NOW = Date.UTC(2026, 10, 23, 12, 0);
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const link = (botId: string, threadId: string) =>
  ({ botId, threadId, createdAt: iso(600), archivedAt: null }) as unknown as PersonalBotThread;
const shell = (id: string, minutesAgo: number, running = false) =>
  ({
    id,
    title: `Thread ${id}`,
    updatedAt: iso(minutesAgo),
    createdAt: iso(minutesAgo),
    latestUserMessageAt: iso(minutesAgo),
    archivedAt: null,
    latestTurn: running
      ? { turnId: "t2", state: "running", assistantMessageId: "m2", completedAt: null }
      : {
          turnId: "t1",
          state: "completed",
          assistantMessageId: "m1",
          completedAt: iso(minutesAgo),
        },
    session: running ? { status: "running", activeTurnId: "t2", updatedAt: iso(0) } : null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  }) as unknown as EnvironmentThreadShell;

const task = (status: PersonalTask["status"], waiting: boolean) =>
  ({
    taskId: "task-1",
    botId: "opuser",
    threadId: "task-chat",
    parentTaskId: null,
    title: "hbots 1.67.55",
    status,
    errorMessage: null,
    result: {
      summary: "The chain (x86, stage, gates) is running",
      ...(waiting ? { waitingOnBackgroundSince: iso(5) } : {}),
    },
  }) as unknown as PersonalTask;

const build = (tasks: ReadonlyArray<PersonalTask>, taskChatRunning = false) =>
  buildBotSummaries({
    bots: [idle, opuser],
    links: [link("opuser", "task-chat"), link("idle", "idle-chat")],
    // The idle bot chatted more recently, so only the working rule can lift Opuser.
    shells: [shell("task-chat", 30, taskChatRunning), shell("idle-chat", 1)],
    providers: [
      { instanceId: "codex", driver: "codex", enabled: true } as unknown as ServerProvider,
    ],
    backgroundThreadIds: threadIdsWaitingOnBackground(tasks),
    nowMs: NOW,
  });

const opuserRow = (rows: ReturnType<typeof build>) =>
  rows.find((row) => row.bot.botId === "opuser")!;

describe("threadIdsWaitingOnBackground", () => {
  it("lists only running tasks with waitingOnBackgroundSince", () => {
    expect([...threadIdsWaitingOnBackground([task("running", true)])]).toEqual(["task-chat"]);
    expect(threadIdsWaitingOnBackground([task("running", false)]).size).toBe(0);
    expect(threadIdsWaitingOnBackground([task("completed", true)]).size).toBe(0);
  });
});

describe("botStatus for a task waiting on background work", () => {
  it("says Working in background, not Ready", () => {
    const row = opuserRow(build([task("running", true)]));
    expect(row.live).toBe(false);
    expect(row.workingInBackground).toBe(true);
    expect(botStatus(row, NOW)).toEqual({ label: WORKING_IN_BACKGROUND_LABEL, tone: "normal" });
    expect(isBotWorking(row)).toBe(true);
  });

  it("sorts the bot with the working bots, above a more recently active idle bot", () => {
    const rows = build([task("running", true)]);
    expect(rows.map((row) => row.bot.botId)).toEqual(["opuser", "idle"]);
  });

  it("clears when the task completes", () => {
    const rows = build([task("completed", true)]);
    const row = opuserRow(rows);
    expect(row.workingInBackground).toBe(false);
    expect(botStatus(row, NOW).label).toBe("Ready");
    expect(rows.map((r) => r.bot.botId)).toEqual(["idle", "opuser"]);
  });

  it("gives way to Working when the background job wakes the bot for a live turn", () => {
    const row = opuserRow(build([task("running", true)], true));
    expect(row.live).toBe(true);
    expect(row.workingInBackground).toBe(false);
    expect(botStatus(row, NOW).label).toBe("Working");
  });

  it("a needs-you state still wins over it", () => {
    const row = { ...opuserRow(build([task("running", true)])), hasPendingApprovals: true };
    expect(botStatus(row, NOW).label).toBe("Needs approval");
  });
});

describe("the task card agrees with the row", () => {
  const card = (t: PersonalTask, turnLive = false) =>
    deriveDelegationCard({
      task: t,
      entries: [
        { id: "e1", label: "Ran gates", tone: "tool", turnId: "t1" },
        { id: "e2", label: "Started x86 build", tone: "tool", turnId: "t1" },
      ] as never,
      labelOf: (entry) => entry.label,
      turnLive,
    });

  it("says Working in background with no step still current", () => {
    const model = card(task("running", true));
    expect(model.status).toBe(WORKING_IN_BACKGROUND_LABEL);
    expect(model.steps.map((step) => step.state)).toEqual(["done", "done"]);
  });

  it("says Working while a turn runs, and for a plain running task", () => {
    expect(card(task("running", true), true).status).toBe("Working");
    expect(card(task("running", false)).status).toBe("Working");
    expect(card(task("running", false)).steps.at(-1)?.state).toBe("current");
  });
});
