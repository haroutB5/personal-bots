/**
 * Durable per-file scan cache.
 *
 * Transcripts are append-only and a file that has not changed can never yield
 * different usage, so parsed records are keyed by `(size, mtime)` and reused.
 * Without this every server restart re-parses the whole window: roughly 3.5s
 * for a 30-day scan here, against ~11ms to reload this cache.
 *
 * Caching *per file* rather than per day is deliberate. It is timezone
 * independent, so changing the reporting zone does not invalidate anything, and
 * it keeps cross-file de-duplication exact: cached entries are de-duplicated
 * within their own file only, and the aggregator still applies the global
 * dedupe pass over the small surviving key set.
 *
 * @module usageScanCache
 */
import type { UsageProviderKind } from "@t3tools/contracts";

import type { SliceYield } from "./sliceYield.ts";
import { GUARD_LENGTH, type TranscriptParsePosition } from "./usageTranscriptReader.ts";
import type { CodexScanState, UsageRecord, UsageSpeed } from "./usageTranscripts.ts";

// v2: Codex fork-copy suppression changed what a file parses to, so v1
// entries would keep serving double-counted records forever.
// v3: entries carry the parse position and reducer state so a grown file
// re-parses only its appended bytes instead of starting over.
// v4: records carry Claude fast mode, which v3 rows never captured.
// v5: Codex records carry their service tier. v4 rows store speed the same
// way, so v4 entries still load; see `decodeScanCache` for v4 Codex entries.
const USAGE_SCAN_CACHE_VERSION = 5 as const;
const SPEED_COMPATIBLE_SINCE_VERSION = 4;

/**
 * Each cache version writes its own file in the state directory. An older
 * server sharing that directory cannot read a newer cache and would replace
 * it, dropping saved usage for deleted transcripts. Separate files keep both.
 * A v5 server reads the legacy (v4) file once, when its own file is missing.
 */
export const SCAN_CACHE_FILE_NAME = "usage-scan-cache-v5.json";
export const LEGACY_SCAN_CACHE_FILE_NAME = "usage-scan-cache.json";

/** Serialised as the index into this list. */
const SPEEDS: readonly UsageSpeed[] = ["standard", "fast", "ultrafast"];

function isSpeed(value: unknown): value is UsageSpeed {
  return SPEEDS.some((speed) => speed === value);
}

export interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly provider: UsageProviderKind;
  /** Records from newline-terminated lines, up to `position.resumeOffset`. */
  readonly records: readonly UsageRecord[];
  /**
   * Records from a trailing segment the writer had not newline-terminated at
   * parse time. Kept apart from `records` because an incremental parse
   * re-reads that segment and would otherwise double count it.
   */
  readonly tailRecords: readonly UsageRecord[];
  readonly position: TranscriptParsePosition;
}

export type ScanCache = Map<string, CachedFile>;

/**
 * Row layout for the serialised form. Positional and interned rather than
 * object-per-record: on a 30-day window that is the difference between a file
 * measured in tens of megabytes and one under six.
 */
type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  speed: number,
];

interface SerializedFile {
  readonly s: number;
  readonly m: number;
  readonly p: UsageProviderKind;
  readonly r: readonly SerializedRecord[];
  /** Tail records; see `CachedFile.tailRecords`. */
  readonly t: readonly SerializedRecord[];
  /** Parse position: resume offset, guard length, guard hash. */
  readonly o: number;
  readonly gl: number;
  readonly gh: number;
  /** Codex reducer state at `o`; `null` for stateless providers. */
  readonly cs: CodexScanState | null;
}

interface SerializedCache {
  readonly version: number;
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<Record<string, SerializedFile>>;
}

/**
 * Interns the repeated model and session strings and serialises files against
 * the tables it builds, so a cache can be written whole or one file at a time.
 */
