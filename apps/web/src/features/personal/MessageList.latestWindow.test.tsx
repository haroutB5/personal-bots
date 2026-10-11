/**
 * The newest messages are never behind a tap (Harout, 2026-10-11: "I always
 * want latest messages shown instantly, i dont want to have to press that in
 * order to see the latest messages"). A reader at the bottom follows them; a
 * window frozen on an older message is left where it is, and reaching its end
 * brings the later messages in by itself (with the reader's place kept), so the
 * "Load later messages" fallback never has to be pressed in normal use. Sends,
 * reopening a chat and resuming the app land on the latest window, pinned.
 */
import { MessageId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel";
import { JUMP_TO_LATEST_DELAY_MS, MessageList, type PendingOutgoingMessage } from "./MessageList";

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
  count(type: string) {
    return this.map.get(type)?.size ?? 0;
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
  /** Every offset written, in order and before clamping. */
  readonly writes: number[] = [];
  readonly listeners = new Listeners();
  get bottom() {
    return Math.max(0, this.scrollHeight - this.clientHeight);
  }
  get scrollTop() {
    return this.top;
  }
  set scrollTop(value: number) {
    this.writes.push(value);
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
  clearWrites() {
    this.writes.length = 0;
  }
}

let renderer: ReactTestRenderer | undefined;
let scroller: FakeScroller;
let resize: () => void;
let windowListeners: Listeners;
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
  resize = () => {};
  windowListeners = new Listeners();
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
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      windowListeners.add(type, listener),
    removeEventListener: (type: string, listener: (event: unknown) => void) =>
      windowListeners.remove(type, listener),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
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
  extra: Partial<Parameters<typeof MessageList>[0]> = {},
): Promise<void> {
  const element = (
    <MessageList
      {...BASE_PROPS}
      {...extra}
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
        // The transcript column: enough of a node for the anchor code to walk
        // its rows (there are none without a browser layout).
        if (props.role === "log") return { querySelectorAll: () => [], contains: () => true };
        return {};
      },
    });
  });
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
const laterFallback = () =>
  renderer!.root.findAll(
    (node) => node.type === "button" && node.children.includes("Load later messages"),
  );
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

it("opens on the latest window and shows new messages at once, with no button", async () => {
  await render("thread-1", messages(200));
  // The window is the newest 80 rows, at the end of the transcript.
  expect(lastRow()).toBe("m-199");
  expect(laterFallback()).toHaveLength(0);
  expect(scroller.scrollTop).toBe(scroller.bottom);

  // The reader drifts 40px up: inside the stick threshold, still their bottom.
  await scrollTo(scroller.bottom - 40);
  await wait(JUMP_TO_LATEST_DELAY_MS * 2);
  expect(jumpButtons()).toHaveLength(0);

  await render("thread-1", messages(203));
  expect(lastRow()).toBe("m-202");
  expect(scroller.scrollTop).toBe(scroller.bottom);
  expect(laterFallback()).toHaveLength(0);
  expect(jumpButtons()).toHaveLength(0);
});

it("leaves a reader up in history alone, and loads the later messages as they reach its end", async () => {
  await render("thread-1", messages(200));
  await scrollTo(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
  expect(firstRow()).toBe("m-120");
  expect(lastRow()).toBe("m-199");

  // Five messages arrive while the reader is reading older ones: the window
  // and the reader's place do not move.
  await render("thread-1", messages(205));
  expect(scroller.scrollTop).toBe(100);
  expect(firstRow()).toBe("m-120");
  expect(lastRow()).toBe("m-199");

  // Reaching the end of the loaded window brings the next batch in, with no
  // tap and no press of the fallback, and settles at the newest, pinned.
  await scrollTo(scroller.bottom - 40);
  expect(lastRow()).toBe("m-204");
  expect(scroller.scrollTop).toBe(scroller.bottom);
  expect(laterFallback()).toHaveLength(0);
  expect(jumpButtons()).toHaveLength(0);

  // And it keeps following from there.
  await render("thread-1", messages(206));
  expect(lastRow()).toBe("m-205");
  expect(scroller.scrollTop).toBe(scroller.bottom);
});

it("shows messages that arrive while the reader sits at the end of a frozen window", async () => {
  await render("thread-1", messages(200));
  await scrollTo(100);
  await render("thread-1", messages(205));
  // Down to the end of what is loaded: the newest are in and it is pinned.
  await scrollTo(scroller.bottom - 40);
  expect(lastRow()).toBe("m-204");
  expect(laterFallback()).toHaveLength(0);

  // One more arrives now, while they sit there: on screen at once, no button.
  await render("thread-1", messages(206));
  expect(lastRow()).toBe("m-205");
  expect(laterFallback()).toHaveLength(0);
  expect(jumpButtons()).toHaveLength(0);
});

it("lands on the latest window, pinned, when the app is resumed", async () => {
  await render("thread-1", messages(200));
  await scrollTo(scroller.bottom);
  // The transcript grew while the app was away (the phone reconnects, the
  // viewport settles): coming back is the newest, followed to the end.
  scroller.scrollHeight = 1400;
  await act(async () => documentListeners.fire("visibilitychange"));
  expect(scroller.scrollTop).toBe(scroller.bottom);
  expect(jumpButtons()).toHaveLength(0);

  // A reader up in history is not yanked to the bottom on resume.
  await scrollTo(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  scroller.scrollHeight = 1800;
  await act(async () => documentListeners.fire("visibilitychange"));
  expect(scroller.scrollTop).toBe(100);
  expect(firstRow()).toBe("m-120");
});

it("lands on the latest window, pinned, when the owner sends", async () => {
  await render("thread-1", messages(200));
  await scrollTo(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);

  const pending: PendingOutgoingMessage = {
    id: "p-1",
    threadId: "thread-1",
    text: "on it",
    createdAt: "2026-10-11T10:02:00.000Z",
    attachments: [],
  };
  await render("thread-1", messages(200), { pending: [pending] });
  expect(scroller.scrollTop).toBe(scroller.bottom);
  expect(firstRow()).toBe("m-120");
  expect(lastRow()).toBe("m-199");
  expect(jumpButtons()).toHaveLength(0);
  expect(laterFallback()).toHaveLength(0);
});

it("reopening another chat lands on its latest window", async () => {
  await render("thread-1", messages(200));
  await scrollTo(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);

  await render("thread-2", messages(50));
  expect(firstRow()).toBe("m-0");
  expect(lastRow()).toBe("m-49");
  expect(scroller.scrollTop).toBe(scroller.bottom);
  expect(jumpButtons()).toHaveLength(0);
  expect(laterFallback()).toHaveLength(0);
});

it("listens for resumes while it owns the scroller, and stops on unmount", async () => {
  await render("thread-1", messages(200));
  expect(documentListeners.count("visibilitychange")).toBe(1);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(documentListeners.count("visibilitychange")).toBe(0);
});
