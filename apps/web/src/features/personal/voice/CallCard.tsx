/**
 * The call card in the chat (spec 6): one system card at the time the call
 * started, with duration, how it ended, Call back and a collapsed transcript.
 * While the call is on, the same card is the way back to it.
 *
 * From 1.66.59 (Harout, 16 Oct) the finished card also carries the call's
 * **summary**: one sentence, up to five concrete facts and the last decision,
 * written by the server from the transcript. It is what he reads a day later
 * instead of opening the transcript, so it sits on the card, not inside it.
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
import type { VoiceCallSummary, VoiceCallTranscriptEntry } from "./voiceCallApi";

export interface VoiceCallCardModel {
  readonly callId: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  /** The sentence the call ended with ("You hung up."), or null while it runs. */
  readonly endedLine: string | null;
  readonly sentCount: number;
  readonly transcript: ReadonlyArray<VoiceCallTranscriptEntry>;
  /** The server-written summary; absent while it is being written, or when it failed. */
  readonly summary?: VoiceCallSummary | undefined;
  /** True while the call is still running: the card is the way back in. */
  readonly live: boolean;
  readonly voiceName: string | null;
}

/** "0:12" offset from the call's start, for a transcript row. */
export function transcriptOffset(startedAtMs: number, at: VoiceCallTranscriptEntry["at"]): string {
  const parsed = DateTime.toEpochMillis(at);
  return formatCallDuration(Math.max(0, parsed - startedAtMs));
}

/**
 * The call's summary as the card shows it: the sentence, the concrete facts,
 * then the decision, which is the line he actually comes back for and so is
 * the only one given a surface of its own. Everything wraps and carries
 * `dir="auto"`, because the languages on this call include Armenian and Arabic.
 */
export function CallSummary({ summary }: { readonly summary: VoiceCallSummary }): JSX.Element {
  const points = summary.points.filter((point) => point.trim().length > 0);
  return (
    <div className="mt-2 border-t border-[var(--personal-border)] pt-2">
      <p dir="auto" className="text-[14px] leading-[19px] break-words text-[var(--personal-text)]">
        {summary.summary}
      </p>
      {points.length === 0 ? null : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {points.map((point) => (
            <li key={point} className="flex gap-2">
              <span
                aria-hidden="true"
                className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--personal-text-tertiary)]"
              />
              <span
                dir="auto"
                className="min-w-0 flex-1 text-[13px] leading-[18px] break-words text-[var(--personal-text-secondary)]"
              >
                {point}
              </span>
            </li>
          ))}
        </ul>
      )}
      {summary.decision === null || summary.decision.trim().length === 0 ? null : (
        <p
          data-voice-call-decision="true"
          className="mt-2 flex gap-1.5 rounded-[10px] bg-[var(--personal-fill-muted)] px-2.5 py-1.5"
        >
          <span className="shrink-0 text-[13px] leading-[18px] font-semibold text-[var(--personal-text)]">
            Decided:
          </span>
          <span
            dir="auto"
            className="min-w-0 flex-1 text-[13px] leading-[18px] break-words text-[var(--personal-text-secondary)]"
          >
            {summary.decision}
          </span>
        </p>
      )}
      {summary.open === null || summary.open.trim().length === 0 ? null : (
        <p dir="auto" className="mt-1.5 text-[13px] leading-[18px] break-words">
          <span className="font-semibold text-[var(--personal-text-secondary)]">Still open: </span>
          <span className="text-[var(--personal-text-tertiary)]">{summary.open}</span>
        </p>
      )}
    </div>
  );
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

      {model.live || model.summary === undefined ? null : <CallSummary summary={model.summary} />}

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
                    {/* dir="auto" so Arabic and Armenian lines lay out right-to-left. */}
                    <span
                      dir="auto"
                      className="min-w-0 flex-1 text-[14px] leading-[19px] break-words text-[var(--personal-text)]"
                    >
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
