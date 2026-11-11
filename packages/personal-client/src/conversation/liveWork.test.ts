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

import { groupRunWork, runWork, workStepLabel } from "./liveWork.ts";

const threadId = ThreadId.make("thread-1");
const instanceId = ProviderInstanceId.make("codex");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const requestedAt = at("2026-06-20T00:00:00.000Z");
const startedAt = at("2026-06-20T00:00:10.000Z");
const completedAt = at("2026-06-20T00:02:10.000Z");
const itemAt = at("2026-06-20T00:00:20.000Z");

function run(
  status: OrchestrationV2Run["status"],
  ordinal = 1,
  startedAtValue: OrchestrationV2Run["startedAt"] = startedAt,
): OrchestrationV2Run {
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
    startedAt: startedAtValue,
    completedAt:
      status === "running" || status === "starting" || status === "queued" || status === "preparing"
        ? null
        : completedAt,
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

function item(
  id: string,
  ordinal: number,
  fields: Record<string, unknown>,
): OrchestrationV2TurnItem {
  return {
    ...itemBase,
    id: TurnItemId.make(id),
    ordinal,
    ...fields,
  } as OrchestrationV2TurnItem;
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

  it("counts wire-collapsed deferred work in the settled summary", () => {
    const anchor = {
      ...reasoning("think-1", "First thought.", "completed"),
      deferredWork: { cursor: "work-page" as never, itemCount: 221, lastOrdinal: 1_000_221 },
    };
    const work = runWork(projection([run("completed")], [anchor]));

    expect(work.phase).toBe("settled");
    if (work.phase !== "settled") return;
    expect(work.steps).toHaveLength(1);
    expect(work.deferredCount).toBe(220);
    expect(work.summary.count).toBe(221);
  });

  it("drops a leading cd prefix from a command label", () => {
    const work = runWork(
      projection(
        [run("running")],
        [
          command("cmd-1", "cd /repo && pnpm test", "completed"),
          command("cmd-2", "cd '/repo with space'; git status --short", "running"),
        ],
      ),
    );

    expect(work.phase).toBe("working");
    if (work.phase !== "working") return;
    expect(work.current).toMatchObject({ kind: "command", label: "git status --short" });
    expect(work.steps.map((step) => workStepLabel(step))).toEqual([
      "pnpm test",
      "git status --short",
    ]);
  });

  it("keeps a bare cd command unchanged", () => {
    const work = runWork(projection([run("running")], [command("cmd-1", "cd /repo", "running")]));

    expect(work.phase).toBe("working");
    if (work.phase !== "working") return;
    expect(work.current).toMatchObject({ label: "cd /repo" });
  });

  it("humanises mcp tool names", () => {
    const work = runWork(
      projection(
        [run("running")],
        [
          item("tool-1", 3, {
            type: "dynamic_tool",
            toolName: "mcp__t3-code__update_work_record",
            title: null,
            input: {},
            status: "running",
          }),
        ],
      ),
    );

    expect(work.phase).toBe("working");
    if (work.phase !== "working") return;
    expect(work.current).toMatchObject({ kind: "tool", label: "update work record" });
  });

  it("counts subagents and searches as steps with readable labels", () => {
    const work = runWork(
      projection(
        [run("running")],
        [
          item("sub-1", 3, { type: "subagent", status: "running" }),
          item("web-1", 4, { type: "web_search", status: "completed" }),
          item("search-1", 5, { type: "file_search", status: "completed" }),
          item("error-1", 6, { type: "error", status: "completed" }),
        ],
      ),
    );

    expect(work.phase).toBe("working");
    if (work.phase !== "working") return;
    expect(work.steps.map((step) => workStepLabel(step))).toEqual([
      "Subagent",
      "Web search",
      "File search",
      "Error",
    ]);
  });

  it("keeps the previous summary while the next run is still queued", () => {
    const work = runWork(
      projection(
        [run("completed", 1), run("queued", 2, null)],
        [command("cmd-1", "pnpm test", "completed")],
      ),
    );

    expect(work.phase).toBe("settled");
    if (work.phase !== "settled") return;
    expect(work.runId).toBe("run-1");
    expect(work.summary.count).toBe(1);
  });

  it("follows the queued run once it starts", () => {
    const work = runWork(
      projection(
        [run("completed", 1), run("running", 2)],
        [
          command("cmd-1", "pnpm test", "completed"),
          { ...command("cmd-2", "pnpm build", "running"), runId: RunId.make("run-2") },
        ],
      ),
    );

    expect(work.phase).toBe("working");
    if (work.phase !== "working") return;
    expect(work.runId).toBe("run-2");
  });

  it("keeps the spinner and says it waits on background work", () => {
    const work = runWork(projection([run("waiting")], [command("cmd-1", "sleep 600", "waiting")]));

    expect(work.phase).toBe("working");
    if (work.phase !== "working") return;
    expect(work.waitingOnBackground).toBe(true);
    expect(work.current).toMatchObject({ status: "running" });
  });
  describe("empty live lines", () => {
    it.each(["{}", "[]", "", "   ", "{ }", " [ ] "])(
      "treats a running command with input %j as not started yet",
      (input) => {
        const work = runWork(projection([run("running")], [command("cmd-1", input, "running")]));

        expect(work.phase).toBe("working");
        if (work.phase !== "working") return;
        expect(work.current).toBeNull();
        expect(work.steps).toHaveLength(0);
      },
    );

    it("falls back to the previous step while the new command has no input", () => {
      const work = runWork(
        projection(
          [run("running")],
          [command("cmd-1", "pnpm test", "completed"), command("cmd-2", "{}", "running")],
        ),
      );

      expect(work.phase).toBe("working");
      if (work.phase !== "working") return;
      expect(work.current).toMatchObject({ kind: "command", label: "pnpm test" });
      expect(work.steps).toHaveLength(1);
    });

    it("shows the real input once it arrives", () => {
      const work = runWork(
        projection([run("running")], [command("cmd-1", "git status", "running")]),
      );

      expect(work.phase).toBe("working");
      if (work.phase !== "working") return;
      expect(work.current).toMatchObject({ label: "git status" });
    });

    it("does not count an empty command in a settled run", () => {
      const work = runWork(
        projection(
          [run("completed")],
          [command("cmd-1", "ls", "completed"), command("cmd-2", "[]", "completed")],
        ),
      );

      expect(work.phase).toBe("settled");
      if (work.phase !== "settled") return;
      expect(work.summary.count).toBe(1);
    });
  });

  describe("wire-collapsed count", () => {
    const deferredWork = (itemCount: number) => ({
      cursor: "work-page" as never,
      itemCount,
      lastOrdinal: 1_000_000 + itemCount,
    });

    it("shows the exact count for a 499-item group anchored on a real step", () => {
      const anchor = {
        ...command("cmd-anchor", "ls", "completed"),
        deferredWork: deferredWork(499),
      };
      const work = runWork(projection([run("completed")], [anchor]));

      expect(work.phase).toBe("settled");
      if (work.phase !== "settled") return;
      expect(work.steps).toHaveLength(1);
      expect(work.deferredCount).toBe(498);
      expect(work.summary.count).toBe(499);
    });

    it("drops the empty reasoning the server reports among 499 items", () => {
      const anchor = {
        ...command("cmd-anchor", "ls", "completed"),
        deferredWork: { ...deferredWork(499), emptyItemCount: 120 },
      };
      const work = runWork(projection([run("completed")], [anchor]));

      expect(work.phase).toBe("settled");
      if (work.phase !== "settled") return;
      expect(work.steps).toHaveLength(1);
      expect(work.deferredCount).toBe(378);
      expect(work.summary.count).toBe(379);
    });

    it("counts every omitted row when an older server leaves the field out", () => {
      const anchor = {
        ...command("cmd-anchor", "ls", "completed"),
        deferredWork: deferredWork(499),
      };
      const work = runWork(projection([run("completed")], [anchor]));

      expect(work.phase).toBe("settled");
      if (work.phase !== "settled") return;
      expect(work.deferredCount).toBe(498);
    });

    it("does not count an empty anchor as a step or as an omitted row", () => {
      const anchor = {
        ...reasoning("think-anchor", "", "completed"),
        deferredWork: deferredWork(499),
      };
      const work = runWork(projection([run("completed")], [anchor]));

      expect(work.phase).toBe("settled");
      if (work.phase !== "settled") return;
      expect(work.steps).toHaveLength(0);
      expect(work.deferredCount).toBe(498);
      expect(work.summary.count).toBe(498);
    });
  });

  describe("groupRunWork", () => {
    const member = (status: OrchestrationV2Run["status"], items: OrchestrationV2TurnItem[]) =>
      projection([run(status)], items);

    it("shows the speaking member's work while the round is live", () => {
      const work = groupRunWork({
        roundLive: true,
        memberProjection: member("running", [
          command("cmd-1", "pnpm test", "completed"),
          command("cmd-2", "git status", "running"),
        ]),
      });

      expect(work.phase).toBe("working");
      if (work.phase !== "working") return;
      expect(work.current).toMatchObject({ label: "git status" });
    });

    it("shows nothing before the member thread has loaded", () => {
      expect(groupRunWork({ roundLive: true, memberProjection: null }).phase).toBe("idle");
    });

    it("shows nothing when the round is not live", () => {
      const work = groupRunWork({
        roundLive: false,
        memberProjection: member("running", [command("cmd-1", "ls", "running")]),
      });

      expect(work.phase).toBe("idle");
    });

    it("hides the member's previous turn while the next one is queued", () => {
      const work = groupRunWork({
        roundLive: true,
        memberProjection: member("completed", [command("cmd-1", "ls", "completed")]),
      });

      expect(work.phase).toBe("idle");
    });
  });
});
