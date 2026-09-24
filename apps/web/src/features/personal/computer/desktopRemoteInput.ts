/**
 * The pure half of remote control: keyboard events to key names the server's
 * allowlist knows, sticky modifiers, text chunking, the zoomed view's
 * transform, frame coordinates and wheel units. The component only wires
 * these to events.
 */
import {
  PERSONAL_DESKTOP_REMOTE_TEXT_MAX,
  PERSONAL_DESKTOP_WHEEL_NOTCH,
  type PersonalDesktopModifier,
  type PersonalDesktopViewInput,
} from "@t3tools/contracts";

export type RemoteKeyInput = Extract<PersonalDesktopViewInput, { _tag: "Keys" | "Text" }>;

export const MODIFIER_ORDER: ReadonlyArray<PersonalDesktopModifier> = [
  "ctrl",
  "alt",
  "shift",
  "win",
];

/** Browser `KeyboardEvent.key` values to the server's key names. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: "enter",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "esc",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  ContextMenu: "menu",
  PrintScreen: "printscreen",
};

/** Keys that are only ever modifiers or states: never sent on their own. */
const IGNORED_KEYS = new Set([
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
  "Meta",
  "OS",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Unidentified",
  "Process",
  "Compose",
]);

/** A combination string the server parses: modifiers in a fixed order, then the key. */
export function comboString(
  modifiers: Iterable<PersonalDesktopModifier>,
  key: string | null,
): string {
  const held = new Set(modifiers);
  const parts: string[] = MODIFIER_ORDER.filter((name) => held.has(name));
  if (key !== null) {
    parts.push(key === "+" ? "plus" : key === " " ? "space" : key);
  }
  return parts.join("+");
}

export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/**
 * One hardware key press (or the phone keyboard's keydown) as remote input,
 * or null when it is not something to send (a bare modifier, a dead key).
 * Printable characters without Ctrl/Alt/Win become text, so any layout and
 * any symbol types as itself; the rest become a named combination.
 */
export function keyEventInput(
  event: KeyEventLike,
  sticky: ReadonlySet<PersonalDesktopModifier> = new Set(),
): RemoteKeyInput | null {
  const { key } = event;
  if (IGNORED_KEYS.has(key)) return null;
  const modifiers = new Set(sticky);
  // AltGr arrives as Ctrl+Alt with the character it typed: that is text.
  const altGraph = event.ctrlKey && event.altKey && [...key].length === 1;
  if (event.ctrlKey && !altGraph) modifiers.add("ctrl");
  if (event.altKey && !altGraph) modifiers.add("alt");
  if (event.metaKey) modifiers.add("win");
  const named = NAMED_KEYS[key] ?? (/^F([1-9]|1[0-2])$/.test(key) ? key.toLowerCase() : null);
  if (named !== null) {
    if (event.shiftKey) modifiers.add("shift");
    return { _tag: "Keys", keys: comboString(modifiers, named) };
  }
  if ([...key].length !== 1) return null;
  if (modifiers.size === 0) return { _tag: "Text", text: key };
  // Shift is already in a symbol ("!"), but not in a letter's lower-case name.
  if (event.shiftKey && /^[a-z]$/i.test(key)) modifiers.add("shift");
  return {
    _tag: "Keys",
    keys: comboString(modifiers, /^[a-z]$/i.test(key) ? key.toLowerCase() : key),
  };
}

/**
 * Text from the phone keyboard. With sticky modifiers armed the first
 * character is pressed as a combination (Ctrl then "c" is Ctrl+C) and the
 * rest is typed; long text goes in chunks the server accepts.
 */
export function textInputs(
  text: string,
  sticky: ReadonlySet<PersonalDesktopModifier> = new Set(),
): RemoteKeyInput[] {
  const chars = [...text];
  if (chars.length === 0) return [];
  const inputs: RemoteKeyInput[] = [];
  let rest = chars;
  if (sticky.size > 0) {
    const first = chars[0]!;
    const name = first === "\n" ? "enter" : /^[a-z]$/i.test(first) ? first.toLowerCase() : first;
    const modifiers = new Set(sticky);
    if (/^[A-Z]$/.test(first)) modifiers.add("shift");
    inputs.push({ _tag: "Keys", keys: comboString(modifiers, name) });
    rest = chars.slice(1);
  }
  for (let start = 0; start < rest.length; start += PERSONAL_DESKTOP_REMOTE_TEXT_MAX) {
    inputs.push({
      _tag: "Text",
      text: rest.slice(start, start + PERSONAL_DESKTOP_REMOTE_TEXT_MAX).join(""),
    });
  }
  return inputs;
}

