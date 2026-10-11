/**
 * Bounded ordered capture for the iPhone chat "jumping" while a message is
 * typed with the keyboard up (the 1.66.21 follow-up). The six min/max lines
 * the aggregate capture (typeJumpDiag.ts) posts cannot identify an
 * oscillation or its writer, so this module records the ordered sequence:
 * at most two rounds per page view, each one `PersonalTypeJumpTrace`
 * (packages/contracts/src/personalTypeJumpTrace.ts) POSTed to
 * `PERSONAL_TYPE_JUMP_TRACE_PATH` over the normal same-origin transport
 * (the session cookie, keepalive, no new secret).
 *
 * Rounds (passive only; writes stay empty):
 *   - round 1 runs the untouched default: while the composer field is
 *     focused (and the document is), a 2 s rolling prehistory at <= 30 Hz
 *     plus one sample per beforeinput / input (the input read runs a
 *     microtask later, after React commits), composition, selection and
 *     resize event; nothing samples unfocused. The first composer growth of
 *     >= 8 px above the height it had when the session armed - the typed
 *     line reaching its second row - starts the round: the ring is trimmed
 *     to the last 2 s and its newest sample is re-marked kind=7 (start).
 *   - a round stops at the 10 s / 320-sample budget, on blur, on send
 *     (noteTypeJumpTraceSent), on the page hiding, or when the chat
 *     unmounts; a final kind=8 (stop) sample closes it, then the one POST
 *     goes out (best-effort; no retry).
 *   - round 2 exists only if round 1 captured (posted), and repeats the same
 *     sequence with the re-pin tween turned OFF: before it arms, the
 *     recorder merges "resize-pin-tween" into the existing `bots:perf-off`
 *     list (perfFlags.ts reads that key live at every re-pin decision, so no
 *     reload is needed), remembers the exact original string in
 *     sessionStorage, and shows a small fixed overlay banner ("Round 2 of 2
 *     - type the same again") that is out of flow and pointer-transparent,
 *     so no layout moves. The original string is restored EXACTLY on the
 *     round-2 stop, on the page hiding, on a watchdog about 2 minutes after
 *     the flip if round 2 never triggered, and (belt and braces, after a
 *     kill) at the next start if a marker survived. Nothing persists: the
 *     visible switch is back to its original value in every exit path.
 *   - after round 2 (or its watchdog, or round 1 alone failing to trigger
 *     and the pair being abandoned) nothing more is captured this page view.
 *
 * Kill switches (read-only here; both live): `bots:perf-off` with "rum"
 * (perfFlags.ts) and with "type-jump-trace" turn the capture off entirely.
 *
 * Privacy: numbers only. Rows are tracked as element references and reported
 * as two screen tops and a tail generation; the draft, chat ids, URLs, the
 * user agent and any key are never read or sent, and the capture id is
 * random. The reads are plain geometry reads in the frame callback; the
 * only writes are the round-2 control flip (restored exactly), the banner,
 * and the POST itself, none of which touch the transcript or the composer.
 */
import {
  PERSONAL_TYPE_JUMP_TRACE_PATH,
  TYPE_JUMP_TRACE_MAX_MS,
  TYPE_JUMP_TRACE_MAX_SAMPLES,
  type PersonalTypeJumpTrace,
} from "@t3tools/contracts";
import { PERF_OFF_STORAGE_KEY, perfOptimizationOn } from "./perfFlags";
import { isTranscriptPinned } from "./transcriptPinState";
import {
  encodeTypeJumpTrace,
  readInt,
  TYPE_JUMP_FLAG,
  TYPE_JUMP_KIND,
  typeJumpAssetName,
  typeJumpCaptureId,
  type TypeJumpKind,
  type TypeJumpRawSample,
  type TypeJumpTraceContext,
} from "./typeJumpEncode";

