/**
 * The composer-driven re-pin's glide (MessageList's resize effect): a typed
 * line grows the composer about 22px and shrinks the transcript with it, and
 * re-pinning that in one write is the jump the phone reported. These tests
 * drive the resize observer by hand, step the tween's own frames, and read
 * every write to the scroller's offset.
 */
import { MessageId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel";
import {
  JUMP_TO_LATEST_DELAY_MS,
  MessageList,
  RESIZE_PIN_TWEEN_MS,
  VIEWPORT_SETTLE_MS,
} from "./MessageList";

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
  /** Where the browser's smooth scroll is still heading, until it lands or is stopped. */
  smoothTarget: number | null = null;
  readonly scrollTo = vi.fn((options: { top: number; behavior: ScrollBehavior }) => {
    // Like the browser: any new scroll replaces a smooth one in flight.
    this.smoothTarget = null;
    if (options.behavior === "smooth") this.smoothTarget = options.top;
    else this.scrollTop = options.top;
  });
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
  /** The browser finishes whatever smooth scroll is still running. */
  settleSmoothScroll() {
    if (this.smoothTarget === null) return;
    const target = Math.min(this.smoothTarget, this.bottom);
    this.smoothTarget = null;
    this.scrollToTop(target);
  }
  clearWrites() {
    this.writes.length = 0;
  }
}

let renderer: ReactTestRenderer | undefined;
let scroller: FakeScroller;
let resize: () => void;
let reduceMotion: boolean;
let perfOff: string | null;
let composerInDom: boolean;
let composer: {
  height: number;
  isConnected: boolean;
  getBoundingClientRect: () => { height: number };
};
let windowListeners: Listeners;
/** The frames requestAnimationFrame has queued but not run, in order. */
let frameQueue: Array<{ id: number; callback: (time: number) => void }>;
let nextFrameId: number;
let frameClock: number;

const COMPOSER_SELECTOR = "[data-chat-composer-input]";

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
  perfOff = null;
  composerInDom = true;
  composer = {
    height: 44,
    isConnected: true,
    getBoundingClientRect: () => ({ height: composer.height }),
  };
  windowListeners = new Listeners();
  frameQueue = [];
  nextFrameId = 1;
  frameClock = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: (selector: string) =>
      composerInDom && selector === COMPOSER_SELECTOR ? composer : null,
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "bots:perf-off" ? perfOff : null),
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
  composer.height += px;
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

