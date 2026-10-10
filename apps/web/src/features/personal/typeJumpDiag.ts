/**
 * On-phone capture for the iPhone chat "jumping" while a message is typed with
 * the keyboard up (the 1.66.21 follow-up). It does not reproduce on desktop
 * Chrome or in a headless WebKit probe, so the phone reports the numbers and
 * the server log says what actually moved.
 *
 * While a 1:1 chat is mounted (ConversationScreen) and its composer has been
 * typed in, the viewport and scroll geometry is read per animation frame:
 * window.scrollY, visualViewport.offsetTop, visualViewport.height,
 * window.innerHeight, the transcript scroller's scrollTop and clientHeight,
 * and the composer field's height. When the owner sends a message - or the
 * chat closes with typing never sent - the reads fold into at most six
 * aggregated lines posted through the same perf RUM channel as perfRum.ts
 * (event "perf" on clientDiagRoute.ts):
 *
 *   type-docy    ms/at = min/max window.scrollY            - iOS panning the page
 *   type-vvoff   ms/at = min/max visualViewport.offsetTop
 *   type-vvh     ms/at = min/max visualViewport.height, closed = window.innerHeight
 *   type-scroll  ms/at = min/max transcript scrollTop, closed = its clientHeight
 *   type-comp    ms/at = min/max composer field height
 *   type-taps    recent = input events on the field (keystrokes, paste, dictation)
 *
 * `recent` holds the number of times the reported (rounded) value changed, so
 * min = max with recent 0 says "this one stayed still". The channel's
 * allowlist has no plain `count` field (clientDiagRoute.ts FIELDS), so the
 * number of changes rides in `recent`, the allowed numeric that counts
 * events; the server drops anything else. A metric never read in the session
 * is left out of the batch rather than sent as a guess; if nothing moved the
 * full set still goes out, because that is an answer too. One batch per sent
 * message, at most, covering the typing since the previous one (or since
 * mount).
 *
 * Numbers only: nothing here reads the draft, the chat, any id or any text.
 * Reads are rounded to non-negative integers, because the channel keeps
 * non-negative integer numbers only (clientDiagRoute.ts readers) while iOS
 * reports fractional offsets that go briefly negative in rubber-band
 * overscroll. Honours the "rum" kill switch (localStorage bots:perf-off).
 */

import { perfOptimizationOn } from "./perfFlags";

const DIAG_URL = "/api/personal/client-diag";
/** The composer's message field marks itself (composerRefocus.ts). */
const COMPOSER_ATTRIBUTE = "data-chat-composer-input";
/** The transcript scroller that owns the chat rows (MessageList.tsx). */
const TRANSCRIPT_ATTRIBUTE = "data-chat-transcript";
/**
 * Unfocused frames the loop still samples, so a keyboard-dismiss animation is
 * measured; then it rests until the next keystroke. A focused field samples
 * without this limit: that is the keyboard-up window the jumping is about.
 */
const UNFOCUSED_FRAMES_BEFORE_REST = 120;

/**
 * The composer field's shape, as this module reads it. Duck-typed rather than
 * `instanceof` so tests can drive the fold with lightweight stand-ins (the
 * same choice useKeyboardInset.ts makes for its keyboard-target check).
 */
interface ComposerField {
  readonly isConnected: boolean;
  readonly getBoundingClientRect: () => { readonly height: number };
}

