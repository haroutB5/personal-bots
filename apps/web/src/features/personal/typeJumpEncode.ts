/**
 * The pure half of the bounded ordered typing capture (typeJumpDiag.ts): it
 * turns the raw per-frame reads into exactly one `PersonalTypeJumpTrace` for
 * POST `PERSONAL_TYPE_JUMP_TRACE_PATH`, enforcing every budget the shared
 * contract (packages/contracts/src/personalTypeJumpTrace.ts) and the route
 * declare. No DOM and no timers live here, so the budget and privacy rules
 * are testable against the real schema without a browser.
 *
 *   - 17-int samples (kind, ms, composer height/top, field scroll, transcript
 *     scroll/client/height/endDistance, two tracked row tops + a tail
 *     generation, document Y, visual-viewport top/height, innerHeight, flags)
 *   - 5-int writes (ms, writer, before, target, after) for the writers arm;
 *     a passive trace always carries none (the schema rejects otherwise)
 *   - ms is relative to the first retained sample, clamped to the 10 s
 *     budget and forced non-decreasing
 *   - at most TYPE_JUMP_TRACE_MAX_SAMPLES samples and
 *     TYPE_JUMP_TRACE_MAX_WRITES writes; over-length traces lose their
 *     oldest samples first, and the start marker follows the new first sample
 *   - geometry stays signed (a negative endDistance is real rubber-band
 *     overscroll, never clamped to zero); only non-finite reads become 0
 *   - the final JSON is kept under TYPE_JUMP_TRACE_MAX_BYTES by dropping the
 *     oldest rows, because the route rejects an over-long body outright
 *
 * Writer ids (the contract's order): 0 items-follow, 1 resize-follow,
 * 2 re-pin tween, 3 tween land, 4 settle re-pin, 5 end re-assert,
 * 6 window anchor restore, 7 jump (message/latest, browser-chosen target is
 * the -1 sentinel), 8 live field height write, 9 hidden measurer write.
 */
import {
  TYPE_JUMP_TRACE_MAX_BYTES,
  TYPE_JUMP_TRACE_MAX_MS,
  TYPE_JUMP_TRACE_MAX_SAMPLES,
  TYPE_JUMP_TRACE_MAX_WRITES,
  type PersonalTypeJumpTrace,
} from "@t3tools/contracts";

export const TYPE_JUMP_PROTOCOL = "typejump-v1";

export const TYPE_JUMP_KIND = {
  frame: 0,
  beforeinput: 1,
  input: 2,
  resize: 3,
  scroll: 4,
  selection: 5,
  composition: 6,
  start: 7,
  stop: 8,
} as const;
export type TypeJumpKind = (typeof TYPE_JUMP_KIND)[keyof typeof TYPE_JUMP_KIND];

export const TYPE_JUMP_WRITER = {
  items: 0,
  resize: 1,
  tween: 2,
  land: 3,
  settle: 4,
  reassert: 5,
  history: 6,
  jump: 7,
  liveHeight: 8,
  measureHeight: 9,
} as const;
export type TypeJumpWriterId = (typeof TYPE_JUMP_WRITER)[keyof typeof TYPE_JUMP_WRITER];

export const TYPE_JUMP_FLAG = {
  focused: 1,
  pinned: 2,
  composing: 4,
  row1Present: 8,
  row2Present: 16,
} as const;

/** One raw read; `absMs` is on the capture's own clock, rebased on encode. */
export interface TypeJumpRawSample {
  absMs: number;
  kind: number;
  composerHeight: number;
  composerTop: number;
  fieldScrollTop: number;
  transcriptScrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  endDistance: number;
  row1Top: number;
  row2Top: number;
  rowGeneration: number;
  documentY: number;
  visualViewportTop: number;
  visualViewportHeight: number;
  innerHeight: number;
  flags: number;
}

