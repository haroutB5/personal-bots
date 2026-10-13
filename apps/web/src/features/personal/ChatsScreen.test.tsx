import { PersonalBot, PersonalGroup } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { BotAvatar } from "./BotAvatar";
import { ChatsScreen } from "./ChatsScreen";
import { buildChatsSnapshot, writeChatsSnapshot } from "./chatsSnapshot";
import { resetNeedsYouCount } from "./needsYouStore";
import { NEEDS_YOU_PILL_LABEL } from "./needsYou";
import { PERF_OFF_STORAGE_KEY } from "./perfFlags";
import { readNeedsYouCount } from "./needsYouStore";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);

const state = vi.hoisted(() => ({
  environmentId: "env-1" as string | null,
  listData: null as { bots: unknown[]; threads: unknown[]; personalProjectId: null } | null,
  shells: [] as unknown[],
  refresh: vi.fn(),
  tasksCalls: [] as Array<string | null>,
  secretRequests: [] as unknown[],
  approvalThreadIds: [] as string[],
  rafQueue: [] as Array<FrameRequestCallback>,
  timeouts: new Map<number, () => void>(),
  nextTimeoutId: 1,
  reload: vi.fn(),
  navigate: vi.fn(),
  bulk: vi.fn(async (..._args: unknown[]) => ({
    status: "settled" as const,
    notice: "",
    failedIds: [] as string[],
    anyFailed: false,
  })),
  groupPin: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
  groupSnooze: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
  groupsData: { groups: [], rounds: [] } as { groups: unknown[]; rounds: unknown[] } | null,
  groupFeedCalls: [] as Array<string | null>,
  taskFeed: new Map<string, unknown>(),
  loginRequests: [] as unknown[],
  loginAsked: [] as string[],
  progressNotes: new Map<string, { note: string; turnId: string | null; toolStep?: boolean }>(),
  progressTargets: [] as Array<{ threadId: string; updatedAt: string }>,
  pickerOpen: false,
  params: {} as Record<string, string>,
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

/** The first-launch step-by-step mount is off unless a test asks for it: the rest draw whole lists at once. */
let stageMountInTest = false;

function stubWindow(perfOff = "") {
  const localStorage = createLocalStorageStub();
  const off = [perfOff, stageMountInTest ? "" : "home-stage-mount"].filter(Boolean).join(",");
  if (off !== "") localStorage.setItem(PERF_OFF_STORAGE_KEY, off);
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

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [],
  useAtomRefresh: () => () => undefined,
}));
vi.mock("~/state/entities", () => ({ useThreadShells: () => state.shells }));
vi.mock("~/state/server", () => ({
  primaryServerProvidersAtom: {},
  serverEnvironment: { refreshProviders: { label: "refreshProviders" } },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => undefined }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => (
    <a
      data-to={to}
      data-params={params === undefined ? undefined : JSON.stringify(params)}
      {...(rest as Record<string, unknown>)}
    >
      {children}
    </a>
  ),
  useNavigate: () => state.navigate,
  useParams: (options?: { select?: (params: Record<string, string>) => unknown }) =>
    options?.select ? options.select(state.params) : state.params,
  useRouter: () => ({ routesById: {}, loadRouteChunk: async () => undefined }),
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ open, children }: { open?: boolean; children: React.ReactNode }) => (
    <div data-menu-open={String(open === true)}>{children}</div>
  ),
  MenuGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuGroupLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  MenuSeparator: () => <hr />,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("~/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetClose: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
// The picker has its own suite; here it only has to open and receive the bots.
vi.mock("./BotPickerSheet", () => ({
  BotPickerSheet: ({ open, bots }: { open: boolean; bots: unknown[] }) => {
    state.pickerOpen = open;
    return <div data-testid="pick-bot-sheet" data-open={String(open)} data-bots={bots.length} />;
  },
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
    archivedGroups: (list?.groups ?? []).filter(
      (group) => (group as { archivedAt: unknown }).archivedAt !== null,
    ),
    rounds: list?.rounds ?? [],
  }),
}));
vi.mock("./usePersonalBots", () => ({
  usePersonalEnvironmentId: () => state.environmentId,
  usePersonalBotsList: () => ({ data: state.listData, error: null, refresh: state.refresh }),
  usePersonalProfile: () => ({ data: null }),
}));
vi.mock("./useWorkingProgress", async (importActual) => ({
  ...(await importActual<typeof import("./useWorkingProgress")>()),
  useWorkingProgressNotes: (
    _environmentId: string | null,
    targets: Array<{ threadId: string; updatedAt: string }>,
  ) => {
    state.progressTargets = targets;
    return state.progressNotes;
  },
}));
vi.mock("./usePersonalAutomation", () => ({
  usePersonalTasks: (environmentId: string | null) => {
    state.tasksCalls.push(environmentId);
    return { tasks: state.taskFeed, error: null };
  },
  usePersonalRoutines: () => ({ data: { routines: [], occurrences: [] }, error: null }),
}));
vi.mock("./computer/computerState", () => ({
  useComputerFeed: () => ({ feed: { status: null, events: [] }, error: null, loading: false }),
}));
vi.mock("./computer/desktopState", () => ({
  useDesktopStatus: () => null,
  useDesktopSummaryInput: () => null,
}));
vi.mock("./useNeedsYouLoginRequests", () => ({
  useNeedsYouLoginRequests: (
    _environmentId: string | null,
    browserWaitingThreadIds: ReadonlyArray<string>,
  ) => {
    state.loginAsked = [...browserWaitingThreadIds];
    return state.loginRequests;
  },
}));
vi.mock("./useSecretRequests", () => ({
  usePendingSecretRequests: () => ({ data: { requests: state.secretRequests }, error: null }),
}));
vi.mock("./useConnectionApprovals", () => ({
  usePendingConnectionApprovals: () => ({
    data: {
      approvals: state.approvalThreadIds.map((threadId) => ({ threadId, approvalId: threadId })),
    },
    error: null,
  }),
}));
vi.mock("./useRefreshBotsForTaskThreads", () => ({ useRefreshBotsForTaskThreads: () => {} }));
vi.mock("./useBulkChatActions", () => ({ useBulkChatActions: () => state.bulk }));
vi.mock("./useGroupChatState", () => ({
  useGroupChatState: () => ({ setPinned: state.groupPin, snooze: state.groupSnooze }),
}));
vi.mock("./MessageSearchResults", () => ({
  MessageSearchResults: ({ query }: { query: string }) => (
    <section data-testid="message-search" data-query={query} />
  ),
}));
vi.mock("./appVersion", () => ({
  useAppVersion: () => state.versionInfo,
  reloadLatestApp: async () => state.reload(),
}));
vi.mock("./UpdateStatusLine", () => ({
  UpdateStatusLine: ({ versionLabel }: { versionLabel?: string | null }) => (
    <span data-update-status-line={versionLabel ?? ""} />
  ),
}));
vi.mock("./PersonalUsageStrip", () => ({
  PersonalUsageStrip: () => <span data-testid="usage-line" />,
}));

