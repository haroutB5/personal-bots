import {
  EnvironmentId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { toChatThread } from "./chatThread.ts";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const instanceId = ProviderInstanceId.make("codex");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const t0 = at("2026-06-20T00:00:00.000Z");
const t1 = at("2026-06-20T00:00:01.000Z");
const t2 = at("2026-06-20T00:00:02.000Z");

function run(
  id: string,
  status: OrchestrationV2Run["status"],
  ordinal: number,
): OrchestrationV2Run {
  return {
    id: RunId.make(id),
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId: MessageId.make(`user-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: t0,
    startedAt: t1,
    completedAt: status === "running" ? null : t2,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function message(
  id: string,
  role: OrchestrationV2ConversationMessage["role"],
  runId: string | null,
): OrchestrationV2ConversationMessage {
  return {
    createdBy: "user",
    creationSource: "web",
    id: MessageId.make(id),
    threadId,
    runId: runId === null ? null : RunId.make(runId),
    nodeId: null,
    role,
    text: `${role} says hi`,
    attachments: [],
    streaming: false,
    createdAt: t1,
    updatedAt: t2,
  };
}

const itemBase = {
  threadId,
  runId: RunId.make("run-2"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  title: null,
  startedAt: t1,
  completedAt: null,
  updatedAt: t2,
} as const;

const approval: OrchestrationV2TurnItem = {
  ...itemBase,
  id: TurnItemId.make("item-approval"),
  ordinal: 2,
  status: "running",
  type: "approval_request",
  requestId: RuntimeRequestId.make("request-1"),
  requestKind: "command",
};

const command: OrchestrationV2TurnItem = {
  ...itemBase,
  id: TurnItemId.make("item-command"),
  ordinal: 3,
  status: "failed",
  title: "Run tests",
  type: "command_execution",
  input: "npm test",
};

const assistantItem: OrchestrationV2TurnItem = {
  ...itemBase,
  id: TurnItemId.make("item-assistant"),
  ordinal: 1,
  status: "completed",
  type: "assistant_message",
  messageId: MessageId.make("assistant-1"),
  text: "assistant says hi",
  streaming: false,
};

function projection(
  overrides: Partial<OrchestrationV2ThreadProjection> = {},
): OrchestrationV2ThreadProjection {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Plan the trip",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: t0,
      updatedAt: t2,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: t2,
    ...overrides,
  };
}

const visible = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  items.map((item, position) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  }));

describe("toChatThread", () => {
  it("keeps the thread fields and has no session before the first run", () => {
    const chat = toChatThread(environmentId, projection());

    expect(chat).toMatchObject({
      environmentId,
      id: threadId,
      title: "Plan the trip",
      branch: "main",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:02.000Z",
      archivedAt: null,
      messages: [],
      activities: [],
      proposedPlans: [],
    });
    expect(chat.session).toBeNull();
    expect(chat.latestTurn).toBeNull();
  });

  it("maps messages with their run as the turn and ISO dates", () => {
    const chat = toChatThread(
      environmentId,
      projection({
        messages: [message("user-1", "user", null), message("a-1", "assistant", "run-1")],
      }),
    );

    expect(chat.messages).toEqual([
      {
        id: "user-1",
        role: "user",
        text: "user says hi",
        attachments: [],
        context: undefined,
        turnId: null,
        streaming: false,
        createdAt: "2026-06-20T00:00:01.000Z",
        updatedAt: "2026-06-20T00:00:02.000Z",
      },
      {
        id: "a-1",
        role: "assistant",
        text: "assistant says hi",
        attachments: [],
        context: undefined,
        turnId: "run-1",
        streaming: false,
        createdAt: "2026-06-20T00:00:01.000Z",
        updatedAt: "2026-06-20T00:00:02.000Z",
      },
    ]);
  });

  it("turns non-message items into activities with approval, error and tool tones", () => {
    const chat = toChatThread(
      environmentId,
      projection({ visibleTurnItems: visible([assistantItem, approval, command]) }),
    );

    expect(
      chat.activities.map(({ id, tone, kind, summary, turnId, sequence }) => ({
        id,
        tone,
        kind,
        summary,
        turnId,
        sequence,
      })),
    ).toEqual([
      {
        id: "item-approval",
        tone: "approval",
        kind: "approval_request",
        summary: "Approval Request",
        turnId: "run-2",
        sequence: 2,
      },
      {
        id: "item-command",
        tone: "error",
        kind: "command_execution",
        summary: "Run tests",
        turnId: "run-2",
        sequence: 3,
      },
    ]);
  });

  it("keeps proposed plans and drops todo lists", () => {
    const planBase = {
      threadId,
      runId: RunId.make("run-1"),
      nodeId: NodeId.make("node-1"),
      status: "completed" as const,
    };
    const chat = toChatThread(
      environmentId,
      projection({
        plans: [
          { ...planBase, id: PlanId.make("plan-1"), kind: "proposed_plan", markdown: "# Go" },
          { ...planBase, id: PlanId.make("todo-1"), kind: "todo_list", steps: [] },
        ],
      }),
    );

    expect(chat.proposedPlans).toEqual([
      {
        id: "plan-1",
        turnId: "run-1",
        planMarkdown: "# Go",
        implementedAt: "2026-06-20T00:00:02.000Z",
        implementationThreadId: null,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:02.000Z",
      },
    ]);
  });

  it("reads the latest turn and session from the last run", () => {
    const chat = toChatThread(
      environmentId,
      projection({
        runs: [run("run-1", "completed", 1), run("run-2", "running", 2)],
        messages: [message("a-1", "assistant", "run-1"), message("u-2", "user", "run-2")],
      }),
    );

    expect(chat.latestTurn).toEqual({
      turnId: "run-2",
      state: "running",
      requestedAt: "2026-06-20T00:00:00.000Z",
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: "a-1",
    });
    expect(chat.session).toEqual({
      threadId,
      status: "running",
      providerName: null,
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: "run-2",
      lastError: null,
      updatedAt: "2026-06-20T00:00:01.000Z",
    });
  });

  it("reports a failed last run as an error turn and session", () => {
    const chat = toChatThread(
      environmentId,
      projection({ runs: [run("run-1", "completed", 1), run("run-2", "failed", 2)] }),
    );

    expect(chat.latestTurn?.state).toBe("error");
    expect(chat.latestTurn?.completedAt).toBe("2026-06-20T00:00:02.000Z");
    expect(chat.session).toMatchObject({
      status: "error",
      activeTurnId: null,
      lastError: "The last turn failed.",
      updatedAt: "2026-06-20T00:00:02.000Z",
    });
  });
});
