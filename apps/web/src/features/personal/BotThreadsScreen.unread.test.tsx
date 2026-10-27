import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { BotThreadsScreen } from "./BotThreadsScreen";
import { markChatOpen, resetChatSeenState } from "./unreadChats";

const state = vi.hoisted(() => ({
  archive: (() => {}) as (...args: unknown[]) => unknown,
  otherCommand: (() => {}) as (...args: unknown[]) => unknown,
  deleteChat: (() => {}) as (...args: unknown[]) => unknown,
  lead: true,
  /** The task feed the screen reads: a chat a task made needs its task here. */
  tasks: null as Map<string, { threadId: string; createdAt: Date }> | null,
  /** Active rows beside the mock's two, for the chats a task or routine made. */
  extraRows: [] as ReadonlyArray<{
    threadId: string;
    title: string;
    createdAt: Date;
    markedUnread?: boolean;
  }>,
}));

const ARCHIVE_COMMAND = vi.hoisted(() => ({ name: "personalBotArchiveThread" }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: React.ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a
      data-to={to}
      data-params={params === undefined ? undefined : JSON.stringify(params)}
      aria-label={(props as { "aria-label"?: string })["aria-label"]}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/state/lazyThreadShells", () => ({
  useLazyThreadShells: () => ({ pending: false }),
  withLazyThreadShells: <A,>(atom: A) => atom,
}));
vi.mock("~/state/entities", () => ({
  useThreadDetail: () => null,
  useThreadShells: () => [],
}));
vi.mock("~/state/server", () => ({ primaryServerProvidersAtom: {} }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === ARCHIVE_COMMAND ? state.archive : state.otherCommand,
}));
vi.mock("./BotAvatar", () => ({ BotAvatar: () => <span data-avatar="" /> }));
vi.mock("./botModelLabel", () => ({
  botModelShortLabel: () => null,
  botActiveModelShortLabel: () => null,
  fallbackNoteLabel: () => null,
}));
const makeReply = vi.hoisted(() => () => new Date(Date.UTC(2026, 9, 2, 10, 5)));
vi.mock("effect/DateTime", () => ({ toEpochMillis: (value: Date) => value.getTime() }));
vi.mock("./botThreadRows", () => {
  const row = (
    threadId: string,
    title: string,
    archivedAt: string | null,
    unread = true,
    createdAt = new Date(Date.UTC(2026, 8, 30, 9)),
    markedUnread = false,
  ) => ({
    link: {
      botId: "bot-a",
      threadId,
      createdAt,
      archivedAt,
      ...(markedUnread ? { markedUnread: true } : {}),
      ...(unread ? { unread: true, lastReplyAt: makeReply() } : {}),
    },
    shell: { id: threadId, title, archivedAt, environmentId: "env-1" },
    updatedMs: Date.UTC(2026, 8, 30, 10),
  });
  return {
    botThreadRows: () => ({
      active: [
        row("thread-open", "Open chat", null),
        row("thread-read", "Read chat", null, false),
        ...state.extraRows.map((extra) =>
          row(
            extra.threadId,
            extra.title,
            null,
            true,
            extra.createdAt,
            extra.markedUnread === true,
          ),
        ),
      ],
      archived: [row("thread-archived", "Old plans", "2026-09-30T10:00:00.000Z")],
      snoozed: [],
    }),
  };
});
vi.mock("./usePersonalGroups", () => ({
  usePersonalGroupRelayThreadIds: () => new Set<string>(),
}));
vi.mock("./botSummaries", () => ({
  isThreadLive: () => false,
  isThreadRateLimited: () => false,
  threadNeedsAttention: () => false,
}));
vi.mock("./relativeTime", () => ({ formatRelativeTime: () => "Yesterday" }));
vi.mock("./startBotChat", () => ({
  useStartBotChat: () => ({ start: async () => undefined, starting: false }),
}));
vi.mock("./PersonalOfflineBanner", () => ({ useLaptopOffline: () => false }));
vi.mock("./usePersonalAutomation", () => ({ usePersonalTasks: () => ({ tasks: state.tasks }) }));
vi.mock("./useRefreshBotsForTaskThreads", () => ({ useRefreshBotsForTaskThreads: () => {} }));
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
          lead: state.lead,
        },
      ],
      threads: [],
    },
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("./wrapupChat", () => ({
  useWrapupChat: () => ({ send: async () => true, sending: false }),
}));
vi.mock("./useDeleteChat", () => ({ useDeleteChat: () => state.deleteChat }));
vi.mock("./SwipeToDelete", () => ({
  SwipeToDelete: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./useBulkChatActions", () => ({ useBulkChatActions: () => async () => undefined }));
vi.mock("./usePersonalBackTarget", () => ({
  usePersonalBackTarget: () => ({ to: "/bots", label: "Back to Bots" }),
}));

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.archive = vi.fn(async () => ({ _tag: "Success", value: {} }));
  state.otherCommand = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  state.deleteChat = vi.fn(async () => ({ status: "cancelled" }));
  state.lead = true;
  state.tasks = null;
  state.extraRows = [];
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  resetChatSeenState();
  vi.unstubAllGlobals();
});

/** Thread ids of the rows that carry an unread dot. */
function dottedThreads(): string[] {
  return renderer!.root
    .findAll((node) => node.type === "a" && node.props["data-to"] === "/bots/$botId/$threadId")
    .filter((link) => link.findAll((node) => node.props["data-testid"] === "unread-dot").length > 0)
    .map((link) => JSON.parse(link.props["data-params"] as string).threadId as string);
}

it("an unread chat carries a dot; read and archived ones do not", async () => {
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });
  expect(dottedThreads()).toEqual(["thread-open"]);
  // Spoken too, not only drawn.
  expect(JSON.stringify(renderer!.toJSON())).toContain(", unread");
});

