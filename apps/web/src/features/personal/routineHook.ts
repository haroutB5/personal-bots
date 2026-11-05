export {
  isEventRoutine,
  routineHookUrl,
  routineTriggerStatusLabel,
} from "@hbots/personal-client/routines/routineHook";

/** The origin the client is served from, or null when there is no document. */
export function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

/**
 * True for an origin only this computer can reach. The webhook URL is built
 * from the origin the page was served on, so opening the app on the machine
 * itself produces a URL that is correct and completely useless to GitHub or
 * any other external sender: it has to be copied from a tunnel origin.
 */
export function isLocalOnlyOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
