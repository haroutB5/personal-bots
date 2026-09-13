import { PersonalTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "~/session-logic";
import type { ChatMessage } from "~/types";

import { buildConversationItems, placeDelegationCards } from "./conversationModel";
import {
  classifyLegacyTaskMessage,
  deriveDelegationCard,
  delegatedChildren,
  readServerTurn,
  resolveTurnChildren,
  serverTurnLabel,
  waitingLabelsByThread,
} from "./delegationModel";

const decodeTask = Schema.decodeUnknownSync(PersonalTask);

function task(overrides: Record<string, unknown>) {
  return decodeTask({
    taskId: "root",
    rootTaskId: "root",
    parentTaskId: null,
    botId: "bot-assistant",
    threadId: "thread-parent",
    title: "Root",
    objective: "Do it",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "running",
    source: "user",
    idempotencyKey: `key-${String(overrides.taskId ?? "root")}`,
    depth: 0,
    maxDepth: 2,
    maxChildren: 4,
    result: null,
    errorCategory: null,
    errorMessage: null,
    availableAt: null,
    createdAt: "2026-09-13T04:02:00.000Z",
    updatedAt: "2026-09-13T04:02:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides,
  });
}

const NAMES: Record<string, string> = {
  "bot-assistant": "Assistant",
  "bot-developer": "Developer",
  "bot-researcher": "Researcher",
};
const nameOf = (botId: string) => NAMES[botId] ?? null;

function message(
  overrides: Omit<Partial<ChatMessage>, "id"> & { id: string; text: string },
): ChatMessage {
  return {
    role: "user",
    turnId: null,
    streaming: false,
    createdAt: "2026-09-13T04:02:21.662Z",
    updatedAt: "2026-09-13T04:02:21.662Z",
    ...overrides,
  } as ChatMessage;
}

function markerContext(payload: unknown) {
  return {
    version: 1,
    records: [
      {
        version: 1,
        contextId: "personal-task",
        label: "Task turn",
        kind: "personal-task",
        payload,
      },
    ],
  } as unknown as ChatMessage["context"];
}

// Live evidence, thread 2289a758 (2026-09-13): written before the marker existed.
const LEGACY_CONTINUATION = [
  "[Task continuation] Your delegated tasks have finished. Their results:",
  "### PONG connectivity check (completed)\nPONG",
  "Continue the task below with these results and give your final answer.",
  "Task id: 25c496ec-e273-43e2-923b-842cfddc98ec",
  "Title: Use your delegate_task tool to ask the Developer bot",
].join("\n\n");
const LEGACY_DELEGATED = [
  "[Delegated task from Assistant]",
  "Task id: 9c41b8e6-b489-4b16-b651-a3745e22bd22",
  "Title: PONG connectivity check",
  "Objective:\nReply with exactly the word PONG.",
].join("\n\n");

describe("readServerTurn", () => {
  it("reads the marker the task service attaches", () => {
    const turn = readServerTurn(
      message({
        id: "any-id",
        text: "[Task continuation] ...",
        context: markerContext({
          taskId: "root",
          attempt: 2,
          turn: "continuation",
          source: "user",
          title: "Root",
          delegatorBotId: null,
          children: [
            { taskId: "child", botId: "bot-developer", title: "PONG check", status: "completed" },
          ],
        }),
      }),
    );
    expect(turn).toMatchObject({ taskId: "root", attempt: 2, turn: "continuation" });
    expect(serverTurnLabel(turn!, turn!.children, nameOf)).toBe("Developer finished: PONG check");
  });

  it("keeps the user's own messages as user messages", () => {
    expect(readServerTurn(message({ id: "c3f1b0de", text: "[Task continuation] hi" }))).toBeNull();
    expect(
      readServerTurn(message({ id: "personal-task-x-1", text: "hi", role: "assistant" })),
    ).toBeNull();
    // A server id with an unknown header is not guessed at.
    expect(readServerTurn(message({ id: "personal-task-x-1", text: "Hello" }))).toBeNull();
  });

  it("ignores a malformed marker rather than trusting it", () => {
    const turn = readServerTurn(
      message({ id: "c3f1b0de", text: "x", context: markerContext({ taskId: "root" }) }),
    );
    expect(turn).toBeNull();
  });
});

describe("classifyLegacyTaskMessage", () => {
  it("classifies the live continuation and names the child from the task feed", () => {
    const turn = classifyLegacyTaskMessage({
      id: "personal-task-25c496ec-e273-43e2-923b-842cfddc98ec-2",
      text: LEGACY_CONTINUATION,
    })!;
    expect(turn).toMatchObject({
      taskId: "25c496ec-e273-43e2-923b-842cfddc98ec",
      attempt: 2,
      turn: "continuation",
      children: [
        { taskId: null, botId: null, title: "PONG connectivity check", status: "completed" },
      ],
    });
    const tasks = [
      task({
        taskId: "9c41b8e6",
        parentTaskId: "25c496ec-e273-43e2-923b-842cfddc98ec",
        botId: "bot-developer",
        title: "PONG connectivity check",
      }),
    ];
    const children = resolveTurnChildren(turn, tasks);
    expect(children[0]).toMatchObject({ taskId: "9c41b8e6", botId: "bot-developer" });
    expect(serverTurnLabel(turn, children, nameOf)).toBe(
      "Developer finished: PONG connectivity check",
    );
    // Without the feed it still never claims a bot it does not know.
    expect(serverTurnLabel(turn, turn.children, nameOf)).toBe(
      "A bot finished: PONG connectivity check",
    );
  });

  it("classifies delegated, routine, user and retry headers", () => {
    const delegated = classifyLegacyTaskMessage({
      id: "personal-task-9c41b8e6-b489-4b16-b651-a3745e22bd22-1",
      text: LEGACY_DELEGATED,
    })!;
    expect(delegated).toMatchObject({
      turn: "start",
      source: "delegation",
      delegatorName: "Assistant",
    });
    expect(serverTurnLabel(delegated, [], nameOf)).toBe(
      "Task from Assistant: PONG connectivity check",
    );

    const routine = classifyLegacyTaskMessage({
      id: "personal-task-a2166242-1",
      text: "[Routine task]\n\nTask id: a2166242\n\nTitle: Phase 4 tick",
    })!;
    expect(serverTurnLabel(routine, [], nameOf)).toBe("Routine: Phase 4 tick");

    const retry = classifyLegacyTaskMessage({
      id: "personal-task-t1-3",
      text: "[Task from you] Retry, attempt 3.\n\nTask id: t1\n\nTitle: Weather view",
    })!;
    expect(retry).toMatchObject({ turn: "retry", source: "user", attempt: 3 });
    expect(serverTurnLabel(retry, [], nameOf)).toBe("Retry, attempt 3: Weather view");
  });
});

describe("serverTurnLabel", () => {
  const base = {
    taskId: "root",
    attempt: 2,
    turn: "continuation" as const,
    source: "user" as const,
    title: "Root",
    delegatorBotId: null,
    delegatorName: null,
    children: [],
  };

  it("reports failures and several children honestly", () => {
    expect(
      serverTurnLabel(
        base,
        [{ taskId: "c", botId: "bot-developer", title: "Build", status: "failed" }],
        nameOf,
      ),
    ).toBe("Developer failed: Build");
    expect(
      serverTurnLabel(
        base,
        [
          { taskId: "a", botId: "bot-developer", title: "A", status: "completed" },
          { taskId: "b", botId: "bot-researcher", title: "B", status: "completed" },
        ],
        nameOf,
      ),
    ).toBe("Developer and Researcher finished 2 tasks");
    expect(serverTurnLabel(base, [], nameOf)).toBe("Task resumed: Root");
  });

  it("names the delegator from the marker's bot id", () => {
    expect(
      serverTurnLabel(
        { ...base, turn: "start", source: "delegation", delegatorBotId: "bot-assistant" },
        [],
        nameOf,
      ),
    ).toBe("Task from Assistant: Root");
  });
});

const entry = (id: string, overrides: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
  id,
  createdAt: "2026-09-13T04:02:15.000Z",
  label: id,
  tone: "tool",
  turnId: null,
  ...overrides,
});
const labelOf = (value: WorkLogEntry) => value.label;

