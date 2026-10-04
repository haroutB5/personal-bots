// @effect-diagnostics globalDate:off - plain clock reads: this registry has no Effect runtime and runs inside hot synchronous paths.
/**
 * Process-wide notes for the stall recorder: which named jobs are running, which
 * long jobs just finished, which SQLite statements were slow and which garbage
 * collections were long. The recorder reads them when the event loop was blocked, so
 * the stall names what ran. Everything here is static labels and numbers (job names,
 * SQL text with its literals masked, durations): no page content, chat text or secrets.
 *
 * No dependencies and no Effect, so the SQLite client can feed it. Disabled
 * (every call a no-op) with `T3CODE_STALL_RECORDER=off`.
 */

const REGISTRY_KEY = Symbol.for("t3.personal.stallContext");

/** A finished job is kept only if it ran this long; a 1 s stall cannot hide in a shorter one. */
const RECENT_JOB_MIN_MS = 500;
/** A synchronous call is kept only if it blocked the loop this long. */
export const SLOW_OP_MIN_MS = 100;
const RING_SIZE = 64;
const SQL_FINGERPRINT_MAX = 140;

export interface StallJobRecord {
  readonly name: string;
  /** Epoch ms. */
  readonly startedAt: number;
  /** Epoch ms, or null while the job is still running. */
  readonly endedAt: number | null;
}

export interface StallOpRecord {
  /** `sql` for a SQLite statement, `fs` for a synchronous file write. */
  readonly kind: "sql" | "fs";
  /** The statement with literals masked, or the file's base name, cut short. */
  readonly label: string;
  /** How long the synchronous call held the loop. */
  readonly ms: number;
  /** Rows returned, or bytes written. */
  readonly size: number;
  /** Epoch ms the call finished. */
  readonly at: number;
}

export interface StallGcRecord {
  readonly kind: string;
  readonly ms: number;
  /** Epoch ms the collection finished. */
  readonly at: number;
}

export interface StallWindowContext {
  readonly jobs: ReadonlyArray<StallJobRecord>;
  readonly ops: ReadonlyArray<StallOpRecord>;
  readonly gc: ReadonlyArray<StallGcRecord>;
}

interface Registry {
  readonly enabled: boolean;
  nextJobId: number;
  readonly active: Map<number, { name: string; startedAt: number }>;
  readonly recentJobs: Array<StallJobRecord>;
  readonly ops: Array<StallOpRecord>;
  readonly gc: Array<StallGcRecord>;
}

const envDisabled = (value: string | undefined) =>
  value !== undefined && ["off", "0", "false", "no"].includes(value.trim().toLowerCase());

const registry = (): Registry => {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = holder[REGISTRY_KEY];
  if (existing !== undefined) return existing;
  const created: Registry = {
    enabled: !envDisabled(process.env.T3CODE_STALL_RECORDER),
    nextJobId: 1,
    active: new Map(),
    recentJobs: [],
    ops: [],
    gc: [],
  };
  holder[REGISTRY_KEY] = created;
  return created;
};

const pushRing = <T>(ring: Array<T>, entry: T) => {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
};

export const stallRecorderEnabled = (): boolean => registry().enabled;

/**
 * Masks literals so a statement can be logged: `WHERE id = 'abc'` and
 * `LIMIT 20` become `WHERE id = ? ` and `LIMIT ?`.
 */
export const fingerprintSql = (sql: string): string => {
  const masked = sql
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
  return masked.length > SQL_FINGERPRINT_MAX
    ? `${masked.slice(0, SQL_FINGERPRINT_MAX)}...`
    : masked;
};

/**
 * Marks a named job as running. Call the returned function when it ends. Names are
 * static labels such as `sweep:task-chat-archive`, never ids or text.
 */
export const beginStallJob = (name: string): (() => void) => {
  const reg = registry();
  if (!reg.enabled) return noop;
  const id = reg.nextJobId++;
  const startedAt = Date.now();
  reg.active.set(id, { name, startedAt });
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    reg.active.delete(id);
    const endedAt = Date.now();
    if (endedAt - startedAt >= RECENT_JOB_MIN_MS) {
      pushRing(reg.recentJobs, { name, startedAt, endedAt });
    }
  };
};

const noop = () => undefined;

/**
 * Reports a finished synchronous call. `startedPerfMs` is `performance.now()` from before
 * the call; `label` is only read when the call was slow. A statement's label is
 * masked, a file's is cut to its base name with digits masked.
 */
export const noteSlowOp = (
  kind: StallOpRecord["kind"],
  startedPerfMs: number,
  size: number,
  label: () => string,
): void => {
  const reg = registry();
  if (!reg.enabled) return;
  const ms = performance.now() - startedPerfMs;
  if (ms < SLOW_OP_MIN_MS) return;
  pushRing(reg.ops, {
    kind,
    label: fingerprintSql(label()),
    ms: Math.round(ms),
    size,
    at: Date.now(),
  });
};

export const noteGc = (kind: string, ms: number, at: number): void => {
  const reg = registry();
  if (!reg.enabled) return;
  pushRing(reg.gc, { kind, ms: Math.round(ms), at });
};

/**
 * Everything that overlapped `[fromMs, toMs]` (epoch ms): jobs that were running at
 * any point of it (including ones still running now), calls and collections
 * that finished inside it (up to 3 s after the window, since a call is only noted
 * when it ends).
 */
export const snapshotStallWindow = (fromMs: number, toMs: number): StallWindowContext => {
  const reg = registry();
  const jobs: Array<StallJobRecord> = [];
  for (const job of reg.recentJobs) {
    if (job.endedAt !== null && job.endedAt >= fromMs && job.startedAt <= toMs) jobs.push(job);
  }
  for (const job of reg.active.values()) {
    if (job.startedAt <= toMs)
      jobs.push({ name: job.name, startedAt: job.startedAt, endedAt: null });
  }
  return {
    jobs,
    ops: reg.ops.filter((o) => o.at >= fromMs && o.at <= toMs + 3000),
    gc: reg.gc.filter((g) => g.at >= fromMs && g.at <= toMs + 3000),
  };
};

/** Test hook: forget everything. */
export const resetStallContextForTests = (): void => {
  const reg = registry();
  reg.active.clear();
  reg.recentJobs.length = 0;
  reg.ops.length = 0;
  reg.gc.length = 0;
};
