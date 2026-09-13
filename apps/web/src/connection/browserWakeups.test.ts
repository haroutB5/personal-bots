import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { subscribeBrowserWakeups } from "./browserWakeups";

afterEach(() => vi.useRealTimers());

function setup(mobile: boolean) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const target = new EventTarget();
  const emit = vi.fn();
  const cleanup = subscribeBrowserWakeups(emit, mobile, page, target);
  const visibility = (state: DocumentVisibilityState) => {
    page.visibilityState = state;
    page.dispatchEvent(new Event("visibilitychange"));
  };
  return { page, target, emit, cleanup, visibility };
}

describe("browser resume connections", () => {
  it("reconnects immediately after a mobile background suspension", () => {
    const app = setup(true);
    app.visibility("hidden");
    vi.advanceTimersByTime(10_000);
    app.visibility("visible");
    expect(app.emit).toHaveBeenCalledExactlyOnceWith("application-active-reconnect");
    app.cleanup();
  });

  it("uses the fast probe for brief mobile interruptions", () => {
    const app = setup(true);
    app.visibility("hidden");
    vi.advanceTimersByTime(500);
    app.visibility("visible");
    expect(app.emit).toHaveBeenCalledExactlyOnceWith("application-active-probe");
    app.cleanup();
  });

  it("retains desktop connection behaviour", () => {
    const app = setup(false);
    app.visibility("hidden");
    vi.advanceTimersByTime(60_000);
    app.visibility("visible");
    expect(app.emit).toHaveBeenCalledExactlyOnceWith("application-active");
    app.cleanup();
  });

  it("handles a cached page restore and removes listeners on cleanup", () => {
    const app = setup(true);
    app.target.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(60_000);
    const restore = Object.assign(new Event("pageshow"), { persisted: true });
    app.target.dispatchEvent(restore);
    app.target.dispatchEvent(restore);
    expect(app.emit).toHaveBeenCalledExactlyOnceWith("application-active-reconnect");
    app.cleanup();
    app.visibility("hidden");
    app.visibility("visible");
    expect(app.emit).toHaveBeenCalledOnce();
  });
});