/** The transcript scroller's shape, as this module reads it. */
interface TranscriptScroller {
  readonly isConnected: boolean;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

/** One folded metric: min / max / changes of the rounded non-negative reads. */
interface Fold {
  min: number;
  max: number;
  /** The previous rounded read, so `changes` counts transitions. */
  last: number;
  changes: number;
  read: boolean;
}

interface Capture {
  /** The field the last input event came from; its height is read each frame. */
  field: ComposerField | null;
  /** Cached transcript scroller; re-found when it leaves the document. */
  transcript: TranscriptScroller | null;
  /** Input events since the last batch: keystrokes, paste, dictation. */
  taps: number;
  /** Consecutive unfocused frames of the sampling loop. */
  unfocusedFrames: number;
  readonly docY: Fold;
  readonly vvTop: Fold;
  readonly vvHeight: Fold;
  readonly winHeight: Fold;
  readonly scrollTop: Fold;
  readonly scrollClient: Fold;
  readonly fieldHeight: Fold;
}

let watching = false;
/** The typing session being folded; null between batches. */
let current: Capture | null = null;
let frame: number | null = null;

const newFold = (): Fold => ({ min: 0, max: 0, last: 0, changes: 0, read: false });

const newCapture = (): Capture => ({
  field: null,
  transcript: null,
  taps: 0,
  unfocusedFrames: 0,
  docY: newFold(),
  vvTop: newFold(),
  vvHeight: newFold(),
  winHeight: newFold(),
  scrollTop: newFold(),
  scrollClient: newFold(),
  fieldHeight: newFold(),
});

/**
 * Folds one read into its metric. The reported number is the rounded clamp:
 * the diag channel keeps non-negative integers, and iOS reports fractional
 * offsets that go briefly negative during rubber-band overscroll.
 */
function fold(target: Fold, value: number): void {
  if (!Number.isFinite(value)) return;
  const rounded = Math.max(0, Math.round(value));
  if (!target.read) {
    target.read = true;
    target.min = rounded;
    target.max = rounded;
    target.last = rounded;
    return;
  }
  if (rounded !== target.last) {
    target.changes += 1;
    target.last = rounded;
  }
  if (rounded < target.min) target.min = rounded;
  if (rounded > target.max) target.max = rounded;
}

/** The composer field behind an input event, or null when it is some other field. */
function composerField(target: EventTarget | null): ComposerField | null {
  if (target === null || typeof target !== "object") return null;
  const element = target as { hasAttribute?: (name: string) => boolean };
  if (typeof element.hasAttribute !== "function") return null;
  // Called on the element itself: a DOM method detached from its receiver
  // throws "Illegal invocation" (a real typed keystroke found this, 10 Oct).
  return element.hasAttribute(COMPOSER_ATTRIBUTE) ? (element as unknown as ComposerField) : null;
}

function transcriptOf(capture: Capture): TranscriptScroller | null {
  const cached = capture.transcript;
  if (cached !== null && cached.isConnected) return cached;
  capture.transcript = document.querySelector<HTMLElement>(`[${TRANSCRIPT_ATTRIBUTE}]`);
  return capture.transcript;
}

function readSample(capture: Capture): void {
  const viewport = window.visualViewport;
  fold(capture.docY, window.scrollY);
  fold(capture.vvTop, viewport ? viewport.offsetTop : 0);
  fold(capture.vvHeight, viewport ? viewport.height : window.innerHeight);
  fold(capture.winHeight, window.innerHeight);
  const scroller = transcriptOf(capture);
  if (scroller !== null) {
    fold(capture.scrollTop, scroller.scrollTop);
    fold(capture.scrollClient, scroller.clientHeight);
  }
  const field = capture.field;
  if (field !== null && field.isConnected) {
    fold(capture.fieldHeight, field.getBoundingClientRect().height);
  }
}

function scheduleFrame(): void {
  if (frame !== null || typeof requestAnimationFrame !== "function") return;
  frame = requestAnimationFrame(onFrame);
}

function onFrame(): void {
  frame = null;
  const capture = current;
  if (capture === null) return;
  readSample(capture);
  capture.unfocusedFrames =
    document.activeElement === capture.field ? 0 : capture.unfocusedFrames + 1;
  if (capture.unfocusedFrames < UNFOCUSED_FRAMES_BEFORE_REST) scheduleFrame();
}

function onInput(event: Event): void {
  if (!watching) return;
  const field = composerField(event.target);
  if (field === null) return;
  if (current === null) current = newCapture();
  current.field = field;
  current.taps += 1;
  // The keystroke's own reading, before this frame's layout is even computed;
  // the loop then follows what the keyboard and the list do with it.
  readSample(current);
  scheduleFrame();
}

/** The batch lines for one capture: at most six, all "type-" perf lines. */
function batchLines(capture: Capture): ReadonlyArray<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  const range = (type: string, fold: Fold, closed?: Fold): void => {
    if (!fold.read) return;
    lines.push({
      event: "perf",
      type,
      ms: fold.min,
      at: fold.max,
      // The number of changes; `recent` is the channel's allowed count of
      // events, `count` itself is not in its allowlist (it is dropped).
      recent: fold.changes,
      // The value when the batch closed, for the one number of a pair that has
      // no range of its own (the layout viewport behind the visual one, the
      // scroller's box behind its offset).
      ...(closed !== undefined && closed.read ? { closed: closed.last } : {}),
    });
  };
  range("type-docy", capture.docY);
  range("type-vvoff", capture.vvTop);
  range("type-vvh", capture.vvHeight, capture.winHeight);
  range("type-scroll", capture.scrollTop, capture.scrollClient);
  range("type-comp", capture.fieldHeight);
  if (capture.taps > 0) lines.push({ event: "perf", type: "type-taps", recent: capture.taps });
  return lines;
}

function postBatch(lines: ReadonlyArray<Record<string, unknown>>): void {
  if (!perfOptimizationOn("rum")) return;
  for (const line of lines) {
    try {
      void fetch(DIAG_URL, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(line),
      }).catch(() => undefined);
    } catch {
      // Best-effort, like every other line on this channel.
    }
  }
}

/**
 * Posts the capture, if one is open, and lets sampling go. A send takes the
 * batch, or the chat closing does; the next keystroke opens a fresh one.
 */
function flush(): boolean {
  const capture = current;
  current = null;
  if (frame !== null) {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = null;
  }
  if (capture === null) return false;
  postBatch(batchLines(capture));
  return true;
}

/**
 * A 1:1 chat screen mounted (ConversationScreen): watch its composer field.
 * Safe to call more than once.
 */
export function startTypeJumpWatch(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("input", onInput, { capture: true, passive: true });
}

/**
 * The chat screen unmounted: post typing that was never sent, and stop.
 * Nothing is left running afterwards.
 */
export function stopTypeJumpWatch(): void {
  if (typeof document !== "undefined") {
    document.removeEventListener("input", onInput, { capture: true });
  }
  watching = false;
  flush();
}

/**
 * The composer's send was tapped (PersonalComposer): post this typing session
 * once. A second send with no typing between them posts nothing.
 */
export function noteTypeJumpSent(): void {
  flush();
}

/** Test hook: forget everything and stop sampling between tests. */
export function resetTypeJumpDiagForTest(): void {
  watching = false;
  current = null;
  if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
  frame = null;
}
