import { describe, expect, it } from "vite-plus/test";

import { NOT_NOW_MS, type CardFacts } from "./permissionCard";
import { createPermissionCardStore, type CardStorage } from "./permissionCardStore";

const NOW = 5_000_000;
const facts = (over: Partial<CardFacts> = {}): CardFacts => ({
  now: NOW,
  notificationsEnabled: false,
  questionOpen: false,
  canAsk: true,
  ...over,
});

function memoryStorage(initial: string | null = null) {
  const box = { value: initial, writes: 0 };
  const storage: CardStorage = {
    read: () => box.value,
    write: (value) => {
      box.value = value;
      box.writes += 1;
    },
  };
  return { box, storage };
}

describe("permission card store", () => {
  it("does not show on launch, then shows after a send and leaving the chat", () => {
    const { storage } = memoryStorage();
    const store = createPermissionCardStore(storage);
    expect(store.view(facts())).toEqual({ kind: "none" });
    store.messageSent();
    expect(store.view(facts())).toEqual({ kind: "none" });
    store.leftChat();
    expect(store.view(facts())).toEqual({ kind: "ask" });
  });

  it("remembers a refusal across a restart and never asks again", () => {
    const { box, storage } = memoryStorage();
    const first = createPermissionCardStore(storage);
    first.messageSent();
    first.leftChat();
    first.shown();
    first.answered("denied");
    const second = createPermissionCardStore(memoryStorage(box.value).storage);
    expect(second.view(facts({ questionOpen: true, now: NOW + 365 * NOT_NOW_MS }))).toEqual({
      kind: "none",
    });
  });

  it("remembers Not now for 7 days across a restart", () => {
    const { box, storage } = memoryStorage();
    const first = createPermissionCardStore(storage);
    first.shown();
    first.notNow(NOW);
    const second = createPermissionCardStore(memoryStorage(box.value).storage);
    expect(second.view(facts({ questionOpen: true }))).toEqual({ kind: "none" });
    expect(second.view(facts({ questionOpen: true, now: NOW + NOT_NOW_MS }))).toEqual({
      kind: "ask",
    });
  });

  it("counts shows and stops after two", () => {
    const { storage } = memoryStorage();
    const store = createPermissionCardStore(storage);
    store.shown();
    store.shown();
    expect(store.view(facts({ questionOpen: true }))).toEqual({ kind: "none" });
  });

  it("tells subscribers once per real change and not for a repeat", () => {
    const { box, storage } = memoryStorage();
    const store = createPermissionCardStore(storage);
    let calls = 0;
    const stop = store.subscribe(() => (calls += 1));
    store.messageSent();
    store.messageSent();
    expect(calls).toBe(1);
    expect(box.writes).toBe(1);
    stop();
    store.leftChat();
    expect(calls).toBe(1);
  });

  it("survives a store that throws", () => {
    const store = createPermissionCardStore({
      read: () => {
        throw new Error("no store");
      },
      write: () => {
        throw new Error("no store");
      },
    });
    store.messageSent();
    store.leftChat();
    expect(store.view(facts())).toEqual({ kind: "ask" });
  });
});
