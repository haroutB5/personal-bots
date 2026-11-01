import type { BlobStore } from "../ports/blobStore.ts";
import type { Cancel } from "../ports/cancel.ts";
import type { Clock } from "../ports/clock.ts";
import type { Confirm, ConfirmRequest } from "../ports/confirm.ts";
import type { Ids } from "../ports/ids.ts";
import type { KeyValueStore } from "../ports/keyValueStore.ts";
import type { Lifecycle, LifecycleState } from "../ports/lifecycle.ts";

export interface MemoryKeyValueStore extends KeyValueStore {
  /** Writes as another holder of the store would, so subscribers hear it. */
  writeFromOutside(key: string, value: string): void;
  clearFromOutside(): void;
}

export function createMemoryKeyValueStore(
  initial: Readonly<Record<string, string>> = {},
): MemoryKeyValueStore {
  const entries = new Map(Object.entries(initial));
  const listeners = new Set<(key: string | null) => void>();
  const notify = (key: string | null) => {
    for (const listener of listeners) listener(key);
  };
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    writeFromOutside: (key, value) => {
      entries.set(key, value);
      notify(key);
    },
    clearFromOutside: () => {
      entries.clear();
      notify(null);
    },
  };
}

export function createMemoryBlobStore<P>(sizeOf: (payload: P) => number): BlobStore<P> {
  const blobs = new Map<string, P>();
  return {
    put: async (key, payload) => {
      blobs.set(key, payload);
    },
    get: async (key) => blobs.get(key) ?? null,
    deletePrefix: async (prefix) => {
      for (const key of blobs.keys()) {
        if (key.startsWith(prefix)) blobs.delete(key);
      }
    },
    keys: async () => [...blobs.keys()],
    sizeOf,
  };
}

/** One frame is 16 ms on this clock. */
export const MANUAL_CLOCK_FRAME_MS = 16;

export interface ManualClock extends Clock {
  /** Moves time forward and runs every timer that falls due, in order, including ones they schedule. */
  advance(ms: number): void;
  pendingCount(): number;
}

export function createManualClock(startMs = 0): ManualClock {
  let nowMs = startMs;
  let nextId = 0;
  const timers = new Map<number, { readonly dueAt: number; readonly work: () => void }>();
  const schedule = (work: () => void, delayMs: number): Cancel => {
    const id = nextId++;
    timers.set(id, { dueAt: nowMs + delayMs, work });
    return () => {
      timers.delete(id);
    };
  };
  const nextDue = (limit: number) => {
    let best: { readonly id: number; readonly dueAt: number } | null = null;
    for (const [id, timer] of timers) {
      if (timer.dueAt <= limit && (best === null || timer.dueAt < best.dueAt)) {
        best = { id, dueAt: timer.dueAt };
      }
    }
    return best;
  };
  return {
    now: () => nowMs,
    setTimeout: schedule,
    whenIdle: (work, fallbackMs) => schedule(work, fallbackMs),
    nextFrame: (work) => schedule(work, MANUAL_CLOCK_FRAME_MS),
    advance: (ms) => {
      const target = nowMs + ms;
      for (let due = nextDue(target); due !== null; due = nextDue(target)) {
        const timer = timers.get(due.id);
        timers.delete(due.id);
        nowMs = due.dueAt;
        timer?.work();
      }
      nowMs = target;
    },
    pendingCount: () => timers.size,
  };
}

export interface FakeLifecycle extends Lifecycle {
  set(state: LifecycleState): void;
}

export function createFakeLifecycle(initial: LifecycleState = "foreground"): FakeLifecycle {
  let state = initial;
  const listeners = new Set<(state: LifecycleState) => void>();
  return {
    current: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener(next);
    },
  };
}

export interface FakeConfirm extends Confirm {
  readonly requests: ReadonlyArray<ConfirmRequest>;
}

/** Answers each request with the next entry of `answers`, then with `fallback`. */
export function createFakeConfirm(
  answers: ReadonlyArray<boolean> = [],
  fallback = false,
): FakeConfirm {
  const requests: ConfirmRequest[] = [];
  return {
    requests,
    confirm: async (request) => {
      const index = requests.length;
      requests.push(request);
      return answers[index] ?? fallback;
    },
  };
}

/** Ids shaped like UUID v4 that count up: `00000000-0000-4000-8000-000000000001`, then `...02`. */
export function createSequentialIds(): Ids {
  let counter = 0;
  return {
    randomUUID: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
    },
  };
}
