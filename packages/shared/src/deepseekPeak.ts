/** End of the current weekday UTC peak window, or null off-peak. */
export function deepSeekPeakWindowEndMs(timestampMs: number): number | null {
  // Match Date's TimeClip, including sub-millisecond and pre-epoch inputs.
  if (!Number.isFinite(timestampMs) || Math.abs(timestampMs) > 8.64e15) return null;
  const ms = Math.trunc(timestampMs);
  const day = Math.floor(ms / 86_400_000);
  const weekDay = (((day + 4) % 7) + 7) % 7; // epoch was a Thursday
  if (weekDay === 0 || weekDay === 6) return null;
  const hour = Math.floor((ms - day * 86_400_000) / 3_600_000);
  const endHour = hour >= 1 && hour < 4 ? 4 : hour >= 6 && hour < 10 ? 10 : null;
  return endHour === null ? null : day * 86_400_000 + endHour * 3_600_000;
}
