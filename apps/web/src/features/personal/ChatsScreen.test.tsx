import { PersonalBot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ChatsScreen } from "./ChatsScreen";
import { buildChatsSnapshot, writeChatsSnapshot } from "./chatsSnapshot";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);

const state = vi.hoisted(() => ({
  environmentId: "env-1" as string | null,
  listData: null as { bots: unknown[]; threads: unknown[]; personalProjectId: null } | null,
  shells: [] as unknown[],
  refresh: vi.fn(),
  tasksCalls: [] as Array<string | null>,
  deleteOutcome: { status: "done" } as
    | { readonly status: "done" }
    | { readonly status: "cancelled" }
    | { readonly status: "failed"; readonly message: string },
  rafQueue: [] as Array<FrameRequestCallback>,
  timeouts: new Map<number, () => void>(),
  nextTimeoutId: 1,
  reload: vi.fn(),
  versionInfo: { label: "v9.9.9-test", updateAvailable: false } as {
    label: string | null;
    updateAvailable: boolean;
  },
}));

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function stubWindow() {
  const localStorage = createLocalStorageStub();
  vi.stubGlobal("window", {
    localStorage,
    setInterval: () => 0,
    clearInterval: () => undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      state.rafQueue.push(callback);
      return state.rafQueue.length;
    },
    cancelAnimationFrame: () => undefined,
    setTimeout: (callback: () => void) => {
      const id = state.nextTimeoutId++;
      state.timeouts.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => {
      state.timeouts.delete(id);
    },
    location: { reload: state.reload },
  });
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
}

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/state/entities", () => ({ useThreadShells: () => state.shells }));
vi.mock("~/state/server", () => ({
  primaryServerProvidersAtom: {},
  serverEnvironment: { refreshProviders: { label: "refreshProviders" } },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => undefined }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => state.environmentId,
  usePersonalBotsList: () => ({ data: state.listData, error: null, refresh: state.refresh }),
  usePersonalProfile: () => ({ data: null }),
}));
vi.mock("./usePersonalAutomation", () => ({
  usePersonalTasks: (environmentId: string | null) => {
    state.tasksCalls.push(environmentId);
    return { tasks: null, error: null };
  },
  usePersonalRoutines: () => ({ data: { routines: [], occurrences: [] }, error: null }),
}));
vi.mock("./computer/computerState", () => ({
  useComputerFeed: () => ({
    feed: { status: null, events: [] },
    error: null,
    loading: false,
  }),
}));
vi.mock("./useRefreshBotsForTaskThreads", () => ({ useRefreshBotsForTaskThreads: () => {} }));
vi.mock("./useDeleteBot", () => ({ useDeleteBot: () => async () => state.deleteOutcome }));
vi.mock("./startBotChat", () => ({
  useStartBotChat: () => ({ start: vi.fn(), starting: false }),
}));
vi.mock("./appVersion", () => ({ useAppVersion: () => state.versionInfo }));

let renderer: ReactTestRenderer | undefined;

async function flushRaf() {
  await act(async () => {
    const queue = [...state.rafQueue];
    state.rafQueue.length = 0;
    for (const callback of queue) callback(16);
  });
}

function seedSnapshot() {
  writeChatsSnapshot(
    "env-1",
    buildChatsSnapshot({
      environmentId: "env-1",
      savedAtMs: 1_757_800_000_000,
      rows: [
        {
          botId: "bot-cached",
          name: "Cached Ada",
          avatarShape: "blob",
          avatarColor: "#1A73E8",
          subtitle: "General assistant",
          previewLabel: "cached preview line",
          previewAtMs: 1_757_800_000_000,
          threadId: "thread-cached",
          threadTitle: "Cached thread",
        },
      ],
    }),
  );
}

