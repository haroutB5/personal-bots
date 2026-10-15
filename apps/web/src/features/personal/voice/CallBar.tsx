/**
 * The minimised call: a bar above the page content on every Bots page while a
 * call runs, so the owner can read the chat without hanging up (spec 3.5).
 * Its level bars read the same `--lvl` the stage does.
 *
 * @module features/personal/voice/CallBar
 */
import type { JSX } from "react";
import { useEffect, useRef } from "react";

import { Mic, MicOff, PhoneOff } from "lucide-react";

import { type VoiceCallState, formatCallDuration, pillLabel } from "./callState";

export function CallBar({
  botName,
  color,
  state,
  elapsedMs,
  onReturn,
  onToggleMute,
  onEnd,
  readLevel,
}: {
  readonly botName: string;
  readonly color: string;
  readonly state: VoiceCallState;
  readonly elapsedMs: number;
  readonly onReturn: () => void;
  readonly onToggleMute: () => void;
  readonly onEnd: () => void;
  readonly readLevel: () => number;
}): JSX.Element {
  const barsRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const host = barsRef.current;
    if (host === null) return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let level = 0;
    const step = () => {
      const next = readLevel();
      level += (next - level) * (next > level ? 0.28 : 0.075);
      if (!reduced) {
        host.style.setProperty("--lvl", level.toFixed(3));
      }
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [readLevel]);

  const stateWord =
    state.status === "reconnecting"
      ? "Reconnecting"
      : pillLabel(state.pill, botName).split("'")[0] || "On a call";

  return (
    <div
      data-voice-bar=""
      className="personal-app relative z-40 flex h-14 shrink-0 items-center gap-2 border-b border-[var(--personal-border)] bg-[var(--personal-surface)] px-2"
    >
      <button
        type="button"
        onClick={onReturn}
        aria-label={`Return to the call with ${botName}`}
        className="flex h-12 min-w-0 flex-1 items-center gap-3 rounded-[12px] px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      >
        <span
          ref={barsRef}
          aria-hidden="true"
          className="voice-call-level-bars flex h-5 shrink-0 items-end gap-[3px]"
          style={{ "--bot": color } as React.CSSProperties}
        >
          <i /> <i /> <i />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)] [font-variant-numeric:tabular-nums]">
            {botName} · {formatCallDuration(elapsedMs)}
          </span>
          <span className="block truncate text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
            {stateWord} · tap to return
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onToggleMute}
        aria-pressed={state.muted}
        aria-label={state.muted ? "Unmute" : "Mute"}
        className={`flex size-11 shrink-0 items-center justify-center rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.94] ${
          state.muted
            ? "border-[var(--personal-text)] bg-[var(--personal-text)] text-[var(--personal-bg)]"
            : "border-[var(--personal-border)] bg-[var(--personal-fill-muted)] text-[var(--personal-text)]"
        }`}
      >
        {state.muted ? (
          <MicOff aria-hidden="true" className="size-5" strokeWidth={1.75} />
        ) : (
          <Mic aria-hidden="true" className="size-5" strokeWidth={1.75} />
        )}
      </button>
      <button
        type="button"
        onClick={onEnd}
        aria-label="End call"
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--personal-destructive)] text-[var(--personal-destructive-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.94]"
      >
        <PhoneOff aria-hidden="true" className="size-5" strokeWidth={1.75} />
      </button>
    </div>
  );
}