describe("deriveDelegationCard", () => {
  const child = (overrides: Record<string, unknown>) =>
    task({ taskId: "child", parentTaskId: "root", botId: "bot-developer", ...overrides });

  it("shows only the status row when the child has no activity yet", () => {
    expect(
      deriveDelegationCard({ task: child({ status: "queued" }), entries: [], labelOf }),
    ).toEqual({ tone: "neutral", status: "Queued", steps: [], detail: null, canCancel: true });
    expect(
      deriveDelegationCard({ task: child({ status: "running" }), entries: [], labelOf }),
    ).toMatchObject({ status: "Working", steps: [] });
  });

  it("summarises the current turn's real activity as up to three steps", () => {
    const entries = [
      entry("old", { turnId: "turn-1" as never }),
      entry("think", { turnId: "turn-2" as never, tone: "thinking" }),
      entry("read", { turnId: "turn-2" as never }),
      entry("search", { turnId: "turn-2" as never }),
      entry("edit", { turnId: "turn-2" as never, tone: "error" }),
      entry("run", { turnId: "turn-2" as never }),
    ];
    const card = deriveDelegationCard({ task: child({ status: "running" }), entries, labelOf });
    expect(card.steps).toEqual([
      { id: "search", label: "search", state: "done" },
      { id: "edit", label: "edit", state: "failed" },
      { id: "run", label: "run", state: "current" },
    ]);
  });

  it("never shows steps once the child stops running", () => {
    const entries = [entry("read")];
    expect(
      deriveDelegationCard({
        task: child({ status: "completed", result: { summary: " PONG " } }),
        entries,
        labelOf,
      }),
    ).toEqual({ tone: "done", status: "Done", steps: [], detail: "PONG", canCancel: false });
    expect(
      deriveDelegationCard({ task: child({ status: "waiting_for_user" }), entries, labelOf }),
    ).toMatchObject({ tone: "review", status: "Needs your input", steps: [] });
    expect(
      deriveDelegationCard({
        task: child({ status: "failed", errorMessage: "Provider crashed" }),
        entries,
        labelOf,
      }),
    ).toMatchObject({ tone: "error", status: "Failed", detail: "Provider crashed" });
    expect(
      deriveDelegationCard({ task: child({ status: "cancelled" }), entries, labelOf }),
    ).toMatchObject({ status: "Cancelled", detail: null, canCancel: false });
    expect(
      deriveDelegationCard({
        task: child({ status: "waiting_for_agent" }),
        entries,
        labelOf,
        waitingFor: "Waiting for Researcher",
      }),
    ).toMatchObject({ status: "Waiting for Researcher", canCancel: true });
  });
});

