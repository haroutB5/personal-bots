import { behindOfState, isPersonalChatPath } from "./botsBackStack";

/**
 * Swipe-back from a chat in the installed iPhone app.
 *
 * iOS draws its own edge swipe from a snapshot of the page last painted for
 * the history entry behind. The entry behind a chat is /bots (botsBackStack),
 * but it was rewritten there without the list ever painting, so the swipe
 * showed the task page, the bot's chat list or a blank page and only then the
 * Bots list. A touch that starts at the left edge is taken over instead: its
 * touchstart default is prevented (which stops the native gesture, iOS 13.4+)
 * and the chat is dragged off over the real Bots list, then goes to /bots the
 * same way the Back arrow does.
 */

/** Touches starting this close to the left edge are the swipe's. */
export const EDGE_WIDTH_PX = 20;
/** Movement before a touch counts as a drag, a scroll or neither. */
const DECIDE_PX = 8;
/** Past this share of the width, letting go completes the swipe. */
const COMPLETE_SHARE = 0.35;
/** A flick faster than this (px/ms, rightwards) completes it from anywhere. */
const FLICK_PX_PER_MS = 0.5;

/** `localStorage.setItem("bots:native-swipe", "1")` puts the iOS swipe back on one device. */
export const NATIVE_SWIPE_STORAGE_KEY = "bots:native-swipe";

export function nativeSwipeForced(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(NATIVE_SWIPE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function chatSwipeBackEnabled(input: {
  readonly pathname: string;
  readonly state: unknown;
  readonly standalone: boolean;
  readonly wide: boolean;
  readonly nativeForced: boolean;
}): boolean {
  if (!input.standalone || input.wide || input.nativeForced) return false;
  if (!isPersonalChatPath(input.pathname)) return false;
  // The Bots list, or the Team screen when the chat was opened from it.
  return behindOfState(input.state) !== null;
}

export type SwipeMove =
  | { readonly kind: "undecided" }
  | { readonly kind: "drag"; readonly offset: number }
  | { readonly kind: "scroll"; readonly dx: number; readonly dy: number };

export type SwipeEnd =
  | { readonly kind: "tap"; readonly x: number; readonly y: number }
  | { readonly kind: "complete"; readonly offset: number }
  | { readonly kind: "cancel"; readonly offset: number }
  | { readonly kind: "scroll" };

interface Sample {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

/** One edge touch, from touchstart to touchend. No DOM: the view feeds it points. */
export class EdgeSwipeTracker {
  private readonly width: number;
  private origin: Sample;
  private last: Sample;
  private previous: Sample;
  private mode: "undecided" | "drag" | "scroll" = "undecided";

  constructor(start: Sample, width: number) {
    this.width = width;
    this.origin = start;
    this.last = start;
    this.previous = start;
  }

  move(point: Sample): SwipeMove {
    const dxStep = point.x - this.last.x;
    const dyStep = point.y - this.last.y;
    this.previous = this.last;
    this.last = point;
    const dx = point.x - this.origin.x;
    const dy = point.y - this.origin.y;
    if (this.mode === "undecided") {
      if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return { kind: "undecided" };
      this.mode = dx > 0 && Math.abs(dx) > Math.abs(dy) ? "drag" : "scroll";
    }
    if (this.mode === "scroll") return { kind: "scroll", dx: dxStep, dy: dyStep };
    return { kind: "drag", offset: this.offset() };
  }

  end(t: number): SwipeEnd {
    if (this.mode === "scroll") return { kind: "scroll" };
    if (this.mode === "undecided") return { kind: "tap", x: this.origin.x, y: this.origin.y };
    const offset = this.offset();
    const elapsed = Math.max(1, this.last.t - this.previous.t);
    // A finger held still before letting go is not a flick.
    const velocity = t - this.last.t > 100 ? 0 : (this.last.x - this.previous.x) / elapsed;
    const completes =
      velocity >= 0 && (offset >= this.width * COMPLETE_SHARE || velocity >= FLICK_PX_PER_MS);
    return completes && offset > 0 ? { kind: "complete", offset } : { kind: "cancel", offset };
  }

  private offset(): number {
    return Math.min(this.width, Math.max(0, this.last.x - this.origin.x));
  }
}
