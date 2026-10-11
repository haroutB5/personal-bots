import * as Schema from "effect/Schema";

export const PERSONAL_TYPE_JUMP_TRACE_PATH = "/api/personal/type-jump-trace";
export const TYPE_JUMP_TRACE_MAX_BYTES = 32_768;
export const TYPE_JUMP_TRACE_MAX_SAMPLES = 320;
export const TYPE_JUMP_TRACE_MAX_WRITES = 80;
export const TYPE_JUMP_TRACE_MAX_MS = 10_000;

const time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: TYPE_JUMP_TRACE_MAX_MS }));
const geometry = Schema.Int.check(Schema.isBetween({ minimum: -10_000_000, maximum: 10_000_000 }));
const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 }));
const asset = Schema.String.check(
  Schema.isMaxLength(96),
  Schema.isPattern(/^(?:[A-Za-z][A-Za-z0-9_-]*\.js)?$/),
);

/** kind: frame=0, beforeinput=1, input=2, resize=3, scroll=4, selection=5,
 * composition=6, start=7, stop=8. Positions are signed CSS pixels.
 * Tuple: kind, ms, composerHeight, composerTop, fieldScrollTop, transcriptScrollTop,
 * clientHeight, scrollHeight, endDistance, row1Top, row2Top, rowGeneration,
 * documentY, visualViewportTop, visualViewportHeight, innerHeight, flags.
 * flags: focused=1, pinned=2, composing=4, row1Present=8, row2Present=16.
 * Rows are local ordinal references; no message identifiers or content are sent.
 */
export const PersonalTypeJumpSample = Schema.Tuple([
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })), time,
  geometry, geometry, geometry, geometry, geometry, geometry, geometry,
  geometry, geometry, count, geometry, geometry, geometry, geometry,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 31 })),
]);
export type PersonalTypeJumpSample = typeof PersonalTypeJumpSample.Type;

/** ms, writer, before, target, after. Writer IDs: items=0, resize=1, tween=2,
 * land=3, settle=4, reassert=5, history=6, jump=7, liveHeight=8, measureHeight=9.
 * Optional second-arm instrumentation, absent from passive capture.
 */
export const PersonalTypeJumpWrite = Schema.Tuple([
  time, Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
  geometry, geometry, geometry,
]);
export type PersonalTypeJumpWrite = typeof PersonalTypeJumpWrite.Type;

export const PersonalTypeJumpTrace = Schema.Struct({
  protocol: Schema.Literal("typejump-v1"),
  captureId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  mode: Schema.Literals(["passive", "writers"]),
  stop: Schema.Literals(["timeout", "budget", "blur", "send", "close"]),
  entryAsset: asset,
  composerAsset: asset,
  workerAsset: asset,
  standalone: Schema.Boolean,
  tween: Schema.Boolean,
  reducedMotion: Schema.Boolean,
  frozen: Schema.Boolean,
  // CSS width, DPR * 100, visualViewport scale * 100.
  viewport: Schema.Tuple([count, count, count]),
  samples: Schema.Array(PersonalTypeJumpSample).check(
    Schema.isMinLength(1), Schema.isMaxLength(TYPE_JUMP_TRACE_MAX_SAMPLES),
    Schema.makeFilter((rows) => rows.every((row, i) => i === 0 || row[1] >= rows[i - 1]![1])),
  ),
  writes: Schema.Array(PersonalTypeJumpWrite).check(
    Schema.isMaxLength(TYPE_JUMP_TRACE_MAX_WRITES),
    Schema.makeFilter((rows) => rows.every((row, i) => i === 0 || row[0] >= rows[i - 1]![0])),
  ),
}).check(Schema.makeFilter((trace) => trace.mode === "writers" || trace.writes.length === 0));
export type PersonalTypeJumpTrace = typeof PersonalTypeJumpTrace.Type;
