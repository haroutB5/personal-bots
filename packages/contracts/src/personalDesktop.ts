import * as Schema from "effect/Schema";

/**
 * The user's real Windows desktop, driven by one bot at a time. A bot holds it
 * from its first desktop action until the turn ends, it calls
 * `computer_release`, it goes idle, or the user stops it (hotkey or app).
 * Other bots queue behind the holder.
 */

/** The key that stops a bot and takes the PC back (Ctrl+Alt+Esc works too). */
export const PERSONAL_DESKTOP_STOP_HOTKEY = "Esc";

export const PersonalDesktopClaimant = Schema.Struct({
  threadId: Schema.String,
  botId: Schema.String,
  botName: Schema.String,
});
export type PersonalDesktopClaimant = typeof PersonalDesktopClaimant.Type;

export const PersonalDesktopHolder = Schema.Struct({
  threadId: Schema.String,
  botId: Schema.String,
  botName: Schema.String,
  /** ISO-8601 UTC instant the bot got the PC. */
  since: Schema.String,
  /** ISO-8601 UTC instant of its latest desktop action. */
  lastActionAt: Schema.String,
  /**
   * `user`: the owner is controlling the PC remotely from the app (botName is
   * "You"); bots wait in line behind them. Absent from older servers: a bot.
   */
  kind: Schema.optional(Schema.Literals(["bot", "user"])),
});
export type PersonalDesktopHolder = typeof PersonalDesktopHolder.Type;

export const PersonalDesktopStopReason = Schema.Literals(["hotkey", "app", "idle"]);
export type PersonalDesktopStopReason = typeof PersonalDesktopStopReason.Type;

export const PersonalDesktopStop = Schema.Struct({
  threadId: Schema.String,
  botName: Schema.String,
  by: PersonalDesktopStopReason,
  at: Schema.String,
});
export type PersonalDesktopStop = typeof PersonalDesktopStop.Type;

export const PersonalDesktopStatus = Schema.Struct({
  /** False where the server cannot drive a desktop (not Windows). */
  available: Schema.Boolean,
  holder: Schema.NullOr(PersonalDesktopHolder),
  /** Bots waiting for the PC, first in line first. */
  waiting: Schema.Array(PersonalDesktopClaimant),
  lastStop: Schema.NullOr(PersonalDesktopStop),
  stopHotkey: Schema.String,
});
export type PersonalDesktopStatus = typeof PersonalDesktopStatus.Type;

export class PersonalDesktopError extends Schema.TaggedError<PersonalDesktopError>()(
  "PersonalDesktopError",
  { message: Schema.String },
) {}

/**
 * Live view of the PC in the app's Computer tab. A WebSocket upgrade on this
 * path (authenticated like the browser viewport: session cookie or a
 * short-lived `wsTicket`) carries binary JPEG frames, framed with
 * `encodePersonalBrowserFrame` (width/height = the frame's pixels), and JSON
 * control messages. Watching is view only; mouse and keyboard input for the
 * PC is acted on only after the socket takes remote control (`Control`).
 *
 * Frames flow only while a socket is open, which the app does only while the
 * Desktop view is on screen and the page is visible. One frame is in flight at
 * a time: the server sends the next only after the client's `Ack`, so a slow
 * relay never builds a queue.
 */
export const PERSONAL_DESKTOP_STREAM_PATH = "/api/personal/desktop/stream";

/**
 * The longest frame edge the live view ever sends, in pixels: a high-DPR
 * phone in landscape (2796 device px wide) gets most of a 1440p screen, and
 * slow acks still step frames down from here.
 */
export const PERSONAL_DESKTOP_VIEW_MAX_EDGE = 2560;
/** The shortest box edge the server honours; smaller requests are raised to it. */
export const PERSONAL_DESKTOP_VIEW_MIN_EDGE = 240;

const DesktopViewExtent = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(20_000),
);

/** Coordinates on the frame the client last drew, in that frame's pixels. */
const DesktopFrameCoordinate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(20_000),
);
const DesktopMouseButton = Schema.Literals(["left", "right", "middle"]);
/** Modifier keys a remote click may hold (the special-keys row's sticky modifiers). */
export const PersonalDesktopModifier = Schema.Literals(["ctrl", "alt", "shift", "win"]);
export type PersonalDesktopModifier = typeof PersonalDesktopModifier.Type;
/** Longest text one remote `Text` message may type. */
export const PERSONAL_DESKTOP_REMOTE_TEXT_MAX = 500;
/** One wheel notch in Windows' units (WHEEL_DELTA). */
export const PERSONAL_DESKTOP_WHEEL_NOTCH = 120;
const WheelDelta = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(-20 * PERSONAL_DESKTOP_WHEEL_NOTCH),
).check(Schema.isLessThanOrEqualTo(20 * PERSONAL_DESKTOP_WHEEL_NOTCH));
/** A share of the monitor, 0..1 on each axis. */
const DesktopViewFraction = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);

