import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";

/**
 * Lifecycle of the server-owned persistent Chrome shared by bots and the user.
 * `offline` means not launched yet (it launches on the first agent op or on
 * Take control); `locked` means another process holds the profile directory.
 */
export const PersonalBrowserState = Schema.Literals([
  "offline",
  "starting",
  "connected",
  "waiting_for_login",
  "crashed",
  "locked",
]);
export type PersonalBrowserState = typeof PersonalBrowserState.Type;

export const PersonalBrowserController = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Agent", {
    threadId: ThreadId,
    botId: Schema.NullOr(PersonalBotId),
    botName: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("Human", {
    /** True when the requesting session is the one holding control. */
    self: Schema.Boolean,
    /** Whether the controlling session currently has a viewer attached. */
    connected: Schema.Boolean,
  }),
]);
export type PersonalBrowserController = typeof PersonalBrowserController.Type;

export const PersonalBrowserPage = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
});
export type PersonalBrowserPage = typeof PersonalBrowserPage.Type;

export const PersonalBrowserHelpRequest = Schema.Struct({
  threadId: ThreadId,
  botId: PersonalBotId,
  botName: Schema.String,
  reason: Schema.String,
  /** ISO-8601 UTC instant from the host clock. */
  requestedAt: Schema.String,
});
export type PersonalBrowserHelpRequest = typeof PersonalBrowserHelpRequest.Type;

/** A bot and the chat it drove the browser from. */
export const PersonalBrowserAgentRef = Schema.Struct({
  threadId: ThreadId,
  botId: PersonalBotId,
});
export type PersonalBrowserAgentRef = typeof PersonalBrowserAgentRef.Type;

/**
 * A native JavaScript dialog open on the page the viewport shows. The page is
 * paused until it is answered, and a screencast cannot show browser dialogs,
 * so the client draws it and answers with `AnswerDialog`.
 */
export const PersonalBrowserDialog = Schema.Struct({
  type: Schema.Literals(["alert", "confirm", "prompt", "beforeunload"]),
  message: Schema.String,
  defaultValue: Schema.String,
});
export type PersonalBrowserDialog = typeof PersonalBrowserDialog.Type;

export const PersonalBrowserStatus = Schema.Struct({
  state: PersonalBrowserState,
  /** Human-readable reason for crashed/locked states, e.g. "Locked by pid 4312". */
  detail: Schema.NullOr(Schema.String),
  lockedByPid: Schema.NullOr(Schema.Int),
  controller: PersonalBrowserController,
  /** Bumped on every control change; stale agent ops are rejected against it. */
  generation: Schema.Int,
  /** The page the viewport shows, or null before any page exists. */
  page: Schema.NullOr(PersonalBrowserPage),
  /** A bot blocked on the shared page until the user takes over and returns it. */
  helpRequest: Schema.NullOr(PersonalBrowserHelpRequest),
  /** The dialog open on the viewport page. Optional: older servers never send it. */
  dialog: Schema.optional(Schema.NullOr(PersonalBrowserDialog)),
  /**
   * The last bot to drive this browser, kept after its agent lease lapses and
   * across a human takeover, until the browser closes (or the chat is
   * deleted). `controller` drops back to `None` 90s after the bot's last op
   * while Chrome stays open for ten idle minutes, so this — not `controller` —
   * is what "Back to chat" on the Computer tab steers by.
   */
  lastAgent: Schema.NullOr(PersonalBrowserAgentRef),
  viewers: Schema.Int,
});
export type PersonalBrowserStatus = typeof PersonalBrowserStatus.Type;

export const PersonalBrowserActivityKind = Schema.Literals([
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "resize",
  "setColorScheme",
  "screenshot",
  "download",
  "control",
]);
export type PersonalBrowserActivityKind = typeof PersonalBrowserActivityKind.Type;