describe("delegatedChildren and waiting labels", () => {
  const tasks = [
    task({ taskId: "root", status: "waiting_for_agent" }),
    task({
      taskId: "dev",
      parentTaskId: "root",
      botId: "bot-developer",
      threadId: "thread-dev",
      createdAt: "2026-09-13T04:02:13.000Z",
    }),
    task({
      taskId: "res",
      parentTaskId: "root",
      botId: "bot-researcher",
      threadId: null,
      status: "completed",
      createdAt: "2026-09-13T04:02:12.000Z",
    }),
    task({ taskId: "other", threadId: "thread-other", botId: "bot-researcher" }),
  ];

  it("finds the children of every task that ran in the thread, oldest first", () => {
    expect(delegatedChildren("thread-parent", tasks).map((value) => value.taskId)).toEqual([
      "res",
      "dev",
    ]);
    expect(delegatedChildren("thread-other", tasks)).toEqual([]);
  });

  it("names only the unfinished children a parked parent waits for", () => {
    const labels = waitingLabelsByThread(tasks, nameOf);
    expect(labels.get("thread-parent")).toBe("Waiting for Developer");
    expect(labels.has("thread-dev")).toBe(false);
    // A parked parent whose children all just finished waits for no one in particular.
    const done = tasks.map((value) =>
      value.taskId === "dev"
        ? task({ taskId: "dev", parentTaskId: "root", botId: "bot-developer", status: "completed" })
        : value,
    );
    expect(waitingLabelsByThread(done, nameOf).get("thread-parent")).toBe("Waiting on another bot");
  });
});