/**
 * The part of the monitor the viewer shows, as fractions of the monitor
 * (0,0,1,1 is all of it). A zoomed-in viewer names just what is on its
 * screen, so the server captures that at up to native resolution instead of
 * the whole monitor shrunk to the box.
 */
export const PersonalDesktopViewRegion = Schema.Struct({
  x: DesktopViewFraction,
  y: DesktopViewFraction,
  width: DesktopViewFraction,
  height: DesktopViewFraction,
});
export type PersonalDesktopViewRegion = typeof PersonalDesktopViewRegion.Type;

const FramePoint = {
  x: DesktopFrameCoordinate,
  y: DesktopFrameCoordinate,
  /** The size of the frame x/y refer to; the server maps it onto the monitor. */
  frameWidth: DesktopViewExtent,
  frameHeight: DesktopViewExtent,
};

/**
 * Client -> server JSON messages on the live view socket. Watching needs only
 * Ack and Viewport. Everything from `Control` down is remote control: the
 * server acts on input only while this socket holds control (see `Control`),
 * validates every coordinate against the frame, and rate-limits the socket.
 */
export const PersonalDesktopViewInput = Schema.Union([
  /** The last frame arrived and was drawn: the server may capture the next. */
  Schema.TaggedStruct("Ack", {}),
  /**
   * The box the frame is shown in, in device pixels. The server fits the
   * screen (or `region` of it) inside it, never upscaling, capped at
   * {@link PERSONAL_DESKTOP_VIEW_MAX_EDGE}. A client that sends `region`
   * (even the whole monitor) gets region frames
   * ({@link encodePersonalDesktopFrame}); one that never does gets plain
   * browser frames of the whole monitor.
   */
  Schema.TaggedStruct("Viewport", {
    width: DesktopViewExtent,
    height: DesktopViewExtent,
    region: Schema.optional(PersonalDesktopViewRegion),
  }),
  /**
   * Take (`on`) or hand back remote control. Taking it makes the user the
   * PC's holder: a bot using it is stopped, bots in line keep waiting behind
   * the user. Closing the socket hands it back too.
   */
  Schema.TaggedStruct("Control", { on: Schema.Boolean }),
  /**
   * Mouse input at a frame point. `click` is a whole press and release
   * (`count` 2 = double click); `down`/`move`/`up` drive a drag or hover.
   */
  Schema.TaggedStruct("Pointer", {
    action: Schema.Literals(["move", "down", "up", "click"]),
    ...FramePoint,
    button: Schema.optional(DesktopMouseButton),
    count: Schema.optional(Schema.Literals([1, 2])),
    modifiers: Schema.optional(Schema.Array(PersonalDesktopModifier).check(Schema.isMaxLength(4))),
  }),
  /**
   * Mouse wheel at a frame point, in WHEEL_DELTA units (120 = one notch).
   * Browser convention: `deltaY > 0` scrolls down, `deltaX > 0` scrolls right.
   */
  Schema.TaggedStruct("Scroll", { ...FramePoint, deltaX: WheelDelta, deltaY: WheelDelta }),
  /**
   * One key combination by name, e.g. "ctrl+c", "alt+tab", "win", "escape",
   * "left" (names from the server's allowlist; a single character is allowed).
   */
  Schema.TaggedStruct("Keys", {
    keys: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(48)),
  }),
  /** Text typed as Unicode characters; a newline presses Enter. */
  Schema.TaggedStruct("Text", {
    text: Schema.String.check(Schema.isNonEmpty()).check(
      Schema.isMaxLength(PERSONAL_DESKTOP_REMOTE_TEXT_MAX),
    ),
  }),
]);
export type PersonalDesktopViewInput = typeof PersonalDesktopViewInput.Type;

export const PersonalDesktopViewState = Schema.Literals(["live", "locked", "unavailable"]);
export type PersonalDesktopViewState = typeof PersonalDesktopViewState.Type;

/** Server -> client JSON messages; binary messages are frames. */
export const PersonalDesktopViewMessage = Schema.Union([
  /**
   * `locked`: the PC is locked or a secure prompt is up, so nothing is
   * captured. `unavailable`: the screen cannot be captured right now (detail
   * says why); the server keeps retrying while the view stays open.
   */
  Schema.TaggedStruct("ViewState", {
    state: PersonalDesktopViewState,
    detail: Schema.optional(Schema.String),
  }),
  /**
   * Whether this socket controls the PC. Sent in answer to `Control`, and
   * unprompted when control ends on the server's side (idle, Esc pressed at
   * the PC, another device took over, the PC locked); `detail` says why.
   */
  Schema.TaggedStruct("Control", {
    on: Schema.Boolean,
    detail: Schema.optional(Schema.String),
  }),
  /** One input was refused (outside the frame, too fast, PC locked); nothing was done. */
  Schema.TaggedStruct("InputRefused", { detail: Schema.String }),
]);
export type PersonalDesktopViewMessage = typeof PersonalDesktopViewMessage.Type;

