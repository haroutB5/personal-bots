import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PERSONAL_TYPE_JUMP_TRACE_PATH,
  TYPE_JUMP_TRACE_MAX_BYTES,
  TYPE_JUMP_TRACE_MAX_SAMPLES,
  TYPE_JUMP_TRACE_MAX_WRITES,
  PersonalTypeJumpTrace,
} from "@t3tools/contracts";
import {
  TYPE_JUMP_KIND,
  TYPE_JUMP_WRITER,
  encodeTypeJumpTrace,
  typeJumpAssetName,
  typeJumpCaptureId,
  typeJumpViewportCount,
  type TypeJumpRawSample,
  type TypeJumpRawWrite,
  type TypeJumpTraceContext,
} from "./typeJumpEncode";

const decode = Schema.decodeUnknownSync(PersonalTypeJumpTrace);

function sample(overrides: Partial<TypeJumpRawSample> = {}): TypeJumpRawSample {
  return {
    absMs: 1_000,
    kind: TYPE_JUMP_KIND.frame,
    composerHeight: 44,
    composerTop: 500,
    fieldScrollTop: 0,
    transcriptScrollTop: 1_600,
    clientHeight: 487,
    scrollHeight: 2_100,
    endDistance: 13,
    row1Top: 300,
    row2Top: 420,
    rowGeneration: 0,
    documentY: 0,
    visualViewportTop: 0,
    visualViewportHeight: 487,
    innerHeight: 873,
    flags: 3,
    ...overrides,
  };
}

function context(overrides: Partial<TypeJumpTraceContext> = {}): TypeJumpTraceContext {
  return {
    captureId: "0123456789abcdef0123456789abcdef",
    mode: "passive",
    stop: "send",
    epochAbs: 1_000,
    entryAsset: "index-abc123.js",
    composerAsset: "personal-def456.js",
    workerAsset: "sw.js",
    standalone: true,
    tween: true,
    reducedMotion: false,
    frozen: false,
    viewportWidth: 390,
    devicePixelRatio: 3,
    visualViewportScale: 1,
    ...overrides,
  };
}

