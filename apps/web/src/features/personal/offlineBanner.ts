import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import { formatRelativeTime } from "./relativeTime";
import {
  RESTART_BANNER_GRACE_MS,
  RESTART_EXPECTED_PHASES,
  RESTART_EXPECTED_WINDOW_MS,
  type LastSeenPhase,
} from "./updateStatus";

const LAST_CONTACT_PREFIX = "t3.personal.lastContact.";

export function readLastContact(environmentId: string): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_CONTACT_PREFIX + environmentId);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeLastContact(environmentId: string, at: number): void {
  try {
    window.localStorage.setItem(LAST_CONTACT_PREFIX + environmentId, String(at));
  } catch {
    // Private mode: the banner falls back to "Laptop offline" without a time.
  }
}

/**
 * Banner text for the laptop's connection, or null when it is connected.
 * The first connect after a cold start stays quiet (nothing was lost yet).
 */
export function offlineBannerText(
  phase: EnvironmentConnectionPhase,
  lastContact: number | null,
  now: number,
): string | null {
  if (phase === "connected" || phase === "connecting" || phase === "available") return null;
  if (phase === "reconnecting") return "Reconnecting to your laptop…";
  if (lastContact === null) return "Laptop offline";
  const relative = formatRelativeTime(lastContact, now);
  return `Laptop offline · last contact ${relative === "Now" ? "just now" : relative.endsWith("m") || relative.endsWith("h") ? `${relative} ago` : relative}`;
}

/**
 * True while the Bots page keeps the calm update line and nothing else: an
 * update is landing (a restart-expected phase was seen inside its 30-minute
 * window) and the page is /bots. The generic banner would only repeat in
 * worse words what the line is already saying calmly, so it steps aside,
 * but for at most five minutes after the line went to "Restarting for
 * update": past that, an "expected" restart has taken long enough to stop
 * looking expected, and the banner comes back (CTO ruling, 2026-10-12).
 * Every other page keeps the banner exactly as it is.
 */
export function offlineBannerHiddenForRestart(input: {
  readonly pathname: string;
  readonly lastSeen: LastSeenPhase | null;
  readonly restartingSinceMs: number | null;
  readonly nowMs: number;
}): boolean {
  const path = input.pathname.length > 1 ? input.pathname.replace(/\/+$/, "") : input.pathname;
  if (path !== "/bots") return false;
  const seen = input.lastSeen;
  if (seen === null || !RESTART_EXPECTED_PHASES.has(seen.phase)) return false;
  if (input.nowMs - seen.atMs > RESTART_EXPECTED_WINDOW_MS) return false;
  const sinceMs = input.restartingSinceMs;
  return sinceMs === null || input.nowMs - sinceMs < RESTART_BANNER_GRACE_MS;
}

/**
 * What the composer says while the laptop is away: a message sent now is not
 * refused, it is kept on this device and goes out when the connection is back.
 * Null when connected.
 */
export function offlineComposerNotice(phase: EnvironmentConnectionPhase): string | null {
  if (phase === "connected") return null;
  return phase === "offline" || phase === "error"
    ? "Your laptop is offline. Messages you send now are saved on this device and go out when it reconnects."
    : "Reconnecting to your laptop. Messages you send now are saved here and go out when it's back.";
}

/** The line under the banner: what happens to a message sent now, and how many are waiting. */
export function offlineBannerHint(waiting: number): string {
  if (waiting === 0) return "Messages you send will go out when it reconnects.";
  return waiting === 1
    ? "1 message is waiting to send. It goes out when it reconnects."
    : `${waiting} messages are waiting to send. They go out when it reconnects.`;
}
