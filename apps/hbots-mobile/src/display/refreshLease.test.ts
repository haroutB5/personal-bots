import { describe, expect, it } from "vite-plus/test";
import { createRefreshLease, type DisplayNative, type Scheduler } from "./refreshLease";

function fakeNative(available = true) {
  const calls: boolean[] = [];
  let checks = 0;
  const native: DisplayNative = {
    available: () => {
      checks += 1;
      return available;
    },
    request: (high) => {
      calls.push(high);
    },
  };
  return { native, calls, checks: () => checks };
}

function fakeClock() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 1;
  const scheduler: Scheduler = {
    set: (run, ms) => {
      const id = next++;
      pending.set(id, { run, ms });
      return id;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    scheduler,
    pending: () => pending.size,
    fire: () => {
      const due = Array.from(pending.entries());
      for (const [id, timer] of due) {
        pending.delete(id);
        timer.run();
      }
    },
  };
}

describe("the refresh lease", () => {
  it("asks for the high rate when a scroll starts and gives it back after", () => {
    const { native, calls } = fakeNative();
    const clock = fakeClock();
    const lease = createRefreshLease(native, clock.scheduler);
    lease.acquire("chat");
    expect(calls).toEqual([true]);
    lease.releaseSoon("chat", 400);
    expect(calls).toEqual([true]);
    clock.fire();
    expect(calls).toEqual([true, false]);
    expect(lease.active()).toBe(false);
  });

  it("asks once for repeated scroll starts", () => {
    const { native, calls } = fakeNative();
    const lease = createRefreshLease(native, fakeClock().scheduler);
    lease.acquire("chat");
    lease.acquire("chat");
    lease.acquire("chat");
    expect(calls).toEqual([true]);
  });

  it("keeps the rate when momentum follows the drag", () => {
    const { native, calls } = fakeNative();
    const clock = fakeClock();
    const lease = createRefreshLease(native, clock.scheduler);
    lease.acquire("chat");
    lease.releaseSoon("chat", 400);
    lease.acquire("chat");
    expect(clock.pending()).toBe(0);
    clock.fire();
    expect(calls).toEqual([true]);
    lease.release("chat");
    expect(calls).toEqual([true, false]);
  });

  it("holds the rate until the last of two lists lets go", () => {
    const { native, calls } = fakeNative();
    const lease = createRefreshLease(native, fakeClock().scheduler);
    lease.acquire("chats");
    lease.acquire("files");
    lease.release("chats");
    expect(calls).toEqual([true]);
    lease.release("files");
    expect(calls).toEqual([true, false]);
  });

  it("never asks on a display with one mode", () => {
    const { native, calls } = fakeNative(false);
    const lease = createRefreshLease(native, fakeClock().scheduler);
    lease.acquire("chat");
    lease.release("chat");
    expect(calls).toEqual([]);
    expect(lease.active()).toBe(false);
  });

  it("asks the display only once whether it has a fast mode", () => {
    const { native, checks } = fakeNative();
    const lease = createRefreshLease(native, fakeClock().scheduler);
    lease.acquire("a");
    lease.release("a");
    lease.acquire("a");
    expect(checks()).toBe(1);
  });

  it("does nothing without the native module", () => {
    const lease = createRefreshLease(null, fakeClock().scheduler);
    lease.acquire("chat");
    lease.release("chat");
    expect(lease.active()).toBe(false);
  });

  it("survives a native call that throws", () => {
    const native: DisplayNative = {
      available: () => true,
      request: () => {
        throw new Error("no activity");
      },
    };
    const lease = createRefreshLease(native, fakeClock().scheduler);
    expect(() => {
      lease.acquire("chat");
      lease.release("chat");
    }).not.toThrow();
  });

  it("gives the rate back for a list that goes away mid scroll", () => {
    const { native, calls } = fakeNative();
    const lease = createRefreshLease(native, fakeClock().scheduler);
    lease.acquire("chat");
    lease.release("chat");
    expect(calls).toEqual([true, false]);
  });
});
