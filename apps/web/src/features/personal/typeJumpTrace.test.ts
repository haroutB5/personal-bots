import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PersonalTypeJumpTrace } from "@t3tools/contracts";
import { PERF_OFF_STORAGE_KEY } from "./perfFlags";
import { resetTranscriptPinStateForTest, setTranscriptPinned } from "./transcriptPinState";
import {
  noteTypeJumpTraceSent,
  resetTypeJumpTraceForTest,
  startTypeJumpTrace,
  stopTypeJumpTrace,
} from "./typeJumpTrace";

const decodeSync = Schema.decodeUnknownSync(PersonalTypeJumpTrace);

interface Post {
  readonly url: string;
  readonly init: {
    readonly method?: string;
    readonly credentials?: string;
    readonly body?: string;
  };
  readonly body: Record<string, unknown>;
}

class FakeBanner {
  textContent = "";
  readonly style = { cssText: "" };
  readonly attributes = new Map<string, string>();
  removed = false;
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  remove(): void {
    this.removed = true;
  }
}

class FakeField {
  isConnected = true;
  height = 44;
  scrollTop = 0;
  text = "a draft that must never leave the device";
  readonly marker = "data-chat-composer-input";
  getBoundingClientRect(): { readonly height: number; readonly top: number } {
    return { height: this.height, top: 500 };
  }
  hasAttribute(name: string): boolean {
    return this.marker === name;
  }
}

class FakeRow {
  constructor(public top: number) {}
  getBoundingClientRect(): { readonly top: number } {
    return { top: this.top };
  }
}

class FakeScroller {
  isConnected = true;
  scrollTop = 1_000;
  clientHeight = 487;
  scrollHeight = 1_600;
  // The wrappers stay identical objects between reads, like real DOM rows.
  rows: FakeRow[] = [new FakeRow(300), new FakeRow(420)];
  readonly marker = "data-chat-transcript";
  querySelectorAll(selector: string): ArrayLike<FakeRow> {
    if (selector !== "[data-transcript-row]") return [];
    return this.rows;
  }
}

class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let posts: Post[] = [];
let banners: FakeBanner[] = [];
let appendedBanners: FakeBanner[] = [];
let listeners = new Map<string, Array<(event: unknown) => void>>();
let field: FakeField;
let scroller: FakeScroller;
let nowMs = 0;
let frames: Array<{ readonly handle: number; readonly callback: (time: number) => void }> = [];
let nextFrameHandle = 1;
let observers: Array<{ callback: () => void; disconnected: boolean }> = [];
let localStorageFake: FakeStorage;
let sessionStorageFake: FakeStorage;
let hasFocus = true;
let fakeDocument: Record<string, unknown>;
let fakeWindow: Record<string, unknown>;

function addListener(type: string, handler: (event: unknown) => void): void {
  const list = listeners.get(type) ?? [];
  list.push(handler);
  listeners.set(type, list);
}

function fire(type: string, event: Record<string, unknown> = {}): void {
  for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
}

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function focusField(): void {
  (fakeDocument as { activeElement: unknown }).activeElement = field;
  fire("focusin", { target: field });
}

function typeInput(): void {
  fire("input", { target: field });
}

function runFrames(count: number, stepMs = 16): void {
  for (let index = 0; index < count; index += 1) {
    const next = frames.shift();
    if (next === undefined) return;
    nowMs += stepMs;
    next.callback(nowMs);
  }
}

function lastPost(): Post {
  expect(posts.length).toBeGreaterThan(0);
  return posts[posts.length - 1]!;
}

function bodySamples(body: Record<string, unknown>): Array<Array<number>> {
  return body.samples as Array<Array<number>>;
}

/** One full round: focus, first typed-line growth, then a stop reason. */
async function captureRound(stop: () => void = noteTypeJumpTraceSent): Promise<void> {
  focusField();
  field.height += 22;
  typeInput();
  await tick();
  stop();
}

