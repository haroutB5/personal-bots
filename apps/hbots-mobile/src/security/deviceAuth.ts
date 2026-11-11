import * as LocalAuthentication from "expo-local-authentication";

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

/** Asks for a strong biometric, with the phone's PIN, pattern or password as the fallback. */
export async function authenticate(): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock hbots",
      biometricsSecurityLevel: "strong",
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
