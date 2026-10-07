import * as React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { clearPendingWrapup, pendingWrapupFor } from "./chatChipHandoff";
import { clearChipFreeze } from "./chatChipOrder";
import { ConversationScreen } from "./ConversationScreen";

type Outcome = { status: "done" } | { status: "cancelled" } | { status: "failed"; message: string };

const state = vi.hoisted(() => ({
  shell: null as null | { title: string; archivedAt: string | null },
  linkArchivedAt: null as string | null,
  thread: null as unknown,
  navigate: (() => {}) as (...args: unknown[]) => unknown,
  archive: (() => {}) as (...args: unknown[]) => unknown,
  otherCommand: (() => {}) as (...args: unknown[]) => unknown,
  deleteChat: (() => {}) as (...args: unknown[]) => unknown,
  prewarm: [] as boolean[],
  viewing: [] as boolean[],
  messageListProps: [] as Array<Record<string, unknown>>,
  composerRenders: 0,
  retry: (() => {}) as (...args: unknown[]) => unknown,
  sendWrapup: (() => {}) as (...args: unknown[]) => unknown,
  startNewChat: (() => {}) as (...args: unknown[]) => unknown,
  chipModel: null as null | {
    chips: Array<{ threadId: string; text: string; current: boolean }>;
    ownerChips: Array<{ threadId: string; text: string; current: boolean }>;
    temporary: null | { threadId: string; text: string; current: boolean };
    openCount: number;
    visible: boolean;
    turnsKey: string;
  },
  renamed: [] as Array<[string, string]>,
  bulk: (() => {}) as (...args: unknown[]) => unknown,
  linkPinned: false,
  /** A second chat of the bot (thread-2, "hbots"): its link and shell. */
  twoChats: false,
  otherPinned: false,
  otherWorking: false,
  otherUnread: false,
  otherSnoozedUntil: null as number | null,
  linkSnoozedUntil: null as number | null,
  settingsHolds: [] as Array<{ threadId: string; opener: unknown }>,
}));

const ARCHIVE_COMMAND = vi.hoisted(() => ({ name: "personalBotArchiveThread" }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to: _to,
    params: _params,
    activeOptions: _activeOptions,
    ...props
  }: Record<string, unknown> & { children: React.ReactNode }) => <a {...props}>{children}</a>,
  useNavigate: () => state.navigate,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
}));
vi.mock("@t3tools/client-runtime/pending-requests", () => ({
  derivePendingRequests: () => ({ approvals: [], userInputs: [] }),
  deriveUserInputHistory: () => [],
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: () => new Error("failed"),
}));
vi.mock("@t3tools/client-runtime/state/threads", () => ({
  requestOlderThreadTurns: () => {},
  threadHasOlderTurns: () => false,
}));
vi.mock("~/components/ChatView.logic", () => ({
  buildRunningThreadTurnInterruptInput: () => null,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({
    children,
    render,
  }: {
    children: React.ReactNode;
    render: React.ReactElement;
  }) => <div>{React.cloneElement(render, {}, children)}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" data-menu-item="" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  MenuSeparator: () => <hr />,
}));
vi.mock("~/lib/contextWindow", () => ({ deriveLatestContextWindowSnapshot: () => null }));
vi.mock("~/session-logic", () => ({
  derivePhase: () => "ready",
  deriveTimelineEntriesWithState: () => ({ entries: [] }),
  deriveWorkLogEntries: () => [],
}));
vi.mock("~/state/entities", () => ({
  useProject: () => null,
  useThreadDetail: () => state.thread,
  useThreadShell: () => state.shell,
  useThreadShells: () => {
    const shellOf = (id: string, title: string, archivedAt: string | null, extra = {}) => ({
      id,
      environmentId: "env-1",
      title,
      archivedAt,
      createdAt: "2026-10-01T10:00:00.000Z",
      latestUserMessageAt: null,
      latestTurn: null,
      session: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      ...extra,
    });
    return [
      shellOf("thread-1", state.shell?.title ?? "Plans", state.shell?.archivedAt ?? null),
      ...(state.twoChats
        ? [
            shellOf(
              "thread-2",
              "hbots",
              null,
              state.otherWorking ? { latestTurn: { state: "running" } } : {},
            ),
          ]
        : []),
    ];
  },
  useThreadStatus: () => "ready",
}));
vi.mock("~/state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    interruptTurn: {},
    respondToApproval: {},
    respondToUserInput: {},
    dismissUserInput: {},
  },
  useEnvironmentThread: () => ({ status: "ready" }),
  useRetryEnvironmentThread: () => () => undefined,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === ARCHIVE_COMMAND ? state.archive : state.otherCommand,
}));

