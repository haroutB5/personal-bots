/**
 * The live call, as the card the chat shows while the call is on: "On a call ·
 * 2:14 / Tap to return to the call". It subscribes to the call's snapshot
 * itself, so the ticking duration re-renders this card and nothing else in the
 * conversation.
 *
 * @module features/personal/voice/LiveVoiceCallCard
 */
import type { JSX } from "react";

import { CallCard } from "./CallCard";
import { useVoiceCall, useVoiceCallSnapshot } from "./VoiceCallProvider";

export function LiveVoiceCallCard({
  /** Only the chat the call belongs to shows the card. */
  threadId,
  onReturn,
}: {
  readonly threadId: string;
  readonly onReturn: () => void;
}): JSX.Element | null {
  const voice = useVoiceCall();
  const snapshot = useVoiceCallSnapshot();
  const call = voice?.call ?? null;
  if (voice === null || call === null || call.threadId !== threadId) return null;
  if (snapshot.state.status !== "live" && snapshot.state.status !== "reconnecting") return null;

  return (
    <div className="flex justify-end px-4 pb-2">
      <CallCard
        model={{
          callId: voice.session()?.callId ?? "live",
          startedAtMs: call.startedAtMs,
          durationMs: snapshot.elapsedMs,
          endedLine: null,
          sentCount: snapshot.sentMessageIds.length,
          transcript: snapshot.transcript,
          live: true,
          voiceName: voice.session()?.voiceName ?? null,
        }}
        onCallBack={() => undefined}
        onReturn={onReturn}
      />
    </div>
  );
}
