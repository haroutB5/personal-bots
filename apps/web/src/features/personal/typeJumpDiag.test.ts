import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  noteTypeJumpSent,
  resetTypeJumpDiagForTest,
  startTypeJumpWatch,
  stopTypeJumpWatch,
} from "./typeJumpDiag";

type Line = Record<string, unknown>;

/**
 * A composer field stand-in; `text` is here to prove it is never read.
 * `hasAttribute` reads through `this` on purpose: a real element's method
 * throws when it is detached from its receiver, and a typed keystroke in a
 * browser is what found that mistake the first time ("Illegal invocation").
 */
class FakeField {
  isConnected = true;
  height = 46;
  text = "a draft that must never leave the device";
  readonly marker = "data-chat-composer-input";
  getBoundingClientRect(): { readonly height: number } {
    return { height: this.height };
  }
  hasAttribute(name: string): boolean {
    return this.marker === name;
  }
}

class FakeScroller {
  isConnected = true;
  scrollTop = 2_000;
  clientHeight = 700;
  text = "an old message that must never leave the device";
}

let posts: Line[] = [];
let frames: Array<{ readonly handle: number; readonly callback: FrameRequestCallback }> = [];
let nextHandle = 1;
let listeners = new Map<string, (event: unknown) => void>();
let queried: string[] = [];
let transcriptReply: unknown = null;
let field: FakeField;
let scroller: FakeScroller;
let fakeWindow: {
  scrollY: number;
  innerHeight: number;
  visualViewport: { offsetTop: number; height: number };
};
let fakeDocument: {
  activeElement: unknown;
  addEventListener: (name: string, listener: (event: unknown) => void) => void;
  removeEventListener: (name: string) => void;
  querySelector: (selector: string) => unknown;
};

/** One keystroke in the composer: an input event on the field. */
function typeInput(target: unknown = field): void {
  listeners.get("input")?.({ target });
}

/** Runs queued animation frames; ones that keep sampling queue another. */
function runFrames(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const next = frames.shift();
    if (next === undefined) return;
    next.callback(index * 16);
  }
}

function line(type: string): Line {
  const found = posts.find((entry) => entry.type === type);
  expect(found, `no ${type} line was posted`).toBeDefined();
  return found as Line;
}

beforeEach(() => {
  posts = [];
  frames = [];
  nextHandle = 1;
  queried = [];
  listeners = new Map();
  field = new FakeField();
  scroller = new FakeScroller();
  transcriptReply = scroller;
  fakeWindow = {
    scrollY: 0,
    innerHeight: 873,
    visualViewport: { offsetTop: 0, height: 873 },
  };
  fakeDocument = {
    activeElement: null,
    addEventListener: (name, listener) => {
      listeners.set(name, listener);
    },
    removeEventListener: (name) => {
      listeners.delete(name);
    },
    querySelector: (selector) => {
      queried.push(selector);
      return transcriptReply;
    },
  };
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    frames.push({ handle, callback });
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    frames = frames.filter((entry) => entry.handle !== handle);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body) as Line);
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  resetTypeJumpDiagForTest();
  vi.unstubAllGlobals();
});