vi.mock("./perfFlags", () => ({ perfOptimizationOn: () => false }));
vi.mock("./avatarMotion", () => ({ motionForConversationState: () => "idle" }));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => <span data-avatar="" /> }));
vi.mock("./AllChatsCount", () => ({ AllChatsCount: () => null }));
vi.mock("./ChatLoadProblem", () => ({ CHAT_PROBLEM_BUTTON: "", ChatLoadProblem: () => null }));
vi.mock("./threadLoadProblem", () => ({ threadLoadProblem: () => null }));
vi.mock("./BotMute", () => ({
  BotMuteMenuItems: () => null,
  useSetBotMute: () => () => undefined,
}));
vi.mock("./ConversationHeaderName", async (importOriginal) => ({
  conversationChatTitle: (await importOriginal<typeof import("./ConversationHeaderName")>())
    .conversationChatTitle,
  ConversationHeaderName: ({ name }: { name: string }) => <h1>{name}</h1>,
  ConversationHeaderLine: ({ name }: { name: string }) => <h1 data-header-line="">{name}</h1>,
}));
vi.mock("./usePersonalGroups", () => ({ usePersonalGroupRelayThreadIds: () => new Set() }));
vi.mock("./chatChipRows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chatChipRows")>()),
  buildChatChips: () => state.chipModel,
}));
vi.mock("./ChatChips", () => ({
  ChatChips: ({
    chips,
    openCount,
    onNewChat,
    onChipSettings,
  }: {
    chips: Array<{ threadId: string; text: string }>;
    openCount: number;
    onNewChat: () => void;
    onChipSettings: (threadId: string, opener: unknown) => void;
  }) => (
    <nav data-chips={openCount} data-order={chips.map((chip) => chip.threadId).join(",")}>
      {chips.map((chip) => (
        <span key={chip.threadId}>
          {chip.text}
          <button
            type="button"
            data-hold={chip.threadId}
            onClick={() => {
              state.settingsHolds.push({ threadId: chip.threadId, opener: "chip" });
              onChipSettings(chip.threadId, null);
            }}
          />
        </span>
      ))}
      <button type="button" onClick={onNewChat}>
        plus
      </button>
    </nav>
  ),
}));
vi.mock("./NewChatDialog", () => ({
  NewChatDialog: ({ open, onStart }: { open: boolean; onStart: (title: string) => void }) =>
    open ? (
      <button type="button" onClick={() => onStart("  Plan B  ")}>
        start named
      </button>
    ) : null,
}));
vi.mock("./ConversationSubtitle", () => ({ ConversationSubtitle: () => null }));
vi.mock("./botMuteModel", () => ({ botMuteState: () => ({ muted: false }) }));
vi.mock("./botSummaries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./botSummaries")>()),
  conversationHeaderStatus: () => null,
  resolveBotProvider: () => null,
  taskCardBotLine: () => null,
}));
vi.mock("./botModelLabel", () => ({
  botModelShortLabel: () => null,
  botActiveModelShortLabel: () => null,
  fallbackNoteLabel: () => null,
}));
vi.mock("./ConversationComputerLink", () => ({ ConversationComputerLink: () => null }));
vi.mock("./ConversationDesktopLine", () => ({ ConversationDesktopLine: () => null }));
vi.mock("./resumeLastChat", () => ({ useLeaveResumedChatIfGone: () => {} }));
vi.mock("./staleNotifications", () => ({ useCloseChatNotifications: () => {} }));
vi.mock("./computer/desktopState", () => ({ useDesktopStatus: () => null }));
vi.mock("./computer/computerState", () => ({
  useComputerFeed: () => ({ feed: { status: "idle" } }),
}));
vi.mock("./ConversationRoutinesPanel", () => ({
  ConversationRoutinesPanel: () => <div data-routines="" />,
}));
vi.mock("./ConversationSidePanel", () => ({
  CONVERSATION_SIDE_PANEL_ID: "side",
  ConversationSidePanel: () => null,
}));
vi.mock("./conversationModel", () => ({
  providerWaitState: () => null,
  buildConversationItems: () => [],
  contextBadgeLabel: () => null,
  conversationHeaderStateLabel: () => null,
  deriveConversationState: () => "idle",
  friendlyTurnError: (message: string) => ({ message }),
  isTurnThinking: () => false,
  placeDelegationCards: (items: unknown) => items,
  placeQuestionCards: (items: unknown) => items,
  placeSecretRequestCards: (items: unknown) => items,
  placeLoginRequestCards: (items: unknown) => items,
  placeConnectionApprovalCards: (items: unknown) => items,
  placeLeadBotChangeCards: (items: unknown) => items,
  placeMemoryCards: (items: unknown) => items,
  resolveConversationHeaderName: ({ botName }: { botName: string | null }) =>
    botName === null ? { status: "loading" } : { status: "ready", name: botName },
  // A final failed turn: Retry would show on an open chat.
  turnErrorNotice: () => ({
    message: "The reply failed.",
    detail: null,
    tone: "danger",
    canRetry: true,
  }),
}));
vi.mock("./messageReadStatus", () => ({ deriveLatestMessageReadStatus: () => null }));
vi.mock("./DelegationCard", () => ({ DelegationCard: () => null }));
vi.mock("./desktopColumns", () => ({
  useChatSidePanel: () => ({ fits: false, open: false }),
}));
vi.mock("./delegationModel", () => ({
  delegatedChildren: () => [],
  resolveTurnChildren: () => [],
  serverTurnLabel: () => "",
  waitingLabelsByThread: () => new Map(),
}));
vi.mock("./MessageList", () => ({
  MessageList: (props: Record<string, unknown>) => {
    state.messageListProps.push(props);
    return <div data-message-list="" />;
  },
}));
vi.mock("./questionCards", () => ({
  deriveQuestionCards: () => [],
  deriveUserInputResolutions: () => new Map(),
}));
vi.mock("./secretRequestCards", () => ({ deriveSecretRequestCards: () => [] }));
vi.mock("./useConnectionApprovalCards", () => ({
  useConnectionApprovalCards: () => ({
    cards: [],
    respondingIds: new Set(),
    decide: async () => null,
  }),
}));
vi.mock("./useLeadBotChangeCards", () => ({
  useLeadBotChangeCards: () => ({ cards: [], respondingIds: new Set(), decide: () => {} }),
}));
vi.mock("./useMemoryCards", () => ({
  useMemoryCards: () => ({
    cards: [],
    respondingIds: new Set(),
    decide: () => {},
    botName: null,
  }),
}));
vi.mock("./useLoginRequests", () => ({
  useLoginRequestCards: () => ({ cards: [], provide: () => {}, cancel: async () => {} }),
}));
vi.mock("./useSecretRequests", () => ({
  personalSecretCancel: {},
  personalSecretFulfill: {},
  usePendingSecretRequests: () => ({ data: { requests: [] } }),
}));
vi.mock("./personalPreferences", () => ({
  setPersonalPreference: () => {},
  usePersonalPreference: () => true,
}));
vi.mock("./DiagnosticsOverlay", () => ({
  diagnosticsEnabled: () => false,
  DiagnosticsOverlay: () => null,
}));
vi.mock("./useKeyboardInset", () => ({ useKeyboardInset: () => 0 }));
vi.mock("./useReportViewingThread", () => ({
  useReportViewingThread: (_environmentId: unknown, _threadId: unknown, connected: boolean) => {
    state.viewing.push(connected);
  },
}));
vi.mock("./perfRum", () => ({
  markMessageSent: () => {},
  observeChatMessages: () => {},
  reportChatUsable: () => {},
}));
vi.mock("./highlighterWarmup", () => ({ warmHighlighterWhenIdle: () => {} }));
vi.mock("./PersonalComposer", () => ({
  PersonalComposer: () => {
    state.composerRenders += 1;
    return <div data-composer="" />;
  },
}));
vi.mock("./ProgressNoteLine", () => ({ ProgressNoteLine: () => null }));
vi.mock("./latestProgress", () => ({ deriveLatestProgressNote: () => null }));
vi.mock("./PersonalOfflineBanner", () => ({
  useLaptopOffline: () => false,
  usePersonalConnectionPhase: () => "connected",
}));
vi.mock("./startBotChat", () => ({
  useStartBotChat: () => ({ start: state.startNewChat, starting: false }),
}));
vi.mock("./usePersonalAutomation", () => ({
  usePersonalTasks: () => ({ tasks: null }),
  usePersonalRelatedTasks: () => null,
}));
vi.mock("./usePrewarmChatSession", () => ({
  usePrewarmChatSession: (_environmentId: unknown, _threadId: unknown, connected: boolean) => {
    state.prewarm.push(connected);
  },
}));
vi.mock("./taskPresentation", () => ({ mergeTaskLists: () => null }));
vi.mock("./usePersonalBots", async () => {
  const DateTime = await import("effect/DateTime");
  return {
    personalBotArchiveThread: ARCHIVE_COMMAND,
    usePersonalEnvironmentId: () => "env-1",
    usePersonalBotsList: () => ({
      data: {
        bots: [
          {
            botId: "bot-a",
            name: "Ada",
            avatarShape: "pill",
            avatarColor: "#E8711A",
            modelSelection: {},
          },
        ],
        threads: [
          {
            botId: "bot-a",
            threadId: "thread-1",
            archivedAt: state.linkArchivedAt,
            ...(state.linkPinned ? { pinnedAt: "2026-10-01T10:00:00.000Z" } : {}),
            ...(state.linkSnoozedUntil === null
              ? {}
              : { snoozedUntil: DateTime.makeUnsafe(state.linkSnoozedUntil) }),
          },
          ...(state.twoChats
            ? [
                {
                  botId: "bot-a",
                  threadId: "thread-2",
                  archivedAt: null,
                  ...(state.otherPinned ? { pinnedAt: "2026-10-01T10:00:00.000Z" } : {}),
                  ...(state.otherSnoozedUntil === null
                    ? {}
                    : { snoozedUntil: DateTime.makeUnsafe(state.otherSnoozedUntil) }),
                },
              ]
            : []),
        ],
      },
      isPending: false,
      error: null,
      refresh: () => {},
    }),
  };
});
vi.mock("./useRefreshBotsForTaskThreads", () => ({ useRefreshBotsForTaskThreads: () => {} }));
vi.mock("./wrapupChat", () => ({
  useWrapupChat: () => ({ send: state.sendWrapup, sending: false }),
}));
vi.mock("./useBulkChatActions", () => ({ useBulkChatActions: () => state.bulk }));
vi.mock("~/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("./ChatSettingsSheet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ChatSettingsSheet")>();
  return {
    ...actual,
    // Base UI's dialog needs a DOM: the content inside it is what the screen drives.
    ChatSettingsSheet: ({
      returnFocusTo: _returnFocusTo,
      ...props
    }: Parameters<typeof actual.ChatSettingsContent>[0] & { returnFocusTo: unknown }) => (
      <div data-chat-settings-sheet="">
        <actual.ChatSettingsContent {...props} />
      </div>
    ),
  };
});
vi.mock("./chatState", async (importOriginal) => await importOriginal());
vi.mock("./useDeleteChat", () => ({ useDeleteChat: () => state.deleteChat }));
vi.mock("./RenameChatDialog", () => ({
  RenameChatDialog: ({
    open,
    initialTitle,
    onSave,
  }: {
    open: boolean;
    initialTitle: string;
    onSave: (title: string) => Promise<string | null>;
  }) =>
    open ? (
      <button
        type="button"
        data-rename-dialog={initialTitle}
        onClick={() => void onSave("Doubles")}
      >
        save rename
      </button>
    ) : null,
}));
vi.mock("./pendingOutgoing", () => ({ pendingForThread: () => [] }));
vi.mock("./renameChat", () => ({
  renameChatInitialTitle: (title: string | undefined) => title ?? "",
  renameChatDraftTitle: (draft: string) => (draft.trim() === "" ? null : draft.trim()),
  useRenameChat: () => async (threadId: string, title: string) => {
    state.renamed.push([threadId, title]);
    return null;
  },
}));
vi.mock("./retryFailedTurn", () => ({
  findRetryTarget: () => null,
  useRetryFailedTurn: () => ({ retry: state.retry, busy: false }),
}));
vi.mock("./usePersonalBackTarget", () => ({
  usePersonalBackTarget: () => ({ to: "/bots", label: "Back to Bots" }),
}));

