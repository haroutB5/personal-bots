/**
 * The call card in the chat (spec 6): one system card at the time the call
 * started, with duration, how it ended, Call back and a collapsed transcript.
 * While the call is on, the same card is the way back to it.
 *
 * The transcript stays with the chat on the laptop and is never sent to the
 * bot. Free tier at launch: duration only, no cost line (Harout, 15 Oct).
 *
 * @module features/personal/voice/CallCard
 */
import type { JSX, ReactNode } from "react";
import { useState } from "react";

import { ChevronDown, Phone } from "lucide-react";

import * as DateTime from "effect/DateTime";

import { formatCallDuration } from "./callState";
import type { VoiceCallTranscriptEntry } from "./voiceCallApi";

export interface VoiceCallCardModel {
  readonly callId: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  /** The sentence the call ended with ("You hung up."), or null while it runs. */
  readonly endedLine: string | null;
  readonly sentCount: number;
  readonly transcript: ReadonlyArray<VoiceCallTranscriptEntry>;
  /** True while the call is still running: the card is the way back in. */
  readonly live: boolean;
  readonly voiceName: string | null;
}

/** "0:12" offset from the call's start, for a transcript row. */
export function transcriptOffset(startedAtMs: number, at: VoiceCallTranscriptEntry["at"]): string {
  const parsed = DateTime.toEpochMillis(at);
  return formatCallDuration(Math.max(0, parsed - startedAtMs));
}

export function CallCard({
  model,
  onCallBack,
  onReturn,
  transcript = null,
}: {
  readonly model: VoiceCallCardModel;
  readonly onCallBack: () => void;
  readonly onReturn: () => void;
  /**
   * The expanded transcript. Omitted where the rows are already at hand; the
   * chat passes a lazily-fetched one, so nothing is read until the owner opens
   * the card.
   */
  readonly transcript?: ReactNode | undefined;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const sentLine =
    model.sentCount === 0
      ? "No messages sent"
      : `${model.sentCount} ${model.sentCount === 1 ? "message" : "messages"} sent`;

  return (
    <section
      aria-label={`Voice call, ${formatCallDuration(model.durationMs)}`}
      data-voice-call-card={model.live ? "live" : "done"}
      className="w-full max-w-[90%] rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-3.5 pt-3"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`flex size-9 shrink-0 items-center justify-center rounded-full ${
            model.live
              ? "bg-[var(--personal-live)] text-[var(--personal-bg)]"
              : "bg-[var(--personal-fill-muted)] text-[var(--personal-text)]"
          }`}
        >
          <Phone className="size-[18px]" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-5 font-semibold text-[var(--personal-text)] [font-variant-numeric:tabular-nums]">
            {model.live
              ? `On a call · ${formatCallDuration(model.durationMs)}`
              : `Voice call · ${formatCallDuration(model.durationMs)}`}
          </p>
          <p className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
            {model.live ? "Tap to return to the call" : `${sentLine} · ${model.endedLine ?? ""}`}
          </p>
        </div>
        {model.live ? (
          <button
            type="button"
            onClick={onReturn}
            className="flex h-8 shrink-0 items-center rounded-full border border-[var(--personal-border-strong)] px-3 text-[13px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.96]"
          >
            Return
          </button>
        ) : (
          <button
            type="button"
            onClick={onCallBack}
            className="flex h-8 shrink-0 items-center rounded-full border border-[var(--personal-border-strong)] px-3 text-[13px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.96]"
          >
            Call back
          </button>
        )}
      </div>

      {model.live ? null : (
        <>
          <button
            type="button"
            onClick={() => setOpen((previous) => !previous)}
            aria-expanded={open}
            className="mt-2 flex h-11 w-full items-center gap-1 border-t border-[var(--personal-border)] text-[13px] font-semibold text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            Transcript
            <ChevronDown
              aria-hidden="true"
              className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
              strokeWidth={1.75}
            />
          </button>
          {open ? (
            <div className="pb-3">
              {transcript ??
                model.transcript.map((row, index) => (
                  <div key={`${index}-${row.speaker}`} className="flex gap-2 py-0.5">
                    <span className="w-[34px] shrink-0 text-[12px] leading-[19px] text-[var(--personal-text-tertiary)] [font-variant-numeric:tabular-nums]">
                      {transcriptOffset(model.startedAtMs, row.at)}
                    </span>
                    <span
                      className={`w-[52px] shrink-0 truncate text-[13px] leading-[19px] font-semibold ${
                        row.speaker === "you"
                          ? "text-[var(--personal-text-secondary)]"
                          : "text-[var(--personal-text-tertiary)]"
                      }`}
                    >
                      {row.speaker === "you" ? "You" : (model.voiceName ?? "Voice")}
                    </span>
                    <span className="min-w-0 flex-1 text-[14px] leading-[19px] break-words text-[var(--personal-text)]">
                      {row.text}
                    </span>
                  </div>
                ))}
              <p className="mt-2 text-[12px] leading-[17px] text-[var(--personal-text-tertiary)]">
                {[
                  `Gemini Live`,
                  model.voiceName === null ? null : `voice ${model.voiceName}`,
                  formatCallDuration(model.durationMs),
                  "free tier",
                ]
                  .filter((part): part is string => part !== null)
                  .join(" · ")}
              </p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
