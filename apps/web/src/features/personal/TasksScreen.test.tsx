import type { ReactNode } from "react";

import { PersonalTask } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
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

const { feed, loadHistory, bulk } = vi.hoisted(() => ({
  feed: { current: new Map<string, unknown>() },
  loadHistory: vi.fn(),
  bulk: {
    routines: [] as Array<Record<string, unknown>>,
    calls: [] as Array<{ readonly action: string; readonly ids: ReadonlyArray<string> }>,
    outcome: null as unknown,
  },
}));

const settle = (action: string, ids: ReadonlyArray<string>) => {
  bulk.calls.push({ action, ids });
  return (
    bulk.outcome ?? {
      status: "settled",
      notice: `${action} ${ids.length} routines.`,
      doneIds: ids,
      failedIds: [],
      anyFailed: false,
    }
  );
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => loadHistory }));
vi.mock("./usePersonalAutomation", () => ({
  personalTaskHistory: {},
  usePersonalTasks: () => ({ tasks: feed.current, error: null }),
  usePersonalRoutines: () => ({ data: { routines: bulk.routines }, error: null }),
}));
vi.mock("./useBulkDelete", () => ({
  ROUTINE_NOUN: { one: "routine", many: "routines" },
  useBulkDeleteRoutines: () => async (ids: ReadonlyArray<string>) => settle("Deleted", ids),
  useBulkSetRoutinesEnabled: () => async (ids: ReadonlyArray<string>, enabled: boolean) =>
    settle(enabled ? "Resumed" : "Paused", ids),
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuTrigger: () => null,
  MenuPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button type="button" data-menu-item onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("./routineHook", () => ({
  routineTriggerStatusLabel: (routine: { enabled: boolean }) =>
    routine.enabled ? "Next run soon" : "Paused",
}));
vi.mock("@t3tools/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/contracts")>()),
  describePersonalRoutineTrigger: () => "Every day at 09:00",
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

describe("TasksScreen routine select mode", () => {
  const routine = (routineId: string, title: string, enabled: boolean) => ({
    routineId,
    botId: "bot-assistant",
    title,
    enabled,
  });
  const headerTitle = () => renderer!.root.findByType("h1").props.children;
  const checkbox = (name: string) =>
    renderer!.root
      .findAllByProps({ role: "checkbox" })
      .find((node) => node.findAll((child) => child.children.includes(name)).length > 0)!;
  const button = (text: string) =>
    renderer!.root.findAll((node) => node.type === "button" && node.props.children === text)[0]!;
  const click = async (node: ReactTestInstance) => {
    await act(async () => {
      await (node.props.onClick as () => unknown)();
    });
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      }),
    );
    bulk.routines = [
      routine("r-news", "Morning news", true),
      routine("r-backup", "Nightly backup", false),
      routine("r-gym", "Gym reminder", true),
    ];
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    bulk.calls = [];
    bulk.outcome = null;
    bulk.routines = [];
    vi.unstubAllGlobals();
  });

  async function enterSelectMode() {
    await act(async () => {
      renderer = create(<TasksScreen view="scheduled" />);
    });
    await click(button("Select routines"));
  }

  it("is only offered on Scheduled", async () => {
    await act(async () => {
      renderer = create(<TasksScreen view="completed" />);
    });
    expect(
      renderer!.root.findAll(
        (node) => node.type === "button" && node.props.children === "Select routines",
      ),
    ).toHaveLength(0);
  });

  it("pauses only the running picks, resumes only the paused ones", async () => {
    await enterSelectMode();
    expect(headerTitle()).toBe("Select routines");
    expect(button("Pause").props.disabled).toBe(true);
    expect(button("Resume").props.disabled).toBe(true);

    await click(button("Select all"));
    expect(headerTitle()).toBe("3 selected");
    await click(button("Pause"));
    expect(bulk.calls).toEqual([{ action: "Paused", ids: ["r-news", "r-gym"] }]);
    expect(headerTitle()).toBe("Tasks");
    expect(renderer!.root.findByProps({ role: "status" }).props.children).toBe(
      "Paused 2 routines.",
    );

    await click(button("Select routines"));
    await click(checkbox("Nightly backup"));
    await click(checkbox("Morning news"));
    await click(button("Resume"));
    expect(bulk.calls.at(-1)).toEqual({ action: "Resumed", ids: ["r-backup"] });
  });

  it("deletes the pick, keeping refused routines selected", async () => {
    bulk.outcome = {
      status: "settled",
      notice: "Deleted 1 routine. 1 routine couldn't be deleted: Routine not found.",
      doneIds: ["r-news"],
      failedIds: ["r-gym"],
      anyFailed: true,
    };
    await enterSelectMode();
    await click(checkbox("Morning news"));
    await click(checkbox("Gym reminder"));
    await click(button("Delete"));

    expect(bulk.calls).toEqual([{ action: "Deleted", ids: ["r-news", "r-gym"] }]);
    expect(renderer!.root.findByProps({ role: "alert" }).props.children).toContain(
      "couldn't be deleted",
    );
    expect(headerTitle()).toBe("1 selected");
    expect(checkbox("Gym reminder").props["aria-checked"]).toBe(true);
  });

  it("leaves select mode on Cancel and on Escape", async () => {
    await enterSelectMode();
    await click(button("Cancel"));
    expect(headerTitle()).toBe("Tasks");
    await click(button("Select routines"));
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    });
    expect(headerTitle()).toBe("Tasks");
  });
});
