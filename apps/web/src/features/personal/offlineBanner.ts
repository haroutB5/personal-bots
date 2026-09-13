import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import { formatRelativeTime } from "./relativeTime";

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