/**
 * The box a frame is fitted into: the viewer's box with each edge capped at
 * {@link PERSONAL_DESKTOP_VIEW_MAX_EDGE} and raised to at least
 * {@link PERSONAL_DESKTOP_VIEW_MIN_EDGE}. Capping the edges separately (not
 * shrinking the box whole) still keeps the fitted frame's long edge under
 * the cap, without costing a wide landscape box its height.
 */
export function clampPersonalDesktopViewBox(box: {
  readonly width: number;
  readonly height: number;
}): { readonly width: number; readonly height: number } {
  const width =
    Number.isFinite(box.width) && box.width > 0 ? box.width : PERSONAL_DESKTOP_VIEW_MAX_EDGE;
  const height =
    Number.isFinite(box.height) && box.height > 0 ? box.height : PERSONAL_DESKTOP_VIEW_MAX_EDGE;
  const edge = (value: number) =>
    Math.max(
      PERSONAL_DESKTOP_VIEW_MIN_EDGE,
      Math.round(Math.min(PERSONAL_DESKTOP_VIEW_MAX_EDGE, value)),
    );
  return { width: edge(width), height: edge(height) };
}

/**
 * A live view frame that says which part of the monitor it shows. The first
 * 8 bytes are a browser frame header (u16 width, u16 height, u16 100, u16
 * version) with version {@link PERSONAL_DESKTOP_FRAME_VERSION}, so the browser
 * decoder refuses it rather than misplacing it; then u16 region x, y, width,
 * height and u16 monitor width, height, all in the monitor's physical pixels
 * (region relative to the monitor's top-left); then the JPEG.
 *
 * Carrying the region on every frame means a frame captured before a zoom
 * change is still drawn where it belongs, and taps map through the monitor
 * size rather than whichever frame happens to be on screen.
 */
export const PERSONAL_DESKTOP_FRAME_HEADER_BYTES = 20;
export const PERSONAL_DESKTOP_FRAME_VERSION = 2;

export interface PersonalDesktopFrameMeta {
  /** The frame's own pixels. */
  readonly width: number;
  readonly height: number;
  /** What it shows, in monitor pixels. */
  readonly region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly screenWidth: number;
  readonly screenHeight: number;
}

const toU16 = (value: number) => Math.min(65_535, Math.max(0, Math.round(value)));

export function encodePersonalDesktopFrame(
  jpeg: Uint8Array,
  meta: PersonalDesktopFrameMeta,
): Uint8Array {
  const frame = new Uint8Array(PERSONAL_DESKTOP_FRAME_HEADER_BYTES + jpeg.length);
  const header = new DataView(frame.buffer, 0, PERSONAL_DESKTOP_FRAME_HEADER_BYTES);
  const fields = [
    meta.width,
    meta.height,
    100,
    PERSONAL_DESKTOP_FRAME_VERSION,
    meta.region.x,
    meta.region.y,
    meta.region.width,
    meta.region.height,
    meta.screenWidth,
    meta.screenHeight,
  ];
  fields.forEach((value, index) => header.setUint16(index * 2, toU16(value)));
  frame.set(jpeg, PERSONAL_DESKTOP_FRAME_HEADER_BYTES);
  return frame;
}

/** A region frame, or null for anything else (a plain browser frame included). */
export function decodePersonalDesktopFrame(
  frame: Uint8Array,
): { readonly meta: PersonalDesktopFrameMeta; readonly jpeg: Uint8Array } | null {
  if (frame.length <= PERSONAL_DESKTOP_FRAME_HEADER_BYTES) return null;
  const header = new DataView(frame.buffer, frame.byteOffset, PERSONAL_DESKTOP_FRAME_HEADER_BYTES);
  if (header.getUint16(6) !== PERSONAL_DESKTOP_FRAME_VERSION) return null;
  const at = (index: number) => header.getUint16(index * 2);
  const meta: PersonalDesktopFrameMeta = {
    width: at(0),
    height: at(1),
    region: { x: at(4), y: at(5), width: at(6), height: at(7) },
    screenWidth: at(8),
    screenHeight: at(9),
  };
  if (
    meta.width === 0 ||
    meta.height === 0 ||
    meta.region.width === 0 ||
    meta.region.height === 0 ||
    meta.region.x + meta.region.width > meta.screenWidth ||
    meta.region.y + meta.region.height > meta.screenHeight
  ) {
    return null;
  }
  return { meta, jpeg: frame.subarray(PERSONAL_DESKTOP_FRAME_HEADER_BYTES) };
}
