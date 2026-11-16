// Real MessageList through React's reconciler, stand-in react-native, stubbed leaves. It proves
// the wiring the messageRows tests cannot: memo(ChatRow), shared, the handler ref, renderItem.
// Counts are message row renders (one ownerVisibleText call each) and card leaf renders.
import { createElement, act } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const counts = vi.hoisted(() => ({ messageRows: 0, cards: 0 }));

vi.mock("@hbots/personal-client/feed/composerText", async (original) => {
  const real = await original<Record<string, unknown>>();
  return {
    ...real,
    ownerVisibleText: (text: string) => {
      counts.messageRows += 1;
      return (real.ownerVisibleText as (text: string) => string)(text);
    },
  };
});
vi.mock("./cards/registry", async () => {
  const { createElement: h } = await import("react");
  const kinds = await import("./cards/cardKinds");
  function CardStub(props: Record<string, unknown>) {
    counts.cards += 1;
    return h("Card", props);
  }
  return {
    ...kinds,
    renderChatCard: (item: unknown, context: unknown) => h(CardStub, { item, context }),
  };
});
vi.mock("./AttachmentImage", async () => {
  const { createElement: h } = await import("react");
  return {
    AttachmentImage: (props: Record<string, unknown>) => h("AttachmentImage", props),
    PendingAttachmentImage: (props: Record<string, unknown>) => h("PendingAttachmentImage", props),
  };
});
vi.mock("./PageFrame", async () => {
  const { createElement: h } = await import("react");
  return { PageFrame: (props: Record<string, unknown>) => h("PageFrame", props) };
});
vi.mock("./ChoiceButtons", async () => {
  const { createElement: h } = await import("react");
  return { ChoiceButtons: (props: Record<string, unknown>) => h("ChoiceButtons", props) };
});
vi.mock("./LiveWorkRow", async () => {
  const { createElement: h } = await import("react");
  return { LiveWorkRow: (props: Record<string, unknown>) => h("LiveWorkRow", props) };
});
vi.mock("../shell/BotAvatar", async () => {
  const { createElement: h } = await import("react");
  return { BotAvatar: (props: Record<string, unknown>) => h("BotAvatar", props) };
});
vi.mock("../ui/icons", () => {
  const icon = () => null;
  return {
    IconArrowDown: icon,
    IconFile: icon,
    IconFileCode: icon,
    IconFileText: icon,
    IconFileTypePdf: icon,
    IconPhoto: icon,
    IconPaperclip: icon,
  };
});
vi.mock("react-native", () => import("./testSupport/reactNativeStub"));
vi.mock("../display/useHighRefresh", () => ({ useHighRefresh: () => ({}) }));
vi.mock("./useStreamCommitPerf", () => ({ useStreamCommitPerf: () => undefined }));

const { MessageList } = (await import("./MessageList")) as {
  MessageList: (props: Record<string, unknown>) => React.ReactNode;
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Item = Record<string, unknown>;

function message(id: string, role: "user" | "assistant", text: string, extra = {}): Item {
  return {
    kind: "message",
    id,
    message: { id, role, text, streaming: false, createdAt: "2026-11-16T10:00:00.000Z", ...extra },
  };
}
function chat(turns: number, overrides: Record<string, string> = {}): Item[] {
  const items: Item[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    items.push(message(`u${turn}`, "user", `question ${turn}`));
    items.push(message(`a${turn}`, "assistant", overrides[`a${turn}`] ?? `answer ${turn}`));
  }
  return items;
}

const NATIVE = { environmentId: "env", httpBaseUrl: "http://x" };
const CHAT = { name: "chat-a" };
const IDLE = { phase: "idle" };

/** Fresh closures on every call, as the chat screen passes them. */
function props(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    native: NATIVE,
    chat: CHAT,
    items: [],
    pending: [],
    queued: [],
    botName: "Bot",
    currentUserId: "You",
    work: IDLE,
    busy: false,
    latestMessageStatus: null,
    onReply: () => undefined,
    onMessageMenu: () => undefined,
    onOpenFile: () => undefined,
    onOpenLink: () => undefined,
    onCancelQueued: () => undefined,
    onRetryQueued: () => undefined,
    onLoadEarlier: null,
    loadEarlierBusy: false,
    ...over,
  };
}

