import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  DEFERRED_MOUNT_MIN_MS,
  DEFERRED_MOUNT_QUIET_MS,
  DeferredMount,
  whenQuiet,
} from "./DeferredMount";

const state = vi.hoisted(() => ({ off: new Set<string>(), idle: [] as Array<() => void> }));
vi.mock("~/features/personal/perfFlags", () => ({
  perfOptimizationOn: (name: string) => !state.off.has(name),
  whenIdle: (work: () => void) => {
    state.idle.push(work);
    return () => undefined;
  },
}));

const listeners = new Map<string, Set<() => void>>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    addEventListener: (type: string, fn: () => void) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(fn));
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.off.clear();
  state.idle = [];
  listeners.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tap = () => {
  for (const fn of listeners.get("pointerdown") ?? []) fn();
};

it("waits the minimum, then an idle moment", () => {
  const work = vi.fn();
  whenQuiet(work);
  vi.advanceTimersByTime(DEFERRED_MOUNT_MIN_MS - 1);
  expect(state.idle).toHaveLength(0);
  vi.advanceTimersByTime(1);
  state.idle[0]!();
  expect(work).toHaveBeenCalledTimes(1);
  expect(listeners.get("pointerdown")?.size ?? 0).toBe(0);
});

it("a tap near the end pushes the work a full quiet period past the tap (H8)", () => {
  const work = vi.fn();
  whenQuiet(work);
  vi.advanceTimersByTime(DEFERRED_MOUNT_MIN_MS - 100);
  tap();
  vi.advanceTimersByTime(DEFERRED_MOUNT_QUIET_MS - 1);
  expect(state.idle).toHaveLength(0);
  vi.advanceTimersByTime(1);
  expect(state.idle).toHaveLength(1);
});

it("mounts the children once quiet, or at once with lean-boot off", async () => {
  await act(async () => {
    renderer = create(
      <DeferredMount>
        <span>dialogs</span>
      </DeferredMount>,
    );
  });
  expect(renderer!.toJSON()).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(DEFERRED_MOUNT_MIN_MS);
  });
  await act(async () => state.idle[0]!());
  expect(JSON.stringify(renderer!.toJSON())).toContain("dialogs");

  state.off.add("lean-boot");
  let other: ReactTestRenderer | undefined;
  await act(async () => {
    other = create(
      <DeferredMount>
        <span>now</span>
      </DeferredMount>,
    );
  });
  expect(JSON.stringify(other!.toJSON())).toContain("now");
  await act(async () => other!.unmount());
});