/** The composer's message field marks itself (composerRefocus.ts). */
const COMPOSER_ATTRIBUTE = "data-chat-composer-input";
/** The transcript scroller that owns the chat rows (MessageList.tsx). */
const TRANSCRIPT_ATTRIBUTE = "data-chat-transcript";
/** The chat rows; read for positions and tail identity only, never their ids. */
const ROW_ATTRIBUTE = "data-transcript-row";
/** One frame sample per this many ms: the <= 30 Hz ceiling of the contract. */
const FRAME_SAMPLE_MS = 30;
/** Selection events fire with every caret move; one sample per 50 ms is enough. */
const SELECTION_SAMPLE_MS = 50;
/** The rolling prehistory kept while armed, and the ring's own horizon. */
const PREHISTORY_MS = 2_000;
/** Composer growth this large (px) is a real typed-line growth, not a wobble. */
const TRIGGER_GROWTH_PX = 8;
/** How long round 2 waits for its trigger before the control flip is undone. */
const ROUND2_WATCHDOG_MS = 120_000;
/** sessionStorage key holding the pre-flip `bots:perf-off` string. */
const RESTORE_MARKER_KEY = "bots:typejump-restore";
/** The round-2 overlay; fixed and pointer-transparent, so nothing moves. */
const BANNER_TEXT = "Round 2 of 2 - type the same again";
/** The re-pin tween's kill-switch entry in `bots:perf-off`. */
const TWEEN_OFF_ENTRY = "resize-pin-tween";

/** The composer field's shape as this module reads it (duck-typed for tests). */
interface FieldLike {
  readonly isConnected?: boolean;
  readonly scrollTop?: number;
  getBoundingClientRect?: () => { readonly height?: number; readonly top?: number };
}

/** The transcript scroller's shape as this module reads it. */
interface ScrollerLike {
  readonly isConnected?: boolean;
  readonly scrollTop?: number;
  readonly clientHeight?: number;
  readonly scrollHeight?: number;
  querySelectorAll?: (selector: string) => ArrayLike<RowLike> | null | undefined;
}

interface RowLike {
  getBoundingClientRect?: () => { readonly top?: number };
}

type RoundNumber = 1 | 2;
/**
 * round1 -> (round2-wait while the round-1 message is still being typed) ->
 * preparing/repeating round 2 -> done for this page view.
 */
type PairState = "round1" | "round2-wait" | "round2-ready" | "round2" | "done";

interface CaptureSession {
  readonly round: RoundNumber;
  readonly field: FieldLike;
  scroller: ScrollerLike | null;
  state: "armed" | "capturing";
  /** The field height when the session armed; growth beyond it + 8 px triggers. */
  readonly baseline: number;
  samples: Array<TypeJumpRawSample>;
  /** Clock time of the first retained sample; every posted ms is relative to it. */
  epochAbs: number;
  composing: boolean;
  row1: RowLike | null;
  row2: RowLike | null;
  rowGeneration: number;
  lastFrameAbs: number;
  lastSelectionAbs: number;
  frameHandle: number | null;
  observer: { disconnect(): void } | null;
  detach: Array<() => void>;
  stopping: boolean;
}

let watching = false;
/** At most one round-1 and one round-2 capture per page view. */
let pair: PairState = "round1";
let session: CaptureSession | null = null;
let clock: () => number = () => performance.now();
let watchDetach: Array<() => void> = [];
/** Round-2 control bookkeeping (page-level, not chat-level). */
let round2Flipped = false;
let round2Watchdog: ReturnType<typeof setTimeout> | null = null;
let round2Banner: Element | null = null;
let pairDetach: Array<() => void> = [];
let pairListenersAttached = false;

const page = (): Document | undefined => (typeof document === "undefined" ? undefined : document);
const host = (): (Window & typeof globalThis) | undefined =>
  typeof window === "undefined" ? undefined : window;

function soon(work: () => void): void {
  if (typeof queueMicrotask === "function") queueMicrotask(work);
  else void Promise.resolve().then(work);
}

function captureOn(): boolean {
  return perfOptimizationOn("rum") && perfOptimizationOn("type-jump-trace");
}

/**
 * The composer field behind an event, or null when it is some other field.
 * `hasAttribute` reads through the element on purpose: a DOM method detached
 * from its receiver throws "Illegal invocation" (a typed keystroke found
 * that, 10 Oct).
 */
function composerField(target: EventTarget | null): FieldLike | null {
  if (target === null || typeof target !== "object") return null;
  const element = target as { hasAttribute?: (name: string) => boolean };
  if (typeof element.hasAttribute !== "function") return null;
  return element.hasAttribute(COMPOSER_ATTRIBUTE) ? (element as unknown as FieldLike) : null;
}

