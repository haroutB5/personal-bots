import { useEffect } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useAtomCommand } from "~/state/use-atom-command";
import { personalBotsPrewarmThread } from "./usePersonalAutomation";

/**
 * Asks the server to start this chat's bot session while the user reads and
 * types, so the first message after a pause does not wait for it. Sent when
 * the chat opens and when the page comes back to the foreground (an idle
 * session is stopped after 30 minutes). The server decides everything else:
 * it skips live sessions, archived chats and group threads, debounces per
 * chat, and has the kill switch (PB_PERF_OFF=session-prewarm).
 */
export function usePrewarmChatSession(
  environmentId: EnvironmentId | null,
  threadId: ThreadId,
  connected: boolean,
): void {
  const prewarm = useAtomCommand(personalBotsPrewarmThread, {
    label: "personal-bots:prewarm-thread",
    reportFailure: false,
    reportDefect: false,
  });
  useEffect(() => {
    if (environmentId === null || !connected) return;
    if (typeof document === "undefined") return;
    const send = () => {
      if (document.visibilityState === "visible")
        void prewarm({ environmentId, input: { threadId } });
    };
    send();
    document.addEventListener("visibilitychange", send);
    return () => document.removeEventListener("visibilitychange", send);
  }, [environmentId, threadId, connected, prewarm]);
}