/** One real host event: an agent tool op, a saved file, or a control change. */
export const PersonalBrowserActivityEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: PersonalBrowserActivityKind,
  summary: Schema.String,
  status: Schema.Literals(["succeeded", "failed"]),
  /** ISO-8601 UTC instant from the host clock. */
  at: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  botName: Schema.NullOr(Schema.String),
});
export type PersonalBrowserActivityEvent = typeof PersonalBrowserActivityEvent.Type;

/** `personalBrowser.activity` emits recent history first, then live items. */
export const PersonalBrowserStreamItem = Schema.Union([
  Schema.TaggedStruct("Recent", { events: Schema.Array(PersonalBrowserActivityEvent) }),
  Schema.TaggedStruct("Activity", { event: PersonalBrowserActivityEvent }),
  Schema.TaggedStruct("Status", { status: PersonalBrowserStatus }),
]);
export type PersonalBrowserStreamItem = typeof PersonalBrowserStreamItem.Type;

export const PersonalBrowserFile = Schema.Struct({
  /** Opaque id; resolved server-side against the artifacts directory listing. */
  id: TrimmedNonEmptyString,
  name: Schema.String,
  kind: Schema.Literals(["screenshot", "download", "recording", "other"]),
  sizeBytes: Schema.Int,
  modifiedAt: Schema.String,
});
export type PersonalBrowserFile = typeof PersonalBrowserFile.Type;

export const PersonalBrowserFilesResult = Schema.Struct({
  files: Schema.Array(PersonalBrowserFile),
});
export type PersonalBrowserFilesResult = typeof PersonalBrowserFilesResult.Type;

export class PersonalBrowserError extends Schema.TaggedError<PersonalBrowserError>()(
  "PersonalBrowserError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** HTTP upgrade route for the live viewport (binary JPEG frames + JSON control). */
export const PERSONAL_BROWSER_STREAM_PATH = "/api/personal/browser/stream";
/** `GET <prefix>/<fileId>` downloads one artifact listed by `personalBrowser.listFiles`. */
export const PERSONAL_BROWSER_FILES_ROUTE_PREFIX = "/api/personal/browser/files";

const ViewportCoordinate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(-10_000)).check(
  Schema.isLessThanOrEqualTo(100_000),
);
/**
 * Which focus-moving input a `FocusChanged` answers. The phone numbers its taps
 * and Tab/Enter presses and the server echoes the number back, so a slow reply
 * to an earlier tap can never undo what a later tap did. Absent from older
 * clients and servers, which then behave as before.
 */
const FocusSeq = Schema.optional(
  Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(2 ** 31)),
);
/** A measured duration in milliseconds or a count, as the phone reports it. */
const StreamStat = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(3_600_000),
);
const StreamStatPair = Schema.Struct({ p50: StreamStat, p95: StreamStat });
const InputModifiers = Schema.optional(
  Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"])),
);
const ViewportExtent = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(10_000),
);

/**
 * The phone viewport a human controller may ask for, in CSS pixels. Anything
 * outside is clamped rather than refused: a landscape phone reports a short
 * box, and it should get the nearest usable page, not an error.
 */
export const PERSONAL_BROWSER_VIEWPORT_BOUNDS = {
  minWidth: 320,
  maxWidth: 1024,
  minHeight: 480,
  maxHeight: 1400,
} as const;

export function clampPersonalBrowserViewport(size: {
  readonly width: number;
  readonly height: number;
}): { readonly width: number; readonly height: number } {
  const bounds = PERSONAL_BROWSER_VIEWPORT_BOUNDS;
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(value)));
  return {
    width: clamp(size.width, bounds.minWidth, bounds.maxWidth),
    height: clamp(size.height, bounds.minHeight, bounds.maxHeight),
  };
}

/**
 * Client -> server JSON messages on the viewport socket. Coordinates are CSS
 * pixels of the remote viewport (the client maps its displayed frame onto
 * `Meta.width/height`). Accepted only from the session holding human control.
 */
