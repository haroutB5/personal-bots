import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { BotThreadsScreen } from "./BotThreadsScreen";

const state = vi.hoisted(() => ({
  archive: (() => {}) as (...args: unknown[]) => unknown,
  otherCommand: (() => {}) as (...args: unknown[]) => unknown,
  deleteChat: (() => {}) as (...args: unknown[]) => unknown,
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
vi.mock("./botThreadRows", () => {
  const row = (threadId: string, title: string, archivedAt: string | null) => ({
    link: { botId: "bot-a", threadId, archivedAt },
    shell: { id: threadId, title, archivedAt, environmentId: "env-1" },
    updatedMs: Date.UTC(2026, 8, 30, 10),
  });
  return {
    botThreadRows: () => ({
      active: [row("thread-open", "Open chat", null)],
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
vi.mock("./usePersonalAutomation", () => ({ usePersonalTasks: () => ({ tasks: null }) }));
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
  state.archive = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  state.otherCommand = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  state.deleteChat = vi.fn(async () => ({ status: "cancelled" }));
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function chatLinks(): ReactTestInstance[] {
  return renderer!.root.findAll(
    (node) => node.type === "a" && node.props["data-to"] === "/bots/$botId/$threadId",
  );
}

function buttonsLabelled(label: string): ReactTestInstance[] {
  return renderer!.root.findAll(
    (node) =>
      node.type === "button" &&
      node.children.some((child) => typeof child === "string" && child === label),
  );
}

it("an archived chat's row opens the chat and keeps its Unarchive and Delete buttons", async () => {
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });

  const links = chatLinks();
  const params = links.map((link) => JSON.parse(link.props["data-params"] as string));
  expect(params).toContainEqual({ botId: "bot-a", threadId: "thread-open" });
  expect(params).toContainEqual({ botId: "bot-a", threadId: "thread-archived" });

  const archivedLink = links.find(
    (link) => JSON.parse(link.props["data-params"] as string).threadId === "thread-archived",
  )!;
  expect(archivedLink.props["aria-label"]).toBe("Old plans, archived");
  expect(archivedLink.findAll((node) => node.children.includes("Old plans"))).not.toHaveLength(0);

  // The buttons sit beside the link, in the same row, not inside it.
  const unarchive = buttonsLabelled("Unarchive");
  const remove = buttonsLabelled("Delete");
  expect(unarchive).toHaveLength(1);
  expect(remove).toHaveLength(1);
  expect(archivedLink.findAll((node) => node.type === "button")).toHaveLength(0);
  const row = unarchive[0]!.parent!;
  expect(remove[0]!.parent).toBe(row);
  expect(row.findAll((node) => node === archivedLink)).toHaveLength(1);

  // Rendering alone changes nothing on the server.
  expect(state.archive).not.toHaveBeenCalled();
  expect(state.otherCommand).not.toHaveBeenCalled();
  expect(state.deleteChat).not.toHaveBeenCalled();
});

it("the archived row's buttons still unarchive and delete that chat", async () => {
  await act(async () => {
    renderer = create(<BotThreadsScreen botId="bot-a" />);
  });

  await act(async () => {
    buttonsLabelled("Unarchive")[0]!.props.onClick();
  });
  expect(state.archive).toHaveBeenCalledWith({
    environmentId: "env-1",
    input: { threadId: "thread-archived", archived: false },
  });

  await act(async () => {
    buttonsLabelled("Delete")[0]!.props.onClick();
  });
  expect(state.deleteChat).toHaveBeenCalledWith("thread-archived");
});
