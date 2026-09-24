/**
 * Remote control of the PC by its owner, from the app's Computer > Desktop:
 * what one input message becomes for the helper.
 *
 * Coordinates arrive in the pixels of the frame the app last drew and are
 * mapped onto the monitor with the same geometry the bots' screenshots use,
 * so points outside the frame are refused rather than clamped. Key names go
 * through the bots' key parser, which is the allowlist: an unknown name is
 * refused. Every command carries `remote: true`, which makes the helper tag
 * the input as the remote user's (neither a bot's nor the person at the PC's)
 * and skip the "wait for the user to stop typing" pause bots get.
 */
import type { PersonalDesktopModifier, PersonalDesktopViewInput } from "@t3tools/contracts";

import { type DesktopRect, type ScreenFrame, toPhysical } from "./desktopGeometry.ts";
import { DesktopKeyError, parseKeyCombos } from "./desktopKeys.ts";

/** The input half of the live view socket: everything a controlling client sends. */
export type RemoteDesktopInput = Extract<
  PersonalDesktopViewInput,
  { readonly _tag: "Pointer" | "Scroll" | "Keys" | "Text" }
>;

export interface RemoteCommand {
  readonly cmd: "move" | "button" | "click" | "wheel" | "keys" | "type";
  readonly params: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

export const MODIFIER_VIRTUAL_KEYS: Readonly<Record<PersonalDesktopModifier, number>> = {
  ctrl: 0x11,
  alt: 0x12,
  shift: 0x10,
  win: 0x5b,
};

/** Is this message one that drives the PC (as opposed to Ack/Viewport/Control)? */
export function isRemoteDesktopInput(
  message: PersonalDesktopViewInput,
): message is RemoteDesktopInput {
  return (
    message._tag === "Pointer" ||
    message._tag === "Scroll" ||
    message._tag === "Keys" ||
    message._tag === "Text"
  );
}

function framePoint(
  monitor: DesktopRect,
  input: { x: number; y: number; frameWidth: number; frameHeight: number },
): { x: number; y: number } {
  const frame: ScreenFrame = {
    region: monitor,
    imageWidth: Math.round(input.frameWidth),
    imageHeight: Math.round(input.frameHeight),
    monitor: 0,
  };
  return toPhysical(frame, { x: input.x, y: input.y });
}

function planPointer(
  input: Extract<RemoteDesktopInput, { readonly _tag: "Pointer" }>,
  monitor: DesktopRect,
): RemoteCommand {
  const point = framePoint(monitor, input);
  const button = input.button ?? "left";
  switch (input.action) {
    case "move":
      return { cmd: "move", params: { ...point, remote: true } };
    case "down":
      return { cmd: "button", params: { ...point, button, down: true, remote: true } };
    case "up":
      return { cmd: "button", params: { ...point, button, down: false, remote: true } };
    case "click":
      return {
        cmd: "click",
        params: {
          ...point,
          button,
          count: input.count ?? 1,
          modifiers: [...new Set(input.modifiers ?? [])].map((name) => MODIFIER_VIRTUAL_KEYS[name]),
          remote: true,
        },
      };
  }
}

/**
 * The helper command for one remote input on `monitor` (physical pixels).
 * Throws DesktopCoordinateError (outside the frame) or DesktopKeyError
 * (unknown key, more than one combination).
 */
export function planRemoteInput(input: RemoteDesktopInput, monitor: DesktopRect): RemoteCommand {
  switch (input._tag) {
    case "Pointer":
      return planPointer(input, monitor);
    case "Scroll": {
      const point = framePoint(monitor, input);
      return {
        cmd: "wheel",
        params: {
          ...point,
          dx: Math.round(input.deltaX),
          dy: Math.round(input.deltaY),
          remote: true,
        },
      };
    }
    case "Keys": {
      const combos = parseKeyCombos(input.keys);
      if (combos.length !== 1) {
        throw new DesktopKeyError("Send one key combination at a time.");
      }
      return { cmd: "keys", params: { combos, repeat: 1, remote: true } };
    }
    case "Text":
      return {
        cmd: "type",
        params: { text: input.text, remote: true },
        timeoutMs: 10_000 + input.text.length * 20,
      };
  }
}

/** Plain moves may be dropped under load; clicks, drags, keys and text never are. */
export function isDroppableInput(input: RemoteDesktopInput): boolean {
  return input._tag === "Pointer" && input.action === "move";
}

/**
 * Per-socket token bucket: a burst of `capacity` inputs, refilled at
 * `perSecond`. A finger dragging at 30 moves a second fits; a script
 * flooding the socket does not.
 */
export class InputRateLimiter {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perSecond: number;
  private readonly now: () => number;

  constructor(options: { capacity: number; perSecond: number; now?: () => number }) {
    this.capacity = options.capacity;
    this.perSecond = options.perSecond;
    this.now = options.now ?? Date.now;
    this.tokens = options.capacity;
    this.last = this.now();
  }

  take(): boolean {
    const at = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((at - this.last) / 1000) * this.perSecond);
    this.last = at;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export const REMOTE_INPUT_RATE = { capacity: 60, perSecond: 40 } as const;
