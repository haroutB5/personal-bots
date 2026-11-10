import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { runWork } from "./liveWork.ts";

const threadId = ThreadId.make("thread-1");
const instanceId = ProviderInstanceId.make("codex");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const requestedAt = at("2026-06-20T00:00:00.000Z");
const startedAt = at("2026-06-20T00:00:10.000Z");
const completedAt = at("2026-06-20T00:02:10.000Z");
const itemAt = at("2026-06-20T00:00:20.000Z");

function run(status: OrchestrationV2Run["status"], ordinal = 1): OrchestrationV2Run {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId: MessageId.make(`user-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt,
    startedAt,
    completedAt: status === "running" || status === "starting" ? null : completedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
}

const itemBase = {
  threadId,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  title: null,
  startedAt: itemAt,
  completedAt: null,
  updatedAt: itemAt,
} as const;

function reasoning(id: string, text: string, status: OrchestrationV2TurnItem["status"]) {
  return {
    ...itemBase,
    id: TurnItemId.make(id),
    ordinal: 1,
    status,
    type: "reasoning" as const,
    text,
    streaming: status === "running",
  } satisfies OrchestrationV2TurnItem;
}

function command(id: string, input: string, status: OrchestrationV2TurnItem["status"]) {
  return {
    ...itemBase,
    id: TurnItemId.make(id),
    ordinal: 2,
    status,
    type: "command_execution" as const,
    input,
  } satisfies OrchestrationV2TurnItem;
}

function projection(
  runs: ReadonlyArray<OrchestrationV2Run>,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Work log",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: requestedAt,
      updatedAt: completedAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [...runs],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [...items],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    })),
    updatedAt: completedAt,
  };
}

describe("runWork", () => {
  it("is idle when the thread has no run", () => {
    expect(runWork(projection([], []))).toEqual({ phase: "idle" });
  });

  it("turns working while a run is running and follows the latest running step", () => {
    const work = runWork(
      projection(
        [run("running")],
        [
          reasoning("think-1", "Checking the test layout.", "completed"),
          command("cmd-1", "pnpm test", "running"),
        ],
      ),
    );

    expect(work).toMatchObject({
      phase: "working",
      runId: "run-1",
      startedAt: "2026-06-20T00:00:10.000Z",
      current: { kind: "command", label: "pnpm test", status: "running" },
    });
    expect(work.phase === "working" ? work.steps : []).toHaveLength(2);
  });

  it("keeps one current line through many reasoning chunks", () => {
    const work = runWork(
      projection(
        [run("running")],
        [
          reasoning("think-1", "First look at the feed.", "completed"),
          reasoning("think-2", "Second pass over the feed.", "completed"),
          reasoning("think-3", "Third pass over the feed.", "completed"),
          reasoning("think-4", "Fourth pass over the feed.", "completed"),
          reasoning("think-5", "The live row needs the latest line.", "running"),
        ],
      ),
    );

    expect(work.phase).toBe("working");
    if (work.phase !== "working") return;
    expect(work.current).toEqual({
      kind: "thinking",
      id: "think-5",
      line: "The live row needs the latest line.",
      status: "running",
    });
    expect(work.steps).toHaveLength(5);
  });

  it("settles with the step count and the run duration", () => {
    const work = runWork(
      projection(
        [run("completed")],
        [
          reasoning("think-1", "**Planning the change.**\nThen the edit.", "completed"),
          command("cmd-1", "pnpm typecheck", "completed"),
          command("cmd-2", "pnpm test", "completed"),
        ],
      ),
    );

    expect(work.phase).toBe("settled");
    if (work.phase !== "settled") return;
    expect(work.durationMs).toBe(120_000);
    expect(work.summary).toEqual({ count: 3, kind: "command", hasFailure: false });
    expect(work.steps.map((step) => step.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("settles an interrupted run as cancelled with no running step", () => {
    const work = runWork(
      projection(
        [run("interrupted")],
        [command("cmd-1", "pnpm test", "completed"), command("cmd-2", "pnpm build", "running")],
      ),
    );

    expect(work.phase).toBe("settled");
    if (work.phase !== "settled") return;
    expect(work.steps.map((step) => step.status)).toEqual(["completed", "cancelled"]);
  });

  it("marks a failed step in the settled summary", () => {
    const work = runWork(
      projection(
        [run("completed")],
        [command("cmd-1", "pnpm lint", "failed"), command("cmd-2", "pnpm test", "completed")],
      ),
    );

    expect(work.phase).toBe("settled");
    if (work.phase !== "settled") return;
    expect(work.summary.hasFailure).toBe(true);
  });

  it("ignores approvals, notifications and plan rows", () => {
    const approval = {
      ...itemBase,
      id: TurnItemId.make("approval-1"),
      ordinal: 9,
      status: "completed" as const,
      type: "approval_request" as const,
      requestId: "request-1" as never,
      requestKind: "command" as const,
    } satisfies OrchestrationV2TurnItem;
    const notification = {
      ...itemBase,
      id: TurnItemId.make("note-1"),
      ordinal: 10,
      status: "completed" as const,
      type: "notification" as const,
      message: "Done",
      level: "info" as const,
    } as unknown as OrchestrationV2TurnItem;
    const work = runWork(
      projection([run("completed")], [approval, notification, command("cmd-1", "ls", "completed")]),
    );

    expect(work.phase).toBe("settled");
    if (work.phase !== "settled") return;
    expect(work.steps).toHaveLength(1);
    expect(work.summary.count).toBe(1);
  });

  it("uses only the latest run's items", () => {
    const older: OrchestrationV2TurnItem = {
      ...command("cmd-old", "pnpm old", "completed"),
      runId: RunId.make("run-0"),
    };
    const work = runWork(
      projection([run("completed", 1)], [older, command("cmd-new", "pnpm new", "completed")]),
    );

    expect(work.phase).toBe("settled");
    if (work.phase !== "settled") return;
    expect(work.steps.map((step) => (step.kind === "command" ? step.label : step.id))).toEqual([
      "pnpm new",
    ]);
  });
});
