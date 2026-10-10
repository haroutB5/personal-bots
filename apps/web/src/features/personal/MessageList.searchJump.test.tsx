import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { MessageList } from "./MessageList";
import { clearMessageJump, peekMessageJump, requestMessageJump } from "./pendingMessageJump";

const mocks = vi.hoisted(() => ({ jump: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrls: () => [] }));
vi.mock("~/components/ChatMarkdown", () => ({ default: ({ text }: { text: string }) => text }));
vi.mock("~/components/chat/MessagesTimeline.logic", () => ({
  shouldPreserveAssistantLineBreaks: () => false,
}));
vi.mock("~/session-logic", () => ({ selectMessageImageResources: () => [] }));
vi.mock("./messageReply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messageReply")>()),
  jumpToMessage: (...args: unknown[]) => mocks.jump(...args),
}));
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
  mocks.jump.mockReset();
  vi.stubGlobal("document", {});
  clearMessageJump("thread-1");
  clearMessageJump("thread-2");
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

async function render(threadId = "thread-1", items: ReadonlyArray<never> = []): Promise<void> {
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

it("does nothing when no jump was asked for", async () => {
  await render();
  expect(mocks.jump).not.toHaveBeenCalled();
  expect(scroller.scrollTop).toBe(1000);
});

it("jumps to the requested message, stops following the bottom, and clears the request", async () => {
  mocks.jump.mockReturnValue(true);
  requestMessageJump("thread-1", "m-42");
  await render();
  expect(mocks.jump).toHaveBeenCalledTimes(1);
  expect(mocks.jump.mock.calls[0]![1]).toBe("m-42");
  expect(peekMessageJump("thread-1")).toBeNull();

  // The jump left the bottom: content growing does not pull the list back down.
  scroller.scrollTop = 300;
  scroller.scrollHeight = 1300;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(300);
});

it("keeps trying as the thread loads, until the message is there", async () => {
  mocks.jump.mockReturnValue(false);
  requestMessageJump("thread-1", "m-42");
  await render("thread-1", []);
  expect(mocks.jump).toHaveBeenCalledTimes(1);
  expect(peekMessageJump("thread-1")).toBe("m-42");
  // Not found: the chat still follows the bottom.
  scroller.scrollHeight = 1300;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(1300);

  await render("thread-1", []);
  expect(mocks.jump).toHaveBeenCalledTimes(2);
  mocks.jump.mockReturnValue(true);
  await render("thread-1", []);
  expect(mocks.jump).toHaveBeenCalledTimes(3);
  expect(peekMessageJump("thread-1")).toBeNull();
  await render("thread-1", []);
  expect(mocks.jump).toHaveBeenCalledTimes(3);
});

it("never fires for a request that has lapsed", async () => {
  requestMessageJump("thread-1", "m-42", Date.now() - 60_000);
  await render();
  expect(mocks.jump).not.toHaveBeenCalled();
});

it("a target requested during a latest jump stays put after the old animation and timer settle", async () => {
  await render();
  await act(async () => scroller.scrollToTop(100));
  await act(async () => vi.advanceTimersByTime(1000));
  const latest = renderer!.root.findByProps({ "aria-label": "Jump to latest message" });
  await act(async () => latest.props.onClick());
  expect(scroller.smoothTarget).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(180));

  mocks.jump.mockImplementation(() => {
    scroller.scrollTop = 200;
    return true;
  });
  requestMessageJump("thread-1", "m-42");
  await render("thread-1", []);
  await act(async () => scroller.settleSmoothScroll());
  await act(async () => vi.advanceTimersByTime(2000));
  scroller.scrollHeight = 1300;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(200);
});

it("a request for another chat is left alone", async () => {
  requestMessageJump("thread-2", "m-9");
  await render("thread-1");
  expect(mocks.jump).not.toHaveBeenCalled();
  expect(peekMessageJump("thread-2")).toBe("m-9");
});
