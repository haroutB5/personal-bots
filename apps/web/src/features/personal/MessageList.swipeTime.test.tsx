import { MessageId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BOT_AVATAR_SHAPE_ORDER } from "./botAvatarShapes";
import type { ConversationItem } from "./conversationModel";
import { MessageList } from "./MessageList";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrls: () => [] }));
vi.mock("~/components/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}));
vi.mock("~/components/chat/MessagesTimeline.logic", () => ({
  shouldPreserveAssistantLineBreaks: () => false,
}));
vi.mock("~/session-logic", () => ({ selectMessageImageResources: () => [] }));
vi.mock("./ToolDetails", () => ({ ToolDetails: () => null }));
vi.mock("./AttachmentPreview", () => ({ AttachmentPreview: () => null }));
// Base UI's menu needs a DOM; the menu's own behaviour is not what is tested here.
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
}));

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("document", {});
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const BASE_PROPS = {
  environmentId: "env-1" as EnvironmentId,
  threadRef: { threadId: "thread-1" } as ScopedThreadRef,
  items: [] as ConversationItem[],
  pending: [],
  working: false,
  botName: "Mori",
  workspaceRoot: undefined,
  approvals: [],
  respondingIds: new Set<string>(),
  onRespondToApproval: () => {},
  onAnswerQuestion: () => {},
  onDismissQuestion: () => {},
  onProvideSecret: () => {},
  onDeclineSecret: () => {},
  onDecideConnectionApproval: () => {},
  approvalRespondingIds: new Set<string>(),
  approvalsNowMs: Date.parse("2026-10-06T10:00:00.000Z"),
  errorText: null,
  loadEarlier: null,
  now: new Date("2026-10-06T10:01:00.000Z"),
  describeTurn: () => "",
  renderDelegation: () => null,
} as const;

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  extra: Record<string, unknown> = {},
) =>
  ({
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-10-06T10:00:00.000Z",
    updatedAt: "2026-10-06T10:00:00.000Z",
    ...extra,
  }) as never;

const item = (
  id: string,
  role: "user" | "assistant",
  text: string,
  extra: Record<string, unknown> = {},
): ConversationItem => ({ kind: "message", id, message: message(id, role, text, extra) });

const render = async (props: Partial<Parameters<typeof MessageList>[0]> = {}) => {
  await act(async () => {
    renderer = create(<MessageList {...BASE_PROPS} {...props} />);
  });
  return renderer!.root;
};

type Root = Awaited<ReturnType<typeof render>>;
const replyable = (root: Root) => root.findAllByProps({ "data-replyable": "" });
const timeRows = (root: Root) => root.findAllByProps({ "data-swipe-time-row": "" });
const swipes = (row: { props: Record<string, unknown> }) =>
  String(row.props.className).includes("pan-y");

describe("swiping a message to see its time", () => {
  it("is on for the owner's messages and a bot's replies in a chat that can send", async () => {
    const root = await render({
      onReply: vi.fn(),
      items: [item("bot-1", "assistant", "All green."), item("user-1", "user", "Ship it")],
    });
    const rows = replyable(root);
    expect(rows).toHaveLength(2);
    expect(rows.every(swipes)).toBe(true);
  });

  it("is on in an archived chat too, where nothing can be replied to", async () => {
    const root = await render({
      readOnly: true,
      items: [item("bot-1", "assistant", "All green."), item("user-1", "user", "Ship it")],
    });
    expect(replyable(root)).toHaveLength(0);
    const rows = timeRows(root);
    expect(rows).toHaveLength(2);
    expect(rows.every(swipes)).toBe(true);
    // The owner's keeps its 78% width; the text is still there.
    expect(String(rows[1]!.props.className)).toContain("max-w-[78%]");
    expect(rows[1]!.findAllByType("p")[0]!.children).toEqual(["Ship it"]);
    expect(root.findByProps({ "data-testid": "markdown" }).children).toEqual(["All green."]);
  });

  it("is on for a group transcript's members", async () => {
    const root = await render({
      onReply: vi.fn(),
      groupSpeaker: () => ({
        name: "Ada",
        avatarShape: BOT_AVATAR_SHAPE_ORDER[0]!,
        avatarColor: "#fff",
        threadId: null,
      }),
      items: [
        {
          kind: "group-message",
          id: "g1",
          speaker: { botId: "bot-ada", name: "Ada" },
          showSpeaker: true,
          message: message("g1", "assistant", "From the group"),
        },
      ],
    });
    expect(replyable(root).every(swipes)).toBe(true);
    expect(replyable(root)).toHaveLength(1);
  });

  it("is off for a message with no usable send time", async () => {
    const sent = await render({
      onReply: vi.fn(),
      items: [
        item("bot-1", "assistant", "No time", { createdAt: "" }),
        item("user-1", "user", "Bad time", { createdAt: "yesterday-ish" }),
      ],
    });
    expect(replyable(sent)).toHaveLength(2);
    expect(replyable(sent).some(swipes)).toBe(false);
    await act(async () => renderer?.unmount());

    const archived = await render({
      readOnly: true,
      items: [
        item("bot-1", "assistant", "No time", { createdAt: "" }),
        item("user-1", "user", "Bad time", { createdAt: "yesterday-ish" }),
      ],
    });
    expect(timeRows(archived)).toHaveLength(0);
    // The text is drawn all the same.
    expect(archived.findAllByProps({ "data-testid": "markdown" })).toHaveLength(1);
  });

  it("is off for a reply that is still streaming in", async () => {
    const root = await render({
      onReply: vi.fn(),
      items: [item("bot-1", "assistant", "Working on", { streaming: true })],
    });
    expect(replyable(root)).toHaveLength(0);
    expect(timeRows(root)).toHaveLength(0);
  });

  it("is off for a message that is still sending (it has not been sent yet)", async () => {
    const root = await render({
      pending: [
        {
          id: "p1",
          threadId: "thread-1",
          text: "On it",
          createdAt: "2026-10-06T10:02:00.000Z",
          attachments: [],
        },
      ],
    });
    expect(timeRows(root)).toHaveLength(0);
    expect(replyable(root)).toHaveLength(0);
  });
});
