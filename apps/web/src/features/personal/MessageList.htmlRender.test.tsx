/**
 * A page a bot showed with its page tool is drawn inline in the bot chat, in
 * the same sandboxed frame the developer chat uses (Harout, 2026-11-12: the
 * widget mockups never appeared in the chat).
 */
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel";
import { MessageList } from "./MessageList";

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
vi.mock("~/components/chat/HtmlRenderFrame", () => ({
  HtmlRenderFrame: (props: Record<string, unknown>) => <div data-frame="" {...props} />,
}));
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
  windowListeners = new Listeners();
  documentListeners = new Listeners();
  // oxlint-disable-next-line t3code/require-disposable-render -- this file's react-test-renderer harness owns the act environment
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
        void callback;
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

const page = {
  attachmentId: "thread-1-abc-html",
  title: "hbots widget mockups",
  height: 640,
  heights: [[320, 900] as const, [728, 640] as const],
};

it("draws a page the bot showed in the sandboxed frame, with the chat's own thread", async () => {
  await render("thread-1", [
    { kind: "divider", id: "divider:1", at: new Date("2026-10-11T10:00:00.000Z") },
    { kind: "html-render", id: "item-1", createdAt: "2026-10-11T10:00:01.000Z", htmlRender: page },
  ]);
  const frames = renderer!.root.findAll((node) => node.props["data-frame"] === "");
  expect(frames).toHaveLength(1);
  expect(frames[0]!.props.htmlRender).toEqual(page);
  expect(frames[0]!.props.environmentId).toBe("env-1");
  expect(frames[0]!.props.threadRef).toEqual({ threadId: "thread-1" });
});
