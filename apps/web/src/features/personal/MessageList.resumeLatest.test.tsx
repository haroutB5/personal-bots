/**
 * Jump to latest when I come back (Harout, 2026-10-11). A reader scrolled up
 * in a chat who leaves the app (the page goes hidden) and returns with items
 * that arrived while they were away lands on the latest messages, pinned.
 * With nothing new their place is kept: a long read is not interrupted by a
 * phone lock. The check stays armed briefly after the return, because on iOS
 * the reconnect that brings the missed items can land after the visible event;
 * the reader's own touch ends it. A reader at the bottom keeps following, as
 * before, and returning to the chat from elsewhere in the app is a fresh mount
 * that opens on the latest window.
 */
import { MessageId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel";
import { AWAY_CATCH_UP_MS, JUMP_TO_LATEST_DELAY_MS, MessageList } from "./MessageList";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrls: () => [] }));
vi.mock("~/components/ChatMarkdown", () => ({ default: ({ text }: { text: string }) => text }));
vi.mock("~/components/chat/MessagesTimeline.logic", () => ({
  shouldPreserveAssistantLineBreaks: () => false,
}));
vi.mock("~/session-logic", () => ({ selectMessageImageResources: () => [] }));
vi.mock("./ToolDetails", () => ({ ToolDetails: () => null }));
vi.mock("./AttachmentPreview", () => ({ AttachmentPreview: () => null }));

class Listeners {
  readonly map = new Map<string, Set<(event: unknown) => void>>();
  add(type: string, listener: (event: unknown) => void) {
    const set = this.map.get(type) ?? new Set();
    set.add(listener);
    this.map.set(type, set);
  }
  remove(type: string, listener: (event: unknown) => void) {
    this.map.get(type)?.delete(listener);
  }
  fire(type: string, event: unknown = {}) {
    for (const listener of this.map.get(type) ?? []) listener(event);
  }
}

/**
 * A browser-like scroller: 1000px of transcript in a 400px window, offsets
 * clamped to the end, and a scroll event raised for every change (the event a
 * real scrollTop write produces).
 */