function transcriptOf(s: CaptureSession): ScrollerLike | null {
  const cached = s.scroller;
  if (cached !== null && cached.isConnected !== false) return cached;
  const found = page()?.querySelector?.(`[${TRANSCRIPT_ATTRIBUTE}]`) ?? null;
  s.scroller = (found as ScrollerLike | null) ?? null;
  return s.scroller;
}

/** Document-level focus (the frame gate reads field focus itself). */
function documentFocused(): boolean {
  const d = page();
  if (d === undefined) return false;
  return typeof d.hasFocus === "function" ? d.hasFocus() : true;
}

function documentVisible(): boolean {
  const d = page();
  if (d === undefined) return false;
  return typeof d.visibilityState === "string" ? d.visibilityState === "visible" : true;
}

function prefersReducedMotion(): boolean {
  try {
    return host()?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/** The glide is live only when its own switch is on and motion is not reduced. */
function tweenActive(): boolean {
  return perfOptimizationOn("resize-pin-tween") && !prefersReducedMotion();
}

function isStandalone(): boolean {
  try {
    if (host()?.matchMedia?.("(display-mode: standalone)").matches === true) return true;
  } catch {
    // fall through to the iOS flag
  }
  const navigatorLike = globalThis.navigator as { standalone?: boolean } | undefined;
  return navigatorLike?.standalone === true;
}

/** The first module script: the entry chunk the page is really executing. */
function entryAssetSource(): string | null {
  const element = page()?.querySelector?.('script[type="module"][src]') ?? null;
  const src = (
    element as { getAttribute?: (name: string) => string | null } | null
  )?.getAttribute?.("src");
  return typeof src === "string" ? src : null;
}

/** This module's own chunk: the executing asset that carries the capture. */
function selfAssetSource(): string | null {
  try {
    return typeof import.meta.url === "string" ? import.meta.url : null;
  } catch {
    return null;
  }
}

function workerAssetSource(): string | null {
  const scriptURL = globalThis.navigator?.serviceWorker?.controller?.scriptURL;
  return typeof scriptURL === "string" ? scriptURL : null;
}

/** One full 17-value read; batched so a frame costs one layout flush at most. */
function readSample(s: CaptureSession, kind: TypeJumpKind): TypeJumpRawSample {
  const abs = clock();
  const fieldRect = s.field.getBoundingClientRect?.();
  const scroller = transcriptOf(s);
  const rows: ArrayLike<RowLike> | null =
    scroller?.querySelectorAll?.(`[${ROW_ATTRIBUTE}]`) ?? null;
  const count = rows === null ? 0 : rows.length;
  const last = count > 0 ? rows![count - 1]! : null;
  const second = count > 1 ? rows![count - 2]! : null;
  // Tail identity: a pure append keeps the previous last row (it is the new
  // second-to-last), a re-mount replaces it without either position holding
  // the old element. Only the latter bumps the generation.
  if (s.row2 !== null && last !== s.row2 && second !== s.row2) s.rowGeneration += 1;
  s.row1 = second;
  s.row2 = last;
  const row1Top = second?.getBoundingClientRect?.().top;
  const row2Top = last?.getBoundingClientRect?.().top;
  const w = host();
  const viewport = w?.visualViewport;
  let flags = 0;
  if (page()?.activeElement === (s.field as unknown as Element)) flags |= TYPE_JUMP_FLAG.focused;
  if (isTranscriptPinned()) flags |= TYPE_JUMP_FLAG.pinned;
  if (s.composing) flags |= TYPE_JUMP_FLAG.composing;
  if (second !== null) flags |= TYPE_JUMP_FLAG.row1Present;
  if (last !== null) flags |= TYPE_JUMP_FLAG.row2Present;
  const scrollHeight = readInt(scroller?.scrollHeight);
  const scrollTop = readInt(scroller?.scrollTop);
  const clientHeight = readInt(scroller?.clientHeight);
  return {
    absMs: abs,
    kind,
    composerHeight: readInt(fieldRect?.height),
    composerTop: readInt(fieldRect?.top),
    fieldScrollTop: readInt(s.field.scrollTop),
    transcriptScrollTop: scrollTop,
    clientHeight,
    scrollHeight,
    // Signed on purpose: negative is live rubber-band overscroll, not an error.
    endDistance: scrollHeight - scrollTop - clientHeight,
    row1Top: readInt(row1Top),
    row2Top: readInt(row2Top),
    rowGeneration: s.rowGeneration,
    documentY: readInt(w?.scrollY),
    visualViewportTop: readInt(viewport?.offsetTop),
    visualViewportHeight: viewport ? readInt(viewport.height) : readInt(w?.innerHeight),
    innerHeight: readInt(w?.innerHeight),
    flags,
  };
}

/** Drops ring entries older than the prehistory horizon. */
function trim(s: CaptureSession, abs: number): void {
  const cutoff = abs - PREHISTORY_MS;
  while (s.samples.length > 0 && s.samples[0]!.absMs < cutoff) s.samples.shift();
}

function pushSample(s: CaptureSession, kind: TypeJumpKind): void {
  if (s.stopping || session !== s) return;
  const abs = clock();
  if (s.state === "capturing") {
    if (abs - s.epochAbs > TYPE_JUMP_TRACE_MAX_MS) return finish(s, "timeout");
    if (s.samples.length >= TYPE_JUMP_TRACE_MAX_SAMPLES) return finish(s, "budget");
  }
  const sample = readSample(s, kind);
  s.samples.push(sample);
  if (s.state === "armed") {
    trim(s, abs);
    const focused = (sample.flags & TYPE_JUMP_FLAG.focused) !== 0;
    if (focused && sample.composerHeight >= s.baseline + TRIGGER_GROWTH_PX) startCapture(s, abs);
    return;
  }
  if (abs - s.epochAbs >= TYPE_JUMP_TRACE_MAX_MS) finish(s, "timeout");
}

/** The typed line grew: freeze the prehistory and start the round's capture. */
function startCapture(s: CaptureSession, abs: number): void {
  s.state = "capturing";
  trim(s, abs);
  const first = s.samples[0];
  const newest = s.samples[s.samples.length - 1];
  if (newest !== undefined) newest.kind = TYPE_JUMP_KIND.start;
  s.epochAbs = first?.absMs ?? abs;
  if (s.round === 2) {
    // Round 2 is under way: the watchdog must not undo the flip mid-capture.
    pair = "round2";
    clearRound2Watchdog();
  }
}

/** Stops a capture with its reason, posts the one trace, and tears down. */
function finish(s: CaptureSession, stop: PersonalTypeJumpTrace["stop"]): void {
  if (s.stopping) return;
  s.stopping = true;
  if (s.state === "capturing") {
    if (s.samples.length < TYPE_JUMP_TRACE_MAX_SAMPLES) {
      s.samples.push(readSample(s, TYPE_JUMP_KIND.stop));
    } else {
      const last = s.samples[s.samples.length - 1];
      if (last !== undefined) last.kind = TYPE_JUMP_KIND.stop;
    }
    postTrace(s, stop);
    if (s.round === 1) {
      // A budget or time stop lands mid-message at typing speed: flipping the
      // glide off now would put the rest of the same message in round 2's
      // control. Round 2 waits until that message is sent or the field blurs.
      const midMessage =
        (stop === "budget" || stop === "timeout") &&
        page()?.activeElement === (s.field as unknown as Element);
      pair = midMessage ? "round2-wait" : "round2-ready";
      if (!midMessage) armRound2();
    } else {
      pair = "done";
      disarmRound2();
    }
  }
  endSession(s);
}

function postTrace(s: CaptureSession, stop: PersonalTypeJumpTrace["stop"]): void {
  if (!captureOn()) return;
  const w = host();
  const viewport = w?.visualViewport;
  const context: TypeJumpTraceContext = {
    captureId: typeJumpCaptureId(),
    // Passive only this release; the writers arm stays on CTO's shelf.
    mode: "passive",
    stop,
    epochAbs: s.epochAbs,
    entryAsset: typeJumpAssetName(entryAssetSource()),
    composerAsset: typeJumpAssetName(selfAssetSource()),
    workerAsset: typeJumpAssetName(workerAssetSource()),
    standalone: isStandalone(),
    // Read live: round 2 runs with the flip in place, so it reports false.
    tween: tweenActive(),
    reducedMotion: prefersReducedMotion(),
    // The frozen-88 control arm is not reachable in this build; the flag
    // reports its absence honestly rather than guessing.
    frozen: false,
    viewportWidth: readInt(w?.innerWidth),
    devicePixelRatio: typeof w?.devicePixelRatio === "number" ? w.devicePixelRatio : 0,
    visualViewportScale: viewport ? (typeof viewport.scale === "number" ? viewport.scale : 0) : 0,
  };
  const trace = encodeTypeJumpTrace(context, s.samples, []);
  if (trace === null) return;
  try {
    void fetch(PERSONAL_TYPE_JUMP_TRACE_PATH, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trace),
    }).catch(() => undefined);
  } catch {
    // Best-effort, like every other report from the phone.
  }
}

