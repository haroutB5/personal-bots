import { requireOptionalNativeModule } from "expo";

/** A native claim. A photo always names the chat that launched it, and a claim is used once. */
export type CameraClaim =
  | { readonly status: "photo"; readonly uri: string; readonly bytes: number }
  | { readonly status: "empty" }
  | { readonly status: "other"; readonly owner: string };

interface HbotsCameraNative {
  /** Opens the system camera for this chat. True when it saved a photo, false when backed out. */
  launch(owner: string): Promise<boolean>;
  /** The photo this chat launched, once; null when no launch is recorded. */
  claim(owner: string): Promise<CameraClaim | null>;
}

const native = requireOptionalNativeModule<HbotsCameraNative>("HbotsCamera");

/**
 * The system camera's own launch, with EXTRA_OUTPUT in a file this app owns. The launch record
 * is written before the camera opens, so the composer that mounts next still knows the photo's
 * chat after Android destroys the activity or kills the process.
 */
export const HbotsCamera: HbotsCameraNative = {
  launch: (owner) => {
    if (native === null) return Promise.reject(new Error("HbotsCamera module is missing"));
    return native.launch(owner);
  },
  claim: (owner) => (native === null ? Promise.resolve(null) : native.claim(owner)),
};
