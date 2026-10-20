import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PersonalUnreachableScreen } from "./PersonalUnreachableScreen";
import { enqueueOutboxEntry, resetOutboxForTesting } from "./outbox";

let renderer: ReactTestRenderer | undefined;
let doc: EventTarget & { visibilityState: string };
let win: EventTarget;
let network: { onLine: boolean };
beforeEach(() => {
  resetOutboxForTesting(null);
  vi.useFakeTimers();
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  win = new EventTarget();
  network = { onLine: true };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", network);
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetOutboxForTesting(undefined);
});

describe("automatic reconnect", () => {
  it("waits for a slow retry and never schedules after an in-flight retry unmounts", async () => {
    let finish = () => {};
    const retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      renderer = create(<PersonalUnreachableScreen onRetry={retry} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    win.dispatchEvent(new Event("online"));
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).toHaveBeenCalledTimes(1);
    await act(async () => renderer?.unmount());
    renderer = undefined;
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("says nothing about messages when none are waiting", async () => {
    await act(async () => {
      renderer = create(<PersonalUnreachableScreen onRetry={() => {}} />);
    });
    expect(JSON.stringify(renderer?.toJSON())).toContain("Reconnecting to your laptop");
    expect(JSON.stringify(renderer?.toJSON())).not.toContain("waiting to send");
  });
  it("keeps the existing reminder that queued messages are safe", async () => {
    for (const id of ["a", "b"])
      enqueueOutboxEntry({
        id,
        kind: "turn",
        environmentId: "env",
        threadId: "t1",
        groupId: null,
        text: id,
        sendText: id,
        createdAt: "2026-10-08T12:00:00.000Z",
        replyTo: null,
        turn: null,
        attachments: [],
      });
    await act(async () => {
      renderer = create(<PersonalUnreachableScreen onRetry={() => {}} />);
    });
    expect(JSON.stringify(renderer?.toJSON())).toContain(
      "2 messages are waiting to send. They go out when it reconnects.",
    );
  });
  it("backs off from 2 seconds to 30 seconds and cleans up on unmount", async () => {
    const retry = vi.fn();
    await act(async () => {
      renderer = create(<PersonalUnreachableScreen onRetry={retry} />);
    });
    const backoff: ReadonlyArray<readonly [number, number]> = [
      [2_000, 1],
      [4_000, 2],
      [8_000, 3],
      [16_000, 4],
      [30_000, 5],
      [30_000, 6],
    ];
    for (const [delay, count] of backoff) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
      expect(retry).toHaveBeenCalledTimes(count);
    }
    await act(async () => renderer?.unmount());
    renderer = undefined;
    await vi.advanceTimersByTimeAsync(60_000);
    win.dispatchEvent(new Event("online"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(retry).toHaveBeenCalledTimes(6);
  });
  it("retries when online or visible and uses the latest callback without resetting the timer", async () => {
    const oldRetry = vi.fn(),
      retry = vi.fn();
    await act(async () => {
      renderer = create(<PersonalUnreachableScreen onRetry={oldRetry} />);
    });
    await act(async () => renderer?.update(<PersonalUnreachableScreen onRetry={retry} />));
    await act(async () => {
      win.dispatchEvent(new Event("online"));
    });
    expect(retry).toHaveBeenCalledTimes(1);
    doc.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(4_000);
    expect(retry).toHaveBeenCalledTimes(1);
    doc.visibilityState = "visible";
    await act(async () => {
      doc.dispatchEvent(new Event("visibilitychange"));
    });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(oldRetry).not.toHaveBeenCalled();
  });
  it("does not retry offline and respects the device kill switch", async () => {
    const retry = vi.fn();
    network.onLine = false;
    await act(async () => {
      renderer = create(<PersonalUnreachableScreen onRetry={retry} />);
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(retry).not.toHaveBeenCalled();
    await act(async () => renderer?.unmount());
    vi.stubGlobal("localStorage", { getItem: () => "off" });
    network.onLine = true;
    await act(async () => {
      renderer = create(<PersonalUnreachableScreen onRetry={retry} />);
    });
    await vi.advanceTimersByTimeAsync(60_000);
    win.dispatchEvent(new Event("online"));
    expect(retry).not.toHaveBeenCalled();
  });
});