function makeCacheSerializer() {
  const models: string[] = [];
  const sessions: string[] = [];
  const modelIndex = new Map<string, number>();
  const sessionIndex = new Map<string, number>();

  const intern = (table: string[], index: Map<string, number>, value: string): number => {
    const existing = index.get(value);
    if (existing !== undefined) return existing;
    const next = table.length;
    table.push(value);
    index.set(value, next);
    return next;
  };

  const serializeRecord = (record: UsageRecord): SerializedRecord => [
    record.timestampMs,
    intern(models, modelIndex, record.model),
    intern(sessions, sessionIndex, record.sessionId),
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.dedupeKey,
    record.reportedCostUsd,
    SPEEDS.indexOf(record.speed),
  ];

  const serializeFile = (entry: CachedFile): SerializedFile => ({
    s: entry.size,
    m: entry.mtimeMs,
    p: entry.provider,
    r: entry.records.map(serializeRecord),
    t: entry.tailRecords.map(serializeRecord),
    o: entry.position.resumeOffset,
    gl: entry.position.guardLength,
    gh: entry.position.guardHash,
    cs: entry.position.codexState,
  });

  return { models, sessions, serializeFile };
}

/** Serialises the cache, interning the repeated model and session strings. */
export function encodeScanCache(cache: ScanCache): SerializedCache {
  const { models, sessions, serializeFile } = makeCacheSerializer();
  const files: Record<string, SerializedFile> = {};
  for (const [path, entry] of cache) files[path] = serializeFile(entry);
  return { version: USAGE_SCAN_CACHE_VERSION, models, sessions, files };
}

function isRecordArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Rebuilds the cache from a parsed document.
 *
 * Anything malformed yields an empty cache rather than an error: a corrupt
 * cache should cost one cold scan, never a broken page.
 */
export function decodeScanCache(document: unknown): ScanCache {
  const cache: ScanCache = new Map();
  if (typeof document !== "object" || document === null) return cache;

  const root = document as Partial<SerializedCache>;
  const version = root.version;
  if (
    typeof version !== "number" ||
    version < SPEED_COMPATIBLE_SINCE_VERSION ||
    version > USAGE_SCAN_CACHE_VERSION
  ) {
    return cache;
  }
  if (typeof root.files !== "object" || root.files === null) return cache;
  const tables = readTables(root);
  if (tables === null) return cache;

  const decodeEntry = makeEntryDecoder(
    tables.models,
    tables.sessions,
    version < USAGE_SCAN_CACHE_VERSION,
  );
  for (const [path, raw] of Object.entries(root.files)) {
    const entry = decodeEntry(raw);
    if (entry !== null) cache.set(path, entry);
  }
  return cache;
}

/**
 * The intern tables of a serialised cache, or null when either is corrupt.
 *
 * They must be all strings: a numeric entry would pass the undefined guard in
 * the row decoder, land in a record's model, and crash the aggregate at
 * lookupRate. A corrupt table rejects the whole cache.
 */
function readTables(root: {
  readonly models?: unknown;
  readonly sessions?: unknown;
}): { readonly models: readonly string[]; readonly sessions: readonly string[] } | null {
  if (!isRecordArray(root.models) || !isRecordArray(root.sessions)) return null;
  if (!root.models.every((value) => typeof value === "string")) return null;
  if (!root.sessions.every((value) => typeof value === "string")) return null;
  return { models: root.models as readonly string[], sessions: root.sessions as readonly string[] };
}

/**
 * Decodes one file's serialised entry against the intern tables, or returns
 * null for a corrupt one (which then costs a re-parse of that file, nothing
 * more).
 */
