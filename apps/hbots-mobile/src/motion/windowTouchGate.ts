export interface WindowTouchNative {
  readonly setTouchable: (viewTag: number, touchable: boolean) => void;
}

export interface WindowTouchGate {
  readonly apply: (viewTag: number | null, touchable: boolean) => void;
}

/**
 * A closing sheet keeps its Modal window up for the close motion. That window
 * covers the screen and swallows taps meant for the screen beneath, so it is
 * made untouchable until it goes away or the sheet reopens. A new window is
 * touchable, so a view tag never seen before starts from that state.
 */
export function createWindowTouchGate(native: WindowTouchNative | null): WindowTouchGate {
  let tag: number | null = null;
  let touchable = true;
  return {
    apply: (viewTag, wanted) => {
      if (native === null || viewTag === null) return;
      if (viewTag !== tag) {
        tag = viewTag;
        touchable = true;
      }
      if (wanted === touchable) return;
      touchable = wanted;
      native.setTouchable(viewTag, wanted);
    },
  };
}
