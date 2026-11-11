import {
  voiceCallSummaryPending,
  type VoiceCallCardItem,
} from "@hbots/personal-client/conversation/conversationModel";
import { ThreadId, voiceCallEndReasonLabel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useMemo, useRef } from "react";

import type { NativePersonal } from "../personal/nativePersonalClient";

export const SUMMARY_REFRESH_MS = 15_000;

export function useVoiceCallCards(input: {
  readonly native: NativePersonal;
  readonly threadId: string;
  readonly enabled: boolean;
  readonly nowMs: number;
}): ReadonlyArray<VoiceCallCardItem> {
  const { native, threadId, enabled, nowMs } = input;
  const query = native.client.useEnvironmentQuery(
    enabled
      ? native.voice.personalVoiceCallsList({
          environmentId: native.environmentId,
          input: { threadId: ThreadId.make(threadId) },
        })
      : null,
  );
  const cards = useMemo<ReadonlyArray<VoiceCallCardItem>>(
    () =>
      query.data?.calls.map((row) => ({
        callId: row.callId,
        startedAtMs: DateTime.toEpochMillis(row.startedAt),
        endedAtMs: DateTime.toEpochMillis(row.endedAt),
        live: false,
        durationMs: row.durationSeconds * 1_000,
        endedLine: voiceCallEndReasonLabel(row.endReason),
        sentCount: row.messageCount,
        voiceName: row.voiceName,
        transcript: row.transcript,
        ...(row.summary === undefined ? {} : { summary: row.summary }),
      })) ?? [],
    [query.data],
  );
  const pending = voiceCallSummaryPending(cards, nowMs);
  const refresh = useRef(query.refresh);
  useEffect(() => {
    refresh.current = query.refresh;
  }, [query.refresh]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => refresh.current(), SUMMARY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [pending]);
  return cards;
}
