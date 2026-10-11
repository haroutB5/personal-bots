/**
 * The transcript's pin state, mirrored for the typing capture
 * (typeJumpDiag.ts). MessageList owns the truth (`stickRef`): the list is
 * pinned while it follows the newest message, even during a re-pin glide when
 * it no longer sits exactly at its end. The ordered capture needs that intent
 * as a numeric flag, and deriving "pinned" from the distance to the end would
 * report unpinned for every glide frame, which is exactly the window under
 * investigation, so MessageList mirrors the ref here on every change and the
 * capture reads it. One boolean: both screens are never mounted at once.
 */
let pinned = false;

/** Mirrors MessageList's stickRef (called wherever stickRef.current changes). */
export function setTranscriptPinned(value: boolean): void {
  pinned = value;
}

/** The transcript is following its newest message. */
export function isTranscriptPinned(): boolean {
  return pinned;
}

/** Test hook: back to the initial unpinned value between tests. */
export function resetTranscriptPinStateForTest(): void {
  pinned = false;
}