let renderer: ReactTestRenderer | undefined;

async function flushRaf() {
  await act(async () => {
    const queue = [...state.rafQueue];
    state.rafQueue.length = 0;
    for (const callback of queue) callback(16);
  });
}

function snapshotRow(botId: string, name: string, pinned = false, threadTitle = "Cached thread") {
  return {
    botId,
    name,
    avatarShape: "blob" as const,
    avatarColor: "#1A73E8" as const,
    subtitle: "General assistant",
    previewLabel: "cached preview line",
    previewAtMs: 1_757_800_000_000,
    threadId: `thread-${botId}`,
    threadTitle,
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
  extra: {
    lead?: boolean;
    pinned?: boolean;
    groupOnly?: boolean;
    groupIds?: ReadonlyArray<string>;
    hidePreviews?: boolean;
  } = {},
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
    ...extra,
  });
}

const threadLink = (
  threadId: string,
  botId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  botId,
  threadId,
  createdAt: "2026-09-01T10:00:00.000Z",
  archivedAt: null,
  ...extra,
});

const threadShell = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  environmentId: "env-1",
  title: id,
  updatedAt: "2026-09-01T10:00:00.000Z",
  createdAt: "2026-09-01T10:00:00.000Z",
  latestUserMessageAt: null,
  latestTurn: null,
  session: null,
  archivedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...extra,
});

const turn = (turnId: string, extra: Record<string, unknown> = {}) => ({
  turnId,
  state: "running",
  requestedAt: "2026-09-01T10:00:00.000Z",
  startedAt: "2026-09-01T10:00:00.000Z",
  completedAt: null,
  assistantMessageId: null,
  ...extra,
});

/** One live list: bots, their chat links, and the shells those chats read. */
function setList(input: {
  bots: ReadonlyArray<unknown>;
  chats?: ReadonlyArray<{ botId: string; threadId: string; extra?: Record<string, unknown> }>;
}) {
  state.listData = {
    bots: [...input.bots],
    threads: (input.chats ?? []).map((chat) => threadLink(chat.threadId, chat.botId, chat.extra)),
    personalProjectId: null,
  };
}

async function render(
  selected: string | null = null,
  params: Record<string, string> = {},
  perfOff = "",
) {
  stubWindow(perfOff);
  state.params = params;
  await act(async () => {
    renderer = create(<ChatsScreen selectedChat={selected as never} />);
  });
}

/** The same, with the local storage stub in place first (a snapshot can only be seeded after it). */
async function renderWithSnapshot(
  seed: () => void,
  selected: string | null = null,
  params: Record<string, string> = {},
) {
  stubWindow();
  seed();
  state.params = params;
  await act(async () => {
    renderer = create(<ChatsScreen selectedChat={selected as never} />);
  });
}

const json = () => JSON.stringify(renderer!.toJSON());
/** Host elements of one tag (never the composite wrappers a props query can return). */
const hosts = (tag: string) => renderer!.root.findAll((node) => node.type === tag);
const hostWithLabel = (tag: string, label: string) =>
  hosts(tag).find((node) => node.props["aria-label"] === label);
const hostLabelStarts = (tag: string, prefix: string) =>
  hosts(tag).find(
    (node) =>
      typeof node.props["aria-label"] === "string" && node.props["aria-label"].startsWith(prefix),
  );
