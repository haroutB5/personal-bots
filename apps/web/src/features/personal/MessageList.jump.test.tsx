import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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

/** A stand-in for the scroller: 1000px of transcript in a 400px window. */
class FakeScroller {
  scrollTop = 600;
  scrollHeight = 1000;
  clientHeight = 400;
  readonly listeners = new Listeners();
  /** Where the browser's smooth scroll is still heading, until it lands or is stopped. */
  smoothTarget: number | null = null;
  readonly scrollTo = vi.fn((options: { top: number; behavior: ScrollBehavior }) => {
    // Like the browser: any new scroll replaces a smooth one in flight.
    this.smoothTarget = null;
    if (options.behavior === "smooth") this.smoothTarget = options.top;
    else this.scrollTop = Math.min(options.top, this.bottom);
  });
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.add(type, listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.remove(type, listener);
  }
  fire(type: string, event: unknown = { target: this }) {
    this.listeners.fire(type, event);
  }
  /** The browser finishes whatever smooth scroll is still running. */
  settleSmoothScroll() {
    if (this.smoothTarget === null) return;
    const target = Math.min(this.smoothTarget, this.bottom);
    this.smoothTarget = null;
    this.scrollToTop(target);
  }
  /** The reader drags to `top`; the browser reports it as a scroll event. */
  scrollToTop(top: number) {
    this.scrollTop = top;
    this.fire("scroll");
  }
  get bottom() {
    return this.scrollHeight - this.clientHeight;
  }
}

let renderer: ReactTestRenderer | undefined;
let scroller: FakeScroller;
let resize: () => void;
let reduceMotion: boolean;
let windowListeners: Listeners;

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
  reduceMotion = false;
  windowListeners = new Listeners();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: reduceMotion && query.includes("reduce") }),
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

