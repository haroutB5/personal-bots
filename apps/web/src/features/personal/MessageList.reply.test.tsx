import {
  MessageId,
  personalReplyContext,
  type EnvironmentId,
  type PersonalReplyQuote,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BOT_AVATAR_SHAPE_ORDER } from "./botAvatarShapes";
import type { ConversationItem } from "./conversationModel";
import { choicesStates, MessageList } from "./MessageList";

const mocks = vi.hoisted(() => ({ jump: vi.fn() }));

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
vi.mock("./messageReply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messageReply")>()),
  jumpToMessage: (...args: unknown[]) => mocks.jump(...args),
}));
// Base UI's menu needs a DOM; the menu's own behaviour is not what is tested here.
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children }: { children: ReactNode }) => (
    <button data-testid="menu-trigger">{children}</button>
  ),
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
  mocks.jump.mockReset();
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
): ConversationItem => ({
  kind: "message",
  id,
  message: {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-10-06T10:00:00.000Z",
    updatedAt: "2026-10-06T10:00:00.000Z",
    ...extra,
  } as never,
});

const render = async (props: Partial<Parameters<typeof MessageList>[0]> = {}) => {
  await act(async () => {
    renderer = create(<MessageList {...BASE_PROPS} {...props} />);
  });
  return renderer!.root;
};

const QUOTE: PersonalReplyQuote = { messageId: "bot-1", name: "Mori", excerpt: "All green." };
const block = (...lines: string[]) => ["```choices", ...lines, "```"].join("\n");

describe("reply quote on a sent message", () => {
  it("draws the quote above the text, and tapping it jumps to the original", async () => {
    const root = await render({
      items: [
        message("bot-1", "assistant", "All green."),
        message("user-1", "user", "Thanks, ship it", { context: personalReplyContext(QUOTE) }),
      ],
    });
    const chip = root.findByProps({ "data-testid": "reply-quote" });
    expect(chip.props["aria-label"]).toContain("Reply to Mori: All green.");
    await act(async () => chip.props.onClick());
    expect(mocks.jump).toHaveBeenCalledWith(expect.anything(), "bot-1");
  });

  it("draws a plain bubble when the message is not a reply", async () => {
    const root = await render({ items: [message("user-1", "user", "Hello")] });
    expect(root.findAllByProps({ "data-testid": "reply-quote" })).toHaveLength(0);
  });

  it("draws the quote on a message that is still sending, the same way", async () => {
    const root = await render({
      pending: [
        {
          id: "p1",
          threadId: "thread-1",
          text: "On it",
          createdAt: "2026-10-06T10:02:00.000Z",
          attachments: [],
          replyTo: QUOTE,
        },
      ],
    });
    expect(root.findByProps({ "data-testid": "reply-quote" }).props["aria-label"]).toContain(
      "Mori",
    );
  });
});

describe("Reply action", () => {
  it("offers Reply on a bot message and the owner's own, naming each", async () => {
    const onReply = vi.fn();
    const root = await render({
      onReply,
      items: [
        message("bot-1", "assistant", "**Done.** All green."),
        message("user-1", "user", "Ship it"),
      ],
    });
    const rows = root.findAllByProps({ "data-replyable": "" });
    expect(rows.map((row) => row.props["data-message-id"])).toEqual(["bot-1", "user-1"]);
    const replies = root
      .findAllByProps({ role: "menuitem" })
      .filter((item) => item.children.includes("Reply"));
    expect(replies).toHaveLength(2);
    await act(async () => replies[0]!.props.onClick());
    expect(onReply).toHaveBeenLastCalledWith({
      messageId: "bot-1",
      name: "Mori",
      excerpt: "Done. All green.",
    });
    await act(async () => replies[1]!.props.onClick());
    expect(onReply).toHaveBeenLastCalledWith({
      messageId: "user-1",
      name: "You",
      excerpt: "Ship it",
    });
  });

  it("offers nothing where nothing can be sent (an archived chat)", async () => {
    const root = await render({
      readOnly: true,
      items: [message("bot-1", "assistant", "Hi"), message("user-1", "user", "Hello")],
    });
    expect(root.findAllByProps({ "data-replyable": "" })).toHaveLength(0);
  });

  it("does not offer Reply on a bot message that is still streaming", async () => {
    const root = await render({
      onReply: vi.fn(),
      items: [message("bot-1", "assistant", "Working on", { streaming: true })],
    });
    expect(root.findAllByProps({ "data-replyable": "" })).toHaveLength(0);
  });
});

