import type { Cancel } from "./cancel.ts";

export interface Clock {
  now(): number;
  setTimeout(work: () => void, delayMs: number): Cancel;
  /** Runs `work` when the app is idle, or after `fallbackMs` where the host has no idle signal. */
  whenIdle(work: () => void, fallbackMs: number): Cancel;
  nextFrame(work: () => void): Cancel;
}
