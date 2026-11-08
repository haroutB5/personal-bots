import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  subscribeConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "~/confirmDialog";
import {
  webBlobStore,
  webClock,
  webConfirm,
  webIds,
  webKeyValueStore,
  webLifecycle,
} from "./webPorts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetConfirmDialogForTests();
});

function fakeStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
}

function stubWindow(localStorage: ReturnType<typeof fakeStorage>) {
  const target = Object.assign(new EventTarget(), { localStorage });
  vi.stubGlobal("window", target);
  vi.stubGlobal("localStorage", localStorage);
  return target;
}

function storageEvent(key: string | null, storageArea: unknown): Event {
  return Object.assign(new Event("storage"), { key, storageArea });
}

describe("webKeyValueStore", () => {
  it("reads, writes and removes through localStorage", () => {
    stubWindow(fakeStorage({ seeded: "1" }));
    webKeyValueStore.setItem("a", "x");
    expect([webKeyValueStore.getItem("a"), webKeyValueStore.getItem("seeded")]).toEqual(["x", "1"]);
    webKeyValueStore.removeItem("a");
    expect(webKeyValueStore.getItem("a")).toBeNull();
  });

  it("reads null when there is no window", () => {
    expect(webKeyValueStore.getItem("a")).toBeNull();
  });

  it("reports storage events from localStorage only, until cancelled", () => {
    const storage = fakeStorage();
    const target = stubWindow(storage);
    const heard: Array<string | null> = [];
    const cancel = webKeyValueStore.subscribe((key) => heard.push(key));
    target.dispatchEvent(storageEvent("outbox", storage));
    target.dispatchEvent(storageEvent("session-only", fakeStorage()));
    target.dispatchEvent(storageEvent(null, storage));
    cancel();
    target.dispatchEvent(storageEvent("after", storage));
    expect(heard).toEqual(["outbox", null]);
  });
});

describe("webBlobStore", () => {
  it("measures a blob by its byte size", () => {
    expect(webBlobStore.sizeOf(new Blob(["hello"]))).toBe(5);
  });

  it("refuses to store where the device has no IndexedDB", async () => {
    await expect(webBlobStore.put("entry/a", new Blob(["x"]))).rejects.toThrow(
      "This device has no IndexedDB.",
    );
  });
});

describe("webClock", () => {
  it("runs a timeout after its delay and not after cancel", () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    webClock.setTimeout(() => ran.push("kept"), 100);
    webClock.setTimeout(() => ran.push("cancelled"), 100)();
    vi.advanceTimersByTime(99);
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ran).toEqual(["kept"]);
  });

  it("falls back to a timer when there is no requestIdleCallback", () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    webClock.whenIdle(() => ran.push("idle"), 1_500);
    vi.advanceTimersByTime(1_499);
    expect(ran).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ran).toEqual(["idle"]);
  });

  it("runs on the next animation frame and cancels it", () => {
    const frames = new Map<number, () => void>();
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      frames.set(nextHandle, callback);
      return nextHandle++;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => frames.delete(handle));
    const ran: string[] = [];
    webClock.nextFrame(() => ran.push("kept"));
    webClock.nextFrame(() => ran.push("cancelled"))();
    for (const callback of frames.values()) callback();
    expect(ran).toEqual(["kept"]);
  });

  it("reads the current time in milliseconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    expect(webClock.now()).toBe(1_700_000_000_000);
  });
});

describe("webLifecycle", () => {
  function stubPage(visibilityState: "visible" | "hidden") {
    const documentTarget = Object.assign(new EventTarget(), { visibilityState });
    const windowTarget = new EventTarget();
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("window", windowTarget);
    return { documentTarget, windowTarget };
  }

  it("maps visibility to foreground and background", () => {
    const { documentTarget } = stubPage("visible");
    expect(webLifecycle.current()).toBe("foreground");
    documentTarget.visibilityState = "hidden";
    expect(webLifecycle.current()).toBe("background");
  });

  it("notifies on a change from visibility events and from pagehide, once per change", () => {
    const { documentTarget, windowTarget } = stubPage("visible");
    const seen: string[] = [];
    const cancel = webLifecycle.subscribe((state) => seen.push(state));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.visibilityState = "visible";
    windowTarget.dispatchEvent(new Event("pageshow"));
    windowTarget.dispatchEvent(new Event("pagehide"));
    cancel();
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(seen).toEqual(["background", "foreground", "background"]);
  });
});

describe("webConfirm", () => {
  it("shows title and body in the themed dialog and answers with the choice", async () => {
    const release = subscribeConfirmDialogHost(() => {});
    const answer = webConfirm.confirm({
      title: "Delete bot",
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete bot\n\nThis cannot be undone.",
      variant: "destructive",
      confirmLabel: "Delete",
    });
    respondToConfirmDialog(true);
    expect(await answer).toBe(true);
    completeConfirmDialogClose();
    release();
  });

  it("uses only the title when there is no body", async () => {
    const release = subscribeConfirmDialogHost(() => {});
    const answer = webConfirm.confirm({ title: "Leave chat", destructive: false });
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Leave chat",
      variant: "default",
      confirmLabel: undefined,
    });
    respondToConfirmDialog(false);
    expect(await answer).toBe(false);
    release();
  });

  it("declines when no dialog host is mounted", async () => {
    expect(await webConfirm.confirm({ title: "Delete", destructive: true })).toBe(false);
  });
});

describe("webIds", () => {
  it("returns a fresh UUID each call", () => {
    const first = webIds.randomUUID();
    const second = webIds.randomUUID();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});
