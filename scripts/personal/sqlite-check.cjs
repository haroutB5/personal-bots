// Connection-local cache: no journal, durability or schema changes.
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { Worker } = require('node:worker_threads');
// Warms the OS file cache a bounded window ahead of the copy. It runs on its own
// thread so the large sequential reads overlap the backup steps instead of
// running between them (cold 4 KiB page reads cost about 1 ms each here). Raw
// bytes are discarded; SQLite/WAL remains the snapshot authority, and a read
// error only ends the hint.
const READ_AHEAD_WORKER = `
const { workerData } = require('node:worker_threads');
const { openSync, readSync, closeSync, fstatSync } = require('node:fs');
const { path, shared, pageSize, chunkBytes, windowBytes } = workerData;
const state = new Int32Array(shared); // [0] pages copied, [1] stop
let fd;
try {
  fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  const buffer = Buffer.allocUnsafe(chunkBytes);
  let next = 0;
  while (Atomics.load(state, 1) === 0 && next < size) {
    const copied = Atomics.load(state, 0);
    const at = copied * pageSize;
    if (next < at) next = at - (at % chunkBytes);
    if (next < at + windowBytes) {
      const read = readSync(fd, buffer, 0, chunkBytes, next);
      if (read <= 0) break;
      next += read;
    } else {
      Atomics.wait(state, 0, copied, 200);
    }
  }
} catch {
} finally {
  if (fd !== undefined) closeSync(fd);
}
`;
function startReadAhead(path, pageSize, { chunkBytes = 8 * 1024 * 1024, windowBytes = 64 * 1024 * 1024 } = {}) {
  const shared = new SharedArrayBuffer(8);
  const state = new Int32Array(shared);
  const worker = new Worker(READ_AHEAD_WORKER, { eval: true, workerData: { path, shared, pageSize, chunkBytes, windowBytes } });
  worker.on('error', () => {});
  let closed = false;
  return {
    advance(copiedPages) {
      Atomics.store(state, 0, copiedPages);
      Atomics.notify(state, 0);
    },
    async close() {
      if (closed) return;
      closed = true;
      Atomics.store(state, 1, 1);
      Atomics.notify(state, 0);
      await worker.terminate();
    },
  };
}
function configureCheck(db) {
  db.exec('PRAGMA cache_size = -65536; PRAGMA mmap_size = 0');
}
function checkDatabase(db) {
  configureCheck(db);
  const verdicts = db.prepare('PRAGMA integrity_check').all();
  if (verdicts.length !== 1 || Object.values(verdicts[0])[0] !== 'ok') {
    throw new Error(`integrity_check failed: ${JSON.stringify(verdicts)}`);
  }
  const has = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return {
    ic: 'ok',
    rows: has('projection_thread_activities') ? db.prepare('SELECT count(*) n FROM projection_thread_activities').get().n : null,
    mem: has('personal_memory') ? db.prepare('SELECT count(*) n FROM personal_memory').get().n : null,
    mig: has('effect_sql_migrations') ? db.prepare('SELECT max(migration_id) m FROM effect_sql_migrations').get().m : null,
  };
}
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}
module.exports = { configureCheck, checkDatabase, fileHash, startReadAhead };
