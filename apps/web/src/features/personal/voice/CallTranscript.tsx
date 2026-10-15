/**
 * One call card's transcript, fetched when the owner expands the card.
 *
 * The chat's own list of calls deliberately carries no transcripts (a chat with
 * fifty calls would otherwise send every one of them on every open, voice on or
 * off), so this is the only thing that asks for one.
 *
 * @module features/personal/voice/CallTranscript
 */
import type { JSX } from "react";

import { useEnvironmentQuery } from "~/state/query";

import { usePersonalEnvironmentId } from "../usePersonalBots";
import { transcriptOffset } from "./CallCard";
import { personalVoiceCallTranscript } from "./voiceCallApi";

export function CallTranscript({
  callId,
  startedAtMs,
  voiceName,
}: {
  readonly callId: string;
  readonly startedAtMs: number;
  /** The voice the call ran on, for the speaker column. */
  readonly voiceName: string | null;
}): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : personalVoiceCallTranscript({ environmentId, input: { callId } }),
  );
  const rows = query.data?.transcript;

  if (rows === undefined) {
    return (
      <p className="py-1 text-[13px] leading-[18px] text-[var(--personal-text-tertiary)]">
        Loading the transcript…
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="py-1 text-[13px] leading-[18px] text-[var(--personal-text-tertiary)]">
        Nothing was written down on this call.
      </p>
    );
  }
  return (
    <>
      {rows.map((row, index) => (
        <div key={`${index}-${row.speaker}`} className="flex gap-2 py-0.5">
          <span className="w-[34px] shrink-0 text-[12px] leading-[19px] text-[var(--personal-text-tertiary)] [font-variant-numeric:tabular-nums]">
            {transcriptOffset(startedAtMs, row.at)}
          </span>
          <span
            className={`w-[52px] shrink-0 truncate text-[13px] leading-[19px] font-semibold ${
              row.speaker === "you"
                ? "text-[var(--personal-text-secondary)]"
                : "text-[var(--personal-text-tertiary)]"
            }`}
          >
            {row.speaker === "you" ? "You" : (voiceName ?? "Voice")}
          </span>
          <span className="min-w-0 flex-1 text-[14px] leading-[19px] break-words text-[var(--personal-text)]">
            {row.text}
          </span>
        </div>
      ))}
    </>
  );
}