beforeEach(() => {
  posts = [];
  banners = [];
  appendedBanners = [];
  listeners = new Map();
  frames = [];
  nextFrameHandle = 1;
  observers = [];
  nowMs = 0;
  hasFocus = true;
  field = new FakeField();
  scroller = new FakeScroller();
  localStorageFake = new FakeStorage();
  sessionStorageFake = new FakeStorage();

  fakeDocument = {
    activeElement: null,
    visibilityState: "visible",
    hasFocus: () => hasFocus,
    body: {
      append: (element: unknown) => {
        if (element instanceof FakeBanner) appendedBanners.push(element);
      },
    },
    createElement: () => {
      const banner = new FakeBanner();
      banners.push(banner);
      return banner;
    },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      addListener(type, handler);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== handler),
      );
    },
    querySelector: (selector: string) => {
      if (selector === "[data-chat-transcript]") return scroller;
      if (selector === 'script[type="module"][src]') {
        return { getAttribute: (name: string) => (name === "src" ? "/assets/index-abc.js" : null) };
      }
      return null;
    },
  };
  fakeWindow = {
    scrollY: 0,
    innerHeight: 873,
    innerWidth: 390,
    devicePixelRatio: 3,
    visualViewport: { offsetTop: 0, height: 487, scale: 1 },
    matchMedia: () => ({ matches: false }),
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      addListener(type, handler);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== handler),
      );
    },
  };

  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("localStorage", localStorageFake);
  vi.stubGlobal("sessionStorage", sessionStorageFake);
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    const handle = nextFrameHandle;
    nextFrameHandle += 1;
    frames.push({ handle, callback });
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    frames = frames.filter((entry) => entry.handle !== handle);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly entry: { callback: () => void; disconnected: boolean };
      constructor(callback: () => void) {
        this.entry = { callback, disconnected: false };
        observers.push(this.entry);
      }
      observe(): void {}
      disconnect(): void {
        this.entry.disconnected = true;
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; credentials?: string; body?: string }) => {
      posts.push({ url, init, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
      return new Response(null, { status: 204 });
    }),
  );

  resetTranscriptPinStateForTest();
  resetTypeJumpTraceForTest(() => nowMs);
});

afterEach(() => {
  vi.useRealTimers();
  resetTypeJumpTraceForTest();
  resetTranscriptPinStateForTest();
  vi.unstubAllGlobals();
});

