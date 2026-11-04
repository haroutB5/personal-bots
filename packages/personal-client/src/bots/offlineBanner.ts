import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import { formatRelativeTime } from "./relativeTime.ts";

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

/** The line under the banner: what happens to a message sent now, and how many are waiting. */
export function offlineBannerHint(waiting: number): string {
  if (waiting === 0) return "Messages you send will go out when it reconnects.";
  return waiting === 1
    ? "1 message is waiting to send. It goes out when it reconnects."
    : `${waiting} messages are waiting to send. They go out when it reconnects.`;
}
