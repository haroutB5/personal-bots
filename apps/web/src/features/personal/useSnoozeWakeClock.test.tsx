import * as DateTime from "effect/DateTime";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { WAKE_SLACK_MS, useSnoozeWakeClock } from "./useSnoozeWakeClock";

const T0 = Date.parse("2026-10-06T12:00:00.000Z");
const at = (offsetMs: number) => ({ snoozedUntil: DateTime.makeUnsafe(T0 + offsetMs) });

let renderer: ReactTestRenderer | undefined;
let clock = 0;
const refresh = vi.fn();

function Probe({ items }: { items: ReadonlyArray<{ snoozedUntil: DateTime.Utc }> }) {
  clock = useSnoozeWakeClock(items, refresh);
  return null;
}

const render = async (items: ReadonlyArray<{ snoozedUntil: DateTime.Utc }>) => {
  await act(async () => {
    if (renderer === undefined) renderer = create(<Probe items={items} />);
    else renderer.update(<Probe items={items} />);
  });
};
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  refresh.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("moves the clock past the nearest wake time once, and refetches the list", async () => {
  await render([at(60_000), at(10 * 60_000)]);
  expect(clock).toBe(T0);
  await advance(60_000 - 1);
  expect(refresh).not.toHaveBeenCalled();
  expect(clock).toBe(T0);
  await advance(1 + WAKE_SLACK_MS);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(clock).toBeGreaterThanOrEqual(T0 + 60_000);
});

it("then waits for the next wake time", async () => {
  await render([at(60_000), at(120_000)]);
  await advance(60_000 + WAKE_SLACK_MS);
  expect(refresh).toHaveBeenCalledTimes(1);
  await advance(60_000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("does nothing when nothing is snoozed", async () => {
  await render([]);
  await advance(24 * 3_600_000);
  expect(refresh).not.toHaveBeenCalled();
});

it("a wake time already behind is not waited for", async () => {
  await render([at(-1_000)]);
  expect(refresh).not.toHaveBeenCalled();
  await advance(0);
  expect(refresh).not.toHaveBeenCalled();
});