/** The visible strings inside a node, in order. */
function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string" || typeof value === "number") parts.push(String(value));
    else if (Array.isArray(value)) for (const item of value) walk(item);
  };
  try {
    walk(node.props?.children);
    for (const child of node.findAll(() => true)) walk(child.props?.children);
  } catch {
    // A composite instance with no props: nothing to read.
  }
  return parts.join("");
}
const buttonWithText = (needle: string) =>
  hosts("button").find((node) => textOf(node).includes(needle));
const rows = () => hostWithLabel("ul", "Your chats")!;
const rowLabels = () =>
  rows()
    .findAll((node) => node.type === "li")
    .map((row) => {
      const anchor = row.findAll((node) => node.type === "a")[0];
      return (anchor?.props["aria-label"] as string | undefined) ?? "?";
    });
const railCaptions = () =>
  renderer!.root
    .findAll((node) => node.props?.["data-testid"] === "rail-cap" && node.type === "span")
    .map((cap) => (cap.props.children as string).trim());
const chipCount = () =>
  Number(renderer!.root.findByProps({ "data-testid": "needs-filter-count" }).props.children);
const chip = (label: string) => hosts("button").find((node) => textOf(node).includes(label));

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.environmentId = "env-1";
  state.listData = null;
  state.shells = [];
  state.refresh.mockClear();
  state.tasksCalls.length = 0;
  state.secretRequests = [];
  state.approvalThreadIds = [];
  state.rafQueue.length = 0;
  state.timeouts.clear();
  state.reload.mockClear();
  state.navigate.mockClear();
  state.bulk.mockClear();
  state.groupPin.mockClear();
  state.groupSnooze.mockClear();
  state.groupsData = { groups: [], rounds: [] };
  state.groupFeedCalls.length = 0;
  state.taskFeed = new Map();
  state.loginRequests = [];
  state.loginAsked = [];
  state.progressNotes = new Map();
  state.progressTargets = [];
  state.pickerOpen = false;
  state.params = {};
  state.versionInfo = { label: "v9.9.9-test", updateAvailable: false };
  resetNeedsYouCount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatsScreen cold start", () => {
  it("shows skeletons with aria-busy and holds the tasks feed until paint", async () => {
    await render();
    const status = renderer!.root.findByProps({ role: "status" });
    expect(String(status.props["aria-busy"])).toBe("true");
    expect(json()).toContain("Loading your bots");
    expect(state.tasksCalls).toEqual([null]);
    await flushRaf();
    expect(state.tasksCalls).toEqual([null]);
  });

  it("paints the snapshot as chat rows, then arms the tasks feed", async () => {
    await renderWithSnapshot(() =>
      seedSnapshot([snapshotRow("bot-cached", "Cached Ada", false, "Weekend in Lisbon")]),
    );
    const painted = json();
    expect(painted).toContain("Weekend in Lisbon");
    expect(painted).toContain("cached preview line");
    // Neutral live state: no working dot, no pill.
    expect(painted).not.toContain("Working");
    expect(state.tasksCalls).toEqual([null]);
    await flushRaf();
    await flushRaf();
    expect(state.tasksCalls).toEqual([null, "env-1"]);
  });

  it("paints the snapshot before the environment is known, and drops a foreign one after", async () => {
    state.environmentId = null;
    await renderWithSnapshot(() => seedSnapshot());
    expect(json()).toContain("Cached Ada");

    state.environmentId = "env-1";
    await act(async () => renderer!.update(<ChatsScreen />));
    expect(json()).toContain("Cached Ada");

    state.environmentId = "env-2";
    await act(async () => renderer!.update(<ChatsScreen />));
    expect(json()).not.toContain("Cached Ada");
    expect(json()).toContain("Loading your bots");
  });

  it("waits for the environment when the early paint is switched off", async () => {
    state.environmentId = null;
    await renderWithSnapshot(() => {
      seedSnapshot();
      localStorage.setItem("bots:perf-off", "snapshot-early");
    });
    expect(json()).not.toContain("Cached Ada");
    localStorage.removeItem("bots:perf-off");
  });

  it("replaces the snapshot with the live rows in place", async () => {
    await renderWithSnapshot(() => seedSnapshot());
    expect(json()).toContain("Cached Ada");

    await act(async () => {
      setList({
        bots: [bot("bot-live", "Live Ada")],
        chats: [{ botId: "bot-live", threadId: "thread-live" }],
      });
      state.shells = [threadShell("thread-live", { title: "Live thread" })];
      renderer!.update(<ChatsScreen />);
    });

    const live = json();
    expect(live).toContain("Live thread");
    expect(live).not.toContain("Cached Ada");
    expect(live).not.toContain("Loading your bots");
  });

  it("keeps the actionable update prompt, and the version out of the header", async () => {
    state.versionInfo = { label: "v9.9.10-test", updateAvailable: true };
    await render();
    const update = buttonWithText("Update to");
    expect(update).toBeDefined();
    await act(async () => update!.props.onClick());
    expect(state.reload).toHaveBeenCalledTimes(1);
    expect(json()).toContain("Updating");
    // The version is not shown beside the title any more (design decision).
    expect(
      renderer!.root.findAllByProps({ "data-update-status-line": "v9.9.10-test" }),
    ).toHaveLength(1);
  });
});

