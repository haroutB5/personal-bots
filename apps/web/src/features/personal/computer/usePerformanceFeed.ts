/**
 * The Performance tab's live feed: one SSE subscription, open only while the
 * pane is mounted and the document visible. The store lives outside React,
 * so switching segments and coming back shows the last numbers instantly
 * (with a grey "Starting" dot until the next sample) and a reload gets the
 * server's ring buffer in the hello frame.
 */
import { useEffect, useSyncExternalStore } from "react";

import type {
  PerformanceGroups,
  PerformanceSample,
  PerformanceSlow,
  PerformanceStatics,
  PerformanceStreamEvent,
} from "@t3tools/contracts";

export const PERFORMANCE_STREAM_URL = "/api/personal/performance/stream";
/** The server's ring is 450 samples; the browser keeps the same window. */
export const PERFORMANCE_HISTORY_SAMPLES = 450;
/** A gap wider than this inside the history is time nobody watched. */
export const PERFORMANCE_GAP_MS = 6_000;

export interface PerformanceFeedState {
  readonly samples: ReadonlyArray<PerformanceSample>;
  readonly groups: PerformanceGroups | null;
  readonly slow: PerformanceSlow | null;
  readonly statics: PerformanceStatics | null;
  /** Client time the newest sample arrived, for the paused state. */
  readonly lastSampleAt: number | null;
  /** "idle" before the first subscribe, "starting" until the first SSE frame. */
  readonly status: "idle" | "starting" | "live";
}

const EMPTY: PerformanceFeedState = {
  samples: [],
  groups: null,
  slow: null,
  statics: null,
  lastSampleAt: null,
  status: "idle",
};

let state: PerformanceFeedState = EMPTY;
const listeners = new Set<() => void>();

/**
 * One notification per animation-frame's worth of events: the server sends
 * the groups frame and the sample frame back to back in the same tick, and
 * the profile showed the pane paying two full renders for them.
 */
let notifyScheduled = false;
const scheduleNotify = (): void => {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const listener of listeners) listener();
  });
};

const emit = (next: PerformanceFeedState): void => {
  state = next;
  scheduleNotify();
};

export function applyEvent(event: PerformanceStreamEvent, now: number): void {
  switch (event.kind) {
    case "hello": {
      const samples = [...event.history].slice(-PERFORMANCE_HISTORY_SAMPLES);
      emit({
        samples,
        groups: state.groups,
        slow: event.slow,
        statics: event.statics,
        lastSampleAt: samples.length === 0 ? state.lastSampleAt : now,
        status: "live",
      });
      return;
    }
    case "sample": {
      const samples = [...state.samples, event.sample].slice(-PERFORMANCE_HISTORY_SAMPLES);
      emit({ ...state, samples, lastSampleAt: now, status: "live" });
      return;
    }
    case "groups":
      emit({ ...state, groups: event.groups });
      return;
    case "slow":
      emit({ ...state, slow: event.slow });
      return;
  }
}

const subscribeStore = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = (): PerformanceFeedState => state;
const getServerSnapshot = (): PerformanceFeedState => EMPTY;

/**
 * Open the feed while `active`. Closing aborts the request; the server stops
 * sampling about ten seconds after the last viewer leaves.
 */
export function usePerformanceFeed(active: boolean): PerformanceFeedState {
  const snapshot = useSyncExternalStore(subscribeStore, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    emit({ ...state, status: state.status === "live" ? "live" : "starting" });

    const decoder = new TextDecoder();
    let buffer = "";
    const run = async () => {
      try {
        const response = await fetch(PERFORMANCE_STREAM_URL, {
          signal: controller.signal,
          headers: { accept: "text/event-stream" },
        });
        if (!response.ok || response.body === null) {
          emit({ ...state, status: "idle" });
          return;
        }
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const event = JSON.parse(line.slice(6)) as PerformanceStreamEvent;
                applyEvent(event, Date.now());
              } catch {
                // A frame that is not JSON is dropped, never guessed at.
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // Aborted on purpose, or the connection dropped; the pane says so.
      } finally {
        reader?.releaseLock();
      }
    };
    void run();

    return () => {
      controller.abort();
      if (state.status === "live") emit({ ...state, status: "starting" });
    };
  }, [active]);

  return snapshot;
}