/** The ids of the transcript rows the mounted window currently draws. */
function rowIds(): string[] {
  return renderer!.root
    .findAll((node) => typeof node.props["data-transcript-row"] === "string")
    .map((node) => node.props["data-transcript-row"] as string);
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

it("glides a typed line's re-pin and lands exactly at the bottom", async () => {
  await render();
  expect(scroller.scrollTop).toBe(600);
  scroller.clearWrites();
  await typedLine();
  // No instant write: the re-pin is on its way down over frames.
  expect(scroller.writes).toEqual([]);
  await advanceFrames(1);
  expect(scroller.writes).toEqual([]);
  await advanceFrames(7);
  const gliding = scroller.writes.filter((value) => value > 600 && value < 622);
  expect(gliding.length).toBeGreaterThanOrEqual(4);
  // Every frame of the glide moves towards the bottom, none of them jumps to it.
  for (let index = 1; index < gliding.length; index += 1)
    expect(gliding[index]!).toBeGreaterThan(gliding[index - 1]!);
  await advanceFrames(3);
  expect(scroller.scrollTop).toBe(622);
  // It ends by writing the true bottom, so it lands exactly there.
  expect(scroller.writes[scroller.writes.length - 1]).toBe(1000);
  expect(jumpButtons()).toHaveLength(0);
});

it("the pinned write of an items update mid-glide cannot pull the transcript back", async () => {
  await render("thread-1", messages(40));
  scroller.clearWrites();
  await typedLine();
  await advanceFrames(3);
  expect(scroller.scrollTop).toBeGreaterThan(600);
  expect(scroller.scrollTop).toBeLessThan(622);
  // The layout effect's pinned write, the one an items update raises: the
  // scroller snaps to the bottom between two frames of the glide.
  await act(async () => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  expect(scroller.scrollTop).toBe(622);
  const marker = scroller.writes.length;
  await advanceFrames(12);
  // Frames still ran after the write (the 622 holds), and not one of them
  // pulled back under the bottom the write already reached.
  expect(scroller.writes.slice(marker)).toContain(622);
  for (const value of scroller.writes.slice(marker)) expect(value).toBeGreaterThanOrEqual(622);
  // The glide still ends exactly at the bottom.
  expect(scroller.scrollTop).toBe(622);
  expect(scroller.writes[scroller.writes.length - 1]).toBe(1000);
});

it("a new items array mid-glide (the layout effect's own write) leaves no pull-back", async () => {
  await render("thread-1", messages(40));
  scroller.clearWrites();
  await typedLine();
  await advanceFrames(3);
  expect(scroller.scrollTop).toBeLessThan(622);
  // The ~2s items identity change of an open chat: a fresh items array runs
  // the layout effect, which pins with one write of scrollHeight.
  await render("thread-1", messages(41));
  expect(scroller.scrollTop).toBe(622);
  const marker = scroller.writes.length;
  await advanceFrames(12);
  expect(scroller.writes.slice(marker)).toContain(622);
  for (const value of scroller.writes.slice(marker)) expect(value).toBeGreaterThanOrEqual(622);
  expect(scroller.scrollTop).toBe(622);
});

it("a partial outside write mid-glide is carried on from, never undone", async () => {
  await render();
  scroller.clearWrites();
  await typedLine();
  await advanceFrames(3);
  await act(async () => {
    scroller.scrollTop = 615;
  });
  expect(scroller.scrollTop).toBe(615);
  const marker = scroller.writes.length;
  await advanceFrames(12);
  for (const value of scroller.writes.slice(marker)) expect(value).toBeGreaterThanOrEqual(615);
  expect(scroller.scrollTop).toBe(622);
});

it("a pinned write during the restore cannot move the top off the grown end, and the end re-assert survives", async () => {
  await render();
  await typedLine();
  await advanceFrames(12);
  expect(scroller.scrollTop).toBe(622);
  scroller.clearWrites();
  composer.height = 44;
  scroller.clientHeight = 400;
  await act(async () => resize());
  await advanceFrames(3);
  // Every position the restore passes sits at or past the grown scroller's
  // end, so its first frame's write lands there and holds.
  expect(scroller.scrollTop).toBe(600);
  // The pinned write of an items update inside that window changes nothing...
  await act(async () => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  expect(scroller.scrollTop).toBe(600);
  const marker = scroller.writes.length;
  for (let index = 0; index < 12; index += 1) {
    await advanceFrames(1);
    // ...and step by step no frame takes the top off the end; the landing's
    // re-assert (599 then the bottom) stays inside one frame.
    expect(scroller.scrollTop).toBe(600);
  }
  // The landing still writes the bottom and re-applies the grown list's end
  // the keyboard way (`end - 1` first so WebKit applies it).
  expect(scroller.writes.slice(marker)).toContain(1000);
  expect(scroller.writes.slice(-3)).toEqual([1000, 599, 1000]);
});

it("glides a pasted block that adds more than one line at once", async () => {
  await render();
  scroller.clearWrites();
  // 44 -> 130 (about four lines) at once: the glide covers more than the
  // 80px "near enough" band the ordinary scroll handling allows.
  await typedLine(86);
  await advanceFrames(12);
  expect(scroller.scrollTop).toBe(686);
  expect(
    scroller.writes.filter((value) => value > 600 && value < 686).length,
  ).toBeGreaterThanOrEqual(4);
  expect(jumpButtons()).toHaveLength(0);
});

it("glides the restore when the composer shrinks back, reasserting the end once it lands", async () => {
  await render();
  await typedLine();
  await advanceFrames(12);
  expect(scroller.scrollTop).toBe(622);
  scroller.clearWrites();
  composer.height = 44;
  scroller.clientHeight = 400;
  await act(async () => resize());
  expect(scroller.writes).toEqual([]);
  await advanceFrames(12);
  expect(scroller.scrollTop).toBe(600);
  const gliding = scroller.writes.filter((value) => value > 600 && value < 622);
  expect(gliding.length).toBeGreaterThanOrEqual(4);
  // The landing writes the bottom, then a grown list re-applies its end the
  // way the keyboard path does (`end - 1` first, so WebKit applies it).
  expect(scroller.writes.slice(-3)).toEqual([1000, 599, 1000]);
  scroller.clearWrites();
  await wait(VIEWPORT_SETTLE_MS);
  expect(scroller.writes).toEqual([1000, 599, 1000]);
});

it("the kill switch restores the one instant write", async () => {
  perfOff = "resize-pin-tween";
  await render();
  scroller.clearWrites();
  await typedLine();
  expect(scroller.writes).toEqual([1000]);
  await advanceFrames(5);
  expect(scroller.writes).toEqual([1000]);
  expect(scroller.scrollTop).toBe(622);
});

it("jumps instantly when the reader prefers reduced motion", async () => {
  reduceMotion = true;
  await render();
  scroller.clearWrites();
  await typedLine();
  expect(scroller.writes).toEqual([1000]);
  await advanceFrames(5);
  expect(scroller.writes).toEqual([1000]);
});

it("keeps the instant follow without a composer field to read", async () => {
  composerInDom = false;
  await render();
  scroller.clearWrites();
  await typedLine();
  expect(scroller.writes).toEqual([1000]);
  await advanceFrames(5);
  expect(scroller.writes).toEqual([1000]);
});

it("a resize that is not the composer (a strip appearing) keeps the instant follow", async () => {
  await render();
  scroller.clearWrites();
  scroller.clientHeight = 322;
  await act(async () => resize());
  expect(scroller.writes).toEqual([1000]);
  expect(scroller.scrollTop).toBe(678);
  await advanceFrames(5);
  expect(scroller.writes).toEqual([1000]);
});

it("the keyboard growing the list keeps today's writes, tween or not", async () => {
  await render();
  scroller.clearWrites();
  scroller.clientHeight = 745;
  await act(async () => resize());
  expect(scroller.writes).toEqual([1000, 254, 1000]);
  expect(scroller.scrollTop).toBe(255);
  await wait(VIEWPORT_SETTLE_MS);
  expect(scroller.writes).toEqual([1000, 254, 1000, 1000, 254, 1000]);
});

it("changes nothing when the reader has scrolled away", async () => {
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

it("handles content growing mid-glide: the glide stops and the follow is instant", async () => {
  await render();
  scroller.clearWrites();
  await typedLine();
  await advanceFrames(3);
  const before = scroller.writes.length;
  expect(before).toBeGreaterThan(0);
  scroller.scrollHeight = 1100;
  await act(async () => resize());
  expect(scroller.writes[scroller.writes.length - 1]).toBe(1100);
  await advanceFrames(12);
  expect(scroller.writes).toHaveLength(before + 1);
  expect(scroller.scrollTop).toBe(722);
});

it("a later resize takes the scroll over from the glide", async () => {
  await render();
  scroller.clearWrites();
  await typedLine();
  await advanceFrames(3);
  scroller.clientHeight = 300;
  await act(async () => resize());
  expect(scroller.scrollTop).toBe(700);
  const settled = scroller.writes.length;
  await advanceFrames(12);
  expect(scroller.writes).toHaveLength(settled);
});

it("a finger mid-glide lands the re-pin, and the drag still lets go of the bottom", async () => {
  await render();
  scroller.clearWrites();
  await typedLine();
  await advanceFrames(3);
  expect(scroller.scrollTop).toBeLessThan(622);
  await act(async () => scroller.fire("touchstart"));
  expect(scroller.scrollTop).toBe(622);
  const settled = scroller.writes.length;
  await advanceFrames(12);
  expect(scroller.writes).toHaveLength(settled);
  // The finger's own drag is the reader's: it un-sticks and arms the button.
  scroller.scrollToTop(300);
  await wait(JUMP_TO_LATEST_DELAY_MS);
  expect(jumpButtons()).toHaveLength(1);
});

it("a wheel or a scroll key mid-glide lands it too", async () => {
  await render();
  await typedLine();
  await advanceFrames(3);
  await act(async () => scroller.fire("wheel"));
  expect(scroller.scrollTop).toBe(622);
  await typedLine();
  await advanceFrames(3);
  expect(scroller.scrollTop).toBeLessThan(644);
  await act(async () =>
    windowListeners.fire("keydown", { key: "PageUp", target: { tagName: "DIV" } }),
  );
  expect(scroller.scrollTop).toBe(644);
});

it("the glide's own events leave the pin, the arrow and the mounted window alone", async () => {
  await render("thread-1", messages(100));
  expect(rowIds()).not.toContain("m-1");
  expect(rowIds()).toContain("m-100");
  await typedLine();
  await advanceFrames(12);
  scroller.clearWrites();
  // Downwards this time (the composer shrinking back): those writes must not
  // read as the reader leaving the bottom.
  composer.height = 44;
  scroller.clientHeight = 400;
  await act(async () => resize());
  await advanceFrames(12);
  const gliding = scroller.writes.filter((value) => value < 622 && value > 600);
  expect(gliding.length).toBeGreaterThanOrEqual(4);
  expect(scroller.scrollTop).toBe(600);
  expect(jumpButtons()).toHaveLength(0);
  // Still following: a new reply is mounted into the window.
  await render("thread-1", messages(110));
  expect(rowIds()).toContain("m-110");
});

it("switching chats mid-glide leaves the old glide stopped and the new chat at its bottom", async () => {
  await render("thread-1");
  await typedLine();
  await advanceFrames(3);
  await render("thread-2");
  expect(frameQueue).toEqual([]);
  expect(scroller.scrollTop).toBe(622);
  const settled = scroller.writes.length;
  await advanceFrames(12);
  expect(scroller.writes).toHaveLength(settled);
});

it("unmounting mid-glide leaves nothing running", async () => {
  await render();
  await typedLine();
  await advanceFrames(3);
  const settled = scroller.writes.length;
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(frameQueue).toEqual([]);
  await advanceFrames(12);
  expect(scroller.writes).toHaveLength(settled);
});

it("the glide runs for about RESIZE_PIN_TWEEN_MS of frames", async () => {
  await render();
  await typedLine();
  let frames = 0;
  while (scroller.scrollTop < 622 && frames < 40) {
    await advanceFrames(1);
    frames += 1;
  }
  expect(scroller.scrollTop).toBe(622);
  // One frame starts the clock; the motion then spans RESIZE_PIN_TWEEN_MS of
  // 16ms frames (about 8 of them).
  expect(frames).toBeGreaterThanOrEqual(Math.floor(RESIZE_PIN_TWEEN_MS / 16) - 1);
  expect(frames).toBeLessThanOrEqual(Math.ceil(RESIZE_PIN_TWEEN_MS / 16) + 2);
});