/** Tears the session down completely: no listener, observer or frame stays. */
function endSession(s: CaptureSession): void {
  if (session === s) session = null;
  if (s.frameHandle !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(s.frameHandle);
  }
  s.frameHandle = null;
  s.observer?.disconnect();
  s.observer = null;
  for (const detach of s.detach) detach();
  s.detach = [];
  if (pair === "done") detachWatch();
}

function detachWatch(): void {
  for (const detach of watchDetach) detach();
  watchDetach = [];
  for (const detach of pairDetach) detach();
  pairDetach = [];
}

function scheduleFrame(s: CaptureSession): void {
  if (s.frameHandle !== null || session !== s) return;
  if (typeof requestAnimationFrame !== "function") return;
  s.frameHandle = requestAnimationFrame(() => onFrame(s));
}

function onFrame(s: CaptureSession): void {
  s.frameHandle = null;
  if (session !== s || s.stopping) return;
  if (!documentFocused() || page()?.activeElement !== (s.field as unknown as Element)) {
    // Unfocused: no active sampling. A capture ends with its reason, an
    // armed ring is dropped and the field can arm again on the next focus.
    if (s.state === "capturing") finish(s, "blur");
    else endSession(s);
    return;
  }
  const abs = clock();
  if (abs - s.lastFrameAbs >= FRAME_SAMPLE_MS) {
    s.lastFrameAbs = abs;
    pushSample(s, TYPE_JUMP_KIND.frame);
  }
  if (session === s) scheduleFrame(s);
}