const THREAD = {
  id: "thread-1",
  projectId: "project-1",
  title: "Plans",
  messages: [],
  activities: [],
  proposedPlans: [],
  session: null,
  latestTurn: null,
  worktreePath: null,
};

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setInterval: () => 1,
    clearInterval: () => {},
    // Late-bound so fake timers installed by a test are the ones that run.
    setTimeout: (run: () => void, ms?: number) => setTimeout(run, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    location: { pathname: "/bots/bot-a/thread-1" },
  });
  const documentListeners = new Map<string, Set<(event: unknown) => void>>();
  vi.stubGlobal("document", {
    activeElement: null,
    visibilityState: "visible",
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      documentListeners.get(type)?.delete(listener);
    },
  });
  state.shell = { title: "Plans", archivedAt: "2026-09-30T10:00:00.000Z" };
  state.linkArchivedAt = "2026-09-30T10:00:00.000Z";
  state.thread = THREAD;
  state.navigate = vi.fn(async () => undefined);
  state.archive = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  state.otherCommand = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  state.deleteChat = vi.fn(async (): Promise<Outcome> => ({ status: "done" }));
  state.retry = vi.fn(async () => true);
  state.sendWrapup = vi.fn(async () => true);
  state.startNewChat = vi.fn(async () => undefined);
  state.chipModel = null;
  state.bulk = vi.fn(async () => ({
    status: "settled",
    notice: "",
    failedIds: [],
    anyFailed: false,
  }));
  state.linkPinned = false;
  state.twoChats = false;
  state.otherPinned = false;
  state.otherWorking = false;
  state.otherUnread = false;
  state.otherSnoozedUntil = null;
  state.linkSnoozedUntil = null;
  state.settingsHolds = [];
  clearPendingWrapup();
  clearChipFreeze();
  state.renamed = [];
  state.prewarm = [];
  state.viewing = [];
  state.messageListProps = [];
  state.composerRenders = 0;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function renderScreen() {
  await act(async () => {
    renderer = create(<ConversationScreen botId="bot-a" threadId="thread-1" />);
  });
  return renderer!;
}

