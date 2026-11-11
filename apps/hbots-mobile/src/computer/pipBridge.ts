import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface PipNative {
  setPip?(enabled: boolean, width: number, height: number): boolean;
  addListener?(
    event: "onPipChanged",
    listener: (event: { readonly inPip: boolean }) => void,
  ): { remove(): void };
}

const native = Platform.OS === "android" ? requireOptionalNativeModule<PipNative>("HbotsLiveView") : null;

/** Asks Android to enter PiP by itself on Home. False when this phone cannot do PiP. */
export function setPip(enabled: boolean, width: number, height: number): boolean {
  try {
    return native?.setPip?.(enabled, Math.round(width), Math.round(height)) === true;
  } catch {
    // No PiP is a missing nicety, never a crash.
    return false;
  }
}

/** Reports each time the window enters or leaves PiP. Returns the unsubscribe. */
export function onPipChanged(listener: (inPip: boolean) => void): () => void {
  const subscription = native?.addListener?.("onPipChanged", (event) => listener(event.inPip));
  return () => subscription?.remove();
}
