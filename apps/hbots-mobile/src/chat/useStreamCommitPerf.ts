import { useLayoutEffect, useRef, useState } from "react";

import type { ConversationItem } from "@hbots/personal-client/conversation/conversationModel";

import { reportPerf } from "../crash/crashReporter";
import { createStreamPerf, replyIsStreaming } from "./chatStreamPerf";

/**
 * Times each list commit while a reply streams: `renderStartedAt` is the clock at the top of
 * the list's render, and the layout effect runs after its rows are committed. Measures only.
 */
export function useStreamCommitPerf(
  renderStartedAt: number,
  items: ReadonlyArray<ConversationItem>,
  rows: number,
): void {
  const [perf] = useState(createStreamPerf);
  const lastItems = useRef<ReadonlyArray<ConversationItem> | null>(null);
  useLayoutEffect(() => {
    const committedAt = performance.now();
    const changed = lastItems.current !== items;
    lastItems.current = items;
    const streaming = replyIsStreaming(items);
    // A commit that did not bring new rows (a scroll button, the keyboard) is not an update.
    if (streaming && !changed) return;
    const note = perf.note({ ms: committedAt - renderStartedAt, rows, streaming });
    if (note.line !== null) console.info(note.line);
    if (note.body !== null) reportPerf(note.body);
  });
  useLayoutEffect(
    () => () => {
      const body = perf.flush();
      if (body !== null) reportPerf(body);
    },
    [perf],
  );
}
