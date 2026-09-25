import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { JUMP_TO_LATEST_DELAY_MS, MessageList } from "./MessageList";

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

/** A stand-in for the scroller: 1000px of transcript in a 400px window. */
class FakeScroller {
  scrollTop = 600;
  scrollHeight = 1000;
  clientHeight = 400;
  readonly listeners = new Map<string, Set<() => void>>();
  readonly scrollTo = vi.fn((options: { top: number; behavior: ScrollBehavior }) => {
    void options;
  });
  addEventListener(type: string, listener: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: reduceMotion && query.includes("reduce") }),
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