function onFocusOut(reference: CaptureSession, event: Event): void {
  if (session !== reference || event.target !== (reference.field as unknown as EventTarget)) return;
  reference.composing = false;
  if (reference.state === "capturing") finish(reference, "blur");
  else endSession(reference);
}

function onBeforeInput(reference: CaptureSession, event: Event): void {
  if (session !== reference) return;
  if (composerField(event.target) === null) return;
  pushSample(reference, TYPE_JUMP_KIND.beforeinput);
}

function onInput(reference: CaptureSession, event: Event): void {
  if (session !== reference) return;
  if (composerField(event.target) === null) return;
  // After React's synchronous commit for the event: a microtask queued here
  // runs once the whole dispatch (handlers, commit, layout effects) is done,
  // so the read sees the resized field, not the pre-commit one.
  soon(() => {
    if (session === reference && !reference.stopping) pushSample(reference, TYPE_JUMP_KIND.input);
  });
}

function onComposition(reference: CaptureSession, event: Event): void {
  if (session !== reference) return;
  if (composerField(event.target) === null) return;
  reference.composing = event.type !== "compositionend";
  pushSample(reference, TYPE_JUMP_KIND.composition);
}

function onSelection(reference: CaptureSession): void {
  if (session !== reference) return;
  const abs = clock();
  if (abs - reference.lastSelectionAbs < SELECTION_SAMPLE_MS) return;
  reference.lastSelectionAbs = abs;
  pushSample(reference, TYPE_JUMP_KIND.selection);
}

