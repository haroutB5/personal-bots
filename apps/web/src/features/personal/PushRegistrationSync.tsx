import { useEffect, useRef } from "react";

import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { usePersonalConnectionPhase } from "./PersonalOfflineBanner";
import { resyncPushSubscription } from "./pushRegistrationSync";
import { readyServiceWorker } from "./serviceWorker";
import { personalPushSubscribe } from "./usePersonalAutomation";
import { usePersonalEnvironmentId } from "./usePersonalBots";

/**
 * Web push follows the sign-in. The server only sends to a browser whose
 * sign-in is still live, so once per connection, when the laptop is connected,
 * this re-sends the subscription the browser already has; the server binds it
 * to the current sign-in. A browser that was signed out and signed back in, or
 * one subscribed before subscriptions were bound, starts receiving again
 * without the user touching Settings.
 *
 * It never asks for permission and never creates a subscription. A send the
 * server refused is tried again after the next reconnect.
 */
export function PushRegistrationSync(): null {
  const environmentId = usePersonalEnvironmentId();
  const phase = usePersonalConnectionPhase();
  const subscribe = useAtomCommand(personalPushSubscribe, { reportFailure: false });
  const doneRef = useRef(false);
  const runningRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the server's record of this browser's subscription in step with the current sign-in, once per connection
  useEffect(() => {
    if (phase !== "connected") {
      doneRef.current = false;
      return;
    }
    if (environmentId === null) return;
    if (doneRef.current || runningRef.current) return;
    runningRef.current = true;
    void (async () => {
      try {
        const outcome = await resyncPushSubscription({
          permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
          userAgent: navigator.userAgent,
          getRegistration: readyServiceWorker,
          send: async (input) =>
            commandFailureMessage(
              await subscribe({ environmentId, input }),
              "Could not re-send the notification subscription.",
            ),
        });
        if (outcome !== "failed") doneRef.current = true;
      } catch {
        // A browser without a usable worker has nothing to bind this time.
      } finally {
        runningRef.current = false;
      }
    })();
  }, [phase, environmentId, subscribe]);

  return null;
}
