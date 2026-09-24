/**
 * Touch gestures on the remote-controlled PC picture, turned into what they
 * mean for the PC (clicks, drags, the mouse wheel) or for the view itself
 * (pinch zoom, pan). Pure: pointer events and a clock in, actions out, so the
 * rules are tested without a screen.
 *
 * - tap: left click where the finger lifted
 * - double tap: a second click snapped onto the first tap's point, so Windows
 *   sees two clicks on the same pixel and makes it a double click
 * - long press: right click (fires while the finger is still down)
 * - hold briefly, then move: drag (button down, moves, button up)
 * - move straight away: pan the (zoomed) view
 * - two fingers moving together: scroll the PC
 * - two fingers pinching: zoom the view (never the PC)
 */

export interface GesturePoint {
  readonly id: number;
  /** Client (CSS) pixels. */
  readonly x: number;
  readonly y: number;
}

export type GestureAction =
  | {
      readonly type: "click";
      readonly x: number;
      readonly y: number;
      readonly button: "left" | "right";
      /** A double tap's second click, snapped onto the first tap's point. */
      readonly snapped?: true;
    }
  | { readonly type: "dragStart"; readonly x: number; readonly y: number }
  | { readonly type: "dragMove"; readonly x: number; readonly y: number }
  | { readonly type: "dragEnd"; readonly x: number; readonly y: number }
  /** Client-pixel wheel deltas at the fingers' centre; dy > 0 scrolls down. */
  | {
      readonly type: "scroll";
      readonly x: number;
      readonly y: number;
      readonly dx: number;
      readonly dy: number;
    }
  | { readonly type: "pan"; readonly dx: number; readonly dy: number }
  /** Multiply the view's zoom by `factor` around the client point (cx, cy). */
  | { readonly type: "zoom"; readonly factor: number; readonly cx: number; readonly cy: number }
  /** A long press is about to right-click here (the UI can show it). */
  | { readonly type: "press"; readonly x: number; readonly y: number };

export interface GestureTiming {
  readonly longPressMs: number;
  /** A finger held this long before moving drags instead of panning. */
  readonly dragHoldMs: number;
  /** Movement below this is still a tap or a hold. */
  readonly slopPx: number;
  readonly doubleTapMs: number;
  readonly doubleTapSlopPx: number;
  /** Relative change in finger distance that makes two fingers a pinch. */
  readonly pinchThreshold: number;
  /** Centre movement that makes two fingers a scroll. */
  readonly scrollSlopPx: number;
}

export const DEFAULT_GESTURE_TIMING: GestureTiming = {
  longPressMs: 550,
  dragHoldMs: 250,
  slopPx: 10,
  doubleTapMs: 350,
  doubleTapSlopPx: 28,
  pinchThreshold: 0.08,
  scrollSlopPx: 10,
};

export interface GestureRecognizerOptions {
  readonly emit: (action: GestureAction) => void;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly timing?: Partial<GestureTiming>;
}

type OneFinger = {
  readonly kind: "one";
  readonly id: number;
  readonly startX: number;
  readonly startY: number;
  readonly startAt: number;
  x: number;
  y: number;
  mode: "pending" | "pan" | "drag" | "pressed";
  timer: unknown;
};

type TwoFingers = {
  readonly kind: "two";
  readonly ids: readonly [number, number];
  readonly points: Map<number, { x: number; y: number }>;
  readonly startDistance: number;
  readonly startCentre: { x: number; y: number };
  lastDistance: number;
  lastCentre: { x: number; y: number };
  mode: "pending" | "scroll" | "pinch";
};

/** Fingers still down after a gesture ended; nothing happens until they lift. */
type Draining = { readonly kind: "draining"; readonly ids: Set<number> };

type State = { readonly kind: "idle" } | OneFinger | TwoFingers | Draining;

const distance = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

export class TouchGestureRecognizer {
  private state: State = { kind: "idle" };
  private lastTap: { x: number; y: number; at: number } | null = null;
  private readonly timing: GestureTiming;
  private readonly options: GestureRecognizerOptions;

  constructor(options: GestureRecognizerOptions) {
    this.options = options;
    this.timing = { ...DEFAULT_GESTURE_TIMING, ...options.timing };
  }

  down(point: GesturePoint): void {
    const state = this.state;
    if (state.kind === "idle") {
      const one: OneFinger = {
        kind: "one",
        id: point.id,
        startX: point.x,
        startY: point.y,
        startAt: this.options.now(),
        x: point.x,
        y: point.y,
        mode: "pending",
        timer: null,
      };
      one.timer = this.options.setTimer(() => this.longPress(one), this.timing.longPressMs);
      this.state = one;
      return;
    }
    if (state.kind === "one") {
      this.clearOne(state);
      if (state.mode === "drag") this.options.emit({ type: "dragEnd", x: state.x, y: state.y });
      if (state.mode === "drag" || state.mode === "pressed") {
        this.state = { kind: "draining", ids: new Set([state.id, point.id]) };
        return;
      }
      const points = new Map([
        [state.id, { x: state.x, y: state.y }],
        [point.id, { x: point.x, y: point.y }],
      ]);
      const centre = { x: (state.x + point.x) / 2, y: (state.y + point.y) / 2 };
      const spread = Math.max(1, distance(state.x, state.y, point.x, point.y));
      this.state = {
        kind: "two",
        ids: [state.id, point.id],
        points,
        startDistance: spread,
        startCentre: centre,
        lastDistance: spread,
        lastCentre: centre,
        mode: "pending",
      };
      return;
    }
    // A third finger (or one landing while others drain) ends the gesture.
    const ids = new Set<number>(state.ids);
    ids.add(point.id);
    this.state = { kind: "draining", ids };
  }

