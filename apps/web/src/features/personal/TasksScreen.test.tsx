import type { ReactNode } from "react";

import { PersonalTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TasksScreen } from "./TasksScreen";

const decodeTask = Schema.decodeUnknownSync(PersonalTask);
const task = (taskId: string, createdAt: string) =>
  decodeTask({
    taskId,
    rootTaskId: taskId,
    parentTaskId: null,
    botId: "bot-assistant",
    threadId: null,
    title: `Task ${taskId}`,
    objective: "",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "completed",
    source: "user",
    idempotencyKey: `key-${taskId}`,
    depth: 0,
    maxDepth: 2,
    maxChildren: 4,
    result: null,
    errorCategory: null,
    errorMessage: null,
    availableAt: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: createdAt,
    detailOmitted: true,
  });

const { feed, loadHistory } = vi.hoisted(() => ({
  feed: { current: new Map<string, unknown>() },
  loadHistory: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => loadHistory }));
vi.mock("./usePersonalAutomation", () => ({
  personalTaskHistory: {},
  usePersonalTasks: () => ({ tasks: feed.current, error: null }),
  usePersonalRoutines: () => ({ data: { routines: [] }, error: null }),
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => "env-1",
  usePersonalBotsList: () => ({ data: { bots: [] } }),
}));
vi.mock("./useMinuteNow", () => ({ useMinuteNow: () => Date.parse("2026-09-25T00:00:00Z") }));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => null }));

let renderer: ReactTestRenderer | undefined;

const titles = () =>
  renderer!.root
    .findAll((node) => typeof node.props.children === "string")
    .map((node) => node.props.children as string)
    .filter((text) => text.startsWith("Task "));
const olderButton = () =>
  renderer!.root.findAll(
    (node) => node.type === "button" && node.props.children === "Show older tasks",
  );

describe("TasksScreen finished list", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    loadHistory.mockReset();
    vi.unstubAllGlobals();
  });

  it("shows the feed's recent tasks, then pages older ones in on request", async () => {
    const recent = task("recent", "2026-09-20T00:00:00.000Z");
    feed.current = new Map([[recent.taskId, recent]]);
    loadHistory
      .mockResolvedValueOnce({
        _tag: "Success",
        // The first page overlaps the feed; the overlap is shown once.
        value: { tasks: [recent, task("older", "2026-09-10T00:00:00.000Z")], hasMore: true },
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { tasks: [task("oldest", "2026-09-01T00:00:00.000Z")], hasMore: false },
      });

    await act(async () => {
      renderer = create(<TasksScreen view="completed" />);
    });
    expect(titles()).toEqual(["Task recent"]);

    await act(async () => olderButton()[0]!.props.onClick());
    expect(loadHistory).toHaveBeenLastCalledWith({ environmentId: "env-1", input: { limit: 30 } });
    expect(titles()).toEqual(["Task recent", "Task older"]);

    await act(async () => olderButton()[0]!.props.onClick());
    expect(loadHistory).toHaveBeenLastCalledWith({
      environmentId: "env-1",
      input: { limit: 30, before: "older" },
    });
    expect(titles()).toEqual(["Task recent", "Task older", "Task oldest"]);
    // Nothing more to load: the button goes away.
    expect(olderButton()).toHaveLength(0);
  });
});
