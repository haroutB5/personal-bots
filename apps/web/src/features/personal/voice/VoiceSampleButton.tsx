/**
 * The play button beside one voice in Settings > Voice calls.
 *
 * It draws one voice's state and nothing else: the player itself is owned by
 * the sheet (`createVoiceSamplePlayer`), so only one voice can ever be playing
 * and a Stop or a closed sheet cancels a fetch that is still in flight. The
 * unlock that iOS needs happens in the sheet's tap handler, synchronously,
 * before anything is awaited. Astra re-check R6.
 *
 * A failure is a short line under the list, never a crash and never silence
 * with no explanation.
 *
 * @module features/personal/voice/VoiceSampleButton
 */
import type { JSX } from "react";

import { Pause, Play } from "lucide-react";

export function VoiceSampleButton({
  voiceName,
  playing,
  problem,
  onToggle,
}: {
  readonly voiceName: string;
  /** This voice is the one playing right now. */
  readonly playing: boolean;
  /** This voice's last failure, or null. */
  readonly problem: string | null;
  /** Tapped: the sheet decides between play, stop and switching voice. */
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-label={playing ? `Stop the ${voiceName} sample` : `Play the ${voiceName} sample`}
        aria-pressed={playing}
        className={`flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--personal-border)] ${
          playing
            ? "bg-[var(--personal-text)] text-[var(--personal-bg)]"
            : "bg-[var(--personal-fill-muted)] text-[var(--personal-text)]"
        } outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:scale-[0.96]`}
      >
        {playing ? (
          <Pause aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
        ) : (
          <Play aria-hidden="true" className="size-[18px]" strokeWidth={1.75} />
        )}
      </button>
      {problem === null ? null : (
        <span
          role="alert"
          className="max-w-[140px] text-right text-[12px] text-[var(--personal-danger)]"
        >
          {problem}
        </span>
      )}
    </span>
  );
}