function makeEntryDecoder(
  models: readonly string[],
  sessions: readonly string[],
  /** The cache predates Codex service tiers, so its Codex entries are re-parsed. */
  predatesCodexTiers: boolean,
): (raw: unknown) => CachedFile | null {
  // Any corrupt row disqualifies the whole entry. Keeping the survivors
  // under the original (size, mtime) would read as a valid warm hit and the
  // file would never be re-parsed, silently losing the dropped rows' usage.
  const decodeRecords = (
    rows: readonly unknown[],
    provider: UsageProviderKind,
  ): UsageRecord[] | null => {
    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (!isRecordArray(row) || row.length < 11) return null;
      const [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
        speedIndex,
      ] = row as SerializedRecord;
      const speed = typeof speedIndex === "number" ? SPEEDS[speedIndex] : undefined;

      const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(cacheCreation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning) ||
        speed === undefined
      ) {
        return null;
      }

      records.push({
        provider,
        timestampMs,
        model,
        sessionId: (typeof sessionIndex === "number" ? sessions[sessionIndex] : undefined) ?? "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        reportedCostUsd: typeof reportedCostUsd === "number" ? reportedCostUsd : null,
        speed,
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
      });
    }
    return records;
  };

  return (raw) => {
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Partial<SerializedFile>;
    if (typeof entry.s !== "number" || typeof entry.m !== "number") return null;
    if (entry.p !== "claude" && entry.p !== "codex" && entry.p !== "grok") return null;
    if (!isRecordArray(entry.r) || !isRecordArray(entry.t)) return null;
    // Position fields feed byte offsets and a Buffer allocation in the reader,
    // so anything outside their real ranges must reject the entry: a bogus
    // guard length would otherwise fail every parse of the file, silently
    // dropping its usage instead of costing the documented cold re-parse.
    if (
      typeof entry.o !== "number" ||
      !Number.isSafeInteger(entry.o) ||
      entry.o < 0 ||
      typeof entry.gl !== "number" ||
      !Number.isSafeInteger(entry.gl) ||
      entry.gl < 0 ||
      entry.gl > GUARD_LENGTH ||
      entry.gl > entry.o ||
      typeof entry.gh !== "number" ||
      !Number.isFinite(entry.gh)
    ) {
      return null;
    }
    // Codex records from before service tiers all priced as standard. Keep
    // them, because the rollout may be gone, but make a live rollout re-parse
    // whole: no file has size -1, and a zero position cannot resume.
    const legacyCodex = entry.p === "codex" && predatesCodexTiers;
    const codexState = legacyCodex ? null : decodeCodexState(entry.cs);
    if (codexState === undefined) return null;

    const provider: UsageProviderKind = entry.p;
    const records = decodeRecords(entry.r, provider);
    const tailRecords = decodeRecords(entry.t, provider);
    if (records === null || tailRecords === null) return null;

    return {
      size: legacyCodex ? -1 : entry.s,
      mtimeMs: entry.m,
      provider,
      records,
      tailRecords,
      position: legacyCodex
        ? { resumeOffset: 0, guardLength: 0, guardHash: 0, codexState: null }
        : { resumeOffset: entry.o, guardLength: entry.gl, guardHash: entry.gh, codexState },
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Line format, written and read in slices                                    */
/* -------------------------------------------------------------------------- */

/**
 * The line format (v5, then v6 with Codex service tiers) stores the cache as a header line (the intern tables and the source
 * fingerprints) followed by one line per transcript: `[path, entry]`.
 *
 * It exists so a 6 MB cache is neither stringified nor parsed in one piece.
 * `JSON.stringify` and `JSON.parse` each hold the event loop for about 90 ms
 * on a cache this size, and neither can be interrupted; one line each can, so
 * a write or a load yields to the loop between files. A corrupt or truncated
 * line (the write is not atomic) costs only that file a re-parse, where the
 * single-document v4 lost the whole cache.
 */
const USAGE_SCAN_CACHE_LINES_VERSION = 6 as const;

/** The line format before Codex service tiers; its Codex entries are re-parsed. */
const LEGACY_LINES_VERSION = 5 as const;

/** Serialises the cache as the line format (v6), yielding between files. */
export async function encodeScanCacheLines(
  cache: ScanCache,
  sources: unknown,
  slice: SliceYield,
): Promise<string> {
  const { models, sessions, serializeFile } = makeCacheSerializer();
  const lines: string[] = [];
  for (const [path, entry] of cache) {
    lines.push(JSON.stringify([path, serializeFile(entry)]));
    if (slice.due()) await slice.yieldNow();
  }
  // The tables are only complete once every file has been serialised, so the
  // header is written last and placed first.
  const header = JSON.stringify({
    version: USAGE_SCAN_CACHE_LINES_VERSION,
    models,
    sessions,
    sources,
  });
  return `${header}\n${lines.join("\n")}\n`;
}

export interface DecodedScanCacheText {
  readonly cache: ScanCache;
  /** The object that carries `sources`: the line-format header, or the whole single document. */
  readonly document: unknown;
}

/**
 * Reads a persisted cache in either format, yielding between files. Returns
 * null when the text is not a cache at all (the caller then cold scans).
 * A single-document file (v4, v5) and the v5 line format still load, once: the
 * next write replaces them with the v6 line form.
 */
export async function decodeScanCacheText(
  text: string,
  slice: SliceYield,
): Promise<DecodedScanCacheText | null> {
  const firstNewline = text.indexOf("\n");
  const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return null;
  }
  if (typeof header !== "object" || header === null) return null;

  const root = header as { readonly version?: unknown; readonly files?: unknown };
  if (root.files !== undefined) {
    // The single-document form: the first line is the whole document.
    return { cache: decodeScanCache(header), document: header };
  }
  if (root.version !== USAGE_SCAN_CACHE_LINES_VERSION && root.version !== LEGACY_LINES_VERSION) {
    return null;
  }

  const cache: ScanCache = new Map();
  const tables = readTables(header as { models?: unknown; sessions?: unknown });
  if (tables === null || firstNewline === -1) return { cache, document: header };

  const decodeEntry = makeEntryDecoder(
    tables.models,
    tables.sessions,
    root.version === LEGACY_LINES_VERSION,
  );
  let lineStart = firstNewline + 1;
  while (lineStart < text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A truncated last line or a damaged one: that file is parsed again.
      continue;
    }
    if (!isRecordArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string") continue;
    const entry = decodeEntry(parsed[1]);
    if (entry !== null) cache.set(parsed[0], entry);
    if (slice.due()) await slice.yieldNow();
  }
  return { cache, document: header };
}

/**
 * Validates a persisted Codex reducer state. Returns `undefined` for a corrupt
 * value, which disqualifies the entry: resuming with a bad state would attach
 * appended usage to the wrong model or replay fork-copied history.
 */
function decodeCodexState(value: unknown): CodexScanState | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const state = value as Partial<CodexScanState>;
  if (
    typeof state.model !== "string" ||
    !isSpeed(state.speed) ||
    typeof state.sessionId !== "string" ||
    (state.lastUsageSignature !== null && typeof state.lastUsageSignature !== "string") ||
    typeof state.sawSessionMeta !== "boolean" ||
    typeof state.suppressingForkCopies !== "boolean" ||
    typeof state.forkCopyAnchorMs !== "number" ||
    !Number.isFinite(state.forkCopyAnchorMs)
  ) {
    return undefined;
  }
  return {
    model: state.model,
    speed: state.speed,
    sessionId: state.sessionId,
    lastUsageSignature: state.lastUsageSignature ?? null,
    sawSessionMeta: state.sawSessionMeta,
    suppressingForkCopies: state.suppressingForkCopies,
    forkCopyAnchorMs: state.forkCopyAnchorMs,
  };
}

/** Keeps saved usage after transcript cleanup, until the reporting retention expires. */
export function pruneScanCache(cache: ScanCache, retentionCutoffMs: number): number {
  let removed = 0;
  for (const [path, entry] of cache) {
    if (entry.mtimeMs < retentionCutoffMs) {
      cache.delete(path);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Within-file de-duplication, applied before an entry is cached.
 *
 * Callers stitching an incremental parse together pass one `seen` set across
 * the line and tail record batches so the whole file stays deduplicated as a
 * unit; the set is mutated in place.
 */
export function dedupeWithinFile(
  records: readonly UsageRecord[],
  seen: Set<string> = new Set(),
): readonly UsageRecord[] {
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}
