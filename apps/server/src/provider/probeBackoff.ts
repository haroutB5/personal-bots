/**
 * How long to wait before the next provider probe, given how many probes in a
 * row have already failed.
 *
 * A probe is not free: reading Claude's usage cold-starts the Agent SDK, and a
 * Codex health check spawns `codex.exe app-server`. On a host under memory
 * pressure those reads fail, and the fixed five-minute cadence meant the server
 * paid for the spawn every five minutes all night for an answer it was never
 * going to get. Each consecutive failure doubles the wait instead, up to
 * {@link PROBE_BACKOFF_CAP}; the first success puts it straight back to the
 * configured interval, so a blip costs one longer gap rather than a degraded
 * cadence.
 *
 * @module provider/probeBackoff
 */
import * as Duration from "effect/Duration";

/** The longest gap backoff will stretch a probe interval to. */
export const PROBE_BACKOFF_CAP = Duration.minutes(30);

/** Doubling past this many failures cannot move the result off the cap. */
const MAX_DOUBLINGS = 16;

/**
 * `base` doubled once per consecutive failure, never below `base` and never
 * above the cap. A zero or negative `base` means "periodic refresh is off" and
 * is returned untouched, so backoff can never switch a disabled loop back on.
 */
export const probeBackoffInterval = (
  base: Duration.Input,
  consecutiveFailures: number,
): Duration.Duration => {
  const baseMillis = Duration.toMillis(Duration.fromInputUnsafe(base));
  if (baseMillis <= 0) return Duration.zero;
  const doublings = Math.min(Math.max(Math.trunc(consecutiveFailures), 0), MAX_DOUBLINGS);
  const backedOff = baseMillis * 2 ** doublings;
  return Duration.millis(
    Math.max(baseMillis, Math.min(Duration.toMillis(PROBE_BACKOFF_CAP), backedOff)),
  );
};
