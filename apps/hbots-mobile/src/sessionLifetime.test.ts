import { describe, expect, it } from "vite-plus/test";

import type { StoredSession } from "./session";
import { createSessionLifetime } from "./sessionLifetime";

const SESSION: StoredSession = {
  environmentId: "env-1",
  label: "Laptop",
  httpBaseUrl: "https://relay.example.test/",
  wsBaseUrl: "wss://relay.example.test/",
  accessToken: "tok-1",
  scope: "ws",
  expiresAt: 1_000,
  pairedAt: 500,
};

const RENEWED: StoredSession = { ...SESSION, accessToken: "tok-2", expiresAt: 2_000 };
const NEW_SESSION: StoredSession = {
  ...SESSION,
  environmentId: "env-2",
  accessToken: "tok-3",
  pairedAt: 1_500,
};

function memoryStorage() {
  let value: StoredSession | null = null;
  return {
    storage: {
      save: async (session: StoredSession) => {
        value = session;
      },
      clear: async () => {
        value = null;
      },
    },
    read: () => value,
  };
}

function deferredRenew() {
  let finish: (session: StoredSession) => void = () => undefined;
  const promise = new Promise<StoredSession>((resolve) => {
    finish = resolve;
  });
  return { promise, finish: (session: StoredSession) => finish(session) };
}

describe("session lifetime", () => {
  it("saves the renewed session while the phone stays signed in", async () => {
    const memory = memoryStorage();
    const lifetime = createSessionLifetime({
      renew: async () => RENEWED,
      storage: memory.storage,
    });
    lifetime.restore(SESSION);

    await lifetime.renew();

    expect(lifetime.current()).toBe(RENEWED);
    expect(memory.read()).toBe(RENEWED);
  });

  it("does not save a renew that lands after sign out", async () => {
    const memory = memoryStorage();
    const renew = deferredRenew();
    const lifetime = createSessionLifetime({
      renew: () => renew.promise,
      storage: memory.storage,
    });
    lifetime.restore(SESSION);

    const pending = lifetime.renew();
    await lifetime.end();
    renew.finish(RENEWED);
    await pending;

    expect(memory.read()).toBeNull();
    expect(lifetime.current()).toBeNull();
  });

  it("does not let a renew from the old session replace a new pairing", async () => {
    const memory = memoryStorage();
    const renew = deferredRenew();
    const lifetime = createSessionLifetime({
      renew: () => renew.promise,
      storage: memory.storage,
    });
    lifetime.restore(SESSION);

    const pending = lifetime.renew();
    await lifetime.end();
    await lifetime.adopt(NEW_SESSION);
    renew.finish(RENEWED);
    await pending;

    expect(memory.read()).toBe(NEW_SESSION);
    expect(lifetime.current()).toBe(NEW_SESSION);
  });

  it("adopts the generation the updater reports and never moves back", () => {
    const memory = memoryStorage();
    const lifetime = createSessionLifetime({
      renew: async () => RENEWED,
      storage: memory.storage,
    });

    lifetime.raise(3);
    expect(lifetime.epoch()).toBe(3);

    lifetime.raise(2);
    expect(lifetime.epoch()).toBe(3);

    lifetime.restore(SESSION);
    expect(lifetime.epoch()).toBe(4);
  });

  it("drops a renew that lands after the updater judged the session dead", async () => {
    const memory = memoryStorage();
    const renew = deferredRenew();
    const lifetime = createSessionLifetime({
      renew: () => renew.promise,
      storage: memory.storage,
    });
    lifetime.restore(SESSION);

    const pending = lifetime.renew();
    lifetime.raise(5);
    renew.finish(RENEWED);
    await pending;

    expect(lifetime.current()).toBe(SESSION);
    expect(memory.read()).toBeNull();
  });
});