/** One raw app-owned scroll/height write (writers arm only). */
export interface TypeJumpRawWrite {
  absMs: number;
  writer: number;
  before: number;
  target: number;
  after: number;
}

/** Everything about the capture that is not a per-sample read. */
export interface TypeJumpTraceContext {
  captureId: string;
  mode: "passive" | "writers";
  stop: PersonalTypeJumpTrace["stop"];
  epochAbs: number;
  entryAsset: string;
  composerAsset: string;
  workerAsset: string;
  standalone: boolean;
  tween: boolean;
  reducedMotion: boolean;
  frozen: boolean;
  viewportWidth: number;
  devicePixelRatio: number;
  visualViewportScale: number;
}

const GEOMETRY_LIMIT = 10_000_000;
const COUNT_LIMIT = 65_535;
const FLAGS_LIMIT = 31;
const KIND_LIMIT = 8;
const WRITER_LIMIT = 9;

/** A finite number rounded; anything else is 0 (a read that cannot be sent). */
export function readInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

const time = (value: unknown): number => clamp(readInt(value), 0, TYPE_JUMP_TRACE_MAX_MS);
const geometry = (value: unknown): number => clamp(readInt(value), -GEOMETRY_LIMIT, GEOMETRY_LIMIT);
const count = (value: unknown): number => clamp(readInt(value), 0, COUNT_LIMIT);

/** A viewport number as the contract's 0..65535 count (CSS width, DPR*100, scale*100). */
export function typeJumpViewportCount(value: unknown): number {
  return count(value);
}

/** One sample as the contract's 17-int tuple, in the contract's own order. */
function sampleRow(sample: TypeJumpRawSample, ms: number): Array<number> {
  return [
    clamp(readInt(sample.kind), 0, KIND_LIMIT),
    ms,
    geometry(sample.composerHeight),
    geometry(sample.composerTop),
    geometry(sample.fieldScrollTop),
    geometry(sample.transcriptScrollTop),
    geometry(sample.clientHeight),
    geometry(sample.scrollHeight),
    geometry(sample.endDistance),
    geometry(sample.row1Top),
    geometry(sample.row2Top),
    count(sample.rowGeneration),
    geometry(sample.documentY),
    geometry(sample.visualViewportTop),
    geometry(sample.visualViewportHeight),
    geometry(sample.innerHeight),
    clamp(readInt(sample.flags), 0, FLAGS_LIMIT),
  ];
}

function writeRow(write: TypeJumpRawWrite, ms: number): Array<number> {
  return [
    ms,
    clamp(readInt(write.writer), 0, WRITER_LIMIT),
    geometry(write.before),
    geometry(write.target),
    geometry(write.after),
  ];
}

/**
 * The basename of an executing asset (the entry module script, the capture's
 * own chunk, the service worker), or "" when it cannot be stated as one: the
 * contract only accepts plain `name.js`, so a dev-server `main.tsx` or a
 * file URL reports empty rather than guessing. Never a full URL or query.
 */
export function typeJumpAssetName(source: string | null | undefined): string {
  if (typeof source !== "string" || source.length === 0) return "";
  let path = source;
  try {
    path = new URL(source, "https://asset.invalid/").pathname;
  } catch {
    // Not URL-shaped at all; treat the raw string as the path.
  }
  const base = path.split("/").pop() ?? "";
  return /^[A-Za-z][A-Za-z0-9_-]*\.js$/.test(base) ? base : "";
}

/** A fresh opaque capture id: 32 lowercase hex chars, never derived from chat data. */
export function typeJumpCaptureId(bytes?: Uint8Array): string {
  let data = bytes;
  if (data === undefined) {
    const fresh = new Uint8Array(new ArrayBuffer(16));
    const webCrypto = globalThis.crypto;
    if (webCrypto !== undefined && typeof webCrypto.getRandomValues === "function") {
      webCrypto.getRandomValues(fresh);
    } else {
      for (let index = 0; index < fresh.length; index += 1) {
        fresh[index] = Math.floor(Math.random() * 256);
      }
    }
    data = fresh;
  }
  let out = "";
  for (const byte of data) out += byte.toString(16).padStart(2, "0");
  return out.slice(0, 32).padEnd(32, "0");
}

