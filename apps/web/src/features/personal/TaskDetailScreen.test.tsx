import type { ReactNode } from "react";

import { PersonalTask, PersonalTaskId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TaskDetailScreen } from "./TaskDetailScreen";

const decodeTask = Schema.decodeUnknownSync(PersonalTask);
const task = (overrides: Record<string, unknown>) =>
  decodeTask({
    taskId: "task-1",
    rootTaskId: "task-1",
    parentTaskId: null,
    botId: "bot-assistant",
    threadId: null,
    title: "Ship it",
    objective: "",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "completed",
    source: "user",
    idempotencyKey: "key-task-1",
    depth: 0,
    maxDepth: 2,
    maxChildren: 4,
    result: null,
    errorCategory: null,
    errorMessage: null,
    availableAt: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T01:00:00.000Z",
    startedAt: null,
    completedAt: "2026-09-20T01:00:00.000Z",
    ...overrides,
  });

const { state } = vi.hoisted(() => ({
  state: {
    feed: new Map<string, unknown>(),
    detail: null as unknown,
    related: null as unknown,
    relatedInputs: [] as Array<unknown>,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/components/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <p data-markdown="">{text}</p>,
}));
vi.mock("~/components/chat/MessagesTimeline.logic", () => ({
  shouldPreserveAssistantLineBreaks: () => false,
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: async () => true }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => ({}) }));
vi.mock("./usePersonalAutomation", () => ({
  personalTaskCancel: {},
  personalTaskRetry: {},
  usePersonalTasks: () => ({ tasks: state.feed, error: null }),
  usePersonalTaskDetail: () => ({
    data: state.detail,
    isPending: false,
    refresh: () => undefined,
  }),
  usePersonalRelatedTasks: (_environmentId: unknown, input: unknown) => {
    state.relatedInputs.push(input);
    return state.related;
  },
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({ data: { bots: [] } }),
}));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => null }));

let renderer: ReactTestRenderer | undefined;

const markdown = () =>
  renderer!.root
    .findAll((node) => node.type === "p" && node.props["data-markdown"] === "")
    .map((node) => node.props.children as string);
const text = () => JSON.stringify(renderer!.toJSON());

describe("TaskDetailScreen", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.relatedInputs = [];
    state.related = null;
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("shows the full result from the detail, not the feed's preview", async () => {
    const preview = task({ result: { summary: "short…" }, detailOmitted: true });
    state.feed = new Map([[preview.taskId, preview]]);
    state.detail = {
      task: task({ result: { summary: "the whole result" } }),
      attempts: [],
      children: [],
      handoff: null,
    };

    await act(async () => {
      renderer = create(<TaskDetailScreen taskId={PersonalTaskId.make("task-1")} />);
    });

    expect(markdown()).toEqual(["the whole result"]);
  });

  it("shows the preview while the detail is older than the live task", async () => {
    const live = task({
      result: { summary: "fresh preview…" },
      detailOmitted: true,
      updatedAt: "2026-09-20T02:00:00.000Z",
    });
    state.feed = new Map([[live.taskId, live]]);
    state.detail = { task: task({ status: "running" }), attempts: [], children: [], handoff: null };

    await act(async () => {
      renderer = create(<TaskDetailScreen taskId={PersonalTaskId.make("task-1")} />);
    });

    expect(markdown()).toEqual(["fresh preview…"]);
  });

  it("finds an old task's parent and children outside the feed", async () => {
    const child = task({ parentTaskId: "task-0", rootTaskId: "task-0" });
    state.feed = new Map();
    state.detail = { task: child, attempts: [], children: [], handoff: null };
    state.related = [
      child,
      task({ taskId: "task-0", rootTaskId: "task-0", title: "The parent" }),
      task({
        taskId: "task-2",
        rootTaskId: "task-0",
        parentTaskId: "task-1",
        title: "A grandchild",
      }),
    ];

    await act(async () => {
      renderer = create(<TaskDetailScreen taskId={PersonalTaskId.make("task-1")} />);
    });

    expect(state.relatedInputs.at(-1)).toEqual({ taskIds: ["task-1", "task-0"] });
    expect(text()).toContain("The parent");
    expect(text()).toContain("A grandchild");
  });
});
