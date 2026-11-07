import { requireOptionalNativeModule } from "expo";
import { useEffect } from "react";

interface SecureModule {
  setSecure(secure: boolean): void;
}

const native = requireOptionalNativeModule<SecureModule>("HbotsSecure");

/** Cards hold the flag while they are mounted; the last one out clears it. */
let holders = 0;

function apply(): void {
  native?.setSecure(holders > 0);
}

/**
 * FLAG_SECURE for the screen while `active` is true, per SPEC section 8: a
 * chat showing a secret or sign-in card cannot be screenshotted or recorded.
 */
export function useSecureScreen(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    holders += 1;
    apply();
    return () => {
      holders = Math.max(0, holders - 1);
      apply();
    };
  }, [active]);
}