describe("typeJumpEncode", () => {
  it("posts the contract path the server route owns", () => {
    expect(PERSONAL_TYPE_JUMP_TRACE_PATH).toBe("/api/personal/type-jump-trace");
  });

  it("encodes a passive trace the shared schema accepts", () => {
    const samples = [
      sample({ absMs: 1_000, kind: TYPE_JUMP_KIND.start }),
      sample({ absMs: 2_016, kind: TYPE_JUMP_KIND.input }),
      sample({ absMs: 4_032, kind: TYPE_JUMP_KIND.stop }),
    ];
    const trace = encodeTypeJumpTrace(context(), samples, []);
    expect(trace).not.toBeNull();
    expect(decode(JSON.parse(JSON.stringify(trace)))).toBeDefined();
    expect(trace!.samples.map((row) => row[1])).toEqual([0, 1_016, 3_032]);
    expect(trace!.samples[0]![0]).toBe(TYPE_JUMP_KIND.start);
    expect(trace!.samples.at(-1)![0]).toBe(TYPE_JUMP_KIND.stop);
    expect(trace!.viewport).toEqual([390, 300, 100]);
  });

  it("rebases ms on the first retained sample and forces non-decreasing order", () => {
    const samples = [
      sample({ absMs: 5_000 }),
      sample({ absMs: 5_100 }),
      // Out-of-order reads must never go backwards on the wire.
      sample({ absMs: 5_050 }),
      sample({ absMs: 5_200 }),
    ];
    const trace = encodeTypeJumpTrace(context({ epochAbs: 5_000 }), samples, [])!;
    expect(trace.samples.map((row) => row[1])).toEqual([0, 100, 100, 200]);
  });

  it("clamps ms into the 10 s budget without reordering", () => {
    const samples = [sample({ absMs: 0 }), sample({ absMs: 12_500 }), sample({ absMs: 20_000 })];
    const trace = encodeTypeJumpTrace(context({ epochAbs: 0 }), samples, [])!;
    expect(trace.samples.map((row) => row[1])).toEqual([0, 10_000, 10_000]);
  });

  it("keeps signed geometry: negative endDistance and negative tops survive", () => {
    const samples = [
      sample({ endDistance: -7, composerTop: -120, row2Top: -3, documentY: -2, kind: 7 }),
    ];
    const trace = encodeTypeJumpTrace(context(), samples, [])!;
    const row = decode(JSON.parse(JSON.stringify(trace))).samples[0]!;
    expect(row[8]).toBe(-7);
    expect(row[3]).toBe(-120);
    expect(row[10]).toBe(-3);
    expect(row[12]).toBe(-2);
  });

  it("turns only non-finite reads into 0 and clamps kinds, counts and flags", () => {
    const samples = [
      sample({
        kind: 99,
        rowGeneration: 70_000,
        flags: 200,
        composerHeight: Number.NaN,
        composerTop: Number.POSITIVE_INFINITY,
      }),
      sample({ kind: 99 }),
    ];
    const trace = encodeTypeJumpTrace(context(), samples, [])!;
    const rows = decode(JSON.parse(JSON.stringify(trace))).samples;
    // The first sample has no kind=7 ahead of it, so it takes the start
    // marker; the second proves the out-of-range kind clamps to stop=8.
    expect(rows[0]![0]).toBe(TYPE_JUMP_KIND.start);
    expect(rows[1]![0]).toBe(8);
    expect(rows[0]![11]).toBe(65_535);
    expect(rows[0]![16]).toBe(31);
    expect(rows[0]![2]).toBe(0);
    expect(rows[0]![3]).toBe(0);
  });

  it("bounds a long trace to the sample cap, promoting the earliest survivor to start", () => {
    const samples = Array.from({ length: 400 }, (_, index) =>
      sample({
        absMs: index * 20,
        kind: index === 10 ? TYPE_JUMP_KIND.start : TYPE_JUMP_KIND.frame,
      }),
    );
    const trace = encodeTypeJumpTrace(context({ epochAbs: 0 }), samples, [])!;
    expect(trace.samples.length).toBe(TYPE_JUMP_TRACE_MAX_SAMPLES);
    // The newest 320 survive; the dropped head took the kind=7 marker with it,
    // so the earliest survivor takes it (exactly one start, always).
    expect(trace.samples[0]![0]).toBe(TYPE_JUMP_KIND.start);
    expect(trace.samples.filter((row) => row[0] === TYPE_JUMP_KIND.start).length).toBe(1);
    expect(trace.samples.at(-1)![1]).toBe(399 * 20);
  });

  it("keeps a passive trace's writes empty and caps writers traces at 80", () => {
    const writes: Array<TypeJumpRawWrite> = Array.from({ length: 120 }, (_, index) => ({
      absMs: index * 10,
      writer: TYPE_JUMP_WRITER.tween,
      before: 100,
      target: 120,
      after: 122,
    }));
    const passive = encodeTypeJumpTrace(context(), [sample({ kind: 7 })], writes)!;
    expect(passive.writes).toEqual([]);
    decode(JSON.parse(JSON.stringify(passive)));

    const writers = encodeTypeJumpTrace(
      context({ mode: "writers" }),
      [sample({ kind: 7 })],
      writes,
    )!;
    expect(writers.writes.length).toBe(TYPE_JUMP_TRACE_MAX_WRITES);
    expect(decode(JSON.parse(JSON.stringify(writers)))).toBeDefined();
  });

  it("keeps the JSON body under the route's byte cap even with worst-case reads", () => {
    const samples = Array.from({ length: TYPE_JUMP_TRACE_MAX_SAMPLES }, (_, index) =>
      sample({
        absMs: index * 30,
        kind: index === 0 ? TYPE_JUMP_KIND.start : TYPE_JUMP_KIND.frame,
        composerHeight: 9_999_999,
        composerTop: -9_999_999,
        fieldScrollTop: 9_999_999,
        transcriptScrollTop: -9_999_999,
        clientHeight: 9_999_999,
        scrollHeight: -9_999_999,
        endDistance: -9_999_999,
        row1Top: -9_999_999,
        row2Top: 9_999_999,
        rowGeneration: 65_535,
        documentY: -9_999_999,
        visualViewportTop: 9_999_999,
        visualViewportHeight: -9_999_999,
        innerHeight: 9_999_999,
        flags: 31,
      }),
    );
    const trace = encodeTypeJumpTrace(context({ epochAbs: 0 }), samples, [])!;
    const body = JSON.stringify(trace);
    expect(body.length).toBeLessThanOrEqual(TYPE_JUMP_TRACE_MAX_BYTES);
    const decoded = decode(JSON.parse(body));
    expect(decoded.samples.length).toBeGreaterThan(0);
    expect(decoded.samples.at(-1)![1]).toBe((TYPE_JUMP_TRACE_MAX_SAMPLES - 1) * 30);
  });

  it("names assets as plain js basenames or empty, never URLs", () => {
    expect(typeJumpAssetName("/assets/index-Df3kD2.js")).toBe("index-Df3kD2.js");
    expect(typeJumpAssetName("https://host/a/b/sw.js?v=3")).toBe("sw.js");
    expect(typeJumpAssetName("sw.js")).toBe("sw.js");
    expect(typeJumpAssetName("@vite/client")).toBe("");
    expect(typeJumpAssetName("file:///C:/wt/src/main.tsx")).toBe("");
    expect(typeJumpAssetName("index.js.map")).toBe("");
    expect(typeJumpAssetName(null)).toBe("");
    expect(typeJumpAssetName("")).toBe("");
  });

  it("makes capture ids that are 32 lowercase hex chars and deterministic from bytes", () => {
    const id = typeJumpCaptureId();
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    const injected = typeJumpCaptureId(Uint8Array.from({ length: 16 }, (_, index) => index * 16));
    expect(injected).toBe("00102030405060708090a0b0c0d0e0f0");
    expect(typeJumpCaptureId(new Uint8Array(3))).toBe("0".repeat(32));
  });

  it("clamps viewport counts into the contract range", () => {
    expect(typeJumpViewportCount(390.4)).toBe(390);
    expect(typeJumpViewportCount(-3)).toBe(0);
    expect(typeJumpViewportCount(70_000)).toBe(65_535);
    expect(typeJumpViewportCount(Number.NaN)).toBe(0);
  });
});