async function rerender() {
  await act(async () => {
    renderer!.update(<ConversationScreen botId="bot-a" threadId="thread-1" />);
  });
}

function text(): string {
  return JSON.stringify(renderer!.toJSON());
}

function buttonsLabelled(label: string): ReactTestInstance[] {
  return renderer!.root.findAll(
    (node) =>
      node.type === "button" &&
      node.children.some((child) => typeof child === "string" && child === label),
  );
}

function hasComposer(): boolean {
  return renderer!.root.findAll((node) => node.props["data-composer"] === "").length > 0;
}

function hasArchivedBar(): boolean {
  return renderer!.root.findAll((node) => node.props["aria-label"] === "Archived chat").length > 0;
}

function lastMessageListProps(): Record<string, unknown> {
  const props = state.messageListProps.at(-1);
  expect(props).toBeDefined();
  return props!;
}

function firstString(node: ReactTestInstance): string {
  return String(node.children.find((child) => typeof child === "string") ?? "");
}

/** The three-dots menu's rows, by label. */
function menuLabels(): string[] {
  return renderer!.root
    .findAll((node) => node.type === "button" && node.props["data-menu-item"] !== undefined)
    .map(firstString);
}

function sheetOpen(): boolean {
  return renderer!.root.findAll((node) => node.props["data-chat-settings-sheet"] === "").length > 0;
}

function sheetRowNodes(): ReactTestInstance[] {
  return renderer!.root.findAll(
    (node) => node.type === "button" && node.props["data-chat-settings-row"] !== undefined,
  );
}

function sheetRows(): string[] {
  return sheetRowNodes().map((node) => String(node.props["data-chat-settings-row"]));
}

function rowNode(id: string): ReactTestInstance {
  const node = sheetRowNodes().find((entry) => entry.props["data-chat-settings-row"] === id);
  expect(node, `row ${id}`).toBeDefined();
  return node!;
}

async function chooseRow(id: string) {
  await act(async () => {
    rowNode(id).props.onClick();
  });
}

/** Chat settings… in the three-dots menu: the sheet for the open chat. */
async function openOwnSheet() {
  const item = renderer!.root.findAll(
    (node) =>
      node.type === "button" &&
      node.props["data-menu-item"] !== undefined &&
      firstString(node) === "Chat settings…",
  )[0];
  expect(item).toBeDefined();
  await act(async () => {
    item!.props.onClick();
  });
}

/** A hold on a chip (the chips are mocked: the real hold is in ChatChips.hold.test.tsx). */
async function holdChip(threadId: string) {
  const hold = renderer!.root.findAll((node) => node.props["data-hold"] === threadId)[0];
  expect(hold).toBeDefined();
  await act(async () => {
    hold!.props.onClick();
  });
}

/** What the polite live region says. */
function announced(): string {
  const region = renderer!.root.findAll((node) => node.props.role === "status")[0];
  return region === undefined
    ? ""
    : region.children.filter((child) => typeof child === "string").join("");
}

it("opens an archived chat read-only: the Archived bar, no composer, no session, no retry", async () => {
  await renderScreen();

  expect(hasComposer()).toBe(false);
  expect(state.composerRenders).toBe(0);
  expect(hasArchivedBar()).toBe(true);
  expect(text()).toContain("Archived.");
  expect(buttonsLabelled("Unarchive")).toHaveLength(1);
  expect(buttonsLabelled("Delete")).toHaveLength(1);

  // Never asked to warm a provider session.
  expect(state.prewarm.length).toBeGreaterThan(0);
  expect(state.prewarm.every((connected) => connected === false)).toBe(true);
  // Not reported as viewed either: that writes the chat's last-viewed time.
  expect(state.viewing.length).toBeGreaterThan(0);
  expect(state.viewing.every((connected) => connected === false)).toBe(true);

  const props = lastMessageListProps();
  expect(props.readOnly).toBe(true);
  expect(props.errorRetry).toBeNull();

  // Nothing that would start a turn ran.
  expect(state.otherCommand).not.toHaveBeenCalled();
  expect(state.archive).not.toHaveBeenCalled();
  expect(state.retry).not.toHaveBeenCalled();
  expect(state.sendWrapup).not.toHaveBeenCalled();
  expect(state.startNewChat).not.toHaveBeenCalled();

  // The menu holds none of the chat's own actions; the sheet has Rename, Unarchive and Delete only.
  expect(menuLabels()).toEqual(["Chat settings…", "New chat", "All chats"]);
  await openOwnSheet();
  expect(sheetRows()).toEqual(["rename", "unarchive", "delete"]);

  // No routines strip on an archived chat.
  expect(renderer!.root.findAll((node) => node.props["data-routines"] === "")).toHaveLength(0);
});

it("Unarchive archives=false in place, and the composer and session come back", async () => {
  await renderScreen();

  await act(async () => {
    buttonsLabelled("Unarchive")[0]!.props.onClick();
  });
  expect(state.archive).toHaveBeenCalledTimes(1);
  expect(state.archive).toHaveBeenCalledWith({
    environmentId: "env-1",
    input: { threadId: "thread-1", archived: false },
  });
  // Stays on the chat.
  expect(state.navigate).not.toHaveBeenCalled();

  // The server clears archivedAt on the shell and the link.
  state.shell = { title: "Plans", archivedAt: null };
  state.linkArchivedAt = null;
  state.prewarm = [];
  state.viewing = [];
  await rerender();

  expect(hasComposer()).toBe(true);
  expect(hasArchivedBar()).toBe(false);
  expect(state.prewarm.at(-1)).toBe(true);
  expect(state.viewing.at(-1)).toBe(true);
  expect(lastMessageListProps().readOnly).toBe(false);
  await openOwnSheet();
  expect(sheetRows()).toContain("archive");
  expect(sheetRows()).not.toContain("unarchive");
});

it("the sheet's Unarchive chat runs the same command", async () => {
  await renderScreen();
  await openOwnSheet();
  await chooseRow("unarchive");
  expect(state.archive).toHaveBeenCalledWith({
    environmentId: "env-1",
    input: { threadId: "thread-1", archived: false },
  });
  expect(sheetOpen()).toBe(false);
});

