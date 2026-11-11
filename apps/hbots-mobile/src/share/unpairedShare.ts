import { parseDeepLink } from "../nav/routes";
import { blockedMessage, openPicker, type PickerState } from "./pickerModel";

/**
 * A share or Ask hbots that arrives while this phone is not signed in. The shell
 * is not mounted then, so the picker never opens. The shared content is
 * discarded at once and never sent later (SPEC section 6, not-paired).
 */
export type UnpairedShare =
  | { readonly step: "none" }
  | { readonly step: "notice"; readonly state: PickerState };

export const NO_UNPAIRED_SHARE: UnpairedShare = { step: "none" };

/** The share id a deep link carries, or null when the link is anything else. */
export function shareIdFromLink(raw: string): string | null {
  const stack = parseDeepLink(raw)?.stack;
  const last = stack?.[stack.length - 1];
  return last?.kind === "share" ? last.shareId : null;
}

/** The share a launch link opens: the one intake that must survive the start-up sweep. */
export function shareToKeepAtStart(launchUrl: string | null): string | null {
  return launchUrl === null ? null : shareIdFromLink(launchUrl);
}

/** The screens on which no shell is mounted and no session exists. */
export function isSignedOutScreen(kind: string): boolean {
  return kind === "unpaired" || kind === "signedOut";
}

/**
 * What a link means while signed out. A share link yields the id to discard and
 * the notice to show; any other link means nothing here.
 */
export function receiveLinkWhileSignedOut(
  raw: string,
): { readonly discardId: string; readonly next: UnpairedShare } | null {
  const discardId = shareIdFromLink(raw);
  if (discardId === null) return null;
  const state = openPicker({ ok: false, reason: "empty" }, { paired: false, online: false });
  return { discardId, next: { step: "notice", state } };
}

/** The plain sentence for the notice, from the picker model's own message. */
export function unpairedShareMessage(share: UnpairedShare): string | null {
  if (share.step !== "notice" || share.state.step !== "blocked") return null;
  return blockedMessage(share.state.reason);
}