describe("ordered typing trace rounds", () => {
  it("captures one contract-valid passive round on the first typed-line growth and posts on send", async () => {
    startTypeJumpTrace();
    focusField();
    runFrames(2);
    scroller.scrollTop = 1_020;
    field.height = 66;
    typeInput();
    await tick();
    runFrames(2);
    noteTypeJumpTraceSent();

    expect(posts.length).toBe(1);
    const { url, init, body } = lastPost();
    expect(url).toBe("/api/personal/type-jump-trace");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(body.protocol).toBe("typejump-v1");
    expect(body.mode).toBe("passive");
    expect(body.stop).toBe("send");
    expect(body.writes).toEqual([]);
    expect(body.captureId).toMatch(/^[a-f0-9]{32}$/);
    expect(body.entryAsset).toBe("index-abc.js");
    expect(body.workerAsset).toBe("");
    expect(body.standalone).toBe(false);
    expect(body.tween).toBe(true);
    expect(body.viewport).toEqual([390, 300, 100]);
    const samples = bodySamples(body);
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples[0]![1]).toBe(0);
    expect(samples.some((row) => row[0] === 7)).toBe(true);
    expect(samples.at(-1)![0]).toBe(8);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]![1]!).toBeGreaterThanOrEqual(samples[index - 1]![1]!);
    }
    expect(decodeSync(JSON.parse(JSON.stringify(body)))).toBeDefined();
  });

  it("never sends draft or chat text, only numbers and asset basenames", async () => {
    startTypeJumpTrace();
    await captureRound();
    const serialized = JSON.stringify(lastPost().body);
    expect(serialized).not.toContain("draft");
    expect(serialized).not.toContain("message that must never");
    expect(serialized).not.toContain("http");
    expect(Object.keys(lastPost().body).sort()).toEqual([
      "captureId",
      "composerAsset",
      "entryAsset",
      "frozen",
      "mode",
      "protocol",
      "reducedMotion",
      "samples",
      "standalone",
      "stop",
      "tween",
      "viewport",
      "workerAsset",
      "writes",
    ]);
  });

  it("keeps two seconds of <=30Hz prehistory while armed and nothing while unfocused", async () => {
    startTypeJumpTrace();
    focusField();
    runFrames(40, 16);
    // Unfocused frames end an armed session outright; it can re-arm on focus.
    (fakeDocument as { activeElement: unknown }).activeElement = null;
    runFrames(1);
    focusField();
    runFrames(160, 16);
    field.height = 66;
    typeInput();
    await tick();
    noteTypeJumpTraceSent();

    const samples = bodySamples(lastPost().body);
    const first = samples[0]!;
    expect(first[1]).toBe(0);
    // Prehistory is trimmed to the last 2s of reads before the trigger.
    const triggerIndex = samples.findIndex((row) => row[0] === 7);
    expect(triggerIndex).toBeGreaterThan(0);
    expect(samples[triggerIndex]![1]).toBeLessThanOrEqual(2_000);
    // 160 frames at 16ms is about 2.56s; at a 30ms gate only ~85 reads fit.
    expect(samples.length).toBeLessThan(120);
  });

  it("stops at the sample budget with a stop marker and no overshoot", async () => {
    startTypeJumpTrace();
    focusField();
    field.height = 66;
    typeInput();
    await tick();
    for (let index = 0; index < 400 && posts.length === 0; index += 1) {
      // A fast burst of keystrokes: the 320-sample cap must land well inside 10s.
      nowMs += 1;
      typeInput();
      await tick();
    }
    const body = lastPost().body;
    expect(body.stop).toBe("budget");
    const samples = bodySamples(body);
    expect(samples.length).toBe(320);
    expect(samples.at(-1)![0]).toBe(8);
  });

  it("stops at the ten second budget when typing continues", async () => {
    startTypeJumpTrace();
    focusField();
    field.height = 66;
    typeInput();
    await tick();
    nowMs += 10_400;
    typeInput();
    await tick();
    const body = lastPost().body;
    expect(body.stop).toBe("timeout");
    expect(bodySamples(body).at(-1)![1]).toBeLessThanOrEqual(10_000);
  });

  it("drops an armed session on blur but posts a capture that had started", async () => {
    startTypeJumpTrace();
    focusField();
    fire("focusout", { target: field });
    expect(posts.length).toBe(0);
    // Blur first, then a real capture that stops on blur.
    await captureRound(() => fire("focusout", { target: field }));
    expect(posts.length).toBe(1);
    expect(lastPost().body.stop).toBe("blur");
  });

  it("closes a capture on the page hiding and on unmount", async () => {
    startTypeJumpTrace();
    await captureRound(() => {
      (fakeDocument as { visibilityState: string }).visibilityState = "hidden";
      fire("visibilitychange");
    });
    expect(lastPost().body.stop).toBe("close");

    (fakeDocument as { visibilityState: string }).visibilityState = "visible";
    startTypeJumpTrace();
    await captureRound(() => stopTypeJumpTrace());
    expect(lastPost().body.stop).toBe("close");
  });

  it("reports the pinned, focused, composing and row flags from the live state", async () => {
    startTypeJumpTrace();
    focusField();
    setTranscriptPinned(true);
    fire("compositionstart", { target: field });
    field.height = 66;
    typeInput();
    await tick();
    noteTypeJumpTraceSent();
    const samples = bodySamples(lastPost().body);
    const compositing = samples.find((row) => row[0] === 6);
    expect(compositing).toBeDefined();
    expect(compositing![16]! & 4).toBe(4);
    const grown = samples.find((row) => row[0] === 7)!;
    expect(grown[16]! & 1).toBe(1);
    expect(grown[16]! & 2).toBe(2);
    expect(grown[16]! & 8).toBe(8);
    expect(grown[16]! & 16).toBe(16);
  });

  it("bumps the tail generation on a re-mount but not on an append", async () => {
    startTypeJumpTrace();
    focusField();
    runFrames(1);
    const [firstRow, secondRow] = scroller.rows as [FakeRow, FakeRow];
    // An append: the previous last row stays mounted as the second-to-last.
    scroller.rows = [firstRow, secondRow, new FakeRow(500)];
    runFrames(1);
    // A re-mount of the tail: both last positions hold new elements.
    scroller.rows = [firstRow, new FakeRow(640), new FakeRow(700)];
    runFrames(1);
    field.height = 66;
    typeInput();
    await tick();
    noteTypeJumpTraceSent();
    const generations = bodySamples(lastPost().body).map((row) => row[11]!);
    expect(Math.max(...generations)).toBe(1);
  });

  it("never samples again after the page's capture is done", async () => {
    startTypeJumpTrace();
    await captureRound();
    expect(posts.length).toBe(1);
    // Round 2 needs its turn; here both rounds finish, then nothing captures.
    await captureRound();
    expect(posts.length).toBe(2);
    await captureRound();
    await captureRound();
    expect(posts.length).toBe(2);
  });

  it("honours the rum and type-jump-trace kill switches without touching anything", async () => {
    localStorageFake.setItem(PERF_OFF_STORAGE_KEY, "rum");
    startTypeJumpTrace();
    await captureRound();
    expect(posts.length).toBe(0);
    resetTypeJumpTraceForTest(() => nowMs);
    localStorageFake.setItem(PERF_OFF_STORAGE_KEY, "lean-shell,type-jump-trace");
    startTypeJumpTrace();
    await captureRound();
    expect(posts.length).toBe(0);
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("lean-shell,type-jump-trace");
    expect(appendedBanners.length).toBe(0);
  });
});

