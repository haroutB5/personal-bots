import * as LocalAuthentication from "expo-local-authentication";

import type { AuthResult } from "./appLock";

/** True when the phone has a screen lock (a biometric, PIN, pattern or password) to unlock with. */
export async function hasScreenLock(): Promise<boolean> {
  try {
    return (
      (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE
    );
  } catch {
    return false;
  }
}

/**
 * Asks for a strong biometric, with the phone's PIN, pattern or password as the
 * fallback. A phone with no screen lock has nothing to ask, and the answer says so
 * instead of leaving the app locked with no explanation.
 */
export async function authenticate(): Promise<AuthResult> {
  if (!(await hasScreenLock())) return "no-screen-lock";
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock hbots",
      biometricsSecurityLevel: "strong",
      disableDeviceFallback: false,
    });
    return result.success ? "unlocked" : "cancelled";
  } catch {
    return "cancelled";
  }
}