  move(point: GesturePoint): void {
    const state = this.state;
    if (state.kind === "one" && state.id === point.id) {
      const dx = point.x - state.x;
      const dy = point.y - state.y;
      state.x = point.x;
      state.y = point.y;
      if (state.mode === "pending") {
        if (distance(point.x, point.y, state.startX, state.startY) <= this.timing.slopPx) return;
        this.clearOne(state);
        if (this.options.now() - state.startAt >= this.timing.dragHoldMs) {
          state.mode = "drag";
          this.options.emit({ type: "dragStart", x: state.startX, y: state.startY });
          this.options.emit({ type: "dragMove", x: point.x, y: point.y });
        } else {
          state.mode = "pan";
          this.options.emit({
            type: "pan",
            dx: point.x - state.startX,
            dy: point.y - state.startY,
          });
        }
        return;
      }
      if (state.mode === "pan") this.options.emit({ type: "pan", dx, dy });
      else if (state.mode === "drag")
        this.options.emit({ type: "dragMove", x: point.x, y: point.y });
      return;
    }
    if (state.kind !== "two" || !state.points.has(point.id)) return;
    state.points.set(point.id, { x: point.x, y: point.y });
    const [a, b] = state.ids.map((id) => state.points.get(id)!);
    const centre = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
    const spread = Math.max(1, distance(a!.x, a!.y, b!.x, b!.y));
    if (state.mode === "pending") {
      if (Math.abs(spread / state.startDistance - 1) > this.timing.pinchThreshold) {
        state.mode = "pinch";
      } else if (
        distance(centre.x, centre.y, state.startCentre.x, state.startCentre.y) >
        this.timing.scrollSlopPx
      ) {
        state.mode = "scroll";
        // The slop already travelled counts, so the page moves with the fingers.
        state.lastCentre = state.startCentre;
      } else {
        return;
      }
    }
    if (state.mode === "pinch") {
      this.options.emit({
        type: "zoom",
        factor: spread / state.lastDistance,
        cx: centre.x,
        cy: centre.y,
      });
      this.options.emit({
        type: "pan",
        dx: centre.x - state.lastCentre.x,
        dy: centre.y - state.lastCentre.y,
      });
    } else {
      this.options.emit({
        type: "scroll",
        x: centre.x,
        y: centre.y,
        // Fingers moving up bring later content into view: scroll down.
        dx: state.lastCentre.x - centre.x,
        dy: state.lastCentre.y - centre.y,
      });
    }
    state.lastDistance = spread;
    state.lastCentre = centre;
  }

  up(point: GesturePoint): void {
    const state = this.state;
    if (state.kind === "one" && state.id === point.id) {
      this.clearOne(state);
      this.state = { kind: "idle" };
      if (state.mode === "drag") {
        this.options.emit({ type: "dragEnd", x: point.x, y: point.y });
        return;
      }
      if (state.mode !== "pending") return;
      this.tap(point.x, point.y);
      return;
    }
    this.lift(point.id);
  }

  cancel(id: number): void {
    const state = this.state;
    if (state.kind === "one" && state.id === id) {
      this.clearOne(state);
      this.state = { kind: "idle" };
      // A drag must never leave the PC's mouse button down.
      if (state.mode === "drag") this.options.emit({ type: "dragEnd", x: state.x, y: state.y });
      return;
    }
    this.lift(id);
  }

  /** Stop everything (control ended, the view closed). */
  reset(): void {
    const state = this.state;
    if (state.kind === "one") {
      this.clearOne(state);
      if (state.mode === "drag") this.options.emit({ type: "dragEnd", x: state.x, y: state.y });
    }
    this.state = { kind: "idle" };
    this.lastTap = null;
  }

  private lift(id: number) {
    const state = this.state;
    if (state.kind === "two" && state.points.has(id)) {
      const ids = new Set<number>(state.ids);
      ids.delete(id);
      this.state = ids.size === 0 ? { kind: "idle" } : { kind: "draining", ids };
      return;
    }
    if (state.kind === "draining") {
      state.ids.delete(id);
      if (state.ids.size === 0) this.state = { kind: "idle" };
    }
  }

  private tap(x: number, y: number) {
    const at = this.options.now();
    const last = this.lastTap;
    if (
      last !== null &&
      at - last.at <= this.timing.doubleTapMs &&
      distance(x, y, last.x, last.y) <= this.timing.doubleTapSlopPx
    ) {
      this.lastTap = null;
      this.options.emit({ type: "click", x: last.x, y: last.y, button: "left", snapped: true });
      return;
    }
    this.lastTap = { x, y, at };
    this.options.emit({ type: "click", x, y, button: "left" });
  }

  private longPress(one: OneFinger) {
    if (this.state !== one || one.mode !== "pending") return;
    one.timer = null;
    one.mode = "pressed";
    this.lastTap = null;
    this.options.emit({ type: "press", x: one.startX, y: one.startY });
    this.options.emit({ type: "click", x: one.startX, y: one.startY, button: "right" });
  }

  private clearOne(one: OneFinger) {
    if (one.timer !== null) this.options.clearTimer(one.timer);
    one.timer = null;
  }
}
