import { afterEach, expect, it, vi } from "vite-plus/test";

import { afterPaint } from "./afterPaint";

const state = vi.hoisted(() => ({ off: new Set<string>() }));
vi.mock("./perfFlags", () => ({ perfOptimizationOn: (name: string) => !state.off.has(name) }));

afterEach(() => {
  state.off.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("waits for a frame and a task, and can be cancelled", () => {
  vi.useFakeTimers();
  const frames: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const work = vi.fn();
  afterPaint(work);
  expect(work).not.toHaveBeenCalled();
  frames[0]!();
  expect(work).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(work).toHaveBeenCalledTimes(1);

  const cancelled = vi.fn();
  const cancel = afterPaint(cancelled);
  frames[1]!();
  cancel();
  vi.runAllTimers();
  expect(cancelled).not.toHaveBeenCalled();
});

it("runs at once with chat-open-after-paint off", () => {
  state.off.add("chat-open-after-paint");
  const work = vi.fn();
  afterPaint(work);
  expect(work).toHaveBeenCalledTimes(1);
});
