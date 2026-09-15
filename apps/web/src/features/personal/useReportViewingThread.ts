import { useEffect } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useAtomCommand } from "~/state/use-atom-command";
import { personalPushReportViewing } from "./usePersonalAutomation";

/**
 * Refresh cadence. Shorter than the server's 45 s lease so one dropped
 * report does not make the chat look closed.
 */
export const VIEWING_HEARTBEAT_MS = 20_000;

/**
 * Tells the server which chat this connection has open and visible, so it
 * holds that chat's notifications back (iOS shows every push it receives, so
 * the decision has to be made before sending).
 *
 * Reports on open, on every visibility change, on a heartbeat, and reports
 * "nothing" when the chat closes or the page goes away. The server also
 * forgets this connection when the socket closes and expires stale reports,
 * so a phone that dies mid-chat starts notifying again on its own.
 */
export function useReportViewingThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId,
  connected: boolean,
): void {
  const report = useAtomCommand(personalPushReportViewing, {
    label: "personal-push:report-viewing",
    reportFailure: false,
    reportDefect: false,
  });
  useEffect(() => {
    if (environmentId === null || !connected) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const send = (viewing: boolean) => {
      void report({ environmentId, input: { threadId: viewing ? threadId : null } });
    };
    const sendCurrent = () => send(document.visibilityState === "visible");
    sendCurrent();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") send(true);
    }, VIEWING_HEARTBEAT_MS);
    const onPageHide = () => send(false);
    document.addEventListener("visibilitychange", sendCurrent);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      // Leaving the chat: say so before tearing down, or this connection
      // would keep the chat "open" until its lease expires.
      send(false);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sendCurrent);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [environmentId, threadId, connected, report]);
}
