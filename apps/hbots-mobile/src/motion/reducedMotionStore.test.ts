import { describe, expect, it, vi } from "vite-plus/test";

import { createReducedMotionStore, type ReducedMotionPort } from "./reducedMotionStore";

function fakePort(initial: Promise<boolean>) {
  let handler: (enabled: boolean) => void = () => undefined;
  const port: ReducedMotionPort = {
    isReduceMotionEnabled: () => initial,
    addEventListener: (_name, next) => {
      handler = next;
      return { remove: () => undefined };
    },
  };
  return { port, emit: (enabled: boolean) => handler(enabled) };
}

async function flush() {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

describe("createReducedMotionStore", () => {
  it("starts with motion on", () => {
    const { port } = fakePort(new Promise(() => undefined));
    expect(createReducedMotionStore(port).getSnapshot()).toBe(false);
  });

  it("takes the first system read and tells subscribers", async () => {
    const { port } = fakePort(Promise.resolve(true));
    const store = createReducedMotionStore(port);
    const listener = vi.fn();
    store.subscribe(listener);
    await flush();
    expect(store.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("follows later changes in both directions", async () => {
    const { port, emit } = fakePort(Promise.resolve(false));
    const store = createReducedMotionStore(port);
    await flush();
    emit(true);
    expect(store.getSnapshot()).toBe(true);
    emit(false);
    expect(store.getSnapshot()).toBe(false);
  });

  it("does not let a slow first read overwrite a newer change", async () => {
    let resolve: (value: boolean) => void = () => undefined;
    const { port, emit } = fakePort(new Promise<boolean>((done) => (resolve = done)));
    const store = createReducedMotionStore(port);
    emit(true);
    resolve(false);
    await flush();
    expect(store.getSnapshot()).toBe(true);
  });

  it("keeps motion on when the system read fails", async () => {
    const { port } = fakePort(Promise.reject(new Error("no accessibility service")));
    const store = createReducedMotionStore(port);
    await flush();
    expect(store.getSnapshot()).toBe(false);
  });

  it("stops notifying an unsubscribed listener", async () => {
    const { port, emit } = fakePort(Promise.resolve(false));
    const store = createReducedMotionStore(port);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    emit(true);
    expect(listener).not.toHaveBeenCalled();
  });
});