/** The zoomed view: translate (CSS px), then scale, from the top-left corner. */
export interface ViewTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const IDENTITY_VIEW: ViewTransform = { scale: 1, x: 0, y: 0 };
export const MAX_VIEW_SCALE = 5;

export interface BoxSize {
  readonly width: number;
  readonly height: number;
}

/** Keeps the zoomed picture covering its box: no empty edge is ever pulled in. */
export function clampView(view: ViewTransform, size: BoxSize): ViewTransform {
  const scale = Math.min(MAX_VIEW_SCALE, Math.max(1, view.scale));
  if (scale === 1) return IDENTITY_VIEW;
  const minX = size.width * (1 - scale);
  const minY = size.height * (1 - scale);
  return {
    scale,
    x: Math.min(0, Math.max(minX, view.x)),
    y: Math.min(0, Math.max(minY, view.y)),
  };
}

/** Zoom by `factor` keeping the point (cx, cy) of the box (unzoomed CSS px) still. */
export function zoomView(
  view: ViewTransform,
  factor: number,
  cx: number,
  cy: number,
  size: BoxSize,
): ViewTransform {
  if (!Number.isFinite(factor) || factor <= 0) return view;
  const scale = Math.min(MAX_VIEW_SCALE, Math.max(1, view.scale * factor));
  const applied = scale / view.scale;
  return clampView(
    { scale, x: cx - (cx - view.x) * applied, y: cy - (cy - view.y) * applied },
    size,
  );
}

export function panView(view: ViewTransform, dx: number, dy: number, size: BoxSize): ViewTransform {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, size);
}

/**
 * A client point on the (possibly zoomed) picture, in the frame's pixels.
 * `rect` is the picture's on-screen rect, transform included. Null outside
 * the picture, unless `clamp` pulls it to the nearest edge (a drag that runs
 * off the side still ends on the screen's edge).
 */
export function framePoint(
  clientX: number,
  clientY: number,
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  frame: BoxSize,
  clamp = false,
): { readonly x: number; readonly y: number } | null {
  if (!(rect.width > 0 && rect.height > 0 && frame.width > 0 && frame.height > 0)) return null;
  let x = ((clientX - rect.left) / rect.width) * frame.width;
  let y = ((clientY - rect.top) / rect.height) * frame.height;
  const inside = x >= 0 && y >= 0 && x < frame.width && y < frame.height;
  if (!inside && !clamp) return null;
  x = Math.min(frame.width - 0.01, Math.max(0, x));
  y = Math.min(frame.height - 0.01, Math.max(0, y));
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

const MAX_WHEEL = 20 * PERSONAL_DESKTOP_WHEEL_NOTCH;
const clampWheel = (value: number) => Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, Math.round(value)));

/**
 * A two-finger scroll in client pixels as wheel units. Scaled by how many
 * frame pixels one client pixel covers, so the PC's page moves about as far
 * as the fingers did at any zoom.
 */
export function touchScrollWheel(clientDelta: number, rectSize: number, frameSize: number): number {
  if (!(rectSize > 0)) return 0;
  return clampWheel(clientDelta * (frameSize / rectSize) * 1.5);
}

/** A browser wheel event's delta as Windows wheel units (120 = one notch). */
export function mouseWheelUnits(delta: number, deltaMode: number): number {
  // Pixels: Chrome reports about 100 per notch. Lines: 3 per notch. Pages: one notch-ish each.
  const perUnit = deltaMode === 1 ? 40 : deltaMode === 2 ? 360 : 1.2;
  return clampWheel(delta * perUnit);
}

/** A browser mouse button (`PointerEvent.button`) as the PC's. */
export function mouseButton(button: number): "left" | "middle" | "right" {
  return button === 2 ? "right" : button === 1 ? "middle" : "left";
}