async function render(threadId = "thread-1"): Promise<void> {
  const element = (
    <MessageList {...BASE_PROPS} threadRef={{ threadId } as unknown as ScopedThreadRef} />
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

function jumpButtons() {
  return renderer!.root.findAll(
    (node) => node.type === "button" && node.props["aria-label"] === "Jump to latest message",
  );
}

async function scrollTo(top: number) {
  await act(async () => scroller.scrollToTop(top));
}

async function wait(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

it("opens at the latest message with the button hidden", async () => {
  await render();
  expect(scroller.scrollTop).toBe(1000);
  await scrollTo(scroller.bottom);
  await wait(JUMP_TO_LATEST_DELAY_MS * 2);
  expect(jumpButtons()).toHaveLength(0);
});

it("stays hidden when the reader is only a little way up", async () => {
  await render();
  await scrollTo(scroller.bottom - 40);
  await wait(JUMP_TO_LATEST_DELAY_MS * 2);
  expect(jumpButtons()).toHaveLength(0);
});

it("appears once scrolling up settles, not on every momentum frame", async () => {
  await render();
  await scrollTo(400);
  await wait(JUMP_TO_LATEST_DELAY_MS - 50);
  // Momentum keeps producing scroll events: each one restarts the wait.
  await scrollTo(350);
  await wait(JUMP_TO_LATEST_DELAY_MS - 50);
  await scrollTo(300);
  await wait(JUMP_TO_LATEST_DELAY_MS - 50);
  expect(jumpButtons()).toHaveLength(0);
  await wait(50);
  expect(jumpButtons()).toHaveLength(1);
});

it("hides again when the reader scrolls back to the bottom", async () => {
  await render();
  await scrollTo(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
  await scrollTo(scroller.bottom);
  expect(jumpButtons()).toHaveLength(0);
});

it("a scroll back down before the delay cancels the pending show", async () => {
  await render();
  await scrollTo(100);
  await scrollTo(scroller.bottom);
  await wait(JUMP_TO_LATEST_DELAY_MS * 2);
  expect(jumpButtons()).toHaveLength(0);
});

it("tapping scrolls smoothly to the latest message, hides, and follows new replies again", async () => {
  await render();
  await scrollTo(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  const button = jumpButtons()[0]!;
  const preventDefault = vi.fn();
  button.props.onPointerDown({ preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  await act(async () => button.props.onClick());

  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
  expect(jumpButtons()).toHaveLength(0);

  // The smooth scroll's own frames are still far from the bottom: they must
  // not bring the button back.
  await scrollTo(300);
  await scrollTo(500);
  await wait(JUMP_TO_LATEST_DELAY_MS * 2);
  expect(jumpButtons()).toHaveLength(0);

  // A reply lands mid-scroll: the list follows it to the bottom.
  scroller.scrollHeight = 1300;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(1300);
  await scrollTo(scroller.bottom);

  // And it keeps following the next one after the jump has finished.
  scroller.scrollHeight = 1600;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(1600);
  expect(jumpButtons()).toHaveLength(0);
});

it("jumps instantly when the reader prefers reduced motion", async () => {
  reduceMotion = true;
  await render();
  await scrollTo(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  await act(async () => jumpButtons()[0]!.props.onClick());
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });
});

it("a finger on the list during the jump hands the scroll back to the reader", async () => {
  await render();
  await scrollTo(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  await act(async () => jumpButtons()[0]!.props.onClick());
  scroller.scrollTop = 200;
  await act(async () => scroller.fire("touchstart"));
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
  // Stopped following: new content does not yank the reader down.
  scroller.scrollHeight = 1300;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(200);
});

it("switching chats resets it: the next chat opens at the bottom, button hidden", async () => {
  await render("thread-1");
  await scrollTo(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
  await render("thread-2");
  expect(jumpButtons()).toHaveLength(0);
  expect(scroller.scrollTop).toBe(1000);
  // And it follows the new chat's replies.
  scroller.scrollHeight = 1200;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(1200);
});

async function tapJump() {
  await scrollTo(100);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  await act(async () => jumpButtons()[0]!.props.onClick());
  expect(scroller.smoothTarget).toBe(1000);
  // The smooth scroll is part way down.
  await scrollTo(200);
}

it("a finger during the jump stops it where it is, and the arrow works as usual after", async () => {
  await render();
  await tapJump();
  await act(async () => scroller.fire("touchstart"));
  expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: "instant" });
  // Nothing is left for the browser to finish: the reader stays put.
  await act(async () => scroller.settleSmoothScroll());
  await act(async () => windowListeners.fire("touchend", {}));
  expect(scroller.scrollTop).toBe(200);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
  // A reply does not pull them down, and scrolling back to the bottom hides it.
  scroller.scrollHeight = 1300;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(200);
  await scrollTo(scroller.bottom);
  expect(jumpButtons()).toHaveLength(0);
  scroller.scrollHeight = 1500;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(1500);
});

it("a wheel during the jump stops it too", async () => {
  await render();
  await tapJump();
  await act(async () => scroller.fire("wheel"));
  await act(async () => scroller.settleSmoothScroll());
  expect(scroller.scrollTop).toBe(200);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
});

it("a scroll key during the jump stops it, but typing in the composer does not", async () => {
  await render();
  await tapJump();
  await act(async () =>
    windowListeners.fire("keydown", { key: " ", target: { tagName: "TEXTAREA" } }),
  );
  expect(scroller.smoothTarget).toBe(1000);
  await act(async () => windowListeners.fire("keydown", { key: "PageUp", target: {} }));
  await act(async () => scroller.settleSmoothScroll());
  expect(scroller.scrollTop).toBe(200);
});

it("stays at the latest message when a strip appearing shrinks the list", async () => {
  await render();
  scroller.scrollTop = scroller.bottom;
  // The Routines strip loads late and takes 198px; the browser reports the
  // scroll before the resize.
  scroller.clientHeight = 202;
  await scrollTo(600);
  expect(scroller.scrollTop).toBeGreaterThanOrEqual(scroller.bottom);
  await act(async () => resize());
  await wait(JUMP_TO_LATEST_DELAY_MS * 2);
  expect(scroller.scrollTop).toBeGreaterThanOrEqual(scroller.bottom);
  expect(jumpButtons()).toHaveLength(0);
  // Still following: the next reply is followed.
  scroller.scrollHeight = 1300;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(1300);
});

it("stays at the latest message when the list grows and the content reflows", async () => {
  await render();
  scroller.scrollTop = scroller.bottom;
  scroller.clientHeight = 500;
  scroller.scrollHeight = 1400;
  await scrollTo(500);
  await wait(JUMP_TO_LATEST_DELAY_MS * 2);
  expect(scroller.scrollTop).toBe(1400);
  expect(jumpButtons()).toHaveLength(0);
});

it("the reader scrolling up while a reply grows still lets go", async () => {
  await render();
  await act(async () => scroller.fire("touchstart"));
  scroller.scrollHeight = 1300;
  await scrollTo(300);
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(300);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
});

it("a reader scroll-up just after lifting a finger still lets go", async () => {
  await render();
  await act(async () => scroller.fire("touchstart"));
  await act(async () => windowListeners.fire("touchend", {}));
  scroller.scrollHeight = 1300;
  await scrollTo(300);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
});

it("a tap on the list just before a strip appears does not let go of the bottom", async () => {
  await render();
  await act(async () => scroller.fire("touchstart"));
  await act(async () => windowListeners.fire("touchend", {}));
  scroller.clientHeight = 202;
  await scrollTo(scroller.scrollTop);
  await act(async () => resize());
  await wait(JUMP_TO_LATEST_DELAY_MS * 2);
  expect(scroller.scrollTop).toBeGreaterThanOrEqual(scroller.bottom);
  expect(jumpButtons()).toHaveLength(0);
});

/** Records every write to the scroller's offset, in order. */
function recordScrollWrites(): number[] {
  const writes: number[] = [];
  let top = scroller.scrollTop;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      writes.push(value);
      top = value;
    },
  });
  return writes;
}

it("re-applies the end when the keyboard goes down, and again once it has settled", async () => {
  // 26 Sep, iPhone: the keyboard closed, the list grew by its height, and
  // WebKit kept the old offset, leaving a keyboard-sized blank band under the
  // latest message. A write to a different offset first makes it a real scroll.
  await render();
  await scrollTo(scroller.bottom);
  const writes = recordScrollWrites();
  scroller.clientHeight = 745;
  await act(async () => resize());
  const end = scroller.scrollHeight - scroller.clientHeight;
  expect(writes).toEqual([1000, end - 1, 1000]);
  expect(scroller.scrollTop).toBe(1000);

  await wait(VIEWPORT_SETTLE_MS);
  expect(writes).toEqual([1000, end - 1, 1000, 1000, end - 1, 1000]);
  expect(jumpButtons()).toHaveLength(0);
});

it("leaves a reader who scrolled up alone when the keyboard goes down", async () => {
  await render();
  await act(async () => scroller.fire("touchstart"));
  await scrollTo(100);
  await act(async () => windowListeners.fire("touchend", {}));
  await wait(JUMP_TO_LATEST_DELAY_MS);
  const writes = recordScrollWrites();
  scroller.clientHeight = 745;
  await act(async () => resize());
  await wait(VIEWPORT_SETTLE_MS);
  expect(writes).toEqual([]);
  expect(scroller.scrollTop).toBe(100);
});

it("does not nudge when only the content grows (a reply streaming in)", async () => {
  await render();
  await scrollTo(scroller.bottom);
  const writes = recordScrollWrites();
  scroller.scrollHeight = 1300;
  await act(async () => resize());
  await wait(VIEWPORT_SETTLE_MS);
  expect(writes).toEqual([1300]);
});
