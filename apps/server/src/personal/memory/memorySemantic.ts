// Pure vector math, binary float32 encoding, kill switch, and Reciprocal Rank
// Fusion (RRF) for hybrid FTS5 + semantic memory retrieval.
import * as NodeCrypto from "node:crypto";

import { contextualRetrievalEnabled, MATCHED_WORDS } from "./memoryRetrieval.ts";

export const SEMANTIC_MEMORY_ENV = "T3CODE_PERSONAL_MEMORY_SEMANTIC";

const DISABLED_VALUES = new Set(["off", "0", "false", "no", "disabled"]);

/**
 * Whether hybrid semantic memory retrieval is enabled.
 * Disabled when `T3CODE_PERSONAL_MEMORY_SEMANTIC` is off/0/false/no/disabled,
 * or when `T3CODE_PERSONAL_MEMORY_RETRIEVAL=legacy` is set.
 */
export const semanticMemoryEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  if (!contextualRetrievalEnabled(env)) return false;
  const raw = env[SEMANTIC_MEMORY_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return true;
  return !DISABLED_VALUES.has(raw);
};

/** Standard RRF smoothing constant. */
export const SEMANTIC_RRF_K = 60;
/** Minimum cosine similarity for a semantic hit to participate in RRF. */
export const SEMANTIC_MIN_COSINE = 0.45;
/** Minimum cosine similarity for semantic duplicate detection in `similar()`. */
export const SEMANTIC_SIMILAR_THRESHOLD = 0.72;

export const MATCHED_BY_MEANING = "matched by meaning";
export const MATCHED_WORDS_AND_MEANING = "matched words & meaning";

export type SemanticMatchReason =
  | typeof MATCHED_WORDS
  | typeof MATCHED_BY_MEANING
  | typeof MATCHED_WORDS_AND_MEANING;

/** SHA-256 hex digest of memory content, used to detect stale embeddings. */
export function contentHash(content: string): string {
  return NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** Returns an L2-normalized Float32Array copy (zero vector if norm is 0 or non-finite). */
export function normalizeVector(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values.length);
  let sumSq = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] ?? 0;
    if (!Number.isFinite(v)) return new Float32Array(values.length);
    sumSq += v * v;
  }
  if (sumSq <= 0 || !Number.isFinite(sumSq)) return out;
  const invNorm = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = (values[i] ?? 0) * invNorm;
  }
  return out;
}

/** Exact cosine similarity in [-1, 1]; returns 0 for empty, mismatched, or zero vectors. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 0 || normB <= 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  if (!Number.isFinite(sim)) return 0;
  return Math.max(-1, Math.min(1, sim));
}

/** Fast dot product for already L2-normalized Float32Arrays. */
export function dotProductNormalized(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
  }
  return Number.isFinite(dot) ? Math.max(-1, Math.min(1, dot)) : 0;
}

/** Encodes a float vector as a little-endian Float32Array byte buffer for SQLite BLOB storage. */
export function encodeVector(vector: ArrayLike<number>): Uint8Array {
  const buffer = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < vector.length; i += 1) {
    view.setFloat32(i * 4, vector[i] ?? 0, true);
  }
  return new Uint8Array(buffer);
}

/** Decodes a little-endian Float32Array BLOB from SQLite; returns null on corrupt or mismatched length. */
export function decodeVector(
  blob: Uint8Array | ArrayBuffer | ArrayBufferView,
  expectedDims?: number,
): Float32Array | null {
  const bytes =
    blob instanceof Uint8Array
      ? blob
      : blob instanceof ArrayBuffer
        ? new Uint8Array(blob)
        : new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  const dims = bytes.byteLength / 4;
  if (expectedDims !== undefined && dims !== expectedDims) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) return null;
    out[i] = v;
  }
  return out;
}

export interface FtsCandidate<T> {
  readonly id: string;
  readonly entry: T;
  readonly bm25: number;
}

export interface SemanticCandidate<T> {
  readonly id: string;
  readonly entry: T;
  readonly cosine: number;
}

export interface RrfOptions {
  readonly k?: number | undefined;
  readonly minCosine?: number | undefined;
  readonly ftsWeight?: number | undefined;
  readonly semanticWeight?: number | undefined;
}

export interface FusedCandidate<T> {
  readonly id: string;
  readonly entry: T;
  /** Combined RRF score (positive, bigger is better). */
  readonly rrfScore: number;
  /** Negative score compatible with `rankCandidates` (more negative is better). */
  readonly bm25: number;
  readonly ftsBm25: number | null;
  readonly cosine: number | null;
  readonly matchReason: SemanticMatchReason;
}

/**
 * Merges FTS5 lexical candidates and semantic cosine candidates using
 * Reciprocal Rank Fusion: `sum(weight / (k + rank))`.
 *
 * Semantic candidates below `minCosine` are filtered out before ranking.
 * Output is ordered best-first by `rrfScore DESC`.
 */
export function fuseWithRrf<T>(
  fts: ReadonlyArray<FtsCandidate<T>>,
  semantic: ReadonlyArray<SemanticCandidate<T>>,
  options?: RrfOptions,
): ReadonlyArray<FusedCandidate<T>> {
  const k = options?.k ?? SEMANTIC_RRF_K;
  const minCosine = options?.minCosine ?? SEMANTIC_MIN_COSINE;
  const ftsWeight = options?.ftsWeight ?? 1;
  const semanticWeight = options?.semanticWeight ?? 1;

  const sortedFts = fts.toSorted((a, b) => a.bm25 - b.bm25);
  const sortedSemantic = semantic
    .filter((item) => item.cosine >= minCosine)
    .toSorted((a, b) => b.cosine - a.cosine);

  const merged = new Map<
    string,
    {
      entry: T;
      rrfScore: number;
      ftsBm25: number | null;
      cosine: number | null;
    }
  >();

  for (let i = 0; i < sortedFts.length; i += 1) {
    const item = sortedFts[i]!;
    const contribution = ftsWeight / (k + i + 1);
    const existing = merged.get(item.id);
    if (existing === undefined) {
      merged.set(item.id, {
        entry: item.entry,
        rrfScore: contribution,
        ftsBm25: item.bm25,
        cosine: null,
      });
    } else if (existing.ftsBm25 === null) {
      existing.rrfScore += contribution;
      existing.ftsBm25 = item.bm25;
    }
  }

  for (let i = 0; i < sortedSemantic.length; i += 1) {
    const item = sortedSemantic[i]!;
    const contribution = semanticWeight / (k + i + 1);
    const existing = merged.get(item.id);
    if (existing === undefined) {
      merged.set(item.id, {
        entry: item.entry,
        rrfScore: contribution,
        ftsBm25: null,
        cosine: item.cosine,
      });
    } else if (existing.cosine === null) {
      existing.rrfScore += contribution;
      existing.cosine = item.cosine;
    }
  }

  const results: Array<FusedCandidate<T>> = [];
  for (const [id, item] of merged) {
    const matchReason: SemanticMatchReason =
      item.ftsBm25 !== null && item.cosine !== null
        ? MATCHED_WORDS_AND_MEANING
        : item.cosine !== null
          ? MATCHED_BY_MEANING
          : MATCHED_WORDS;
    results.push({
      id,
      entry: item.entry,
      rrfScore: item.rrfScore,
      bm25: -item.rrfScore,
      ftsBm25: item.ftsBm25,
      cosine: item.cosine,
      matchReason,
    });
  }

  return results.toSorted((a, b) => b.rrfScore - a.rrfScore);
}