it("a bot that is not a lead shows the same dots the chat chips mark unread (1.60.45)", async () => {
  state.lead = false;
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });
  expect(dottedThreads()).toEqual(["thread-open"]);
  expect(JSON.stringify(renderer!.toJSON())).toContain(", unread");
});

it("the dot clears once the chat has been opened on this device, without a refetch", async () => {
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });
  expect(dottedThreads()).toEqual(["thread-open"]);
  await act(async () => {
    markChatOpen("thread-open", true);
  });
  expect(dottedThreads()).toEqual([]);
  await act(async () => {
    markChatOpen("thread-open", false, Date.UTC(2026, 9, 2, 10, 6));
  });
  expect(dottedThreads()).toEqual([]);
});

it("a routine chat the owner never used is listed without a dot, the way the chips hide it", async () => {
  // The real case (2026-10-16): CTO's routine chat was unread, in no chip, and
  // still drew a dot here and on the bot's row.
  const createdAt = new Date(Date.UTC(2026, 8, 30, 9));
  state.tasks = new Map([["thread-task", { threadId: "thread-task", createdAt }]]);
  state.extraRows = [{ threadId: "thread-task", title: "Routine run", createdAt }];
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });
  // The row is still on the list: only its unread marker goes.
  expect(JSON.stringify(renderer!.toJSON())).toContain("Routine run");
  expect(dottedThreads()).toEqual(["thread-open"]);
  expect(JSON.stringify(renderer!.toJSON())).toContain(", unread");
});

it("a routine chat the owner marked unread keeps its dot, as the chips show it", async () => {
  const createdAt = new Date(Date.UTC(2026, 8, 30, 9));
  state.tasks = new Map([["thread-task", { threadId: "thread-task", createdAt }]]);
  state.extraRows = [
    { threadId: "thread-task", title: "Routine run", createdAt, markedUnread: true },
  ];
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });
  expect(dottedThreads()).toEqual(["thread-open", "thread-task"]);
});
