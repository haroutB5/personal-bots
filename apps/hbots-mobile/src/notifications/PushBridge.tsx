import { useEffect } from "react";
import { AppState } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { currentLock, lockIsLoaded, subscribeLock } from "../security/lockSetting";
import { nativeNotify } from "./nativeNotify";
import { buildNativePolicy } from "./policySync";
import { pushController, setPushRegistrar } from "./pushRuntime";
import { usePushRegistrar } from "./pushRegistrar";

/**
 * Mounted while a session is ready. It lends the live connection to the push controller, forwards
 * Firebase token refreshes, re-checks when the app returns to the foreground (the user may have
 * switched notifications on in Android settings), and keeps the native side's lock flag and bot
 * list current for pushes that arrive while the app is closed.
 */
export function PushBridge({
  native,
  appVersion,
}: {
  readonly native: NativePersonal;
  readonly appVersion: string;
}) {
  const registrar = usePushRegistrar(native);
  const list = native.bots.usePersonalBotsList(native.environmentId);
  const bots = list.data?.bots;

  useEffect(() => {
    setPushRegistrar(registrar, appVersion);
    return () => setPushRegistrar(null, "");
  }, [registrar, appVersion]);

  useEffect(() => {
    if (nativeNotify === null) return;
    const subscription = nativeNotify.addListener("tokenRefresh", (event) => {
      void pushController.onTokenRefresh(event.token);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void pushController.refresh();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (nativeNotify === null || bots === undefined) return;
    const push = () => {
      // The lock reads as Off until the saved setting loads. Sending that would open the policy for a
      // moment; native stays closed until the real value arrives (subscribeLock fires when it does).
      if (!lockIsLoaded()) return;
      try {
        const policy = buildNativePolicy(bots, currentLock());
        nativeNotify?.syncPolicy(policy.appLockOn, policy.bots);
      } catch (cause) {
        console.warn("Could not sync notification policy.", cause);
      }
    };
    push();
    return subscribeLock(push);
  }, [bots]);

  return null;
}