/** True when the trace carries no kind-7 start sample. */
function lacksStart(rows: ReadonlyArray<Array<number>>): boolean {
  return !rows.some((row) => row[0] === TYPE_JUMP_KIND.start);
}

/**
 * Encodes one capture. Returns null only if even a single-sample trace cannot
 * fit the byte budget, which the engine treats as "do not post".
 */
export function encodeTypeJumpTrace(
  context: TypeJumpTraceContext,
  samples: ReadonlyArray<TypeJumpRawSample>,
  writes: ReadonlyArray<TypeJumpRawWrite>,
): PersonalTypeJumpTrace | null {
  if (samples.length === 0) return null;
  const epoch = readInt(context.epochAbs);

  // ms: relative to the first retained sample, clamped into the budget and
  // non-decreasing (rounding two events together is fine, going back is not).
  let lastMs = 0;
  const rebase = (absMs: number): number => {
    const ms = time(absMs - epoch);
    if (ms < lastMs) return lastMs;
    lastMs = ms;
    return ms;
  };
  const sampleRows = samples.map((sample) => sampleRow(sample, rebase(sample.absMs)));
  lastMs = 0;
  const writeRows =
    context.mode === "writers" ? writes.map((write) => writeRow(write, rebase(write.absMs))) : [];

  // Budget the totals before the byte pass; oldest rows give way first.
  while (sampleRows.length > TYPE_JUMP_TRACE_MAX_SAMPLES) sampleRows.shift();
  while (writeRows.length > TYPE_JUMP_TRACE_MAX_WRITES) writeRows.pop();
  if (lacksStart(sampleRows)) sampleRows[0]![0] = TYPE_JUMP_KIND.start;

  // The start marker tracks the earliest retained sample.
  const markStart = (): void => {
    if (sampleRows.length > 0 && lacksStart(sampleRows)) sampleRows[0]![0] = TYPE_JUMP_KIND.start;
  };

  // The rows were built and bounded for exactly these schema tuples; only the
  // fixed-length tuple typing has to be re-asserted on the way out.
  const build = (): PersonalTypeJumpTrace => ({
    protocol: TYPE_JUMP_PROTOCOL,
    captureId: context.captureId,
    mode: context.mode,
    stop: context.stop,
    entryAsset: context.entryAsset,
    composerAsset: context.composerAsset,
    workerAsset: context.workerAsset,
    standalone: context.standalone,
    tween: context.tween,
    reducedMotion: context.reducedMotion,
    frozen: context.frozen,
    viewport: [
      typeJumpViewportCount(context.viewportWidth),
      typeJumpViewportCount(context.devicePixelRatio * 100),
      typeJumpViewportCount(context.visualViewportScale * 100),
    ] as unknown as PersonalTypeJumpTrace["viewport"],
    samples: sampleRows as unknown as PersonalTypeJumpTrace["samples"],
    writes: writeRows as unknown as PersonalTypeJumpTrace["writes"],
  });

  // Every character here is ASCII (numbers, hex, name.js), so the string
  // length is the wire size the route's byte cap sees.
  let trace = build();
  let json = JSON.stringify(trace);
  while (json.length > TYPE_JUMP_TRACE_MAX_BYTES && sampleRows.length > 1) {
    sampleRows.shift();
    markStart();
    trace = build();
    json = JSON.stringify(trace);
  }
  while (json.length > TYPE_JUMP_TRACE_MAX_BYTES && writeRows.length > 0) {
    writeRows.pop();
    trace = build();
    json = JSON.stringify(trace);
  }
  if (json.length > TYPE_JUMP_TRACE_MAX_BYTES) return null;
  return trace;
}
