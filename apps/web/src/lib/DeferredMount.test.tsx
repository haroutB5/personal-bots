import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { DEFERRED_MOUNT_MIN_MS, DeferredMount } from "./DeferredMount";

const state = vi.hoisted(() => ({ off: new Set<string>(), idle: [] as Array<() => void> }));
vi.mock("~/features/personal/perfFlags", () => ({
  perfOptimizationOn: (name: string) => !state.off.has(name),
  whenIdle: (work: () => void) => {
    state.idle.push(work);
    return () => undefined;
  },
}));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.off.clear();
  state.idle = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <DeferredMount>
        <span>dialogs</span>
      </DeferredMount>,
    );
  });
  return renderer!;
};

it("mounts nothing at boot, then the children once the app has settled", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  const tree = await mount();
  expect(tree.toJSON()).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(DEFERRED_MOUNT_MIN_MS);
  });
  expect(state.idle).toHaveLength(1);
  await act(async () => state.idle[0]!());
  expect(JSON.stringify(tree.toJSON())).toContain("dialogs");
});

it("mounts at once with lean-boot off", async () => {
  state.off.add("lean-boot");
  const tree = await mount();
  expect(JSON.stringify(tree.toJSON())).toContain("dialogs");
});
