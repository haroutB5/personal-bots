/**
 * The call's stage: the bot's own avatar with a ring that moves with whoever is
 * talking. The level is written straight to a CSS variable from a
 * requestAnimationFrame loop, so a talking call costs no React render per frame
 * and only `transform` and `opacity` animate (spec 3.3).
 *
 * @module features/personal/voice/CallStage
 */
import type { JSX } from "react";
import { useEffect, useRef } from "react";

import { BotAvatar } from "../BotAvatar";
import type { BotAvatarShape } from "../BotAvatar";
import type { AvatarMotion } from "../avatarMotion";
import { liftForContrast } from "./callState";

/** The app's own page background, which the ring has to read against. */
const CALL_BG = "#0f0f0e";

export function CallStage({
  shape,
  color,
  label,
  motion,
  /** "voice" tints the ring with the bot's colour; "you" leaves it grey. */
  speaking,
  /** False while connecting: the ring pulses instead of following a level. */
  live,
  /** Reads the current level, 0 to 1. Called once per frame, never per render. */
  readLevel,
  size = 196,
}: {
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly label: string;
  readonly motion?: AvatarMotion | undefined;
  readonly speaking: boolean;
  readonly live: boolean;
  readonly readLevel: () => number;
  readonly size?: number;
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const avatarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let level = 0;
    const step = () => {
      // Attack 60 ms, release 220 ms, at 60 fps.
      const next = readLevel();
      const rate = next > level ? 0.28 : 0.075;
      level += (next - level) * rate;
      stage.style.setProperty("--lvl", level.toFixed(3));
      if (ringRef.current !== null) {
        ringRef.current.style.transform = reduced
          ? "none"
          : `scale(${(1 + 0.1 * level).toFixed(4)})`;
        if (reduced)
          ringRef.current.style.opacity = (0.45 + (0.55 * Math.round(level * 3)) / 3).toFixed(3);
      }
      if (glowRef.current !== null && !reduced) {
        glowRef.current.style.opacity = (0.08 + 0.32 * level).toFixed(3);
        glowRef.current.style.transform = `scale(${(1 + 0.32 * level).toFixed(4)})`;
      }
      if (avatarRef.current !== null && !reduced) {
        avatarRef.current.style.transform = `translateY(${(level * -3).toFixed(2)}px)`;
      }
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [readLevel]);

  const ringColour = speaking
    ? liftForContrast(color, CALL_BG, 3)
    : "var(--personal-text-secondary)";

  return (
    <div
      ref={stageRef}
      data-voice-stage={live ? "live" : "connecting"}
      className="relative mx-auto flex shrink-0 items-center justify-center"
      style={
        {
          width: size,
          height: size,
          "--call-ring-you": "var(--personal-text-secondary)",
        } as React.CSSProperties
      }
    >
      <div
        ref={glowRef}
        aria-hidden="true"
        className="pointer-events-none absolute rounded-full"
        style={{
          width: size - 44,
          height: size - 44,
          background: ringColour,
          filter: "blur(20px)",
          opacity: 0.08,
        }}
      />
      <div
        ref={ringRef}
        aria-hidden="true"
        className={`absolute rounded-full border-[3px] ${live ? "" : "voice-call-ring-connecting"}`}
        style={{
          width: size - 32,
          height: size - 32,
          borderColor: ringColour,
          opacity: live ? 1 : 0.7,
        }}
      />
      <div ref={avatarRef} className="relative">
        <BotAvatar shape={shape} color={color} size={128} label={label} motion={motion} />
      </div>
    </div>
  );
}