export const PersonalBrowserInputMessage = Schema.Union([
  Schema.TaggedStruct("Pointer", {
    action: Schema.Literals(["tap", "move", "down", "up"]),
    x: ViewportCoordinate,
    y: ViewportCoordinate,
    seq: FocusSeq,
  }),
  Schema.TaggedStruct("Wheel", {
    x: ViewportCoordinate,
    y: ViewportCoordinate,
    deltaX: Schema.Finite,
    deltaY: Schema.Finite,
  }),
  Schema.TaggedStruct("Key", {
    key: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(32)),
    modifiers: InputModifiers,
    seq: FocusSeq,
  }),
  Schema.TaggedStruct("InsertText", {
    text: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(4000)),
  }),
  Schema.TaggedStruct("Navigate", {
    url: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(2048)),
  }),
  /**
   * The finger that was scrolling has lifted: no scroll step of that gesture follows. Sent right
   * after its last `Wheel`, and only once the server said it wants it (`ScrollEndWanted`), so the
   * server can bring the sharp picture back at once instead of waiting to be sure the scrolling
   * has stopped. Never needed: without it the server settles on its own after a short quiet.
   */
  Schema.TaggedStruct("ScrollEnd", {}),
  Schema.TaggedStruct("Back", {}),
  Schema.TaggedStruct("Forward", {}),
  Schema.TaggedStruct("Reload", {}),
  /**
   * The controller's full-screen box, so the page lays out for the phone
   * instead of the laptop window. Held only while that session keeps control
   * and its viewer stays attached; the server clamps it to the bounds above.
   */
  Schema.TaggedStruct("Viewport", {
    width: ViewportExtent,
    height: ViewportExtent,
  }),
  /** OK (`accept`) or Cancel on the open dialog; `promptText` answers a prompt. */
  Schema.TaggedStruct("AnswerDialog", {
    accept: Schema.Boolean,
    promptText: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  }),
  /**
   * One frame has reached the phone. Sent for every binary frame, and only
   * after the server said it wants them (`FrameAcks`), so the server never
   * has more than a couple of frames travelling to a slow link. Any viewer
   * may send it, read-only ones included.
   */
  Schema.TaggedStruct("FrameAck", {}),
  /**
   * What the phone measured over the last few seconds of the live view, sent
   * only after the server asked (`StreamStatsWanted`): frames received, the
   * longest gap between them, decode and paint times, and how long a tap or a
   * scroll took to show up on screen. Timings only, never page content. Any
   * viewer may send it; the server just logs it next to its own numbers.
   */
  Schema.TaggedStruct("StreamStats", {
    windowMs: StreamStat,
    frames: StreamStat,
    replaced: StreamStat,
    maxGapMs: StreamStat,
    taps: StreamStat,
    wheels: StreamStat,
    decode: Schema.optional(StreamStatPair),
    paint: Schema.optional(StreamStatPair),
    receiveToPaint: Schema.optional(StreamStatPair),
    tapToPaint: Schema.optional(StreamStatPair),
    wheelToPaint: Schema.optional(StreamStatPair),
  }),
]);
export type PersonalBrowserInputMessage = typeof PersonalBrowserInputMessage.Type;

/**
 * Inputs after which the server reports where focus ended up: a tap, and Tab or
 * Enter (the next field, or off the form it submitted). These carry `seq`.
 */
export function personalBrowserInputMovesFocus(message: PersonalBrowserInputMessage): boolean {
  if (message._tag === "Pointer") return message.action === "tap";
  if (message._tag === "Key") {
    return (
      (message.key === "Tab" || message.key === "Enter") && (message.modifiers?.length ?? 0) <= 1
    );
  }
  return false;
}