describe("round 2 control flip", () => {
  it("flips the tween off after round 1, posts round 2 with tween false, and restores exactly", async () => {
    localStorageFake.setItem(PERF_OFF_STORAGE_KEY, "lean-shell, preload-chat");
    startTypeJumpTrace();
    await captureRound();
    expect(posts.length).toBe(1);
    expect(sessionStorageFake.getItem("bots:typejump-restore")).toBe(
      JSON.stringify({ present: true, value: "lean-shell, preload-chat" }),
    );
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe(
      "lean-shell, preload-chat,resize-pin-tween",
    );
    expect(appendedBanners.length).toBe(1);
    expect(appendedBanners[0]!.textContent).toBe("Round 2 of 2 - type the same again");
    expect(appendedBanners[0]!.style.cssText).toContain("position:fixed");
    expect(appendedBanners[0]!.style.cssText).toContain("pointer-events:none");
    // Clear of the iPhone status bar in the standalone PWA (viewport-fit=cover).
    expect(appendedBanners[0]!.style.cssText).toContain("env(safe-area-inset-top");

    await captureRound();
    expect(posts.length).toBe(2);
    expect(lastPost().body.tween).toBe(false);
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("lean-shell, preload-chat");
    expect(sessionStorageFake.getItem("bots:typejump-restore")).toBeNull();
    expect(appendedBanners[0]!.removed).toBe(true);
  });

  it("holds round 2 after a mid-message budget stop until that message is sent", async () => {
    startTypeJumpTrace();
    focusField();
    field.height = 66;
    typeInput();
    await tick();
    for (let index = 0; index < 400 && posts.length === 0; index += 1) {
      nowMs += 1;
      typeInput();
      await tick();
    }
    expect(lastPost().body.stop).toBe("budget");
    // Still typing the same message: no flip, no banner, no round-2 session.
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBeNull();
    expect(appendedBanners.length).toBe(0);
    field.height = 88;
    typeInput();
    await tick();
    runFrames(5, 40);
    expect(posts.length).toBe(1);
    expect(frames.length).toBe(0);

    noteTypeJumpTraceSent();
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("resize-pin-tween");
    expect(appendedBanners.length).toBe(1);
    field.height = 44;
    await captureRound();
    expect(posts.length).toBe(2);
    expect(lastPost().body.tween).toBe(false);
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBeNull();
  });

  it("releases a held round 2 when the field blurs or the chat closes", async () => {
    startTypeJumpTrace();
    focusField();
    field.height = 66;
    typeInput();
    await tick();
    nowMs += 10_400;
    typeInput();
    await tick();
    expect(lastPost().body.stop).toBe("timeout");
    expect(appendedBanners.length).toBe(0);
    fire("focusout", { target: field });
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("resize-pin-tween");
    expect(appendedBanners.length).toBe(1);

    resetTypeJumpTraceForTest(() => nowMs);
    field.height = 44;
    startTypeJumpTrace();
    focusField();
    field.height = 66;
    typeInput();
    await tick();
    nowMs += 10_400;
    typeInput();
    await tick();
    stopTypeJumpTrace();
    // Off-chat nothing flips; the next chat's start arms round 2.
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBeNull();
    startTypeJumpTrace();
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("resize-pin-tween");
  });

  it("restores an absent key by removing it again", async () => {
    startTypeJumpTrace();
    await captureRound();
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("resize-pin-tween");
    await captureRound();
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBeNull();
  });

  it("does not rewrite a list that already disables the tween", async () => {
    localStorageFake.setItem(PERF_OFF_STORAGE_KEY, "resize-pin-tween");
    startTypeJumpTrace();
    await captureRound();
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("resize-pin-tween");
    expect(sessionStorageFake.getItem("bots:typejump-restore")).toBeNull();
    // No flip was needed, but the round still runs and reports tween false.
    await captureRound();
    expect(lastPost().body.tween).toBe(false);
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("resize-pin-tween");
  });

  it("restores the flip on the page hiding and re-arms it on return", async () => {
    startTypeJumpTrace();
    await captureRound();
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("resize-pin-tween");

    (fakeDocument as { visibilityState: string }).visibilityState = "hidden";
    fire("visibilitychange");
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBeNull();
    expect(appendedBanners[0]!.removed).toBe(true);

    (fakeDocument as { visibilityState: string }).visibilityState = "visible";
    fire("visibilitychange");
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("resize-pin-tween");
    expect(appendedBanners.length).toBe(2);
  });

  it("undoes the flip with the watchdog when round 2 never triggers", async () => {
    vi.useFakeTimers();
    startTypeJumpTrace();
    await captureRound();
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("resize-pin-tween");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBeNull();
    expect(appendedBanners[0]!.removed).toBe(true);
    // The pair is over: typing again captures nothing more.
    await captureRound();
    expect(posts.length).toBe(1);
  });

  it("restores a marker left by a killed page before round 1 starts", () => {
    localStorageFake.setItem(PERF_OFF_STORAGE_KEY, "lean-shell,resize-pin-tween");
    sessionStorageFake.setItem(
      "bots:typejump-restore",
      JSON.stringify({ present: true, value: "lean-shell" }),
    );
    startTypeJumpTrace();
    expect(localStorageFake.getItem(PERF_OFF_STORAGE_KEY)).toBe("lean-shell");
    expect(sessionStorageFake.getItem("bots:typejump-restore")).toBeNull();
  });

  it("detaches every listener, observer and frame once the pair is done", async () => {
    startTypeJumpTrace();
    await captureRound();
    await captureRound();
    expect(posts.length).toBe(2);
    expect(observers.length).toBeGreaterThan(0);
    for (const observer of observers) expect(observer.disconnected).toBe(true);
    expect(frames.length).toBe(0);
    expect(listeners.get("focusin") ?? []).toHaveLength(0);
    expect(listeners.get("input") ?? []).toHaveLength(0);
    expect(listeners.get("visibilitychange") ?? []).toHaveLength(0);
    expect(listeners.get("pagehide") ?? []).toHaveLength(0);
  });
});
