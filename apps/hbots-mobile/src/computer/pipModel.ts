/**
 * When the Computer live view may shrink to a picture-in-picture window. Pure, so the
 * rule is tested without the screen or the native module.
 */
export interface PipState {
  /** A live view is showing the shown source: the stream is up, not a placeholder. */
  readonly streaming: boolean;
  /** The Computer tab is the focused screen. */
  readonly focused: boolean;
  /** React Native's AppState is "active". It reads background inside the PiP window. */
  readonly appActive: boolean;
  /** The window is currently in picture-in-picture. */
  readonly inPip: boolean;
}

/** The app counts as active inside the PiP window, even when AppState says background. */
export function effectivelyActive(state: Pick<PipState, "appActive" | "inPip">): boolean {
  return state.appActive || state.inPip;
}

/** PiP auto enter is on only while the live view is playing on the focused screen. */
export function pipEnabled(state: PipState): boolean {
  return state.streaming && state.focused && effectivelyActive(state);
}

/**
 * The inline live view stays paused in PiP: the PiP window has its own view, so only one
 * socket is open.
 */
export function inlinePaused(
  state: Pick<PipState, "focused" | "appActive" | "inPip"> & { readonly fullScreen: boolean },
): boolean {
  return !(state.focused && state.appActive && !state.fullScreen && !state.inPip);
}

/** The full screen view hides while the PiP window shows, and comes back when it ends. */
export function fullScreenVisible(state: {
  readonly fullScreen: boolean;
  readonly inPip: boolean;
}): boolean {
  return state.fullScreen && !state.inPip;
}

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/** One native call per change: the same enabled flag and the same shape is not sent twice. */
export function samePipRequest(
  a: { readonly enabled: boolean; readonly frame: FrameSize },
  b: { readonly enabled: boolean; readonly frame: FrameSize },
): boolean {
  return (
    a.enabled === b.enabled && a.frame.width === b.frame.width && a.frame.height === b.frame.height
  );
}
