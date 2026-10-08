import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  deleteOutboxBlobs,
  OUTBOX_BLOB_DELETE_RETRY_MS,
  type OutboxBlobBackend,
  setOutboxBlobBackendForTesting,
  sweepOutboxBlobs,
  undeletedOutboxBlobCount,
} from "./outboxBlobs";

/** An in-memory IndexedDB stand-in whose deletes can be made to fail. */
function memoryBackend(keys: ReadonlyArray<string>, failDeletes: () => boolean) {
  const stored = new Set(keys);
  const backend: OutboxBlobBackend = {
    put: async (key) => {
      stored.add(key);
    },
    get: async () => null,
    deletePrefix: async (prefix) => {
      if (failDeletes()) throw new Error("database is busy");
      for (const key of [...stored]) if (key.startsWith(prefix)) stored.delete(key);
    },
    keys: async () => [...stored],
  };
  return { backend, stored };
}

describe("deleting the bytes of a message that left the queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setOutboxBlobBackendForTesting(undefined);
  });

  it("deletes at once when the database allows it", async () => {
    const { backend, stored } = memoryBackend(["m1/a", "m1/b", "m2/a"], () => false);
    setOutboxBlobBackendForTesting(backend);
    await expect(deleteOutboxBlobs("m1")).resolves.toBe(true);
    expect([...stored]).toEqual(["m2/a"]);
    expect(undeletedOutboxBlobCount()).toBe(0);
  });

  it("retries a refused delete until it works, instead of dropping the error", async () => {
    let refusals = 2;
    const { backend, stored } = memoryBackend(["m1/a"], () => refusals-- > 0);
    setOutboxBlobBackendForTesting(backend);
    const done = deleteOutboxBlobs("m1");
    await vi.advanceTimersByTimeAsync(0);
    expect(stored.has("m1/a")).toBe(true);
    expect(undeletedOutboxBlobCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(OUTBOX_BLOB_DELETE_RETRY_MS[0] ?? 0);
    await vi.advanceTimersByTimeAsync(OUTBOX_BLOB_DELETE_RETRY_MS[1] ?? 0);
    await expect(done).resolves.toBe(true);
    expect(stored.size).toBe(0);
    expect(undeletedOutboxBlobCount()).toBe(0);
  });

  it("gives up loudly after the last retry; the next launch's sweep still removes the bytes", async () => {
    let refuse = true;
    const { backend, stored } = memoryBackend(["m1/a"], () => refuse);
    setOutboxBlobBackendForTesting(backend);
    const done = deleteOutboxBlobs("m1");
    await vi.advanceTimersByTimeAsync(OUTBOX_BLOB_DELETE_RETRY_MS.reduce((sum, ms) => sum + ms, 0));
    await expect(done).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(stored.has("m1/a")).toBe(true);
    expect(undeletedOutboxBlobCount()).toBe(1);

    refuse = false;
    await expect(sweepOutboxBlobs(new Set())).resolves.toBe(true);
    expect(stored.size).toBe(0);
    expect(undeletedOutboxBlobCount()).toBe(0);
  });
});

describe("sweeping orphaned bytes", () => {
  afterEach(() => setOutboxBlobBackendForTesting(undefined));

  it("keeps the bytes of queued messages and removes the rest", async () => {
    const { backend, stored } = memoryBackend(["live/a", "gone/a", "gone/b"], () => false);
    setOutboxBlobBackendForTesting(backend);
    await expect(sweepOutboxBlobs(new Set(["live"]))).resolves.toBe(true);
    expect([...stored]).toEqual(["live/a"]);
  });

  it("one refused delete does not stop the others, and the sweep says it is incomplete", async () => {
    const failing = new Set(["bad"]);
    const { stored, backend } = memoryBackend(["bad/a", "ok/a"], () => false);
    const refusing: OutboxBlobBackend = {
      ...backend,
      deletePrefix: async (prefix) => {
        if ([...failing].some((id) => prefix === `${id}/`)) throw new Error("database is busy");
        await backend.deletePrefix(prefix);
      },
    };
    setOutboxBlobBackendForTesting(refusing);
    await expect(sweepOutboxBlobs(new Set())).resolves.toBe(false);
    expect([...stored]).toEqual(["bad/a"]);
    failing.clear();
    await expect(sweepOutboxBlobs(new Set())).resolves.toBe(true);
    expect(stored.size).toBe(0);
  });
});
