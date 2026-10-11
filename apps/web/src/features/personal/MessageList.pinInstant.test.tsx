/**
 * The transcript's re-pin after a size change (MessageList's resize effect).
 * A typed line grows the composer about 22px and shrinks the transcript with
 * it, and the re-pin that follows is one instant write in the same step: no
 * animation frames, no per-frame stepping (1.66.27, after Harout's phone A/B
 * showed that the 1.66.23 glide to the new bottom was itself the movement he
 * saw while typing). These tests drive the resize observer by hand and read
 * every write to the scroller's offset.
 */
import { MessageId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel";
import { JUMP_TO_LATEST_DELAY_MS, MessageList, VIEWPORT_SETTLE_MS } from "./MessageList";

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
  fire(type: string, event: unknown) {
    for (const listener of this.map.get(type) ?? []) listener(event);
  }
}

/**
 * A browser-like scroller: 1000px of transcript in a 400px window, offsets
 * clamped to the end, and a scroll event reported for every change (the same
 * event a real scrollTop write raises).
 */
class FakeScroller {
  private top = 0;
  scrollHeight = 1000;
  clientHeight = 400;
  /** Every offset written, in order and before clamping (a repeat write too). */
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
/** The frames requestAnimationFrame has queued but not run, in order. */
let frameQueue: Array<{ id: number; callback: (time: number) => void }>;
let nextFrameId: number;
let frameClock: number;
let storageWrites: string[];

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
  approvalsNowMs: Date.parse("2026-09-21T10:00:00.000Z"),
  errorText: null,
  loadEarlier: null,
  now: new Date("2026-09-14T10:01:00.000Z"),
  describeTurn: () => "",
  renderDelegation: () => null,
} as const;

beforeEach(() => {
  vi.useFakeTimers();
  scroller = new FakeScroller();
  resize = () => {};
  windowListeners = new Listeners();
  frameQueue = [];
  nextFrameId = 1;
  frameClock = 0;
  storageWrites = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", {
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  // Nothing in this path may touch the phone's kill switches.
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: (key: string) => storageWrites.push(key),
    removeItem: (key: string) => storageWrites.push(key),
  });
  vi.stubGlobal("window", {
    requestAnimationFrame: (callback: (time: number) => void) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frameQueue.push({ id, callback });
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      frameQueue = frameQueue.filter((entry) => entry.id !== id);
    },
    matchMedia: (query: string) => ({ matches: query.includes("reduce") }),
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
        const className = (node.props as { className?: unknown }).className;
        return typeof className === "string" && className.includes("personal-scroll-quiet")
          ? scroller
          : {};
      },
    });
  });
}

/** Runs the frames queued at the call: one animation frame per step, 16ms apart. */
async function advanceFrames(count: number, stepMs = 16): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    frameClock += stepMs;
    const due = frameQueue;
    frameQueue = [];
    await act(async () => {
      for (const entry of due) entry.callback(frameClock);
    });
  }
}

/** One typed line wraps: the composer gains a line and the scroller loses it. */
async function typedLine(px = 22): Promise<void> {
  scroller.clientHeight -= px;
  await act(async () => resize());
}

async function wait(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function jumpButtons() {
  return renderer!.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"] === "Jump to latest message",
  );
}

const messageItem = (id: string, role: "user" | "assistant", text: string): ConversationItem => ({
  kind: "message",
  id,
  message: {
    id: MessageId.make(id),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
  },
});

const messages = (count: number): ConversationItem[] =>
  Array.from({ length: count }, (_, index) =>
    messageItem(`m-${index + 1}`, index % 2 === 0 ? "user" : "assistant", `Message ${index + 1}`),
  );

it("re-pins a typed line in one instant write, in the same step", async () => {
  await render("thread-1", messages(40));
  scroller.clearWrites();
  await typedLine();
  // One write, already at the new bottom (1000 clamps to 622), in the same
  // step the resize was reported: no frame of its own, no slide.
  expect(scroller.writes).toEqual([1000]);
  expect(scroller.scrollTop).toBe(622);
  await advanceFrames(12);
  expect(scroller.writes).toEqual([1000]);
  expect(scroller.scrollTop).toBe(622);
  expect(frameQueue).toHaveLength(0);
  expect(jumpButtons()).toHaveLength(0);
});

it("re-pins a typed line in one write with rows mounted across the wrap", async () => {
  await render("thread-1", messages(8));
  scroller.clearWrites();
  await typedLine();
  expect(scroller.writes).toEqual([1000]);
  await advanceFrames(12);
  expect(scroller.writes).toEqual([1000]);
  expect(
    renderer!.root.findAll((node) => typeof node.props["data-transcript-row"] === "string"),
  ).toHaveLength(8);
});

it("re-asserts the grown end the WebKit way once the keyboard settles", async () => {
  await render();
  scroller.clearWrites();
  // The keyboard going down: the list grows under a scroll that no longer fits.
  scroller.clientHeight = 745;
  await act(async () => resize());
  expect(scroller.writes).toEqual([1000, 254, 1000]);
  expect(scroller.scrollTop).toBe(255);
  await wait(VIEWPORT_SETTLE_MS);
  expect(scroller.writes).toEqual([1000, 254, 1000, 1000, 254, 1000]);
});

it("re-pins instantly when the composer shrinks back (a backspace)", async () => {
  await render();
  scroller.clearWrites();
  // The field lost a line: this scroller gained it back.
  await typedLine(-22);
  expect(scroller.writes).toEqual([1000, 577, 1000]);
  expect(scroller.scrollTop).toBe(578);
  await wait(VIEWPORT_SETTLE_MS);
  expect(scroller.writes).toEqual([1000, 577, 1000, 1000, 577, 1000]);
  expect(scroller.scrollTop).toBe(578);
});

it("writes nothing for a reader who has scrolled away", async () => {
  await render();
  scroller.scrollToTop(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
  scroller.clearWrites();
  await typedLine();
  await advanceFrames(12);
  expect(scroller.writes).toEqual([]);
  expect(scroller.scrollTop).toBe(100);
});

it("leaves the phone's kill switches alone while it re-pins", async () => {
  await render();
  await typedLine();
  await typedLine(-22);
  await wait(VIEWPORT_SETTLE_MS);
  expect(storageWrites).toEqual([]);
});