function bot(botId: string, name: string) {
  return decodeBot({
    botId,
    name,
    title: "",
    description: "",
    instructions: "",
    avatarShape: "pill",
    avatarColor: "#E8711A",
    modelSelection: { instanceId: "someRuntime", model: "some-model" },
    enabled: true,
    sortOrder: 0,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  });
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.environmentId = "env-1";
  state.listData = null;
  state.shells = [];
  state.refresh.mockClear();
  state.deleteOutcome = { status: "done" };
  state.tasksCalls.length = 0;
  state.rafQueue.length = 0;
  state.timeouts.clear();
  state.reload.mockClear();
  state.versionInfo = { label: "v9.9.9-test", updateAvailable: false };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatsScreen cold start", () => {
  it("shows skeletons with aria-busy and holds the tasks feed until paint", async () => {
    stubWindow();
    await act(async () => {
      renderer = create(<ChatsScreen />);
    });

    const status = renderer!.root.findByProps({ role: "status" });
    expect(String(status.props["aria-busy"])).toBe("true");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Loading your bots");
    // Subscription not armed: nothing scheduled, nothing subscribed.
    expect(state.tasksCalls).toEqual([null]);
    await flushRaf();
    expect(state.tasksCalls).toEqual([null]);
  });

  it("paints the snapshot instantly with neutral indicators, then arms tasks", async () => {
    stubWindow();
    seedSnapshot();
    await act(async () => {
      renderer = create(<ChatsScreen />);
    });

    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain("Cached Ada");
    expect(json).toContain("General assistant");
    expect(json).toContain("cached preview line");
    // Neutral live state: no working dot, no review row.
    expect(json).not.toContain("working");
    expect(json).not.toContain("needs your review");
    // Tasks feed held back on first paint…
    expect(state.tasksCalls).toEqual([null]);
    // …and armed after paint frames.
    await flushRaf();
    await flushRaf();
    expect(state.tasksCalls).toEqual([null, "env-1"]);
    // The running version sits small beside the Bots heading, always visible.
    expect(json).toContain("v9.9.9-test");
    // No provider data yet: the usage strip stays out of the layout entirely.
    expect(json).not.toContain("Open details");
  });

  it("keeps the actionable update prompt on the home screen", async () => {
    stubWindow();
    state.versionInfo = { label: "v9.9.10-test", updateAvailable: true };
    await act(async () => {
      renderer = create(<ChatsScreen />);
    });

    const update = renderer!.root
      .findAllByType("button")
      .find((button) => JSON.stringify(button.props.children).includes("Update to"));
    expect(update).toBeDefined();
    act(() => update!.props.onClick());
    expect(state.reload).toHaveBeenCalledTimes(1);
  });

  it("replaces the snapshot seamlessly when live data arrives", async () => {
    stubWindow();
    seedSnapshot();
    await act(async () => {
      renderer = create(<ChatsScreen />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Cached Ada");

    await act(async () => {
      state.listData = {
        bots: [bot("bot-live", "Live Ada")],
        threads: [],
        personalProjectId: null,
      };
      renderer!.update(<ChatsScreen />);
    });

    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain("Live Ada");
    expect(json).not.toContain("Cached Ada");
    expect(json).not.toContain("Loading your bots");
  });
});

describe("ChatsScreen delete failures", () => {
  async function renderWithOneBot() {
    stubWindow();
    state.listData = { bots: [bot("bot-live", "Live Ada")], threads: [], personalProjectId: null };
    await act(async () => {
      renderer = create(<ChatsScreen />);
    });
  }

  const swipeDelete = () => renderer!.root.findByProps({ label: "Delete Live Ada" }).props.onDelete;

  it("puts a refused delete on screen instead of only in the console", async () => {
    await renderWithOneBot();
    state.deleteOutcome = { status: "failed", message: "Laptop unreachable" };

    await act(async () => {
      await swipeDelete()();
    });

    // The swipe row just slides shut, so this alert is the only feedback that
    // the bot is still there.
    const alert = renderer!.root.findByProps({ role: "alert" });
    expect(JSON.stringify(alert.props.children)).toContain("Laptop unreachable");
  });

  it("says nothing when the delete succeeded or was cancelled", async () => {
    await renderWithOneBot();
    for (const outcome of [{ status: "done" } as const, { status: "cancelled" } as const]) {
      state.deleteOutcome = outcome;
      await act(async () => {
        await swipeDelete()();
      });
      expect(renderer!.root.findAllByProps({ role: "alert" })).toEqual([]);
    }
  });
});

/**
 * The preview-refresh effect exists to catch a message landing on a bot's
 * newest thread. Its key is built from the thread shells, which arrive after
 * the bot list, so seeding the baseline from the pre-data render made the
 * initial population look like a message arriving: every cold start fetched
 * `personalBots.list` twice (measured as two byte-identical 12,035 B
 * responses, 28 ms apart).
 */
describe("ChatsScreen preview refresh", () => {
  const link = (botId: string, threadId: string) => ({
    botId,
    threadId,
    createdAt: "2026-09-01T10:00:00.000Z",
    archivedAt: null,
  });
  const shell = (id: string, updatedAt: string) => ({
    id,
    environmentId: "env-1",
    title: `Thread ${id}`,
    updatedAt,
    archivedAt: null,
    latestTurn: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  });

  async function populate() {
    stubWindow();
    await act(async () => {
      renderer = create(<ChatsScreen />);
    });
    // The list lands first, then the thread shells.
    state.listData = {
      bots: [bot("bot-live", "Live Ada")],
      threads: [link("bot-live", "thread-1")],
      personalProjectId: null,
    };
    await act(async () => renderer!.update(<ChatsScreen />));
    state.shells = [shell("thread-1", "2026-09-01T10:00:00.000Z")];
    await act(async () => renderer!.update(<ChatsScreen />));
  }

  it("does not refetch the list while it is still populating", async () => {
    await populate();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("still refetches once a message bumps the newest thread", async () => {
    await populate();
    state.shells = [shell("thread-1", "2026-09-01T10:05:00.000Z")];
    await act(async () => renderer!.update(<ChatsScreen />));
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});