it("Delete goes through useDeleteChat and leaves for the bot's chats once done", async () => {
  await renderScreen();

  await act(async () => {
    buttonsLabelled("Delete")[0]!.props.onClick();
  });
  expect(state.deleteChat).toHaveBeenCalledWith("thread-1", { name: "Plans" });
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/bots/$botId",
    params: { botId: "bot-a" },
    replace: true,
  });
});

it("a cancelled Delete stays on the chat", async () => {
  state.deleteChat = vi.fn(async (): Promise<Outcome> => ({ status: "cancelled" }));
  await renderScreen();

  await act(async () => {
    buttonsLabelled("Delete")[0]!.props.onClick();
  });
  expect(state.deleteChat).toHaveBeenCalledWith("thread-1", { name: "Plans" });
  expect(state.navigate).not.toHaveBeenCalled();
  expect(hasArchivedBar()).toBe(true);
});

it("a chat archived only on the bots-list link is read-only too", async () => {
  state.shell = { title: "Plans", archivedAt: null };
  state.linkArchivedAt = "2026-09-30T10:00:00.000Z";
  await renderScreen();

  expect(hasComposer()).toBe(false);
  expect(hasArchivedBar()).toBe(true);
  expect(state.prewarm.every((connected) => connected === false)).toBe(true);
  // Not reported as viewed either: that writes the chat's last-viewed time.
  expect(state.viewing.length).toBeGreaterThan(0);
  expect(state.viewing.every((connected) => connected === false)).toBe(true);
  expect(lastMessageListProps().readOnly).toBe(true);
  expect(lastMessageListProps().errorRetry).toBeNull();
  await openOwnSheet();
  expect(sheetRows()).toEqual(["rename", "unarchive", "delete"]);
});

it("an open chat keeps its composer, Retry and session prewarm", async () => {
  state.shell = { title: "Plans", archivedAt: null };
  state.linkArchivedAt = null;
  await renderScreen();

  expect(hasComposer()).toBe(true);
  expect(hasArchivedBar()).toBe(false);
  expect(state.prewarm.at(-1)).toBe(true);
  expect(state.viewing.at(-1)).toBe(true);
  const props = lastMessageListProps();
  expect(props.readOnly).toBe(false);
  expect(props.errorRetry).not.toBeNull();
  await openOwnSheet();
  expect(sheetRows()).toContain("archive");
  expect(sheetRows()).not.toContain("unarchive");
  expect(rowNode("wrapup").props["aria-disabled"]).toBeUndefined();
  expect(renderer!.root.findAll((node) => node.props["data-routines"] === "")).toHaveLength(1);
});

const chipOf = (threadId: string, text: string, current: boolean) => ({
  threadId,
  text,
  current,
  kind: "chat" as const,
  state: "idle" as const,
  unread: false,
  pinned: false,
  label: text,
});
const CHIP_ONE = chipOf("thread-1", "Plans", true);
const CHIP_TWO = chipOf("thread-2", "hbots", false);
const CHIPS = {
  chips: [CHIP_ONE, CHIP_TWO],
  ownerChips: [CHIP_ONE, CHIP_TWO],
  temporary: null,
  openCount: 2,
  visible: true,
  turnsKey: "",
};

function headerClass(): string {
  const header = renderer!.root.findAll((node) => node.type === "header")[0];
  return String(header!.props.className);
}

it("keeps the 64 px header and no chips with one chat", async () => {
  state.chipModel = {
    ...CHIPS,
    chips: [CHIP_ONE],
    ownerChips: [CHIP_ONE],
    openCount: 1,
    visible: false,
  };
  await renderScreen();
  expect(headerClass()).toContain("h-16");
  expect(headerClass()).not.toContain("h-[72px]");
  expect(renderer!.root.findAll((node) => node.props["data-chips"] !== undefined)).toHaveLength(0);
  expect(renderer!.root.findAll((node) => node.props["data-header-line"] === "")).toHaveLength(0);
});

it("takes the 72 px header and shows the chips from two chats", async () => {
  state.chipModel = CHIPS;
  await renderScreen();
  expect(headerClass()).toContain("h-[72px]");
  expect(headerClass()).not.toContain("h-16");
  expect(renderer!.root.findAll((node) => node.props["data-chips"] === 2)).toHaveLength(1);
  // The name line carries the status now: the chat title lives in the chip.
  expect(renderer!.root.findAll((node) => node.props["data-header-line"] === "")).toHaveLength(1);
  expect(text()).toContain("hbots");
});

it("+ opens the name sheet and Start chat creates it, replacing history and naming it", async () => {
  state.chipModel = CHIPS;
  await renderScreen();
  await act(async () => {
    buttonsLabelled("plus")[0]!.props.onClick();
  });
  await act(async () => {
    buttonsLabelled("start named")[0]!.props.onClick();
  });
  expect(state.startNewChat).toHaveBeenCalledTimes(1);
  const options = (state.startNewChat as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
    replace: boolean;
    keepState: boolean;
    onCreated: (threadId: string) => Promise<unknown>;
  };
  expect(options.replace).toBe(true);
  expect(options.keepState).toBe(true);
  await options.onCreated("new-thread");
  expect(state.renamed).toEqual([["new-thread", "Plan B"]]);
});

const openChat = () => {
  state.shell = { title: "Plans", archivedAt: null };
  state.linkArchivedAt = null;
};
const otherChat = () => {
  openChat();
  state.twoChats = true;
  state.chipModel = CHIPS;
};

describe("the three-dots menu", () => {
  it("holds Chat settings…, New chat and All chats, and none of the chat's own actions", async () => {
    openChat();
    await renderScreen();
    expect(menuLabels()).toEqual(["Chat settings…", "New chat", "All chats"]);
    for (const moved of [
      "Wrapup chat",
      "Pin chat",
      "Unpin chat",
      "Snooze…",
      "Mark unread",
      "Rename chat",
      "Archive chat",
      "Unarchive chat",
      "Delete chat",
    ]) {
      expect(buttonsLabelled(moved)).toHaveLength(0);
    }
  });

  it("keeps the trigger named Chat options, which the perf script clicks", async () => {
    openChat();
    await renderScreen();
    const trigger = renderer!.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"] === "Chat options",
    );
    expect(trigger).toHaveLength(1);
  });

  it("hints at holding the name with one chat, and a chip with several", async () => {
    openChat();
    await renderScreen();
    expect(text()).toContain("or hold the name");
    expect(text()).not.toContain("or hold a chip");
    await act(async () => renderer?.unmount());

    state.chipModel = CHIPS;
    await renderScreen();
    expect(text()).toContain("or hold a chip");
    expect(text()).not.toContain("or hold the name");
  });

  it("Chat settings… opens the sheet for the open chat", async () => {
    openChat();
    await renderScreen();
    expect(sheetOpen()).toBe(false);
    await openOwnSheet();
    expect(sheetOpen()).toBe(true);
    expect(sheetRows()).toEqual([
      "pin",
      "snooze",
      "markUnread",
      "rename",
      "wrapup",
      "archive",
      "delete",
    ]);
    expect(text()).toContain("Plans");
    expect(text()).toContain("This chat");
  });
});