describe("on-phone typing capture", () => {
  it("folds each read into min, max and changes, and posts the six type- lines", () => {
    startTypeJumpWatch();
    fakeWindow.scrollY = 0;
    typeInput();
    fakeWindow.scrollY = 12;
    typeInput();
    fakeWindow.scrollY = 4;
    typeInput();
    noteTypeJumpSent();
    expect(posts.map((entry) => entry.type)).toEqual([
      "type-docy",
      "type-vvoff",
      "type-vvh",
      "type-scroll",
      "type-comp",
      "type-taps",
    ]);
    expect(line("type-docy")).toEqual({
      event: "perf",
      type: "type-docy",
      ms: 0,
      at: 12,
      recent: 2,
    });
    expect(line("type-taps")).toEqual({ event: "perf", type: "type-taps", recent: 3 });
  });

  it("reports the keyboard resize, the list re-pin and the growing field", () => {
    startTypeJumpWatch();
    typeInput();
    fakeWindow.visualViewport.height = 487;
    fakeWindow.visualViewport.offsetTop = 0;
    fakeWindow.innerHeight = 487;
    field.height = 90;
    scroller.scrollTop = 1_500;
    scroller.clientHeight = 640;
    typeInput();
    noteTypeJumpSent();
    expect(line("type-vvh")).toEqual({
      event: "perf",
      type: "type-vvh",
      ms: 487,
      at: 873,
      recent: 1,
      closed: 487,
    });
    expect(line("type-scroll")).toEqual({
      event: "perf",
      type: "type-scroll",
      ms: 1_500,
      at: 2_000,
      recent: 1,
      closed: 640,
    });
    expect(line("type-comp")).toEqual({
      event: "perf",
      type: "type-comp",
      ms: 46,
      at: 90,
      recent: 1,
    });
  });

  it("keeps sampling per frame while the field is focused", () => {
    fakeDocument.activeElement = field;
    startTypeJumpWatch();
    typeInput();
    fakeWindow.scrollY = 30;
    runFrames(1);
    fakeWindow.scrollY = 0;
    runFrames(1);
    noteTypeJumpSent();
    expect(line("type-docy")).toEqual({
      event: "perf",
      type: "type-docy",
      ms: 0,
      at: 30,
      recent: 2,
    });
    // The send took the batch and stopped the loop with it.
    expect(frames.length).toBe(0);
  });

  it("rests the loop once the field is unfocused and starts again on the next keystroke", () => {
    startTypeJumpWatch();
    typeInput();
    expect(frames.length).toBe(1);
    fakeDocument.activeElement = null;
    runFrames(120);
    expect(frames.length).toBe(0);
    typeInput();
    expect(frames.length).toBe(1);
    noteTypeJumpSent();
  });

  it("rounds fractional offsets and clamps negative rubber-band overscroll", () => {
    fakeWindow.scrollY = -3.6;
    scroller.scrollTop = 1_500.4;
    startTypeJumpWatch();
    typeInput();
    fakeWindow.scrollY = 2.5;
    scroller.scrollTop = 1_500.6;
    typeInput();
    noteTypeJumpSent();
    expect(line("type-docy")).toEqual({
      event: "perf",
      type: "type-docy",
      ms: 0,
      at: 3,
      recent: 1,
    });
    expect(line("type-scroll").ms).toBe(1_500);
    expect(line("type-scroll").at).toBe(1_501);
  });

  it("still posts the full set when nothing moved", () => {
    startTypeJumpWatch();
    typeInput();
    noteTypeJumpSent();
    expect(posts.length).toBe(6);
    expect(line("type-docy")).toEqual({
      event: "perf",
      type: "type-docy",
      ms: 0,
      at: 0,
      recent: 0,
    });
    expect(line("type-comp")).toEqual({
      event: "perf",
      type: "type-comp",
      ms: 46,
      at: 46,
      recent: 0,
    });
  });

  it("posts at most one batch per sent message", () => {
    startTypeJumpWatch();
    typeInput();
    noteTypeJumpSent();
    expect(posts.length).toBe(6);
    // A second send with no typing between them has nothing to add.
    noteTypeJumpSent();
    expect(posts.length).toBe(6);
    // The next message's typing is its own batch.
    typeInput();
    noteTypeJumpSent();
    expect(posts.length).toBe(12);
  });

  it("posts typing that was never sent when the chat closes, and nothing after", () => {
    startTypeJumpWatch();
    typeInput();
    stopTypeJumpWatch();
    expect(posts.length).toBe(6);
    expect(listeners.has("input")).toBe(false);
    expect(frames.length).toBe(0);
    typeInput();
    expect(posts.length).toBe(6);
  });

  it("leaves out a metric it could never read", () => {
    // Without the transcript marker only its two scroll metrics are missing;
    // the composer is in hand from the input event, so it still reports.
    transcriptReply = null;
    startTypeJumpWatch();
    typeInput();
    noteTypeJumpSent();
    expect(posts.map((entry) => entry.type)).toEqual([
      "type-docy",
      "type-vvoff",
      "type-vvh",
      "type-comp",
      "type-taps",
    ]);
  });

  it("finds the transcript by its marker and re-finds it when it leaves the document", () => {
    startTypeJumpWatch();
    typeInput();
    expect(queried).toContain("[data-chat-transcript]");
    scroller.isConnected = false;
    transcriptReply = { isConnected: true, scrollTop: 100, clientHeight: 300, text: "fresh" };
    typeInput();
    noteTypeJumpSent();
    expect(line("type-scroll")).toEqual({
      event: "perf",
      type: "type-scroll",
      ms: 100,
      at: 2_000,
      recent: 1,
      closed: 300,
    });
  });

  it("ignores typing anywhere but the composer, and before the chat is watched", () => {
    typeInput();
    noteTypeJumpSent();
    expect(posts).toEqual([]);
    startTypeJumpWatch();
    typeInput({ hasAttribute: () => false });
    typeInput(null);
    noteTypeJumpSent();
    expect(posts).toEqual([]);
  });

  it("honours the rum kill switch", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "bots:perf-off" ? "rum" : null),
    });
    startTypeJumpWatch();
    typeInput();
    noteTypeJumpSent();
    expect(posts).toEqual([]);
  });

  it("emits event perf, a short type- label, and numbers only", () => {
    startTypeJumpWatch();
    typeInput();
    noteTypeJumpSent();
    expect(posts.length).toBe(6);
    for (const entry of posts) {
      expect(entry.event).toBe("perf");
      expect(typeof entry.type).toBe("string");
      expect((entry.type as string).startsWith("type-")).toBe(true);
      expect((entry.type as string).length).toBeLessThanOrEqual(32);
      for (const [key, value] of Object.entries(entry)) {
        if (key === "event" || key === "type") continue;
        expect(["ms", "at", "recent", "closed"]).toContain(key);
        expect(Number.isInteger(value)).toBe(true);
        expect(value as number).toBeGreaterThanOrEqual(0);
      }
    }
    // None of the fakes' text (or anything else written down) is in a payload.
    const payload = JSON.stringify(posts);
    expect(payload).not.toContain(field.text);
    expect(payload).not.toContain(scroller.text);
  });

  it("never reads the draft, even when reading it would throw", () => {
    // Every fake carries the kind of content that must not leak, guarded by
    // getters that throw: a capture that touched any of it fails here.
    const guardedField = {
      isConnected: true,
      get text(): string {
        throw new Error("the draft was read");
      },
      get value(): string {
        throw new Error("the draft was read");
      },
      get id(): string {
        throw new Error("a field id was read");
      },
      getAttribute: () => {
        throw new Error("an attribute value was read");
      },
      getBoundingClientRect: () => ({ height: 46 }),
      hasAttribute: (name: string) => name === "data-chat-composer-input",
    };
    const guardedScroller = {
      isConnected: true,
      scrollTop: 100,
      clientHeight: 300,
      get text(): string {
        throw new Error("message text was read");
      },
      get textContent(): string {
        throw new Error("message text was read");
      },
      get id(): string {
        throw new Error("a message id was read");
      },
    };
    field = guardedField as unknown as FakeField;
    transcriptReply = guardedScroller;
    startTypeJumpWatch();
    typeInput(guardedField);
    noteTypeJumpSent();
    expect(posts.length).toBe(6);
    for (const entry of posts) {
      for (const key of Object.keys(entry)) {
        expect(["event", "type", "ms", "at", "recent", "closed"]).toContain(key);
      }
    }
  });
});