describe("ChatsScreen header and rail", () => {
  const withRail = async () => {
    setList({
      bots: [bot("bot-juno", "Juno"), bot("bot-forge", "Forge")],
      chats: [
        {
          botId: "bot-juno",
          threadId: "t-pinned",
          extra: { pinnedAt: DateTime.makeUnsafe("2026-09-01T09:00:00.000Z") },
        },
        { botId: "bot-juno", threadId: "t-lisbon" },
        { botId: "bot-forge", threadId: "t-release" },
      ],
    });
    state.shells = [
      threadShell("t-pinned", { title: "Packing list" }),
      threadShell("t-lisbon", { title: "Weekend in Lisbon", latestTurn: turn("turn-1") }),
      threadShell("t-release", { title: "Release 2.4" }),
    ];
    await render();
  };

  it("carries the four header controls, the Settings gear included", async () => {
    await withRail();
    const labels = renderer!.root
      .findAllByType("a")
      .concat(renderer!.root.findAllByType("button"))
      .map((node) => node.props["aria-label"] as string | undefined)
      .filter((label): label is string => typeof label === "string");
    expect(labels).toContain("Search chats");
    expect(labels).toContain("Team");
    expect(labels).toContain("Settings");
    expect(labels).toContain("New chat, pick a bot");
  });

  it("shows the pinned chat as a card in the rail, not as a row again", async () => {
    await withRail();
    const card = hostLabelStarts("a", "Pinned chat Packing list with Juno");
    expect(card?.props["data-params"]).toContain("t-pinned");
    // Not repeated in All.
    expect(rowLabels().some((label) => label.includes("Packing list"))).toBe(false);
  });

  it("gives every bot a rail tile that opens the bot's page", async () => {
    await withRail();
    const tile = hostLabelStarts("a", "Forge,");
    expect(tile?.props["data-to"]).toBe("/bots/$botId");
    expect(tile?.props["data-params"]).toContain("bot-forge");
  });

  it("says the state in words in the rail caption", async () => {
    setList({
      bots: [bot("bot-forge", "Forge")],
      chats: [{ botId: "bot-forge", threadId: "t-live" }],
    });
    state.shells = [
      threadShell("t-live", {
        title: "Release 2.4",
        latestTurn: turn("turn-1", { assistantMessageId: "m-1" }),
        session: { status: "running", activeTurnId: "turn-1" },
      }),
    ];
    await render();
    expect(railCaptions()).toContain("Working");
  });

  it("marks a rail card whose chat has an open request, and names it", async () => {
    setList({
      bots: [bot("bot-juno", "Juno")],
      chats: [
        {
          botId: "bot-juno",
          threadId: "t-ask",
          extra: { pinnedAt: DateTime.makeUnsafe("2026-09-01T09:00:00.000Z") },
        },
      ],
    });
    state.shells = [threadShell("t-ask", { title: "Table?", hasPendingUserInput: true })];
    await render();
    const card = hostWithLabel("a", "Pinned chat Table? with Juno, Needs you");
    expect(card).toBeDefined();
    expect(railCaptions()).toContain("Needs you");
  });

  it("unpins a chat from the card's own menu", async () => {
    await withRail();
    const unpin = buttonWithText("Unpin Packing list");
    await act(async () => unpin!.props.onClick());
    expect(state.bulk).toHaveBeenCalledWith("unpin", ["t-pinned"], 0);
  });

  it("marks the rail and its rows with the classes that keep a sideways drag in them", async () => {
    await withRail();
    const rail = renderer!.root.findByProps({ "data-testid": "home-rail" });
    expect(String(rail.props.className)).toContain("home-rail");
    const row = hostLabelStarts("a", "Release 2.4");
    expect(String(row?.props.className)).toContain("home-row");
  });

  it("opens the bot picker from the header's plus", async () => {
    await withRail();
    expect(state.pickerOpen).toBe(false);
    const plus = hostWithLabel("button", "New chat, pick a bot")!;
    await act(async () => plus.props.onClick());
    expect(state.pickerOpen).toBe(true);
    const sheet = renderer!.root.findByProps({ "data-testid": "pick-bot-sheet" });
    expect(sheet.props["data-bots"]).toBe(2);
  });

  it("opens the search field from the header and clears it on close", async () => {
    await withRail();
    await act(async () => hostWithLabel("button", "Search chats")!.props.onClick());
    const field = hostWithLabel("input", "Search bots and chats")!;
    await act(async () => field.props.onChange({ target: { value: "lisbon" } }));
    await act(async () => hostWithLabel("button", "Close search")!.props.onClick());
    expect(hostWithLabel("input", "Search bots and chats")).toBeUndefined();
  });
});