describe("the sheet on the open chat", () => {
  it("Pin chat pins this chat and stays on it; a pinned chat offers Unpin chat", async () => {
    openChat();
    await renderScreen();
    await openOwnSheet();
    await chooseRow("pin");
    expect(state.bulk).toHaveBeenCalledWith("pin", ["thread-1"], 0, undefined);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(sheetOpen()).toBe(false);
    // The open chat's own action says nothing aloud.
    expect(announced()).toBe("");
    await act(async () => renderer?.unmount());

    state.linkPinned = true;
    await renderScreen();
    await openOwnSheet();
    expect(sheetRows()).toContain("unpin");
    expect(sheetRows()).not.toContain("pin");
    await chooseRow("unpin");
    expect(state.bulk).toHaveBeenLastCalledWith("unpin", ["thread-1"], 0, undefined);
  });

  it("Mark unread marks this chat and leaves it the way Back does", async () => {
    openChat();
    await renderScreen();
    await openOwnSheet();
    await chooseRow("markUnread");
    expect(state.bulk).toHaveBeenCalledWith("markUnread", ["thread-1"], 0, undefined);
    expect(state.navigate).toHaveBeenCalledWith({ to: "/bots", replace: true });
  });

  it("a refused Mark unread stays on the chat and says why", async () => {
    openChat();
    state.bulk = vi.fn(async () => ({
      status: "settled",
      notice: "1 chat couldn't be marked unread: not found.",
      failedIds: ["thread-1"],
      anyFailed: true,
    }));
    await renderScreen();
    await openOwnSheet();
    await chooseRow("markUnread");
    expect(state.navigate).not.toHaveBeenCalled();
    expect(String(lastMessageListProps().errorText)).toContain("couldn't be marked unread");
  });

  it("Snooze… swaps in the choices, then snoozes this chat until then and leaves it", async () => {
    openChat();
    await renderScreen();
    await openOwnSheet();
    await chooseRow("snooze");
    expect(state.bulk).not.toHaveBeenCalled();
    const first = renderer!.root.findAll(
      (node) => node.props["data-snooze-preset"] !== undefined,
    )[0]!;
    const before = Date.now();
    await act(async () => {
      first.props.onClick();
    });
    expect(state.bulk).toHaveBeenCalledTimes(1);
    const call = (state.bulk as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call.slice(0, 3)).toEqual(["snooze", ["thread-1"], 0]);
    expect(call[3].snoozeUntilMs).toBeGreaterThan(before);
    expect(state.navigate).toHaveBeenCalledWith({ to: "/bots", replace: true });
  });

  it("cancelling the snooze choices changes nothing and closes the sheet", async () => {
    openChat();
    await renderScreen();
    await openOwnSheet();
    await chooseRow("snooze");
    const cancel = buttonsLabelled("Cancel")[0]!;
    await act(async () => {
      cancel.props.onClick();
    });
    expect(state.bulk).not.toHaveBeenCalled();
    expect(sheetOpen()).toBe(false);
  });

  it("Wrapup chat sends the wrapup here, and says so when it cannot start", async () => {
    openChat();
    await renderScreen();
    await openOwnSheet();
    await chooseRow("wrapup");
    expect(state.sendWrapup).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
    state.sendWrapup = vi.fn(async () => false);
    await openOwnSheet();
    await chooseRow("wrapup");
    expect(String(lastMessageListProps().errorText)).toContain("Couldn't start the wrapup");
  });

  it("Rename chat opens the dialog with this chat's title and renames this chat", async () => {
    openChat();
    await renderScreen();
    await openOwnSheet();
    await chooseRow("rename");
    const dialog = renderer!.root.findAll(
      (node) => node.props["data-rename-dialog"] !== undefined,
    )[0]!;
    expect(dialog.props["data-rename-dialog"]).toBe("Plans");
    await act(async () => {
      dialog.props.onClick();
    });
    expect(state.renamed).toEqual([["thread-1", "Doubles"]]);
  });

  it("Archive chat archives and goes to the bot's chats", async () => {
    openChat();
    await renderScreen();
    await openOwnSheet();
    await chooseRow("archive");
    expect(state.archive).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { threadId: "thread-1", archived: true },
    });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/bots/$botId",
      params: { botId: "bot-a" },
      replace: true,
    });
  });

  it("Delete chat confirms without a name, then goes to the bot's chats", async () => {
    openChat();
    await renderScreen();
    await openOwnSheet();
    await chooseRow("delete");
    expect(state.deleteChat).toHaveBeenCalledWith("thread-1", {
      title: undefined,
      name: "Plans",
      working: false,
    });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/bots/$botId",
      params: { botId: "bot-a" },
      replace: true,
    });
  });

  it("a cancelled Delete leaves the chat alone", async () => {
    openChat();
    state.deleteChat = vi.fn(async (): Promise<Outcome> => ({ status: "cancelled" }));
    await renderScreen();
    await openOwnSheet();
    await chooseRow("delete");
    expect(state.navigate).not.toHaveBeenCalled();
    // Only the failed-turn notice the mock always shows: the delete said nothing.
    expect(lastMessageListProps().errorText).toBe("The reply failed.");
  });

  it("a snoozed chat opened from Snoozed offers Wake now, which wakes it in place", async () => {
    openChat();
    state.linkSnoozedUntil = Date.now() + 3_600_000;
    await renderScreen();
    await openOwnSheet();
    expect(sheetRows()).toEqual([
      "pin",
      "wake",
      "markUnread",
      "rename",
      "wrapup",
      "archive",
      "delete",
    ]);
    expect(text()).toContain("Snoozed until");
    await chooseRow("wake");
    expect(state.bulk).toHaveBeenCalledWith("wake", ["thread-1"], 0, undefined);
    expect(state.navigate).not.toHaveBeenCalled();
  });
});

