/**
 * The JS cost of each streamed update to the chat list, as a log line per update and one
 * a-stream beacon per reply. Whole milliseconds and counts only: no chat text leaves here.
 */

import type { ConversationItem } from "@hbots/personal-client/conversation/conversationModel";

export type StreamPerfBody = Record<string, number | string>;

export interface StreamPerfNote {
  /** The `[perf] stream-commit-ms` line for this update; null when no reply is streaming. */
  readonly line: string | null;
  /** The a-stream beacon body, once the reply this commit ended had updates; else null. */
  readonly body: StreamPerfBody | null;
}

export interface StreamPerf {
  readonly note: (commit: {
    readonly ms: number;
    readonly rows: number;
    readonly streaming: boolean;
  }) => StreamPerfNote;
  /** The beacon for a reply cut short (the chat closed mid-reply); null when none is open. */
  readonly flush: () => StreamPerfBody | null;
}

/** A very long reply keeps the newest samples only, so memory stays bounded. */
const MAX_SAMPLES = 2_000;

export function createStreamPerf(): StreamPerf {
  let samples: number[] = [];
  let rows = 0;

  const take = (): StreamPerfBody | null => {
    if (samples.length === 0) return null;
    const sorted = samples.toSorted((left, right) => left - right);
    const body: StreamPerfBody = {
      event: "perf",
      journey: "a-stream",
      updates: sorted.length,
      // Nearest rank: the middle sample of an odd count, the lower middle of an even one.
      commitMsP50: sorted[Math.ceil(sorted.length / 2) - 1]!,
      commitMsMax: sorted[sorted.length - 1]!,
      rows,
    };
    samples = [];
    return body;
  };

  return {
    note: ({ ms, rows: rowCount, streaming }) => {
      if (!streaming) return { line: null, body: take() };
      const whole = Math.round(ms);
      samples.push(whole);
      if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
      rows = rowCount;
      return { line: `[perf] stream-commit-ms ${whole} rows ${rowCount}`, body: null };
    },
    flush: take,
  };
}

/** The newest rows are where a reply streams, so a short look from the end is enough. */
const STREAMING_LOOKBACK = 4;

/** True while one of the newest rows is a message the server is still writing. */
export function replyIsStreaming(items: ReadonlyArray<ConversationItem>): boolean {
  for (
    let index = items.length - 1;
    index >= Math.max(0, items.length - STREAMING_LOOKBACK);
    index -= 1
  ) {
    const item = items[index]!;
    if ((item.kind === "message" || item.kind === "group-message") && item.message.streaming) {
      return true;
    }
  }
  return false;
}
