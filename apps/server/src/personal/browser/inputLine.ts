/**
 * The line of a viewer's inputs waiting for the worker that dispatches them to
 * Chrome, in arrival order.
 *
 * A finger scroll arrives as 60 to 120 `Wheel` messages a second and each one
 * costs the server round trips to Chrome, so while the worker is busy the line
 * used to grow and a scroll played back seconds late. Consecutive `Wheel`
 * messages still waiting in the line are therefore merged into one: the
 * deltas are summed and the latest point kept, so the page scrolls the same
 * distance in fewer steps. A wheel is only ever merged into the one directly
 * before it. A tap, key or any other input in between ends the run, so order
 * is never changed; a message the worker has already taken is never touched.
 * One merged wheel is bounded in count and in distance, so a long stall cannot
 * turn into one huge jump.
 *
 * Kill switch: `T3CODE_PERSONAL_BROWSER_WHEEL_COALESCE=off` (server
 * environment) queues every wheel as it comes, as in 1.60.33.
 */
import { PersonalBrowserInputMessage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Most wheel messages merged into one. */
export const MAX_MERGED_WHEELS = 32;
/** Largest summed scroll distance (per axis, in the page's pixels) merged into one wheel. */
export const MAX_MERGED_WHEEL_DISTANCE = 3_000;

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalBrowserInputMessage));
const encodeInput = Schema.encodeSync(Schema.fromJsonString(PersonalBrowserInputMessage));

export interface InputLineEntry {
  readonly raw: string;
  /** When the oldest message in this entry arrived. */
  readonly arrivedAt: number;
}

interface Waiting {
  raw: string;
  arrivedAt: number;
  /** Set for a wheel: what it will be sent as if it was merged. */
  wheel: { x: number; y: number; deltaX: number; deltaY: number; count: number } | null;
}

export interface InputLineOptions {
  readonly coalesceWheels: boolean;
}

export class InputLine {
  private readonly waiting: Waiting[] = [];
  private readonly coalesceWheels: boolean;

  constructor(options: InputLineOptions) {
    this.coalesceWheels = options.coalesceWheels;
  }

  get size(): number {
    return this.waiting.length;
  }

  /** Adds an input. Returns true when a wheel was merged into the one before it. */
  push(raw: string, arrivedAt: number): boolean {
    if (!this.coalesceWheels || !raw.includes('"Wheel"')) {
      this.waiting.push({ raw, arrivedAt, wheel: null });
      return false;
    }
    const decoded = decodeInput(raw);
    if (Option.isNone(decoded) || decoded.value._tag !== "Wheel") {
      this.waiting.push({ raw, arrivedAt, wheel: null });
      return false;
    }
    const { x, y, deltaX, deltaY } = decoded.value;
    const tail = this.waiting.at(-1);
    if (tail?.wheel != null) {
      const merged = {
        x,
        y,
        deltaX: tail.wheel.deltaX + deltaX,
        deltaY: tail.wheel.deltaY + deltaY,
        count: tail.wheel.count + 1,
      };
      if (
        merged.count <= MAX_MERGED_WHEELS &&
        Math.abs(merged.deltaX) <= MAX_MERGED_WHEEL_DISTANCE &&
        Math.abs(merged.deltaY) <= MAX_MERGED_WHEEL_DISTANCE
      ) {
        tail.wheel = merged;
        return true;
      }
    }
    this.waiting.push({ raw, arrivedAt, wheel: { x, y, deltaX, deltaY, count: 1 } });
    return false;
  }

  /** Removes and returns the oldest input. */
  take(): InputLineEntry | undefined {
    const next = this.waiting.shift();
    if (next === undefined) return undefined;
    if (next.wheel === null || next.wheel.count === 1) {
      return { raw: next.raw, arrivedAt: next.arrivedAt };
    }
    const { x, y, deltaX, deltaY } = next.wheel;
    return { raw: encodeInput({ _tag: "Wheel", x, y, deltaX, deltaY }), arrivedAt: next.arrivedAt };
  }
}
