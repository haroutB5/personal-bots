export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 8;

export type LongPressState =
  | { readonly kind: "idle" }
  | { readonly kind: "holding"; readonly x: number; readonly y: number }
  | { readonly kind: "fired" };

export type LongPressEvent =
  | { readonly kind: "down"; readonly x: number; readonly y: number }
  | { readonly kind: "move"; readonly x: number; readonly y: number }
  | { readonly kind: "elapsed" }
  | { readonly kind: "end" };

export interface LongPressStep {
  readonly state: LongPressState;
  /** True on the one step where the hold completes. */
  readonly fire: boolean;
}

export const LONG_PRESS_IDLE: LongPressState = { kind: "idle" };

/** A still hold fires; a drag of 8 px or more is a swipe or a scroll and gives way. */
export function longPressStep(state: LongPressState, event: LongPressEvent): LongPressStep {
  switch (event.kind) {
    case "down":
      return { state: { kind: "holding", x: event.x, y: event.y }, fire: false };
    case "move":
      if (state.kind !== "holding") return { state, fire: false };
      return Math.hypot(event.x - state.x, event.y - state.y) >= LONG_PRESS_SLOP_PX
        ? { state: LONG_PRESS_IDLE, fire: false }
        : { state, fire: false };
    case "elapsed":
      return state.kind === "holding"
        ? { state: { kind: "fired" }, fire: true }
        : { state, fire: false };
    case "end":
      return { state: LONG_PRESS_IDLE, fire: false };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