/** Server -> client JSON text messages; binary messages are viewport frames. */
export const PersonalBrowserViewerMessage = Schema.Union([
  Schema.TaggedStruct("InputRejected", { reason: Schema.String }),
  /**
   * Frames are being withheld because a saved password was just filled into
   * the page on screen. The next frame means the view is live again (the page
   * left the sign-in form, or a person took control). Older clients do not
   * decode this tag and simply keep the last frame they drew.
   */
  Schema.TaggedStruct("FramesHidden", { reason: Schema.String }),
  /**
   * The first message on a socket: the server paces frames by the client's
   * `FrameAck` replies, so the client should send one per frame. Older
   * clients ignore it and are paced by the socket alone.
   */
  Schema.TaggedStruct("FrameAcks", {}),
  /** Asks the client to report what it measures (`StreamStats`). Older clients ignore it. */
  Schema.TaggedStruct("StreamStatsWanted", {}),
  /** Asks the client to send `ScrollEnd` when a scrolling finger lifts. Older clients ignore it. */
  Schema.TaggedStruct("ScrollEndWanted", {}),
  /**
   * Sent after a human tap: whether that tap left a typable element focused on
   * the remote page.
   *
   * A phone cannot raise its own keyboard outside a touch handler, so the
   * client focuses its offscreen field optimistically on every tap and uses
   * this to put the keyboard straight back down when the tap turned out to hit
   * a link or a button. Older clients do not decode this tag and ignore it.
   */
  Schema.TaggedStruct("FocusChanged", {
    editable: Schema.Boolean,
    /**
     * The kind of field focused, so the phone shows the matching keyboard
     * (`inputmode`). "password" also means: suggest and learn nothing.
     */
    field: Schema.optional(
      Schema.Literals(["text", "email", "numeric", "decimal", "tel", "url", "search", "password"]),
    ),
    /** The `seq` of the input this answers, when it carried one. */
    seq: FocusSeq,
  }),
]);
export type PersonalBrowserViewerMessage = typeof PersonalBrowserViewerMessage.Type;

/**
 * Binary viewport frame: an 8-byte big-endian header (u16 CSS width, u16 CSS
 * height, u16 deviceScaleFactor x100, u16 version) followed by JPEG bytes.
 * Carrying the size on every frame means a dropped frame can never leave the
 * client mapping taps against a stale viewport size.
 */
export const PERSONAL_BROWSER_FRAME_HEADER_BYTES = 8;
const PERSONAL_BROWSER_FRAME_VERSION = 1;

export interface PersonalBrowserFrameMeta {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

const toUint16 = (value: number) => Math.min(65_535, Math.max(0, Math.round(value)));

export function encodePersonalBrowserFrame(
  jpeg: Uint8Array,
  meta: PersonalBrowserFrameMeta,
): Uint8Array {
  const frame = new Uint8Array(PERSONAL_BROWSER_FRAME_HEADER_BYTES + jpeg.length);
  const header = new DataView(frame.buffer, 0, PERSONAL_BROWSER_FRAME_HEADER_BYTES);
  header.setUint16(0, toUint16(meta.width));
  header.setUint16(2, toUint16(meta.height));
  header.setUint16(4, toUint16(meta.deviceScaleFactor * 100));
  header.setUint16(6, PERSONAL_BROWSER_FRAME_VERSION);
  frame.set(jpeg, PERSONAL_BROWSER_FRAME_HEADER_BYTES);
  return frame;
}

export function decodePersonalBrowserFrame(
  frame: Uint8Array,
): { readonly meta: PersonalBrowserFrameMeta; readonly jpeg: Uint8Array } | null {
  if (frame.length <= PERSONAL_BROWSER_FRAME_HEADER_BYTES) return null;
  const header = new DataView(frame.buffer, frame.byteOffset, PERSONAL_BROWSER_FRAME_HEADER_BYTES);
  if (header.getUint16(6) !== PERSONAL_BROWSER_FRAME_VERSION) return null;
  const width = header.getUint16(0);
  const height = header.getUint16(2);
  if (width === 0 || height === 0) return null;
  return {
    meta: { width, height, deviceScaleFactor: header.getUint16(4) / 100 || 1 },
    jpeg: frame.subarray(PERSONAL_BROWSER_FRAME_HEADER_BYTES),
  };
}
