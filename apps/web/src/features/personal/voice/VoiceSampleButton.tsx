/**
 * The play button beside one voice in Settings > Voice calls.
 *
 * The order of what happens on a tap is the whole point, and it is why this is
 * its own component rather than a few lines inside the sheet:
 *
 * 1. `audio.unlock()` runs SYNCHRONOUSLY in the click handler, so iOS lets the
 *    page play sound at all;
 * 2. then the clip is fetched from the laptop (one short Gemini TTS request on
 *    the first tap for that voice, the cached file after that);
 * 3. then it is decoded and played.
 *
 * A failure is a short line under the list, never a crash and never silence
 * with no explanation.
 *
 * @module features/personal/voice/VoiceSampleButton
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

import { Pause, Play } from "lucide-react";

import { base64ToBytes, type FetchVoiceSample, type VoiceSampleAudio } from "./callSamples";

export function VoiceSampleButton({
  voiceName,
  fetchSample,
  createAudio,
}: {
  readonly voiceName: string;
  readonly fetchSample: FetchVoiceSample;
  readonly createAudio: () => VoiceSampleAudio;
}): JSX.Element {
  const audioRef = useRef<VoiceSampleAudio | null>(null);
  const [playing, setPlaying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(
    () => () => {
      audioRef.current?.dispose();
      audioRef.current = null;
    },
    [],
  );

  const audio = (): VoiceSampleAudio => {
    audioRef.current ??= createAudio();
    return audioRef.current;
  };

  const onTap = () => {
    // Inside the tap, before anything asynchronous: iOS starts audio only from
    // a user gesture, and an await loses it.
    const player = audio();
    player.unlock();
    if (playing) {
      player.stop();
      setPlaying(false);
      return;
    }
    player.stop();
    setProblem(null);
    setPlaying(true);
    player.onEnded(() => setPlaying(false));
    void fetchSample({ voiceName })
      .then((sample) => player.play(base64ToBytes(sample.base64)))
      .catch(() => {
        setPlaying(false);
        setProblem("Sample unavailable right now");
      });
  };

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onTap}
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