function onScroll(reference: CaptureSession, event: Event): void {
  if (session !== reference) return;
  const target = event.target;
  if (
    target !== (reference.field as unknown as EventTarget) &&
    target !== (transcriptOf(reference) as unknown as EventTarget) &&
    target !== (page() as unknown as EventTarget)
  ) {
    return;
  }
  pushSample(reference, TYPE_JUMP_KIND.scroll);
}

function observeSizes(s: CaptureSession): void {
  const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (typeof Observer !== "function") return;
  const observer = new Observer(() => {
    if (session === s && !s.stopping) pushSample(s, TYPE_JUMP_KIND.resize);
  });
  observer.observe(s.field as unknown as Element);
  const scroller = transcriptOf(s);
  if (scroller !== null) observer.observe(scroller as unknown as Element);
  s.observer = observer;
}

function attachSessionListeners(s: CaptureSession): void {
  const d = page();
  if (d === undefined) return;
  const on = (target: EventTarget, type: string, handler: (event: Event) => void): void => {
    // A test root or a stripped-down global can be missing the method.
    if (typeof (target as { addEventListener?: unknown }).addEventListener !== "function") return;
    target.addEventListener(type, handler, { capture: true, passive: true });
    s.detach.push(() => target.removeEventListener(type, handler, { capture: true }));
  };
  on(d, "focusout", (event) => onFocusOut(s, event));
  on(d, "beforeinput", (event) => onBeforeInput(s, event));
  on(d, "input", (event) => onInput(s, event));
  on(d, "compositionstart", (event) => onComposition(s, event));
  on(d, "compositionend", (event) => onComposition(s, event));
  on(d, "selectionchange", () => onSelection(s));
  on(d, "scroll", (event) => onScroll(s, event));
  on(d, "visibilitychange", () => {
    if (session !== s) return;
    if (!documentVisible()) {
      if (s.state === "capturing") finish(s, "close");
      else endSession(s);
    }
  });
  const w = host();
  if (w !== undefined) {
    on(w, "pagehide", () => {
      if (session !== s) return;
      if (s.state === "capturing") finish(s, "close");
      else endSession(s);
    });
  }
}

function armSession(field: FieldLike): void {
  if (session !== null || pair === "done" || pair === "round2-wait") return;
  if (!captureOn()) return;
  try {
    if (page()?.activeElement !== (field as unknown as Element)) return;
  } catch {
    return;
  }
  const s: CaptureSession = {
    round: pair === "round1" ? 1 : 2,
    field,
    scroller: null,
    state: "armed",
    baseline: readInt(field.getBoundingClientRect?.().height),
    samples: [],
    epochAbs: 0,
    composing: false,
    row1: null,
    row2: null,
    rowGeneration: 0,
    lastFrameAbs: Number.NEGATIVE_INFINITY,
    lastSelectionAbs: Number.NEGATIVE_INFINITY,
    frameHandle: null,
    observer: null,
    detach: [],
    stopping: false,
  };
  session = s;
  attachSessionListeners(s);
  observeSizes(s);
  scheduleFrame(s);
}

// ---------------------------------------------------------------------------
// Round 2's control flip and overlay. The flip is the only persisted control
// this module touches, and every exit path restores the original string.
// ---------------------------------------------------------------------------

