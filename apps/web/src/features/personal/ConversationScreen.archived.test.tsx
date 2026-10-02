import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
}));

const ARCHIVE_COMMAND = vi.hoisted(() => ({ name: "personalBotArchiveThread" }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
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
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
vi.mock("./ConversationHeaderName", () => ({
  ConversationHeaderName: ({ name }: { name: string }) => <h1>{name}</h1>,
}));
vi.mock("./ConversationSubtitle", () => ({ ConversationSubtitle: () => null }));
vi.mock("./botMuteModel", () => ({ botMuteState: () => ({ muted: false }) }));
vi.mock("./botSummaries", () => ({
  conversationHeaderStatus: () => null,
  resolveBotProvider: () => null,
  taskCardBotLine: () => null,
}));
vi.mock("./botModelLabel", () => ({ botModelShortLabel: () => null }));
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
vi.mock("./usePersonalBots", () => ({
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
      threads: [{ botId: "bot-a", threadId: "thread-1", archivedAt: state.linkArchivedAt }],
    },
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("./useRefreshBotsForTaskThreads", () => ({ useRefreshBotsForTaskThreads: () => {} }));
vi.mock("./wrapupChat", () => ({
  useWrapupChat: () => ({ send: state.sendWrapup, sending: false }),
}));
vi.mock("./useDeleteChat", () => ({ useDeleteChat: () => state.deleteChat }));
vi.mock("./RenameChatDialog", () => ({ RenameChatDialog: () => null }));
vi.mock("./pendingOutgoing", () => ({ pendingForThread: () => [] }));
vi.mock("./renameChat", () => ({
  renameChatInitialTitle: (title: string | undefined) => title ?? "",
  useRenameChat: () => async () => true,
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
    location: { pathname: "/bots/bot-a/thread-1" },
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

  // The menu offers Unarchive in Archive's place, and Wrapup is off.
  expect(buttonsLabelled("Unarchive chat")).toHaveLength(1);
  expect(buttonsLabelled("Archive chat")).toHaveLength(0);
  const wrapup = buttonsLabelled("Wrapup chat");
  expect(wrapup).toHaveLength(1);
  expect(wrapup[0]!.props.disabled).toBe(true);

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
  expect(buttonsLabelled("Archive chat")).toHaveLength(1);
  expect(buttonsLabelled("Unarchive chat")).toHaveLength(0);
});

it("the menu's Unarchive chat runs the same command", async () => {
  await renderScreen();
  await act(async () => {
    buttonsLabelled("Unarchive chat")[0]!.props.onClick();
  });
  expect(state.archive).toHaveBeenCalledWith({
    environmentId: "env-1",
    input: { threadId: "thread-1", archived: false },
  });
});

it("Delete goes through useDeleteChat and leaves for the bot's chats once done", async () => {
  await renderScreen();

  await act(async () => {
    buttonsLabelled("Delete")[0]!.props.onClick();
  });
  expect(state.deleteChat).toHaveBeenCalledWith("thread-1");
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
  expect(state.deleteChat).toHaveBeenCalledWith("thread-1");
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
  expect(buttonsLabelled("Unarchive chat")).toHaveLength(1);
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
  expect(buttonsLabelled("Archive chat")).toHaveLength(1);
  expect(buttonsLabelled("Unarchive chat")).toHaveLength(0);
  expect(buttonsLabelled("Wrapup chat")[0]!.props.disabled).toBe(false);
  expect(renderer!.root.findAll((node) => node.props["data-routines"] === "")).toHaveLength(1);
});