let renderer: ReactTestRenderer | null = null;
function mount(p: Record<string, unknown>): ReactTestRenderer {
  act(() => {
    renderer = create(createElement(MessageList, p));
  });
  return renderer!;
}
function update(p: Record<string, unknown>): void {
  act(() => {
    renderer!.update(createElement(MessageList, p));
  });
}
function strings(): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else walk((node as { children?: unknown }).children);
  };
  walk(renderer!.toJSON());
  return out;
}
function hosts(type: string, where: (node: ReactTestInstance) => boolean = () => true) {
  return renderer!.root.findAll((node) => node.type === type && where(node));
}
function reset() {
  counts.messageRows = 0;
  counts.cards = 0;
}

beforeEach(reset);
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
});

describe("MessageList through the reconciler", () => {
  it("R01 a rebuilt identical list with new handler closures renders no message row", () => {
    mount(props({ items: chat(40) }));
    expect(counts.messageRows).toBe(80);
    reset();
    update(props({ items: chat(40) }));
    expect(counts.messageRows).toBe(0);
  });

  it("R02 one changed reply renders one row and the new text is on screen", () => {
    mount(props({ items: chat(40) }));
    reset();
    update(props({ items: chat(40, { a39: "answer 39 and more words" }) }));
    expect(strings()).toContain("answer 39 and more words");
    expect(strings()).not.toContain("answer 39");
    expect(counts.messageRows).toBe(1);
  });

  it("R03 the streaming flag alone redraws the row: a held-back choices block shows when it drops", () => {
    const text = "Pick one\n\n```choices\nYes\nNo";
    const items = (streaming: boolean) => [
      message("u0", "user", "q"),
      message("a0", "assistant", text, { streaming }),
    ];
    const onChoose = () => Promise.resolve(true);
    mount(props({ items: items(true), onChoose }));
    expect(strings()).toContain("Pick one");
    expect(strings()).not.toContain("Yes\nNo");
    update(props({ items: items(false), onChoose }));
    expect(strings()).toContain("Yes\nNo");
  });

  it("R03b choices follow busy: a finished block is drawn disabled while busy and open after", () => {
    const text = "Pick one\n\n```choices\nYes\nNo\n```";
    const items = [message("u0", "user", "q"), message("a0", "assistant", text)];
    const onChoose = () => Promise.resolve(true);
    mount(props({ items, busy: true, onChoose }));
    expect(hosts("ChoiceButtons")[0]!.props.state).toEqual({ kind: "open", disabled: true });
    update(props({ items, busy: false, onChoose }));
    expect(hosts("ChoiceButtons")[0]!.props.state).toEqual({ kind: "open", disabled: false });
  });

  it("R04 a handler called after a re-render that redrew no row is the current one", async () => {
    const first = {
      onMessageMenu: vi.fn(),
      onReply: vi.fn(),
      onOpenLink: vi.fn(),
      onOpenFile: vi.fn(),
      onChoose: vi.fn(() => Promise.resolve(true)),
      onCancelQueued: vi.fn(),
      onRetryQueued: vi.fn(),
      onRetryPending: vi.fn(),
    };
    const second = {
      onMessageMenu: vi.fn(),
      onReply: vi.fn(),
      onOpenLink: vi.fn(),
      onOpenFile: vi.fn(),
      onChoose: vi.fn(() => Promise.resolve(true)),
      onCancelQueued: vi.fn(),
      onRetryQueued: vi.fn(),
      onRetryPending: vi.fn(),
    };
    const items = () => [
      message("u0", "user", "hello"),
      message(
        "a0",
        "assistant",
        "see [the site](https://example.com) now\n\n```choices\nYes\nNo\n```",
      ),
    ];
    const queued = () => [
      { entry: { id: "q1", text: "queued text", threadId: "t" }, state: "failed" },
    ];
    const pending = () => [
      {
        id: "p1",
        text: "pending text",
        createdAt: "2026-11-16T10:00:00.000Z",
        attachments: [],
        state: "failed",
      },
    ];
    mount(props({ items: items(), queued: queued(), pending: pending(), ...first }));
    reset();
    update(props({ items: items(), queued: queued(), pending: pending(), ...second }));

    const surface = hosts("View", (node) => node.props.accessibilityActions !== undefined)[0]!;
    act(() => surface.props.onAccessibilityAction({ nativeEvent: { actionName: "longpress" } }));
    const bubble = hosts("Pressable", (node) => node.props.onLongPress !== undefined)[0]!;
    act(() => bubble.props.onLongPress());
    const link = hosts("Text", (node) => node.props.accessibilityRole === "link")[0]!;
    act(() => link.props.onPress());
    const choices = hosts("ChoiceButtons")[0]!;
    await act(async () => {
      await choices.props.onChoose("Yes");
    });
    const buttons = hosts("Pressable", (node) => node.props.accessibilityRole === "button");
    for (const button of buttons) act(() => button.props.onPress());
    const swipes = hosts("Animated.View");
    for (const swipe of swipes) {
      act(() => swipe.props.panConfig.onPanResponderRelease({}, { dx: 100, dy: 0 }));
      act(() => swipe.props.panConfig.onPanResponderRelease({}, { dx: -100, dy: 0 }));
    }
    expect(second.onMessageMenu).toHaveBeenCalledTimes(2);
    expect(second.onMessageMenu.mock.calls.map((call) => call[0].messageId).toSorted()).toEqual([
      "a0",
      "u0",
    ]);
    expect(second.onOpenLink).toHaveBeenCalledWith("https://example.com");
    expect(second.onChoose).toHaveBeenCalledWith("Yes");
    expect(second.onCancelQueued).toHaveBeenCalledWith("q1");
    expect(second.onRetryQueued).toHaveBeenCalledWith("q1");
    expect(second.onRetryPending).toHaveBeenCalledWith("p1");
    expect(second.onReply).toHaveBeenCalledTimes(2);
    for (const fn of Object.values(first)) expect(fn).not.toHaveBeenCalled();
  });

  it("R05 after a chat switch the handlers and the shared values belong to the new chat", () => {
    const menuA = vi.fn();
    const menuB = vi.fn();
    mount(
      props({
        items: [message("a0", "assistant", "from chat A")],
        botName: "Bot A",
        onMessageMenu: menuA,
      }),
    );
    update(
      props({
        items: [message("b0", "assistant", "from chat B")],
        botName: "Bot B",
        chat: { name: "chat-b" },
        onMessageMenu: menuB,
      }),
    );
    const surface = hosts("View", (node) => node.props.accessibilityActions !== undefined)[0]!;
    act(() => surface.props.onAccessibilityAction({ nativeEvent: { actionName: "longpress" } }));
    expect(menuA).not.toHaveBeenCalled();
    expect(menuB).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "b0", name: "Bot B", text: "from chat B" }),
    );
  });

  it("R06 the same message id under a new bot name redraws with the new name", () => {
    const menu = vi.fn();
    mount(
      props({ items: [message("a0", "assistant", "same")], botName: "Bot A", onMessageMenu: menu }),
    );
    update(
      props({ items: [message("a0", "assistant", "same")], botName: "Bot B", onMessageMenu: menu }),
    );
    const surface = hosts("View", (node) => node.props.accessibilityActions !== undefined)[0]!;
    act(() => surface.props.onAccessibilityAction({ nativeEvent: { actionName: "longpress" } }));
    expect(menu).toHaveBeenCalledWith(expect.objectContaining({ name: "Bot B" }));
  });

  it("R07 a new card context reaches the card and renders no message row", () => {
    const card = () => ({ kind: "question", id: "q1", card: { requestId: "q1" } });
    const ctxA = { nowMs: 1 };
    const ctxB = { nowMs: 2 };
    mount(props({ items: [...chat(5), card()], cardContext: ctxA }));
    reset();
    update(props({ items: [...chat(5), card()], cardContext: ctxA }));
    const sameContext = { rows: counts.messageRows, cards: counts.cards };
    reset();
    update(props({ items: [...chat(5), card()], cardContext: ctxB }));
    expect(hosts("Card")[0]!.props.context).toBe(ctxB);
    expect(sameContext).toEqual({ rows: 0, cards: 0 });
    expect(counts.messageRows).toBe(0);
    expect(counts.cards).toBe(1);
  });

  it("R08 the read line follows its status and its message", () => {
    const status = (messageId: string, value: string) => ({ messageId, status: value });
    mount(props({ items: chat(3), latestMessageStatus: status("u2", "queued") }));
    expect(strings()).toContain("Queued");
    update(props({ items: chat(3), latestMessageStatus: status("u2", "steering") }));
    expect(strings()).toContain("Steering");
    update(props({ items: chat(3), latestMessageStatus: status("u2", "read") }));
    expect(strings()).toContain("Read");
    expect(strings()).not.toContain("Queued");
    update(props({ items: chat(3), latestMessageStatus: null }));
    expect(strings()).not.toContain("Read");
  });

  it("R09 a group speaker's avatar follows the roster", () => {
    const item = () => ({
      kind: "group-message",
      id: "g1",
      showSpeaker: true,
      speaker: { botId: "b1", name: "Ada" },
      message: {
        id: "g1",
        role: "assistant",
        text: "hi",
        streaming: false,
        createdAt: "2026-11-16T10:00:00.000Z",
      },
    });
    const speaker = (avatarColor: string) => () => ({
      name: "Ada",
      avatarShape: "blob",
      avatarColor,
    });
    mount(props({ items: [item()], groupSpeaker: speaker("red") }));
    reset();
    update(props({ items: [item()], groupSpeaker: speaker("red") }));
    const sameSpeaker = counts.messageRows;
    update(props({ items: [item()], groupSpeaker: speaker("blue") }));
    expect(hosts("BotAvatar")[0]!.props.color).toBe("blue");
    expect(sameSpeaker).toBe(0);
  });

  it("R10 the work row, a pending bubble and a queued row follow their data", () => {
    const work = (label: string) => ({
      phase: "working",
      runId: "r1",
      waitingOnBackground: false,
      current: { id: "s1", kind: "tool", status: "running", label },
    });
    const pending = (state: string) => [
      {
        id: "p1",
        text: "pending text",
        createdAt: "2026-11-16T10:00:00.000Z",
        attachments: [],
        state,
      },
    ];
    const queued = (state: string, error?: string) => [
      {
        entry: { id: "q1", text: "queued text", threadId: "t", ...(error ? { error } : {}) },
        state,
      },
    ];
    mount(
      props({
        items: chat(2),
        work: work("step one"),
        pending: pending("sending"),
        queued: queued("waiting"),
      }),
    );
    expect(strings()).toContain("Queued");
    update(
      props({
        items: chat(2),
        work: work("step two"),
        pending: pending("failed"),
        queued: queued("failed", "No route"),
      }),
    );
    expect(hosts("LiveWorkRow")[0]!.props.work.current.label).toBe("step two");
    expect(strings()).toContain("Not sent");
    expect(strings()).toContain("No route");
    expect(strings()).toContain("Retry");
  });

  it("R11 attachments, the quote chip and the sent time follow the message", () => {
    const item = (name: string, excerpt: string) => [
      message("u0", "user", "look", {
        attachments: [{ type: "file", id: "f1", name }],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: "personal-reply",
              label: "Reply to Bot",
              kind: "personal-reply",
              payload: { messageId: "a9", name: "Bot", excerpt },
            },
          ],
        },
      }),
    ];
    mount(props({ items: item("a.pdf", "old quote") }));
    update(props({ items: item("b.pdf", "new quote") }));
    expect(strings()).toContain("b.pdf");
    expect(strings()).toContain("new quote");
    expect(strings()).not.toContain("old quote");
    reset();
    update(props({ items: item("b.pdf", "new quote") }));
  });

  it("R12 choices appear when sending becomes possible", () => {
    const items = () => [message("a0", "assistant", "Pick\n\n```choices\nYes\nNo\n```")];
    mount(props({ items: items() }));
    expect(hosts("ChoiceButtons").length).toBe(0);
    update(props({ items: items(), onChoose: () => Promise.resolve(true) }));
    expect(hosts("ChoiceButtons").length).toBe(1);
    update(props({ items: items() }));
    expect(hosts("ChoiceButtons").length).toBe(0);
  });

  it("R13 the day divider turns from Today to Yesterday when the card context changes at midnight", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    const divider = { kind: "divider", id: "divider:x", at: new Date("2026-11-16T10:00:00Z") };
    const stable = props({ items: [divider, ...chat(2)], cardContext: { nowMs: 1 } });
    mount(stable);
    const label = () => strings().find((text) => /^(Today|Yesterday)/u.test(text));
    expect(label()).toMatch(/^Today/u);
    vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
    update({ ...stable, cardContext: { nowMs: 2 } });
    expect(label()).toMatch(/^Yesterday/u);
  });
});