function splitPerfOff(value: string | null): Array<string> {
  return value === null
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** Merges the tween entry into `bots:perf-off`, remembering the exact original. */
function flipTweenOff(): void {
  if (round2Flipped) return;
  try {
    const storage = globalThis.localStorage;
    const marker = globalThis.sessionStorage;
    if (storage === undefined || marker === undefined) return;
    const current = storage.getItem(PERF_OFF_STORAGE_KEY);
    if (splitPerfOff(current).includes(TWEEN_OFF_ENTRY)) {
      // The owner already runs with the glide off; this round needs no flip.
      round2Flipped = true;
      return;
    }
    marker.setItem(
      RESTORE_MARKER_KEY,
      JSON.stringify({ present: current !== null, value: current ?? "" }),
    );
    const merged =
      current === null || current.trim() === "" ? TWEEN_OFF_ENTRY : `${current},${TWEEN_OFF_ENTRY}`;
    storage.setItem(PERF_OFF_STORAGE_KEY, merged);
    round2Flipped = true;
  } catch {
    // No storage (a test root): the round still runs, just without the flip.
  }
}

/** Puts the pre-flip string back exactly, wherever the marker says it was. */
function restoreTweenFlag(): void {
  try {
    const storage = globalThis.localStorage;
    const marker = globalThis.sessionStorage;
    if (storage === undefined || marker === undefined) return;
    const raw = marker.getItem(RESTORE_MARKER_KEY);
    if (raw === null) return;
    marker.removeItem(RESTORE_MARKER_KEY);
    const saved = JSON.parse(raw) as { present?: boolean; value?: string };
    if (saved.present === true && typeof saved.value === "string") {
      storage.setItem(PERF_OFF_STORAGE_KEY, saved.value);
    } else {
      storage.removeItem(PERF_OFF_STORAGE_KEY);
    }
  } catch {
    // A marker that cannot be read or applied is left for the next load.
  }
  round2Flipped = false;
}

function showRound2Banner(): void {
  if (round2Banner !== null) return;
  try {
    const d = page();
    if (d === undefined || typeof d.createElement !== "function" || !d.body) return;
    const banner = d.createElement("div");
    banner.textContent = BANNER_TEXT;
    banner.setAttribute("aria-hidden", "true");
    banner.style.cssText = [
      "position:fixed",
      // Below the status bar and Dynamic Island in the standalone PWA
      // (viewport-fit=cover), as InAppNotifications does.
      "top:calc(env(safe-area-inset-top, 0px) + 8px)",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "pointer-events:none",
      "max-width:calc(100vw - 24px)",
      "padding:6px 10px",
      "border-radius:999px",
      "background:rgba(24,24,27,0.92)",
      "color:#fafafa",
      "font:500 12px/16px -apple-system,system-ui,sans-serif",
      "text-align:center",
      "white-space:nowrap",
      "box-shadow:0 2px 8px rgba(0,0,0,0.35)",
    ].join(";");
    d.body.append(banner);
    round2Banner = banner;
  } catch {
    // The overlay is a nicety; the round works without it.
  }
}

function hideRound2Banner(): void {
  try {
    round2Banner?.remove();
  } catch {
    // already gone
  }
  round2Banner = null;
}

function clearRound2Watchdog(): void {
  if (round2Watchdog !== null) clearTimeout(round2Watchdog);
  round2Watchdog = null;
}

/**
 * Arms round 2 (idempotent): flip the control, show the overlay, restart the
 * watchdog. Never runs while the page is hidden; the next visible moment arms.
 */
function armRound2(): void {
  if (pair !== "round2-ready") return;
  if (!captureOn() || !documentVisible()) return;
  flipTweenOff();
  showRound2Banner();
  clearRound2Watchdog();
  round2Watchdog = setTimeout(() => {
    round2Watchdog = null;
    // Two minutes with no second-round typing: end the pair and undo the flip.
    if (pair === "round2-ready") {
      pair = "done";
      disarmRound2();
      const s = session;
      if (s !== null) endSession(s);
      else detachWatch();
    }
  }, ROUND2_WATCHDOG_MS);
}

/**
 * The round-1 message ended (sent, field blurred or chat closed): round 2 may
 * now flip the control. Arms at once while a chat is watched; otherwise the
 * next chat's start does.
 */
function releaseRound2Wait(): void {
  if (pair !== "round2-wait") return;
  pair = "round2-ready";
  if (watching) armRound2();
}

/** Undoes the flip and removes the overlay; the pair state is the caller's. */
function disarmRound2(): void {
  clearRound2Watchdog();
  restoreTweenFlag();
  hideRound2Banner();
}

/**
 * After a kill mid-pair the marker can outlive the page: if one is found and
 * this page has not opened its own round 2, put the owner's string back.
 */
function restoreStaleFlip(): void {
  if (pair !== "round1" || round2Flipped) return;
  try {
    if (globalThis.sessionStorage?.getItem(RESTORE_MARKER_KEY) != null) restoreTweenFlag();
  } catch {
    // unreadable storage: nothing to restore here
  }
}

function attachPairListeners(): void {
  const d = page();
  if (d === undefined || pairListenersAttached) return;
  if (typeof (d as { addEventListener?: unknown }).addEventListener !== "function") return;
  pairListenersAttached = true;
  const onHide = (): void => {
    // Never leave the control flipped while the app is hidden (iOS may kill
    // it); the pair stays armed and the next visible moment flips again.
    if (pair === "round2-ready") disarmRound2();
  };
  const onShow = (): void => {
    if (pair === "round2-ready") armRound2();
  };
  const onVisibility = (): void => (documentVisible() ? onShow() : onHide());
  d.addEventListener("visibilitychange", onVisibility, { capture: true, passive: true });
  pairDetach.push(() => d.removeEventListener("visibilitychange", onVisibility, { capture: true }));
  const w = host();
  if (w !== undefined && typeof w.addEventListener === "function") {
    w.addEventListener("pagehide", onHide, { capture: true, passive: true });
    pairDetach.push(() => w.removeEventListener("pagehide", onHide, { capture: true }));
  }
}

/**
 * A 1:1 chat screen mounted (ConversationScreen): watch its composer field
 * for the at most two rounds this page view may capture. Safe to call more
 * than once; after the pair is done this installs nothing.
 */
export function startTypeJumpTrace(): void {
  restoreStaleFlip();
  if (watching || pair === "done") return;
  const d = page();
  if (d === undefined) return;
  if (typeof (d as { addEventListener?: unknown }).addEventListener !== "function") return;
  watching = true;
  const onFocusIn = (event: Event): void => {
    const field = composerField(event.target);
    if (field !== null) armSession(field);
  };
  const onWatchInput = (event: Event): void => {
    if (session !== null) return;
    const field = composerField(event.target);
    if (field === null) return;
    armSession(field);
    // Read back through a cast: arming may have opened the session, which the
    // compiler cannot see through the call.
    const s = session as CaptureSession | null;
    if (s !== null) {
      // The session's own input listener may not see the keystroke that armed
      // it (listeners added mid-dispatch are not called for that event), so
      // the arming keystroke's post-commit read is scheduled here instead.
      soon(() => {
        if (session === s && !s.stopping) pushSample(s, TYPE_JUMP_KIND.input);
      });
    }
  };
  const onFocusOut = (event: Event): void => {
    if (composerField(event.target) !== null) releaseRound2Wait();
  };
  d.addEventListener("focusin", onFocusIn, { capture: true, passive: true });
  d.addEventListener("focusout", onFocusOut, { capture: true, passive: true });
  d.addEventListener("input", onWatchInput, { capture: true, passive: true });
  watchDetach = [
    () => d.removeEventListener("focusin", onFocusIn, { capture: true }),
    () => d.removeEventListener("focusout", onFocusOut, { capture: true }),
    () => d.removeEventListener("input", onWatchInput, { capture: true }),
  ];
  if (pair === "round2-ready") armRound2();
  attachPairListeners();
}

/**
 * The chat screen unmounted (or switched chats): a capture in flight closes
 * and posts (stop="close"); an armed session that never grew is dropped. The
 * pair itself is page-level and keeps its state (and overlay) across chats.
 */
export function stopTypeJumpTrace(): void {
  watching = false;
  releaseRound2Wait();
  const s = session;
  if (s === null) return;
  if (s.state === "capturing") finish(s, "close");
  else endSession(s);
}

/**
 * The composer's send was tapped (PersonalComposer): a capture in flight
 * ends with its reason and posts (stop="send"); a session that never grew
 * was a one-line message and is dropped as uninteresting.
 */
export function noteTypeJumpTraceSent(): void {
  const s = session;
  if (s === null) {
    // The round-1 message that ran out of budget is the one being sent.
    releaseRound2Wait();
    return;
  }
  if (s.state === "capturing") finish(s, "send");
  else endSession(s);
}

/** Test hook: forget everything, detach everything, restore the clock. */
export function resetTypeJumpTraceForTest(now?: () => number): void {
  const s = session;
  session = null;
  if (s !== null) {
    if (s.frameHandle !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(s.frameHandle);
    }
    s.observer?.disconnect();
    for (const detach of s.detach) detach();
    s.detach = [];
  }
  detachWatch();
  disarmRound2();
  round2Flipped = false;
  pairListenersAttached = false;
  watching = false;
  pair = "round1";
  clock = now ?? (() => performance.now());
}