describe("tap-to-answer choices", () => {
  const reply = `Ship it?\n\n${block("Yes, ship it", "Not yet")}`;

  it("draws the block as buttons under the text, not as code", async () => {
    const root = await render({
      onChoose: async () => true,
      items: [message("bot-1", "assistant", reply)],
    });
    expect(root.findByProps({ "data-testid": "markdown" }).children).toEqual(["Ship it?"]);
    const group = root.findByProps({ "data-testid": "choices" });
    expect(group.findAllByType("button").map((button) => button.props.disabled)).toEqual([
      false,
      false,
    ]);
  });

  it("sends the tapped text through onChoose", async () => {
    const onChoose = vi.fn(async () => true);
    const root = await render({ onChoose, items: [message("bot-1", "assistant", reply)] });
    const buttons = root.findByProps({ "data-testid": "choices" }).findAllByType("button");
    await act(async () => buttons[0]!.props.onClick());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("Yes, ship it");
  });

  it("waits while the chat cannot take a message", async () => {
    const root = await render({
      onChoose: async () => true,
      choicesBusy: true,
      items: [message("bot-1", "assistant", reply)],
    });
    const group = root.findByProps({ "data-testid": "choices" });
    expect(group.props["data-state"]).toBe("disabled");
    expect(group.findAllByType("button").every((button) => button.props.disabled)).toBe(true);
  });

  it("greys out once the owner has sent anything after it, marking a repeated option", async () => {
    const root = await render({
      onChoose: async () => true,
      items: [
        message("bot-1", "assistant", reply),
        message("user-1", "user", "Yes, ship it"),
        message("bot-2", "assistant", "Shipping."),
      ],
    });
    const group = root.findByProps({ "data-testid": "choices" });
    expect(group.props["data-state"]).toBe("used");
    expect(group.findAllByType("button").map((button) => button.props["aria-pressed"])).toEqual([
      true,
      false,
    ]);
  });

  it("only the latest reply's set is open", () => {
    const states = choicesStates(
      [
        message("bot-1", "assistant", reply),
        message("user-1", "user", "something else entirely"),
        message("bot-2", "assistant", block("A", "B")),
      ],
      false,
    );
    expect(states.get("bot-1")).toEqual({ kind: "used", picked: null });
    expect(states.get("bot-2")).toEqual({ kind: "open", disabled: false });
  });

  it("shows a malformed block as the plain code it looks like", async () => {
    const text = `Pick:\n${block("Only one")}`;
    const root = await render({
      onChoose: async () => true,
      items: [message("bot-1", "assistant", text)],
    });
    expect(root.findAllByProps({ "data-testid": "choices" })).toHaveLength(0);
    expect(root.findByProps({ "data-testid": "markdown" }).children).toEqual([text]);
  });

  it("holds back a block that is still streaming in", async () => {
    const text = "Ship it?\n\n```choices\nYes, sh";
    const root = await render({
      onChoose: async () => true,
      items: [message("bot-1", "assistant", text, { streaming: true })],
    });
    expect(root.findAllByProps({ "data-testid": "choices" })).toHaveLength(0);
    expect(root.findByProps({ "data-testid": "markdown" }).children).toEqual(["Ship it?"]);
  });

  it("works in a group transcript too", async () => {
    const onChoose = vi.fn(async () => true);
    const root = await render({
      onChoose,
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
          message: (message("g1", "assistant", reply) as unknown as { message: never }).message,
        },
      ],
    });
    const buttons = root.findByProps({ "data-testid": "choices" }).findAllByType("button");
    await act(async () => buttons[1]!.props.onClick());
    expect(onChoose).toHaveBeenCalledWith("Not yet");
  });
});

describe("Reply on a message with choices", () => {
  it("quotes the words, not the block", async () => {
    const onReply = vi.fn();
    const root = await render({
      onReply,
      onChoose: async () => true,
      items: [message("bot-1", "assistant", `Ship it?\n\n${block("Yes, ship it", "Not yet")}`)],
    });
    const reply = root
      .findAllByProps({ role: "menuitem" })
      .find((item) => item.children.includes("Reply"));
    await act(async () => reply!.props.onClick());
    expect(onReply).toHaveBeenCalledWith({ messageId: "bot-1", name: "Mori", excerpt: "Ship it?" });
  });
});