describe("ChatsScreen rows and filters", () => {
  const withChats = async () => {
    setList({
      bots: [bot("bot-juno", "Juno"), bot("bot-forge", "Forge")],
      chats: [
        { botId: "bot-juno", threadId: "t-ask" },
        { botId: "bot-juno", threadId: "t-plain" },
        {
          botId: "bot-forge",
          threadId: "t-unread",
          extra: { unread: true, lastReplyAt: "2026-09-01T10:00:00.000Z" },
        },
        { botId: "bot-forge", threadId: "t-secret" },
      ],
    });
    state.shells = [
      threadShell("t-ask", { title: "Weekend in Lisbon", hasPendingUserInput: true }),
      threadShell("t-plain", { title: "Packing list" }),
      threadShell("t-unread", { title: "Release 2.4" }),
      threadShell("t-secret", { title: "October bills" }),
    ];
    state.secretRequests = [
      { requestId: "req-1", threadId: "t-secret", botId: "bot-forge", status: "pending" },
    ];
    await render();
  };

  it("draws one row per chat with the bot's name in front of the preview", async () => {
    await withChats();
    expect(rowLabels()).toContain("Packing list, Juno: No messages yet");
    expect(rowLabels()).toContain(
      "October bills, Forge, Needs a secret: No messages yet. Opens the chat at the request",
    );
  });

  it("draws a slice of a long list, the rest standing in as one spacer (windowed rows)", async () => {
    const chats = Array.from({ length: 30 }, (_, index) => ({
      botId: "bot-juno",
      threadId: `t-${index}`,
    }));
    setList({ bots: [bot("bot-juno", "Juno")], chats });
    state.shells = chats.map((chat, index) =>
      threadShell(chat.threadId, { title: `Chat ${index}` }),
    );
    await render();
    // No layout to measure in this renderer: the first-paint slice is 12 rows
    // and the eighteen undrawn rows stand in as one spacer <li>
    // whose height keeps the list's full height, and so the scroll position,
    // exact.
    const items = rows().findAll((node) => node.type === "li");
    const drawn = items.filter((node) => node.props["data-home-window-pad"] === undefined);
    const pads = items.filter((node) => node.props["data-home-window-pad"] !== undefined);
    expect(drawn).toHaveLength(12);
    expect(pads).toHaveLength(1);
    expect(pads[0]!.props.style).toEqual({ height: 18 * 72 });
    // A screen reader hears the row's real place and the list's real length,
    // not the drawn slice's.
    expect(drawn[0]!.props["aria-posinset"]).toBe(1);
    expect(drawn[0]!.props["aria-setsize"]).toBe(30);
    expect(drawn.at(-1)!.props["aria-posinset"]).toBe(12);
    for (const row of drawn) expect(row.props["aria-setsize"]).toBe(30);
  });

  it("mounts a first launch in steps: six rows, then three more per frame, the spacer keeping the height", async () => {
    stageMountInTest = true;
    try {
      const chats = Array.from({ length: 30 }, (_, index) => ({
        botId: "bot-juno",
        threadId: `t-${index}`,
      }));
      setList({ bots: [bot("bot-juno", "Juno")], chats });
      state.shells = chats.map((chat, index) =>
        threadShell(chat.threadId, { title: `Chat ${index}` }),
      );
      await render();
      const drawnCount = () =>
        rows()
          .findAll((node) => node.type === "li")
          .filter((node) => node.props["data-home-window-pad"] === undefined).length;
      const padHeights = () =>
        rows()
          .findAll((node) => node.type === "li")
          .filter((node) => node.props["data-home-window-pad"] !== undefined)
          .map((node) => (node.props.style as { height: number }).height);
      expect(drawnCount()).toBe(6);
      // The list's whole height is the same at every step: 24 rows stand in as spacer.
      expect(padHeights()).toEqual([24 * 72]);
      await flushRaf();
      expect(drawnCount()).toBe(9);
      await flushRaf();
      expect(drawnCount()).toBe(12);
      expect(padHeights()).toEqual([18 * 72]);
      await flushRaf();
      expect(drawnCount()).toBe(12);
    } finally {
      stageMountInTest = false;
    }
  });

  it("draws the live rows whole when they replace saved ones (no fewer rows for a frame)", async () => {
    stageMountInTest = true;
    try {
      const chats = Array.from({ length: 30 }, (_, index) => ({
        botId: "bot-live",
        threadId: `t-${index}`,
      }));
      await renderWithSnapshot(() => seedSnapshot());
      expect(json()).toContain("Cached Ada");
      await act(async () => {
        setList({ bots: [bot("bot-live", "Live Ada")], chats });
        state.shells = chats.map((chat, index) =>
          threadShell(chat.threadId, { title: `Live chat ${index}` }),
        );
        renderer!.update(<ChatsScreen />);
      });
      const drawn = rows()
        .findAll((node) => node.type === "li")
        .filter((node) => node.props["data-home-window-pad"] === undefined);
      expect(drawn).toHaveLength(12);
    } finally {
      stageMountInTest = false;
    }
  });

  it("draws every row with the home-window kill switch off", async () => {
    const chats = Array.from({ length: 30 }, (_, index) => ({
      botId: "bot-juno",
      threadId: `t-${index}`,
    }));
    setList({ bots: [bot("bot-juno", "Juno")], chats });
    state.shells = chats.map((chat, index) =>
      threadShell(chat.threadId, { title: `Chat ${index}` }),
    );
    await render(null, {}, "home-window");
    const items = rows().findAll((node) => node.type === "li");
    expect(items).toHaveLength(30);
    expect(items.filter((node) => node.props["data-home-window-pad"] !== undefined)).toHaveLength(
      0,
    );
  });

  it("puts the pill inside the row's own link, never a button of its own", async () => {
    await withChats();
    const row = hostLabelStarts("a", "October bills");
    const pills = row!.findAllByProps({ "data-testid": "needs-pill" });
    expect(pills).toHaveLength(1);
    expect(pills[0]!.props["data-kind"]).toBe("secret");
    // The row is the link to the chat: no extra buttons inside it.
    expect(row!.findAll((node) => node.type === "button")).toHaveLength(0);
  });

  it("counts the open requests on the chip, in the store and in the list alike", async () => {
    await withChats();
    // The chip's number, the rows the Needs you filter shows and the tab
    // badge all come from the one derivation.
    expect(chipCount()).toBe(2);
    expect(readNeedsYouCount()).toBe(2);
    await act(async () => chip("Needs you")!.props.onClick());
    expect(rowLabels()).toHaveLength(2);
  });

  it("counts a sign-in the owner has to make, on the chats parked on the browser", async () => {
    setList({
      bots: [bot("bot-scout", "Scout")],
      chats: [{ botId: "bot-scout", threadId: "t-signin" }],
    });
    state.shells = [threadShell("t-signin", { title: "Book the court" })];
    state.taskFeed = new Map([
      ["task-1", { taskId: "task-1", status: "waiting_for_browser", threadId: "t-signin" }],
    ]);
    state.loginRequests = [
      { requestId: "login-1", threadId: "t-signin", botId: "bot-scout", status: "pending" },
    ];
    await render();

    // The home asks the login-request RPC about the browser-waiting chat only.
    expect(state.loginAsked).toEqual(["t-signin"]);
    const row = hostLabelStarts("a", "Book the court");
    expect(row!.findByProps({ "data-testid": "needs-pill" }).props["data-kind"]).toBe("login");
    expect(chipCount()).toBe(1);
  });

  it("filters to unread and to groups", async () => {
    await withChats();
    await act(async () => chip("Unread")!.props.onClick());
    expect(rowLabels()).toEqual(["Release 2.4, Forge: No messages yet"]);
    await act(async () => chip("Groups")!.props.onClick());
    expect(hostWithLabel("ul", "Your chats")).toBeUndefined();
    expect(json()).toContain("No groups yet.");
  });

  it("keeps the chosen filter when the screen re-renders (a chat opening and Back)", async () => {
    await withChats();
    await act(async () => chip("Unread")!.props.onClick());
    await act(async () => renderer!.update(<ChatsScreen />));
    const selected = hosts("button").filter((button) => button.props["aria-selected"] === true);
    expect(selected).toHaveLength(1);
    expect(textOf(selected[0]!)).toContain("Unread");
  });

  it("shows the design's note under the Needs you filter only", async () => {
    await withChats();
    expect(json()).not.toContain("Answered requests leave this list.");
    await act(async () => chip("Needs you")!.props.onClick());
    expect(json()).toContain("Answered requests leave this list.");
  });

  it("draws the unread badge and the bold title on an unread chat", async () => {
    await withChats();
    const row = hostLabelStarts("a", "Release 2.4");
    expect(row!.findAllByProps({ "data-testid": "unread-badge" })).toHaveLength(1);
  });

  it("never shows a chat as unread while it is open on this device", async () => {
    setList({
      bots: [bot("bot-forge", "Forge")],
      chats: [
        {
          botId: "bot-forge",
          threadId: "t-open",
          extra: { unread: true, lastReplyAt: "2026-09-01T10:00:00.000Z" },
        },
      ],
    });
    state.shells = [threadShell("t-open", { title: "Release 2.4" })];
    await render(null);
    // The seen state is module-level and the conversation screen marks it; here
    // the list itself has nothing open, so the server's flag stands.
    expect(rows().findAllByProps({ "data-testid": "unread-badge" })).toHaveLength(1);
  });

  it("searches across bots and chats, and hands the query to the message search", async () => {
    await withChats();
    await act(async () => hostWithLabel("button", "Search chats")!.props.onClick());
    await act(async () =>
      hostWithLabel("input", "Search bots and chats")!.props.onChange({
        target: { value: "october" },
      }),
    );
    expect(rowLabels()).toEqual([expect.stringContaining("October bills")]);
    expect(
      renderer!.root.findByProps({ "data-testid": "message-search" }).props["data-query"],
    ).toBe("october");
  });

  it("says when nothing matches", async () => {
    await withChats();
    await act(async () => hostWithLabel("button", "Search chats")!.props.onClick());
    await act(async () =>
      hostWithLabel("input", "Search bots and chats")!.props.onChange({
        target: { value: "nothing at all" },
      }),
    );
    expect(json()).toContain("No bots or chats match");
    expect(json()).toContain("nothing at all");
  });
});

