import { describe, expect, it } from "@effect/vitest";

import { MATCHED_WORDS, RETRIEVAL_ENV } from "./memoryRetrieval.ts";
import {
  contentHash,
  cosineSimilarity,
  decodeVector,
  dotProductNormalized,
  encodeVector,
  fuseWithRrf,
  MATCHED_BY_MEANING,
  MATCHED_WORDS_AND_MEANING,
  normalizeVector,
  SEMANTIC_MEMORY_ENV,
  semanticMemoryEnabled,
} from "./memorySemantic.ts";

describe("semanticMemoryEnabled", () => {
  it("defaults to enabled when env is unset", () => {
    expect(semanticMemoryEnabled({})).toBe(true);
  });

  it("disables on off/0/false/no/disabled (case-insensitive)", () => {
    for (const value of ["off", "OFF", " 0 ", "false", "No", "disabled"]) {
      expect(semanticMemoryEnabled({ [SEMANTIC_MEMORY_ENV]: value }), value).toBe(false);
    }
  });

  it("is bypassed when T3CODE_PERSONAL_MEMORY_RETRIEVAL=legacy", () => {
    expect(
      semanticMemoryEnabled({
        [RETRIEVAL_ENV]: "legacy",
        [SEMANTIC_MEMORY_ENV]: "on",
      }),
    ).toBe(false);
  });

  it("stays enabled for non-disabled values", () => {
    expect(semanticMemoryEnabled({ [SEMANTIC_MEMORY_ENV]: "on" })).toBe(true);
    expect(semanticMemoryEnabled({ [SEMANTIC_MEMORY_ENV]: "1" })).toBe(true);
  });
});

describe("vector math and binary encoding", () => {
  it("L2-normalizes vectors and handles zero or non-finite inputs safely", () => {
    const unit = normalizeVector([3, 4]);
    expect(unit[0]).toBeCloseTo(0.6, 5);
    expect(unit[1]).toBeCloseTo(0.8, 5);

    const zero = normalizeVector([0, 0, 0]);
    expect([...zero]).toEqual([0, 0, 0]);

    const nanVec = normalizeVector([1, Number.NaN, 2]);
    expect([...nanVec]).toEqual([0, 0, 0]);
  });

  it("computes exact cosine similarity and normalized dot product", () => {
    const a = normalizeVector([1, 2, 3]);
    const b = normalizeVector([2, 4, 6]);
    const orth = normalizeVector([0, 3, -2]);
    const opp = normalizeVector([-1, -2, -3]);

    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    expect(dotProductNormalized(a, b)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(a, orth)).toBeCloseTo(0, 5);
    expect(cosineSimilarity(a, opp)).toBeCloseTo(-1, 5);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it("round-trips little-endian Float32Array blobs and rejects malformed inputs", () => {
    const dims = 384;
    const raw = new Float32Array(dims);
    for (let i = 0; i < dims; i += 1) {
      raw[i] = Math.sin(i * 0.13) * 0.5;
    }
    const unit = normalizeVector(raw);
    const blob = encodeVector(unit);
    expect(blob.byteLength).toBe(dims * 4);

    const decoded = decodeVector(blob, dims);
    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(dims);
    for (let i = 0; i < dims; i += 1) {
      expect(decoded![i]).toBeCloseTo(unit[i]!, 6);
    }

    expect(decodeVector(blob, 128)).toBeNull();
    expect(decodeVector(new Uint8Array(0))).toBeNull();
    expect(decodeVector(new Uint8Array(5))).toBeNull();

    // Non-finite float32 bytes are rejected
    const badBuf = new ArrayBuffer(4);
    new DataView(badBuf).setFloat32(0, Number.NaN, true);
    expect(decodeVector(new Uint8Array(badBuf), 1)).toBeNull();
  });

  it("produces stable SHA-256 hex content hashes", () => {
    const h1 = contentHash("Favorite cafe in central London");
    const h2 = contentHash("Favorite cafe in central London");
    const h3 = contentHash("Favorite cafe in east London");
    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("fuseWithRrf", () => {
  it("boosts entries matched by both FTS5 and semantic and preserves match reasons", () => {
    const fused = fuseWithRrf(
      [
        { id: "fts-only", entry: { id: "fts-only" }, bm25: -5.0 },
        { id: "both", entry: { id: "both" }, bm25: -3.0 },
      ],
      [
        { id: "sem-only", entry: { id: "sem-only" }, cosine: 0.85 },
        { id: "both", entry: { id: "both" }, cosine: 0.78 },
        { id: "below-floor", entry: { id: "below-floor" }, cosine: 0.44 },
      ],
      { k: 60, minCosine: 0.45 },
    );

    expect(fused.map((item) => item.id)).toEqual(["both", "fts-only", "sem-only"]);
    expect(fused[0]!.matchReason).toBe(MATCHED_WORDS_AND_MEANING);
    expect(fused[0]!.rrfScore).toBeCloseTo(1 / 62 + 1 / 62, 6);
    expect(fused[0]!.bm25).toBeCloseTo(-fused[0]!.rrfScore, 6);

    expect(fused[1]!.matchReason).toBe(MATCHED_WORDS);
    expect(fused[1]!.cosine).toBeNull();

    expect(fused[2]!.matchReason).toBe(MATCHED_BY_MEANING);
    expect(fused[2]!.ftsBm25).toBeNull();
    expect(fused.some((item) => item.id === "below-floor")).toBe(false);
  });

  it("works when FTS5 returns zero matches (semantic-only recall)", () => {
    const fused = fuseWithRrf(
      [],
      [
        { id: "a", entry: "a", cosine: 0.91 },
        { id: "b", entry: "b", cosine: 0.62 },
      ],
    );

    expect(fused.map((item) => item.id)).toEqual(["a", "b"]);
    expect(fused.every((item) => item.matchReason === MATCHED_BY_MEANING)).toBe(true);
    expect(fused[0]!.bm25).toBeLessThan(fused[1]!.bm25);
  });
});