class FakeScroller {
  private top = 0;
  scrollHeight = 1000;
  clientHeight = 400;
  readonly listeners = new Listeners();
  get bottom() {
    return Math.max(0, this.scrollHeight - this.clientHeight);
  }
  get scrollTop() {
    return this.top;
  }
  set scrollTop(value: number) {
    const next = Math.max(0, Math.min(value, this.bottom));
    if (next === this.top) return;
    this.top = next;
    this.fire("scroll");
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.add(type, listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.remove(type, listener);
  }
  fire(type: string, event: unknown = { target: this }) {
    this.listeners.fire(type, event);
  }
  /** The reader drags to `top`; the browser reports it as a scroll event. */
  scrollToTop(top: number) {
    this.scrollTop = top;
  }
}

let renderer: ReactTestRenderer | undefined;
let scroller: FakeScroller;
let documentListeners: Listeners;

const BASE_PROPS = {
  environmentId: "env-1" as EnvironmentId,
  threadRef: { threadId: "thread-1" } as ScopedThreadRef,
  items: [],
  pending: [],
  working: false,
  botName: "Assistant",
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
  approvalsNowMs: Date.parse("2026-10-11T10:00:00.000Z"),
  errorText: null,
  loadEarlier: null,
  now: new Date("2026-10-11T10:01:00.000Z"),
  describeTurn: () => "",
  renderDelegation: () => null,
} as const;

beforeEach(() => {
  vi.useFakeTimers();
  scroller = new FakeScroller();
  documentListeners = new Listeners();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      documentListeners.add(type, listener),
    removeEventListener: (type: string, listener: (event: unknown) => void) =>
      documentListeners.remove(type, listener),
    visibilityState: "visible",
  });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(
  threadId = "thread-1",
  items: ReadonlyArray<ConversationItem> = [],
): Promise<void> {
  const element = (
    <MessageList
      {...BASE_PROPS}
      items={items}
      threadRef={{ threadId } as unknown as ScopedThreadRef}
    />
  );
  if (renderer !== undefined) {
    await act(async () => renderer!.update(element));
    return;
  }
  await act(async () => {
    renderer = create(element, {
      createNodeMock: (node) => {
        const props = node.props as { className?: unknown; role?: unknown };
        if (
          typeof props.className === "string" &&
          props.className.includes("personal-scroll-quiet")
        )
          return scroller;
        if (props.role === "log") return { querySelectorAll: () => [], contains: () => true };
        return {};
      },
    });
  });
}

/** The page goes away (lock screen, app switch, another tab). */
async function hide(): Promise<void> {
  (document as unknown as { visibilityState: string }).visibilityState = "hidden";
  await act(async () => documentListeners.fire("visibilitychange"));
}

/** The page comes back. */
async function show(): Promise<void> {
  (document as unknown as { visibilityState: string }).visibilityState = "visible";
  await act(async () => documentListeners.fire("visibilitychange"));
}

async function scrollTo(top: number) {
  await act(async () => scroller.scrollToTop(top));
}

async function wait(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

const rowIds = (): string[] =>
  renderer!.root
    .findAll((node) => typeof node.props["data-transcript-row"] === "string")
    .map((node) => String(node.props["data-transcript-row"]));
const firstRow = () => rowIds()[0];
const lastRow = () => rowIds().at(-1);
const jumpButtons = () =>
  renderer!.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"] === "Jump to latest message",
  );

const messageItem = (id: string, role: "user" | "assistant", text: string): ConversationItem => ({
  kind: "message",
  id,
  message: {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-10-11T10:00:00.000Z",
    updatedAt: "2026-10-11T10:00:00.000Z",
  },
});

const messages = (count: number): ConversationItem[] =>
  Array.from({ length: count }, (_, index) =>
    messageItem(`m-${index}`, index % 2 === 0 ? "user" : "assistant", `Message ${index}`),
  );

/** A reader parked up in history with the jump button up. */
async function readerUpInHistory(upTo = 100): Promise<void> {
  await render("thread-1", messages(200));
  await scrollTo(upTo);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
  expect(firstRow()).toBe("m-120");
  expect(lastRow()).toBe("m-199");
}

it("lands on the latest window, pinned, when items arrived while the reader was away", async () => {
  await readerUpInHistory();

  await hide();
  // Three messages arrive while the page is away: nothing moves while hidden.
  await render("thread-1", messages(203));
  expect(scroller.scrollTop).toBe(100);
  expect(firstRow()).toBe("m-120");
  expect(lastRow()).toBe("m-199");

  await show();
  // Back to the newest: the latest window, pinned, no button.
  expect(firstRow()).toBe("m-123");
  expect(lastRow()).toBe("m-202");
  expect(scroller.scrollTop).toBe(scroller.bottom);
  expect(jumpButtons()).toHaveLength(0);
});

it("keeps the reader's place when nothing arrived while they were away", async () => {
  await readerUpInHistory();

  await hide();
  // The viewport settles while away (the iOS stale-offset case); nothing new arrives.
  scroller.scrollHeight = 1200;
  await show();

  expect(scroller.scrollTop).toBe(100);
  expect(firstRow()).toBe("m-120");
  expect(lastRow()).toBe("m-199");
  expect(jumpButtons()).toHaveLength(1);
});

it("lands on the latest when the missed items land just after the return (the reconnect)", async () => {
  await readerUpInHistory();

  await hide();
  await show();
  // On iOS the page resumes before it reconnects: nothing new is here yet.
  expect(scroller.scrollTop).toBe(100);

  await wait(1_000);
  await render("thread-1", messages(204));
  expect(lastRow()).toBe("m-203");
  expect(scroller.scrollTop).toBe(scroller.bottom);
  expect(jumpButtons()).toHaveLength(0);
});

it("keeps the reader's place for items that arrive after the catch-up window", async () => {
  await readerUpInHistory();

  await hide();
  await show();
  await wait(AWAY_CATCH_UP_MS + 1_000);

  // A message arriving long after the return is ordinary new mail for a
  // reader parked in history: they keep their place and the button stays.
  await render("thread-1", messages(203));
  expect(scroller.scrollTop).toBe(100);
  expect(firstRow()).toBe("m-120");
  expect(lastRow()).toBe("m-199");
  expect(jumpButtons()).toHaveLength(1);
});

it("the reader's own touch ends the catch-up window", async () => {
  await readerUpInHistory();

  await hide();
  await show();
  // The reader is back and reading where they are: a finger press takes over.
  await act(async () => scroller.fire("touchstart"));

  await wait(1_000);
  await render("thread-1", messages(203));
  expect(scroller.scrollTop).toBe(100);
  expect(firstRow()).toBe("m-120");
});

it("a reader at the bottom still follows to the end across a hide", async () => {
  await render("thread-1", messages(200));
  expect(scroller.scrollTop).toBe(scroller.bottom);

  await hide();
  await render("thread-1", messages(203));
  await show();

  expect(lastRow()).toBe("m-202");
  expect(scroller.scrollTop).toBe(scroller.bottom);
  expect(jumpButtons()).toHaveLength(0);
});

it("returning to the chat (a fresh mount) opens on the latest window", async () => {
  await readerUpInHistory();

  // Leaving the chat for the bots list unmounts the screen; coming back is a
  // fresh mount, which opens on the latest window whatever arrived meanwhile.
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await render("thread-1", messages(203));

  expect(lastRow()).toBe("m-202");
  expect(scroller.scrollTop).toBe(scroller.bottom);
  expect(jumpButtons()).toHaveLength(0);
});