describe("placeDelegationCards", () => {
  it("puts the card at the end of the delegating turn, before the continuation row", () => {
    const items = buildConversationItems([
      {
        id: "u1",
        kind: "message",
        createdAt: "2026-09-13T04:02:00.000Z",
        message: message({
          id: "u1",
          text: "Ask the Developer for PONG",
          createdAt: "2026-09-13T04:02:00.000Z",
        }),
      },
      {
        id: "w1",
        kind: "work",
        createdAt: "2026-09-13T04:02:05.000Z",
        entry: entry("delegate_task", { createdAt: "2026-09-13T04:02:05.000Z" }),
      },
      {
        id: "a1",
        kind: "message",
        createdAt: "2026-09-13T04:02:12.000Z",
        message: message({
          id: "a1",
          role: "assistant",
          text: "I've asked the Developer.",
          createdAt: "2026-09-13T04:02:12.000Z",
        }),
      },
      {
        id: "personal-task-root-2",
        kind: "message",
        createdAt: "2026-09-13T04:02:21.662Z",
        message: message({ id: "personal-task-root-2", text: LEGACY_CONTINUATION }),
      },
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "divider",
      "message",
      "work",
      "message",
      "system-turn",
    ]);
    const child = task({
      taskId: "dev",
      parentTaskId: "root",
      botId: "bot-developer",
      createdAt: "2026-09-13T04:02:06.000Z",
    });
    const placed = placeDelegationCards(items, [child]);
    expect(placed.map((item) => item.id)).toEqual([
      items[0]!.id,
      "u1",
      "work:w1",
      "a1",
      "delegation:dev",
      "personal-task-root-2",
    ]);
  });
});

describe("placeDelegationCards with several children", () => {
  const item = (id: string, role: "user" | "assistant", createdAt: string) =>
    ({
      id,
      kind: "message",
      createdAt,
      message: { id, role, text: id, createdAt, streaming: false } as unknown as ChatMessage,
    }) as unknown as Parameters<typeof buildConversationItems>[0][number];

  it("puts each card at the end of the turn that created it, in creation order", () => {
    const items = buildConversationItems([
      item("u1", "user", "2026-09-13T10:00:00.000Z"),
      item("a1", "assistant", "2026-09-13T10:00:10.000Z"),
      item("u2", "user", "2026-09-13T10:05:00.000Z"),
      item("a2", "assistant", "2026-09-13T10:05:10.000Z"),
    ]);
    const children = [
      task({ taskId: "c-late", createdAt: "2026-09-13T10:05:05.000Z" }),
      task({ taskId: "c-first", createdAt: "2026-09-13T10:00:03.000Z" }),
      task({ taskId: "c-second", createdAt: "2026-09-13T10:00:04.000Z" }),
    ];
    expect(placeDelegationCards(items, children).map((entry) => entry.id)).toEqual([
      "divider:2026-09-13T10:00:00.000Z",
      "u1",
      "a1",
      "delegation:c-first",
      "delegation:c-second",
      "u2",
      "a2",
      "delegation:c-late",
    ]);
  });
});
