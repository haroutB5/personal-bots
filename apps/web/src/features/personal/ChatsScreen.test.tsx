import { PersonalBot, PersonalGroup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { BotAvatar } from "./BotAvatar";
import { ChatsScreen } from "./ChatsScreen";
import { buildChatsSnapshot, writeChatsSnapshot } from "./chatsSnapshot";
import { SwipeToDelete } from "./SwipeToDelete";

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
  togglePin: vi.fn(),
  navigate: vi.fn(),
  groupsData: null as { groups: unknown[]; rounds: unknown[] } | null,
  groupFeedCalls: [] as Array<string | null>,
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
  useNavigate: () => state.navigate,
}));
// Base UI's menu needs a DOM; the list only cares that the two items exist.
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("./usePersonalGroups", () => ({
  usePersonalGroupsList: () => ({ data: state.groupsData, error: null, refresh: vi.fn() }),
  usePersonalGroupsFeed: (environmentId: string | null) => {
    state.groupFeedCalls.push(environmentId);
    return { feed: null, error: null };
  },
  mergePersonalGroups: (list: { groups: unknown[]; rounds: unknown[] } | null) => ({
    groups: (list?.groups ?? []).filter(
      (group) => (group as { archivedAt: unknown }).archivedAt === null,
    ),
    rounds: list?.rounds ?? [],
  }),
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
vi.mock("./useSecretRequests", () => ({
  usePendingSecretRequests: () => ({ data: null, error: null, refresh: () => {} }),
}));
vi.mock("./useRefreshBotsForTaskThreads", () => ({ useRefreshBotsForTaskThreads: () => {} }));
vi.mock("./useDeleteBot", () => ({ useDeleteBot: () => async () => state.deleteOutcome }));
vi.mock("./usePinBot", () => ({ useTogglePinBot: () => state.togglePin }));
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

function snapshotRow(botId: string, name: string, pinned = false) {
  return {
    botId,
    name,
    avatarShape: "blob" as const,
    avatarColor: "#1A73E8" as const,
    subtitle: "General assistant",
    previewLabel: "cached preview line",
    previewAtMs: 1_757_800_000_000,
    threadId: `thread-${botId}`,
    threadTitle: "Cached thread",
    pinned,
  };
}

function seedSnapshot(rows = [snapshotRow("bot-cached", "Cached Ada")]) {
  writeChatsSnapshot(
    "env-1",
    buildChatsSnapshot({ environmentId: "env-1", savedAtMs: 1_757_800_000_000, rows }),
  );
}

function bot(
  botId: string,
  name: string,
  team: { team?: "dev" | "assistant"; lead?: boolean; pinned?: boolean } = {},
) {
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
    ...team,
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
  state.togglePin.mockClear();
  state.tasksCalls.length = 0;
  state.rafQueue.length = 0;
  state.timeouts.clear();
  state.reload.mockClear();
  state.navigate.mockClear();
  state.groupsData = null;
  state.groupFeedCalls.length = 0;
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

  /**
   * The reported bug: "the pinned bots aren't showing when I first open the
   * app, they appear after a couple of sends". The snapshot carried no pin, so
   * the box only existed once `personalBots.list` landed.
   */
  it("paints the Pinned box from the snapshot alone, before the live list", async () => {
    stubWindow();
    seedSnapshot([
      snapshotRow("bot-cto", "Cached CTO", true),
      snapshotRow("bot-scout", "Cached Scout"),
    ]);
    await act(async () => {
      renderer = create(<ChatsScreen />);
    });

    // No live list yet — this is the cold paint.
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Loading your bots");
    const namesIn = (scope: ReactTestInstance) =>
      scope.findAllByType(BotAvatar).map((avatar) => avatar.props.label as string);
    const box = renderer!.root.findByProps({ "aria-label": "Pinned" });
    expect(namesIn(box)).toEqual(["Cached CTO"]);
    // And the unpinned bot is listed once, under the box, not duplicated in it.
    expect(namesIn(renderer!.root.findByProps({ "aria-label": "Your bots" }))).toEqual([
      "Cached Scout",
    ]);
  });

  it("leaves the box out when the snapshot has nothing pinned", async () => {
    stubWindow();
    seedSnapshot();
    await act(async () => {
      renderer = create(<ChatsScreen />);
    });

    expect(renderer!.root.findAllByProps({ "aria-label": "Pinned" })).toEqual([]);
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
 * The two heads sit in a Pinned box at the top so they are one tap away; the
 * rest of the roster keeps the list it always had. A pinned bot belongs to the
 * box only — listing it twice would make the short list longer, not shorter.
 */
describe("ChatsScreen pinned box", () => {
  async function renderBots(bots: ReturnType<typeof bot>[]) {
    stubWindow();
    state.listData = { bots, threads: [], personalProjectId: null };
    await act(async () => {
      renderer = create(<ChatsScreen />);
    });
  }

  const rowLabels = (scope: ReactTestInstance) =>
    scope.findAllByType(SwipeToDelete).map((row) => row.props.label as string);

  it("does not render the box at all when nothing is pinned", async () => {
    await renderBots([bot("bot-scout", "Scout")]);

    expect(renderer!.root.findAllByProps({ "aria-label": "Pinned" })).toEqual([]);
    expect(rowLabels(renderer!.root)).toEqual(["Delete Scout"]);
  });

  it("puts the leads in the box, CTO first, and lists every bot exactly once", async () => {
    await renderBots([
      bot("bot-assistant", "Assistant", { lead: true, pinned: true }),
      bot("bot-scout", "Scout"),
      bot("bot-cto", "CTO", { team: "dev", lead: true, pinned: true }),
    ]);

    const box = renderer!.root.findByProps({ "aria-label": "Pinned" });
    expect(rowLabels(box)).toEqual(["Delete CTO", "Delete Assistant"]);
    // Once in the whole screen each: the box does not duplicate the list.
    expect(rowLabels(renderer!.root).toSorted()).toEqual([
      "Delete Assistant",
      "Delete CTO",
      "Delete Scout",
    ]);
  });

  it("offers Pin on an unpinned row and Unpin on a pinned one", async () => {
    await renderBots([
      bot("bot-cto", "CTO", { team: "dev", lead: true, pinned: true }),
      bot("bot-scout", "Scout"),
    ]);

    const scout = renderer!.root.findByProps({ label: "Delete Scout" });
    const cto = renderer!.root.findByProps({ label: "Delete CTO" });
    expect(scout.props.secondaryAction.text).toBe("Pin");
    expect(cto.props.secondaryAction.text).toBe("Unpin");

    await act(async () => {
      await scout.props.secondaryAction.run();
    });
    expect(state.togglePin).toHaveBeenCalledTimes(1);
  });
});

/**
 * A group is a chat, not a new object: it belongs in the same list, sorted
 * against the bots by latest activity, and its members' own relay threads must
 * not show up as chats of those bots.
 */
describe("ChatsScreen groups", () => {
  const decodeGroup = Schema.decodeUnknownSync(PersonalGroup);

  function group(overrides: Record<string, unknown> = {}) {
    return decodeGroup({
      groupId: "group-1",
      name: "Launch crew",
      description: "",
      threadId: "group-thread-1",
      maxBotTurns: 6,
      members: [
        {
          groupId: "group-1",
          botId: "bot-ada",
          threadId: "member-thread-ada",
          role: "member",
          sortOrder: 0,
          deliveredSeq: 0,
          joinedAt: "2026-09-19T09:00:00.000Z",
          leftAt: null,
        },
      ],
      createdAt: "2026-09-19T09:00:00.000Z",
      updatedAt: "2026-09-19T09:00:00.000Z",
      archivedAt: null,
      ...overrides,
    });
  }

  async function render() {
    stubWindow();
    await act(async () => {
      renderer = create(<ChatsScreen />);
    });
  }

  it("renders a group row in the same list as the bots", async () => {
    state.listData = { bots: [bot("bot-ada", "Ada")], threads: [], personalProjectId: null };
    state.groupsData = { groups: [group()], rounds: [] };
    await render();

    // In the one list, not a section of its own.
    const list = renderer!.root.findByProps({ "aria-label": "Your chats" });
    const rows = list.findAllByProps({ "aria-label": "Launch crew, group chat" });
    expect(rows).toHaveLength(1);
    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain("Launch crew");
    // The subtitle names the members, so the row says who is in it without a tap.
    expect(json).toContain("Ada");
    // The cluster is the group's face: the member's own avatar, not a group icon.
    expect(rows[0]!.findAllByType(BotAvatar).map((avatar) => avatar.props.label)).toEqual(["Ada"]);
  });

  it("hides a group's member threads from that bot's own chats", async () => {
    state.listData = {
      bots: [bot("bot-ada", "Ada")],
      threads: [
        {
          botId: "bot-ada",
          threadId: "member-thread-ada",
          createdAt: "2026-09-19T09:00:00.000Z",
          archivedAt: null,
        },
      ],
      personalProjectId: null,
    };
    state.shells = [
      {
        id: "member-thread-ada",
        environmentId: "env-1",
        title: "Relay of Launch crew",
        updatedAt: "2026-09-19T09:05:00.000Z",
        archivedAt: null,
        latestTurn: null,
        session: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      },
    ];
    state.groupsData = { groups: [group()], rounds: [] };
    await render();

    // Without the filter the bot row would preview the group's relay thread.
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Relay of Launch crew");
  });

  it("holds the groups feed back until after the first paint, like the tasks feed", async () => {
    state.groupsData = { groups: [group()], rounds: [] };
    state.listData = { bots: [bot("bot-ada", "Ada")], threads: [], personalProjectId: null };
    await render();

    expect(state.groupFeedCalls).toEqual([null]);
    await flushRaf();
    await flushRaf();
    expect(state.groupFeedCalls.at(-1)).toBe("env-1");
  });

  it("keeps an archived group out of the list", async () => {
    state.listData = { bots: [bot("bot-ada", "Ada")], threads: [], personalProjectId: null };
    state.groupsData = {
      groups: [group({ archivedAt: "2026-09-19T10:00:00.000Z" })],
      rounds: [],
    };
    await render();

    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Launch crew");
  });

  it("offers both New bot and New group behind the one header button", async () => {
    state.listData = { bots: [bot("bot-ada", "Ada")], threads: [], personalProjectId: null };
    await render();

    const items = renderer!.root
      .findAllByType("button")
      .filter((button) => typeof button.props.children === "string");
    const labels = items.map((button) => button.props.children as string);
    expect(labels).toContain("New bot");
    expect(labels).toContain("New group");

    const newGroup = items.find((button) => button.props.children === "New group")!;
    await act(async () => newGroup.props.onClick());
    expect(state.navigate).toHaveBeenCalledWith({ to: "/bots/groups/new" });
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