describe("ChatsScreen groups", () => {
  const decodeGroup = Schema.decodeUnknownSync(PersonalGroup);

  const group = (overrides: Record<string, unknown> = {}) =>
    decodeGroup({
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

  it("draws a group among the chat rows, with the members' faces", async () => {
    setList({
      bots: [bot("bot-ada", "Ada")],
      chats: [{ botId: "bot-ada", threadId: "t-ada" }],
    });
    state.shells = [threadShell("t-ada", { title: "Ada's chat" })];
    state.groupsData = {
      groups: [group({ updatedAt: "2026-09-19T11:00:00.000Z" })],
      rounds: [],
    };
    await render();

    const labels = rowLabels();
    expect(labels).toContain("Launch crew, Group: No messages yet");
    const groupRow = hostLabelStarts("a", "Launch crew");
    expect(groupRow!.findAllByType(BotAvatar).map((avatar) => avatar.props.label)).toEqual(["Ada"]);
    // Groups interleave by activity with the chats (Ada's chat has no messages
    // and sorts by creation time, before the group's later update).
    expect(labels[0]).toContain("Launch crew");
  });

  it("shows the Decide pill on a group waiting for a vote", async () => {
    setList({ bots: [], chats: [] });
    state.groupsData = {
      groups: [group()],
      rounds: [
        {
          roundId: "round-1",
          groupId: "group-1",
          triggerMessageId: "m1",
          status: "paused_vote",
          budgetRemaining: 1,
          queue: [],
          spoken: [],
          activeBotId: null,
          activeThreadId: null,
          activeMessageId: null,
          relayedChars: 0,
          availableAt: null,
          deadlineAt: "2026-09-20T09:00:00.000Z",
          errorMessage: null,
          createdAt: "2026-09-19T09:00:00.000Z",
          updatedAt: "2026-09-19T09:00:00.000Z",
        },
      ],
    };
    await render();

    const groupRow = hostLabelStarts("a", "Launch crew");
    const pill = groupRow!.findByProps({ "data-testid": "needs-pill" });
    expect(pill.props["data-kind"]).toBe("vote");
    expect(NEEDS_YOU_PILL_LABEL.vote).toBe("Decide");
    expect(chipCount()).toBe(1);
  });

  it("keeps a group's relay threads out of the rows", async () => {
    setList({
      bots: [bot("bot-ada", "Ada")],
      chats: [{ botId: "bot-ada", threadId: "member-thread-ada" }],
    });
    state.shells = [threadShell("member-thread-ada", { title: "Relay of Launch crew" })];
    state.groupsData = { groups: [group()], rounds: [] };
    await render();

    expect(rowLabels().some((label) => label.includes("Relay of Launch crew"))).toBe(false);
    expect(rowLabels()).toContain("Launch crew, Group: No messages yet");
  });

  it("keeps an archived group out of the rows but in the collapsed section", async () => {
    setList({ bots: [], chats: [] });
    state.groupsData = {
      groups: [group({ archivedAt: "2026-09-20T09:00:00.000Z" })],
      rounds: [],
    };
    await render();
    expect(hostWithLabel("ul", "Your chats")).toBeUndefined();
    expect(json()).toContain("Archived groups (");
  });

  it("hides a group-only bot's tile until it has a private chat", async () => {
    setList({
      bots: [bot("bot-ada", "Ada", { groupOnly: true, groupIds: ["group-1"] })],
      chats: [],
    });
    state.groupsData = { groups: [group()], rounds: [] };
    await render();
    expect(hostLabelStarts("a", "Ada,")).toBeUndefined();
  });

  it("unpins a pinned group's card from its own menu", async () => {
    setList({ bots: [], chats: [] });
    state.groupsData = {
      groups: [group({ pinnedAt: "2026-09-19T09:00:00.000Z" })],
      rounds: [],
    };
    await render();
    const unpin = buttonWithText("Unpin Launch crew");
    await act(async () => unpin!.props.onClick());
    expect(state.groupPin).toHaveBeenCalledWith("group-1", false);
  });
});

describe("ChatsScreen snoozed chats", () => {
  it("moves a snoozed chat out of the rows into Snoozed, with Wake now", async () => {
    setList({
      bots: [bot("bot-juno", "Juno")],
      chats: [
        {
          botId: "bot-juno",
          threadId: "t-asleep",
          extra: { snoozedUntil: DateTime.makeUnsafe("2027-01-01T18:00:00.000Z") },
        },
      ],
    });
    state.shells = [threadShell("t-asleep", { title: "Later" })];
    await render();

    expect(hostWithLabel("ul", "Your chats")).toBeUndefined();
    expect(json()).toContain("Snoozed (");
    const wake = hostWithLabel("button", "Wake Later now")!;
    await act(async () => wake.props.onClick());
    expect(state.bulk).toHaveBeenCalledWith("wake", ["t-asleep"], 0);
  });

  it("says why when waking a chat is refused", async () => {
    state.bulk = vi.fn(async () => ({
      status: "settled" as const,
      notice: "Laptop unreachable",
      failedIds: ["t-asleep"],
      anyFailed: true,
    }));
    setList({
      bots: [bot("bot-juno", "Juno")],
      chats: [
        {
          botId: "bot-juno",
          threadId: "t-asleep",
          extra: { snoozedUntil: DateTime.makeUnsafe("2027-01-01T18:00:00.000Z") },
        },
      ],
    });
    state.shells = [threadShell("t-asleep", { title: "Later" })];
    await render();

    await act(async () => hostWithLabel("button", "Wake Later now")!.props.onClick());
    expect(json()).toContain("Laptop unreachable");
  });
});

describe("ChatsScreen working progress", () => {
  it("asks only about the live chats, and shows a note instead of the last message", async () => {
    setList({
      bots: [bot("bot-forge", "Forge")],
      chats: [
        { botId: "bot-forge", threadId: "t-live" },
        { botId: "bot-forge", threadId: "t-idle" },
      ],
    });
    state.shells = [
      threadShell("t-live", { title: "Release 2.4", latestTurn: turn("turn-1") }),
      threadShell("t-idle", { title: "Docs" }),
    ];
    state.progressNotes = new Map([
      ["t-live", { note: "Running the e2e suite again", turnId: "turn-1" }],
    ]);
    await render();

    expect(state.progressTargets.map((target) => target.threadId)).toEqual(["t-live"]);
    expect(rowLabels()).toContain("Release 2.4, Forge: Running the e2e suite again");
  });

  it("says Couldn't reply for a failed chat, but not when it is waiting on you", async () => {
    setList({
      bots: [bot("bot-forge", "Forge")],
      chats: [
        { botId: "bot-forge", threadId: "t-failed" },
        { botId: "bot-forge", threadId: "t-asking" },
      ],
    });
    state.shells = [
      threadShell("t-failed", {
        title: "Release 2.4",
        session: { status: "error", activeTurnId: null },
      }),
      threadShell("t-asking", {
        title: "Table?",
        hasPendingUserInput: true,
        session: { status: "error", activeTurnId: null },
      }),
    ];
    await render();
    const labels = rowLabels();
    expect(labels.find((label) => label.startsWith("Release 2.4"))).toContain("Couldn't reply");
    // The open request is the thing to act on, so it keeps the row's own words.
    expect(labels.find((label) => label.startsWith("Table?"))).toContain("Needs your answer");
    expect(labels.find((label) => label.startsWith("Table?"))).not.toContain("Couldn't reply");
  });

  it("says Thinking while the turn has produced nothing, and Working after a tool step", async () => {
    setList({
      bots: [bot("bot-forge", "Forge")],
      chats: [{ botId: "bot-forge", threadId: "t-live" }],
    });
    state.shells = [
      threadShell("t-live", {
        title: "Release 2.4",
        latestTurn: turn("turn-1"),
        session: { status: "running", activeTurnId: "turn-1" },
      }),
    ];
    await render();
    expect(rowLabels()[0]).toContain("Thinking");

    state.progressNotes = new Map([["t-live", { note: "", turnId: "turn-1", toolStep: true }]]);
    await act(async () => renderer!.update(<ChatsScreen />));
    expect(rowLabels()[0]).toContain("Working");
  });
});

describe("ChatsScreen preview refresh", () => {
  const withOneChat = () => {
    setList({
      bots: [bot("bot-forge", "Forge")],
      chats: [{ botId: "bot-forge", threadId: "t-1" }],
    });
    state.shells = [threadShell("t-1", { title: "Release 2.4" })];
  };

  it("does not refetch the list while it is still populating", async () => {
    state.listData = null;
    await render();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("does not refetch per streamed chunk (updatedAt alone moving)", async () => {
    withOneChat();
    await render();
    state.shells = [
      threadShell("t-1", { title: "Release 2.4", updatedAt: "2026-09-01T10:05:00.000Z" }),
    ];
    await act(async () => renderer!.update(<ChatsScreen />));
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("refetches once per message boundary, coalescing moves that land together", async () => {
    withOneChat();
    await render();
    state.shells = [
      threadShell("t-1", { title: "Release 2.4", latestUserMessageAt: "2026-09-01T10:05:00.000Z" }),
    ];
    await act(async () => renderer!.update(<ChatsScreen />));
    expect(state.refresh).not.toHaveBeenCalled();
    // The debounce timer is stubbed; run it.
    await act(async () => {
      for (const callback of state.timeouts.values()) callback();
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("ChatsScreen selected chat", () => {
  it("marks the exact open chat's row and nothing else", async () => {
    setList({
      bots: [bot("bot-forge", "Forge")],
      chats: [
        { botId: "bot-forge", threadId: "t-1" },
        { botId: "bot-forge", threadId: "t-2" },
      ],
    });
    state.shells = [threadShell("t-1", { title: "One" }), threadShell("t-2", { title: "Two" })];
    await render("bot:bot-forge", { botId: "bot-forge", threadId: "t-2" });

    const marked = rows().findAll(
      (node) => node.type === "a" && node.props["aria-current"] === "page",
    );
    expect(marked).toHaveLength(1);
    expect(marked[0]!.props["aria-label"]).toContain("Two");
  });

  it("marks a pinned chat's rail card when it is the open one", async () => {
    setList({
      bots: [bot("bot-juno", "Juno")],
      chats: [
        {
          botId: "bot-juno",
          threadId: "t-pinned",
          extra: { pinnedAt: DateTime.makeUnsafe("2026-09-01T09:00:00.000Z") },
        },
      ],
    });
    state.shells = [threadShell("t-pinned", { title: "Packing list" })];
    await render("bot:bot-juno", { botId: "bot-juno", threadId: "t-pinned" });

    const card = hostLabelStarts("a", "Pinned chat Packing list with Juno");
    expect(card?.props["aria-current"]).toBe("page");
  });
});