describe("the sheet on another chat", () => {
  it("a hold on a chip opens that chat's sheet, titled with its name, and opens nothing else", async () => {
    otherChat();
    await renderScreen();
    await holdChip("thread-2");
    expect(sheetOpen()).toBe(true);
    expect(text()).toContain("hbots");
    expect(text()).toContain("Last message");
    expect(text()).not.toContain("This chat");
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("Pin pins that chat, stays on this one, and says so aloud", async () => {
    otherChat();
    await renderScreen();
    await holdChip("thread-2");
    await chooseRow("pin");
    expect(state.bulk).toHaveBeenCalledWith("pin", ["thread-2"], 0, undefined);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(announced()).toBe("hbots pinned.");
  });

  it("Unpin on a pinned chip", async () => {
    otherChat();
    state.otherPinned = true;
    await renderScreen();
    await holdChip("thread-2");
    expect(sheetRows()).toContain("unpin");
    await chooseRow("unpin");
    expect(state.bulk).toHaveBeenCalledWith("unpin", ["thread-2"], 0, undefined);
    expect(announced()).toBe("hbots unpinned.");
  });

  it("Snooze… snoozes that chat and stays here", async () => {
    otherChat();
    await renderScreen();
    await holdChip("thread-2");
    await chooseRow("snooze");
    const first = renderer!.root.findAll(
      (node) => node.props["data-snooze-preset"] !== undefined,
    )[0]!;
    await act(async () => {
      first.props.onClick();
    });
    const call = (state.bulk as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call.slice(0, 3)).toEqual(["snooze", ["thread-2"], 0]);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(announced()).toMatch(/^hbots snoozed until /);
  });

  it("Mark unread marks that chat and stays here", async () => {
    otherChat();
    await renderScreen();
    await holdChip("thread-2");
    await chooseRow("markUnread");
    expect(state.bulk).toHaveBeenCalledWith("markUnread", ["thread-2"], 0, undefined);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(announced()).toBe("hbots marked unread.");
  });

  it("a refused pin says why in the transcript's alert and announces nothing", async () => {
    otherChat();
    state.bulk = vi.fn(async () => ({
      status: "settled",
      notice: "1 chat couldn't be pinned: not found.",
      failedIds: ["thread-2"],
      anyFailed: true,
    }));
    await renderScreen();
    await holdChip("thread-2");
    await chooseRow("pin");
    expect(String(lastMessageListProps().errorText)).toContain("couldn't be pinned");
    expect(announced()).toBe("");
  });

  it("Rename opens the dialog with that chat's title and renames that chat", async () => {
    otherChat();
    await renderScreen();
    await holdChip("thread-2");
    await chooseRow("rename");
    const dialog = renderer!.root.findAll(
      (node) => node.props["data-rename-dialog"] !== undefined,
    )[0]!;
    expect(dialog.props["data-rename-dialog"]).toBe("hbots");
    await act(async () => {
      dialog.props.onClick();
    });
    expect(state.renamed).toEqual([["thread-2", "Doubles"]]);
    expect(announced()).toBe("hbots renamed to “Doubles”.");
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("Archive archives that chat, stays here and names it", async () => {
    otherChat();
    await renderScreen();
    await holdChip("thread-2");
    await chooseRow("archive");
    expect(state.archive).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { threadId: "thread-2", archived: true },
    });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(announced()).toBe("hbots archived.");
  });

  it("a failed Archive names the chat in the alert", async () => {
    otherChat();
    state.archive = vi.fn(async () => ({ _tag: "Failure" }));
    await renderScreen();
    await holdChip("thread-2");
    await chooseRow("archive");
    expect(String(lastMessageListProps().errorText)).toBe("Couldn't archive “hbots”: failed");
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("Delete confirms by name, deletes that chat and stays here", async () => {
    otherChat();
    await renderScreen();
    await holdChip("thread-2");
    await chooseRow("delete");
    expect(state.deleteChat).toHaveBeenCalledWith("thread-2", {
      title: "hbots",
      name: "hbots",
      working: false,
    });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(announced()).toBe("hbots deleted.");
  });

  it("Delete on a chat that is working says so in the confirm", async () => {
    otherChat();
    state.otherWorking = true;
    await renderScreen();
    await holdChip("thread-2");
    await chooseRow("delete");
    expect(state.deleteChat).toHaveBeenCalledWith("thread-2", {
      title: "hbots",
      name: "hbots",
      working: true,
    });
  });

  it("a failed Delete shows the message and stays", async () => {
    otherChat();
    state.deleteChat = vi.fn(async (): Promise<Outcome> => ({
      status: "failed",
      message: "Couldn't delete “hbots”. Try again.",
    }));
    await renderScreen();
    await holdChip("thread-2");
    await chooseRow("delete");
    expect(String(lastMessageListProps().errorText)).toBe("Couldn't delete “hbots”. Try again.");
    expect(announced()).toBe("");
  });

  it("Wrapup opens that chat and leaves the wrapup for it to send", async () => {
    otherChat();
    await renderScreen();
    await holdChip("thread-2");
    expect(rowNode("wrapup").props["aria-disabled"]).toBeUndefined();
    await chooseRow("wrapup");
    expect(state.sendWrapup).not.toHaveBeenCalled();
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/bots/$botId/$threadId",
        params: { botId: "bot-a", threadId: "thread-2" },
        replace: true,
      }),
    );
    expect(pendingWrapupFor("thread-2")).toBe(true);
  });

  it("Wrapup is off with After this reply while that chat is working", async () => {
    otherChat();
    state.otherWorking = true;
    await renderScreen();
    await holdChip("thread-2");
    const row = rowNode("wrapup");
    expect(row.props["aria-disabled"]).toBe(true);
    expect(
      row
        .findAll((node) => typeof node.type === "string")
        .flatMap((node) => node.children.filter((child) => typeof child === "string"))
        .join(" "),
    ).toContain("After this reply");
    await act(async () => {
      row.props.onClick();
    });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(pendingWrapupFor("thread-2")).toBe(false);
    expect(sheetOpen()).toBe(true);
  });

  it("closes when the chat goes away while the sheet is open", async () => {
    otherChat();
    await renderScreen();
    await holdChip("thread-2");
    expect(sheetOpen()).toBe(true);
    state.twoChats = false;
    await rerender();
    expect(sheetOpen()).toBe(false);
  });

  it("holding the same chip again does not open a second sheet", async () => {
    otherChat();
    await renderScreen();
    await holdChip("thread-2");
    await holdChip("thread-2");
    expect(
      renderer!.root.findAll((node) => node.props["data-chat-settings-sheet"] === ""),
    ).toHaveLength(1);
  });
});

describe("the chat that opens for a wrapup", () => {
  it("sends the wrapup once, when its thread has loaded and it can take a turn", async () => {
    openChat();
    const { markPendingWrapup } = await import("./chatChipHandoff");
    markPendingWrapup("thread-1");
    await renderScreen();
    expect(state.sendWrapup).toHaveBeenCalledTimes(1);
    expect(pendingWrapupFor("thread-1")).toBe(false);
    await rerender();
    expect(state.sendWrapup).toHaveBeenCalledTimes(1);
  });

  it("waits while the thread has not loaded", async () => {
    openChat();
    state.thread = null;
    const { markPendingWrapup } = await import("./chatChipHandoff");
    markPendingWrapup("thread-1");
    await renderScreen();
    expect(state.sendWrapup).not.toHaveBeenCalled();
    expect(pendingWrapupFor("thread-1")).toBe(true);
    state.thread = THREAD;
    await rerender();
    expect(state.sendWrapup).toHaveBeenCalledTimes(1);
  });

  it("says it could not start when the chat is archived", async () => {
    const { markPendingWrapup } = await import("./chatChipHandoff");
    markPendingWrapup("thread-1");
    await renderScreen();
    expect(state.sendWrapup).not.toHaveBeenCalled();
    expect(pendingWrapupFor("thread-1")).toBe(false);
    expect(String(lastMessageListProps().errorText)).toContain("Couldn't start the wrapup");
  });

  it("ignores a mark that is for another chat", async () => {
    openChat();
    const { markPendingWrapup } = await import("./chatChipHandoff");
    markPendingWrapup("thread-9");
    await renderScreen();
    expect(state.sendWrapup).not.toHaveBeenCalled();
    expect(pendingWrapupFor("thread-9")).toBe(true);
  });
});

describe("holding the name in the header", () => {
  const hold = async (label: string, ms = 500) => {
    const target = renderer!.root.findAll(
      (node) => node.type === "a" && String(node.props["aria-label"]).startsWith(label),
    )[0]!;
    const down = { clientX: 5, clientY: 5, pointerType: "touch", button: 0, currentTarget: {} };
    await act(async () => {
      target.props.onPointerDown(down);
    });
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    return target;
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("with one chat, a 500 ms hold on the name block opens the open chat's sheet", async () => {
    openChat();
    await renderScreen();
    expect(sheetOpen()).toBe(false);
    await hold("Edit Ada");
    expect(sheetOpen()).toBe(true);
    expect(text()).toContain("This chat");
    // A hold never opens Edit bot.
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("a shorter press opens nothing", async () => {
    openChat();
    await renderScreen();
    await hold("Edit Ada", 300);
    expect(sheetOpen()).toBe(false);
  });

  it("a scroll or drift away from the name opens nothing", async () => {
    openChat();
    await renderScreen();
    const target = renderer!.root.findAll(
      (node) => node.type === "a" && String(node.props["aria-label"]).startsWith("Edit Ada"),
    )[0]!;
    await act(async () => {
      target.props.onPointerDown({
        clientX: 5,
        clientY: 5,
        pointerType: "touch",
        button: 0,
        currentTarget: {},
      });
      target.props.onPointerMove({ clientX: 5, clientY: 40, pointerType: "touch", button: 0 });
    });
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(sheetOpen()).toBe(false);
  });

  it("with chips, holding line 1 opens the open chat's sheet", async () => {
    openChat();
    state.twoChats = true;
    state.chipModel = CHIPS;
    await renderScreen();
    await hold("Edit Ada");
    expect(sheetOpen()).toBe(true);
    expect(text()).toContain("This chat");
  });

  it("right-click on the name opens it too, and keeps the browser's own menu off", async () => {
    openChat();
    await renderScreen();
    const target = renderer!.root.findAll(
      (node) => node.type === "a" && String(node.props["aria-label"]).startsWith("Edit Ada"),
    )[0]!;
    const event = { preventDefault: vi.fn(), currentTarget: {} };
    await act(async () => {
      target.props.onContextMenu(event);
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(sheetOpen()).toBe(true);
  });

  it("tells a screen reader about the hold, and cannot be dragged as a link", async () => {
    openChat();
    await renderScreen();
    const target = renderer!.root.findAll(
      (node) => node.type === "a" && String(node.props["aria-label"]).startsWith("Edit Ada"),
    )[0]!;
    const hint = renderer!.root.findAll(
      (node) => node.type === "span" && node.props.hidden === true,
    )[0]!;
    expect(hint.children).toEqual(["Touch and hold for chat settings."]);
    expect(target.props["aria-describedby"]).toBe(hint.props.id);
    expect(target.props.draggable).toBe(false);
  });
});

describe("the chips' order while he stays", () => {
  const ordered = (...ids: string[]) => ({
    ...CHIPS,
    ownerChips: ids.map((id) => (id === "thread-1" ? CHIP_ONE : CHIP_TWO)),
    chips: ids.map((id) => (id === "thread-1" ? CHIP_ONE : CHIP_TWO)),
  });
  const order = () =>
    String(
      renderer!.root.findAll((node) => node.props["data-order"] !== undefined)[0]!.props[
        "data-order"
      ],
    );

  it("holds the order it took when the chats were entered, and takes a new one on the next entry", async () => {
    state.twoChats = true;
    state.chipModel = ordered("thread-1", "thread-2");
    await renderScreen();
    expect(order()).toBe("thread-1,thread-2");
    // thread-2 was messaged: a fresh sort would put it first. It stays put.
    state.chipModel = ordered("thread-2", "thread-1");
    await rerender();
    expect(order()).toBe("thread-1,thread-2");

    // Back to Bots and in again: the new order.
    await act(async () => renderer?.unmount());
    renderer = undefined;
    await Promise.resolve();
    await renderScreen();
    expect(order()).toBe("thread-2,thread-1");
  });
});
