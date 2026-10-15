// @effect-diagnostics globalTimers:off -- worker startup/stop deadlines live outside any Effect fiber.
import * as NodeWorkerThreads from "node:worker_threads";

export const SQLITE_CHECKPOINT_INTERVAL_MS = 1_000;
// Same trigger as SQLite's default wal_autocheckpoint (1000 frames). Every
// complete checkpoint makes the next commit restart the WAL and sync its
// header on the writer's thread, so checkpointing more often adds main-thread
// syncs instead of removing them.
export const SQLITE_CHECKPOINT_THRESHOLD_FRAMES = 1_000;

export const sqliteCheckpointWorkerEnabled = (value: string | undefined): boolean =>
  !["off", "0", "false", "no", "disabled"].includes(value?.trim().toLowerCase() ?? "");

// Older Node builds can embed SQLite affected by the concurrent WAL-reset race.
// https://sqlite.org/wal.html#the_wal_reset_bug
export const sqliteConcurrentCheckpointSafe = (version: string): boolean => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return (
    major > 3 ||
    (major === 3 &&
      (minor > 51 ||
        (minor === 51 && patch >= 3) ||
        (minor === 50 && patch >= 7) ||
        (minor === 44 && patch >= 6)))
  );
};

// Inline source works in both the bundled server and TS development without a
// second deployment artifact. This connection never writes application rows.
const SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { closeSync, openSync, readSync, statSync } = require('node:fs');
const { endianness } = require('node:os');
const db = new DatabaseSync(workerData.filename, { timeout: 0 });
db.exec('PRAGMA synchronous=' + workerData.synchronous);
db.exec('PRAGMA wal_autocheckpoint=0');
db.exec('PRAGMA cache_size=-2000');
const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
const header = Buffer.alloc(100);
let lastWarning = 0;
function walIndex() {
  let fd;
  try { fd = openSync(workerData.filename + '-shm', 'r'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { if (readSync(fd, header, 0, 100, 0) < 100) return null; }
  finally { closeSync(fd); }
  // https://sqlite.org/walformat.html: two copies of the 48-byte wal-index
  // header (mxFrame at 16), then nBackfill at 96, in native byte order.
  // Copies that differ mean a writer is mid-update: skip this tick.
  if (header.compare(header, 0, 48, 48, 96) !== 0) return null;
  const le = endianness() === 'LE';
  const u32 = (offset) => (le ? header.readUInt32LE(offset) : header.readUInt32BE(offset));
  const version = u32(0);
  if (version === 0 || header[12] !== 1) return null;
  if (version !== 3007000) throw new Error('Unrecognised SQLite wal-index version ' + version);
  return { frames: u32(16), backfilled: u32(96) };
}
function tick() {
  const index = walIndex();
  // Below the threshold, or already fully backfilled: a checkpoint now would
  // only make the next commit restart the WAL (one more main-thread sync).
  if (!index || index.frames < workerData.thresholdFrames || index.backfilled >= index.frames) return;
  const start = performance.now();
  let row;
  let previousLog = -1;
  // A writer can append during the database sync. A short follow-up PASSIVE
  // catches those frames so its next commit can reuse the WAL. Without this,
  // a steady write stream can stay one checkpoint behind indefinitely.
  for (let attempt = 0; attempt < 4; attempt++) {
    row = checkpoint.get();
    if (row.busy || row.log !== row.checkpointed || row.log === previousLog) break;
    previousLog = row.log;
  }
  const ms = performance.now() - start;
  let bytes = 0;
  try { bytes = statSync(workerData.filename + '-wal').size; } catch {}
  parentPort.postMessage({ type: 'checkpoint', ...row, ms, bytes, startedAt: performance.timeOrigin + start });
  // PASSIVE cannot reclaim frames pinned by a backup/read transaction. Do not
  // switch to RESTART/TRUNCATE, which could block the application writer.
  const now = Date.now();
  if (bytes > 64 * 1024 * 1024 && row.log > row.checkpointed && now - lastWarning >= 60000) {
    lastWarning = now;
    parentPort.postMessage({ type: 'warning', message: 'SQLite WAL exceeds 64 MiB; checkpoint is waiting for a reader/writer gap' });
  }
}
const timer = setInterval(tick, workerData.intervalMs);
parentPort.on('message', (message) => {
  if (message === 'checkpoint') tick();
  if (message === 'stop') { clearInterval(timer); db.close(); parentPort.close(); }
});
parentPort.postMessage({ type: 'ready' });
`;

export interface SqliteCheckpointResult {
  readonly type: "checkpoint";
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
  readonly ms: number;
  readonly bytes: number;
  /** Epoch ms (performance.timeOrigin based) when the checkpoint started. */
  readonly startedAt: number;
}

/** Start before disabling the writer's auto-checkpoint; failure restores it. */
export function startSqliteCheckpointWorker(options: {
  readonly filename: string;
  readonly synchronous: "NORMAL" | "FULL";
  readonly onFailure: () => void;
  readonly onWarning: (message: string) => void;
  readonly onCheckpoint?: (result: SqliteCheckpointResult) => void;
}): Promise<{ readonly active: boolean; stop(): Promise<void> }> {
  return new Promise((resolve) => {
    let active = false;
    let stopped = false;
    let worker: NodeWorkerThreads.Worker | undefined;
    let termination: Promise<number> | undefined;
    const handle = {
      get active() {
        return active;
      },
      async stop() {
        if (stopped) {
          await termination;
          return;
        }
        stopped = true;
        active = false;
        clearTimeout(startupTimer);
        // A graceful close may itself checkpoint. Keep it on the worker too.
        const current = worker!;
        await new Promise<void>((done) => {
          const timer = setTimeout(() => {
            void current.terminate().then(() => done());
          }, 5_000);
          current.once("exit", () => {
            clearTimeout(timer);
            done();
          });
          // Worker messages have no browser target origin.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          current.postMessage("stop");
        });
      },
    };
    const fail = () => {
      if (stopped) return;
      stopped = true;
      active = false;
      clearTimeout(startupTimer);
      options.onFailure();
      termination = worker?.terminate();
      resolve(handle);
    };
    const startupTimer = setTimeout(fail, 5_000);
    try {
      if (!sqliteConcurrentCheckpointSafe(process.versions.sqlite ?? "")) {
        fail();
        return;
      }
      worker = new NodeWorkerThreads.Worker(SOURCE, {
        eval: true,
        workerData: {
          filename: options.filename,
          synchronous: options.synchronous,
          intervalMs: SQLITE_CHECKPOINT_INTERVAL_MS,
          thresholdFrames: SQLITE_CHECKPOINT_THRESHOLD_FRAMES,
        },
      });
      worker.on(
        "message",
        (
          message:
            | SqliteCheckpointResult
            | { type: "ready" }
            | { type: "warning"; message: string },
        ) => {
          if (stopped) return;
          if (message.type === "ready") {
            active = true;
            clearTimeout(startupTimer);
            resolve(handle);
          } else if (message.type === "warning") options.onWarning(message.message);
          else options.onCheckpoint?.(message);
        },
      );
      worker.once("error", fail);
      worker.once("exit", fail);
      worker.unref();
    } catch {
      fail();
    }
  });
}
