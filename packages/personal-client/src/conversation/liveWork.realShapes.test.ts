// Real shapes from the dev statev2 DB (claudeAgent and opencode-v2 runs).
// Every string is synthetic. No row text copied. Copied from Verifier's fixture.
import { MessageId, ProviderInstanceId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { runWork } from "./liveWork.ts";

const threadId = ThreadId.make("thread-1");
const iid = ProviderInstanceId.make("claudeAgent");
const at = (s: string) => DateTime.makeUnsafe(s);
const t0 = at("2026-06-20T00:00:00.000Z");
const t1 = at("2026-06-20T00:00:10.000Z");
const t2 = at("2026-06-20T00:02:10.000Z");

const TERMINAL = ["completed", "failed", "interrupted", "cancelled", "rolled_back"];

const run = (status: string, ordinal = 1, extra: object = {}): any => ({
  id: RunId.make(`run-${ordinal}`),
  threadId,
  ordinal,
  providerInstanceId: iid,
  modelSelection: { instanceId: iid, model: "m" },
  providerThreadId: "pt",
  userMessageId: MessageId.make(`u${ordinal}`),
  rootNodeId: "root",
  activeAttemptId: "att",
  status,
  queuePosition: null,
  requestedAt: t0,
  startedAt: status === "queued" || status === "preparing" ? null : t1,
  completedAt: TERMINAL.includes(status) ? t2 : null,
  checkpointId: null,
  contextHandoffId: null,
  ...extra,
});

let n = 0;
const base = (runId = "run-1"): any => ({
  id: TurnItemId.make(`i${++n}`),
  threadId,
  runId: RunId.make(runId),
  nodeId: "node",
  providerThreadId: "pt",
  providerTurnId: "turn",
  nativeItemRef: { driver: "claudeAgent", nativeId: `n${n}`, strength: "strong" },
  parentItemId: null,
  ordinal: 1_000_000 + n,
  title: null,
  startedAt: t1,
  completedAt: t2,
  updatedAt: t2,
});
const reasoning = (text: string, status = "completed"): any => ({
  ...base(),
  type: "reasoning",
  title: "Thinking",
  text,
  streaming: status === "running",
  status,
});
const cmd = (input: string, status = "completed"): any => ({
  ...base(),
  type: "command_execution",
  input,
  status,
});
const tool = (toolName: string | null, status = "completed", title: string | null = null): any => ({
  ...base(),
  type: "dynamic_tool",
  toolName,
  title,
  input: { q: "x" },
  status,
});
const file = (fileName: string, status = "completed"): any => ({
  ...base(),
  type: "file_change",
  fileName,
  status,
});
const sub = (status = "running"): any => ({
  ...base(),
  type: "subagent",
  title: "Subagent task",
  subagentId: "s",
  origin: "provider",
  driver: "claudeAgent",
  providerInstanceId: "claudeAgent",
  childThreadId: "child",
  status,
});
const approval = (): any => ({
  ...base(),
  type: "user_input_request",
  title: "Question",
  requestId: "r",
  questions: [],
  status: "running",
});
const err = (): any => ({
  ...base(),
  type: "error",
  title: "Retrying",
  failure: { class: "x", message: "m", code: "c", retryable: true },
  retry: { attempt: 1, maxAttempts: null, retryDelayMs: 2000 },
  status: "completed",
});
const search = (): any => ({
  ...base(),
  type: "file_search",
  title: "Search",
  pattern: "x",
  status: "completed",
});
const web = (): any => ({
  ...base(),
  type: "web_search",
  patterns: ["x"],
  status: "completed",
});

function proj(runs: any[], items: any[]): any {
  return {
    thread: {},
    runs,
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: items,
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: items.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    })),
    updatedAt: t2,
  };
}

describe("real shapes", () => {
  it("handles every work item type and status without throwing", () => {
    const statuses = [
      "idle",
      "pending",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ];
    for (const rs of [
      "running",
      "waiting",
      "queued",
      "preparing",
      "starting",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "rolled_back",
    ]) {
      const items = statuses.flatMap((s) => [
        reasoning("Looking at it.", s),
        cmd("ls", s),
        tool("Read", s),
        file("/a/b/c.ts", s),
        sub(s),
      ]);
      const w = runWork(proj([run(rs)], items));
      if (
        w.phase === "settled" &&
        (rs === "interrupted" || rs === "cancelled" || rs === "rolled_back")
      ) {
        expect(w.steps.some((s) => s.status === "running" || s.status === "pending")).toBe(false);
      }
    }
  });

  it("waiting run keeps a live line and says it waits on background work", () => {
    const w: any = runWork(proj([run("waiting")], [cmd("pnpm test", "waiting")]));
    expect(w.phase).toBe("working");
    expect(w.waitingOnBackground).toBe(true);
    expect(w.current.status).toBe("running");
  });

  it("counts subagents, searches, errors and questions as steps", () => {
    const w: any = runWork(
      proj([run("running")], [sub("running"), search(), web(), err(), approval()]),
    );
    expect(w.phase).toBe("working");
    expect(w.steps.map((step: any) => step.label)).toEqual([
      "Subagent",
      "File search",
      "Web search",
      "Error",
      "User input request",
    ]);
  });

  it("humanises an mcp tool name", () => {
    const w: any = runWork(
      proj(
        [run("running")],
        [tool("mcp__t3-code__update_work_record", "running", "Update work record")],
      ),
    );
    expect(w.current.label).toBe("update work record");
  });

  it("drops the cd prefix from a command label", () => {
    const w: any = runWork(
      proj(
        [run("running")],
        [cmd("cd /home/user/some/very/long/project/path && git status --short", "running")],
      ),
    );
    expect(w.current.label).toBe("git status --short");
  });

  it("file_change shows only the basename", () => {
    const w: any = runWork(
      proj([run("running")], [file("/home/user/proj/src/deep/File.tsx", "running")]),
    );
    expect(w.current.label).toBe("File.tsx");
  });

  it("counts wire-collapsed deferred work in a reloaded long run", () => {
    const first: any = {
      ...reasoning("First thought."),
      deferredWork: { cursor: "c", itemCount: 221, lastOrdinal: 1_000_221 },
    };
    const w: any = runWork(proj([run("completed")], [first]));
    expect(w.phase).toBe("settled");
    expect(w.summary.count).toBe(221);
    expect(w.deferredCount).toBe(220);
  });

  it("keeps the settled summary while the next run is queued", () => {
    const items = [reasoning("Done thinking."), { ...cmd("ls"), runId: RunId.make("run-1") }];
    const w: any = runWork(proj([run("completed", 1), run("queued", 2)], items));
    expect(w.phase).toBe("settled");
    expect(w.runId).toBe("run-1");
    expect(w.summary.count).toBe(2);
  });

  it("follows the queued run when it starts", () => {
    const items = [reasoning("Done thinking."), { ...cmd("ls"), runId: RunId.make("run-1") }];
    const started = runWork(proj([run("completed", 1), run("running", 2)], items));
    expect(started.phase).toBe("working");
    expect(started.phase === "working" ? started.runId : null).toBe("run-2");
  });

  it("a failed run with all-completed steps still reports failure", () => {
    const w: any = runWork(proj([run("failed")], [cmd("ls")]));
    expect(w.summary.hasFailure).toBe(true);
  });

  it("settles a run with no work items", () => {
    const w: any = runWork(proj([run("completed")], []));
    expect(w.phase).toBe("settled");
    expect(w.summary.count).toBe(0);
  });
});
