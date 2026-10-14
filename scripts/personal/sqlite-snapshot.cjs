// Publish only after the online copy and ONE full integrity check succeed.
const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { checkDatabase, fileHash, startReadAhead } = require('./sqlite-check.cjs');

// The copy may take max(900 s, database bytes / 4 MB/s); the slowest measured
// 3 GB copy at background priority took 298 s.
function limitForBytes(bytes) {
  return Math.max(900000, Math.ceil(bytes / 4000));
}
function timeLimitMs(source) {
  const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
  return limitForBytes(size(source) + size(`${source}-wal`));
}

async function snapshot(source, target, { maxMs, maxRestarts = 0, rate = 1024, hardStopMs } = {}) {
  if (!source || !target) throw new Error('PB_SNAPSHOT_SOURCE and PB_SNAPSHOT_TARGET are required.');
  if (fs.existsSync(target) || fs.existsSync(`${target}.integrity.json`)) throw new Error('Snapshot target already exists.');
  maxMs ??= timeLimitMs(source);
  const candidate = `${target}.candidate-${randomUUID()}`;
  // node:sqlite backup otherwise overwrites an existing destination.
  fs.closeSync(fs.openSync(candidate, 'wx'));
  const timings = { copyLimitSeconds: maxMs / 1000 };
  let db;
  let ahead;
  let watchdog;
  try {
    db = new DatabaseSync(source, { readOnly: true, timeout: 1000 });
    // Sequential copy avoids hundreds of thousands of 4 KiB ReadFile calls.
    // This mapping belongs only to this read-only helper connection. SQLite
    // clamps it to its platform limit (~2 GiB on Windows); it reserves address
    // space rather than allocating a 2 GiB heap buffer. Validation uses mmap=0.
    const sourceMmapBytes = Object.values(db.prepare('PRAGMA mmap_size=2147483648').get())[0];
    // ONE read transaction for the whole copy, the same consistency as VACUUM
    // INTO. sqlite3_backup_step reuses an open source transaction instead of
    // opening one per step, so commits by the server never restart the copy,
    // while the steps still report progress for the time limit and read-ahead.
    // In WAL mode this reader does not block the server's writers.
    db.exec('BEGIN');
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    const started = performance.now();
    const pageSize = Object.values(db.prepare('PRAGMA page_size').get())[0];
    ahead = startReadAhead(source, pageSize);
    // A single step that never returns (a stuck disk) cannot reach the progress
    // check; the helper then exits and backup.ps1 removes the fresh folder.
    watchdog = setTimeout(() => {
      console.error('Online backup step exceeded the hard time limit.');
      process.exit(1);
    }, hardStopMs ?? maxMs + 120000);
    let previousCopied = 0;
    let restarts = 0;
    // Node finalizes sqlite3_backup when progress throws. A restart would mean
    // the pinned read transaction was lost, so by default it fails closed.
    const pages = await backup(db, candidate, { rate, progress({ remainingPages, totalPages }) {
      const copied = totalPages - remainingPages;
      if (copied <= previousCopied && previousCopied > 0) restarts++;
      previousCopied = copied;
      if (restarts > maxRestarts || performance.now() - started > maxMs) {
        throw new Error(`Online backup limit exceeded (${restarts} restarts, limit ${maxMs / 1000} s).`);
      }
      ahead.advance(copied);
    } });
    clearTimeout(watchdog); watchdog = null;
    if (performance.now() - started > maxMs) throw new Error('Online backup time limit exceeded.');
    timings.snapshotSeconds = (performance.now() - started) / 1000;
    console.log(`backup timing snapshotSeconds: ${timings.snapshotSeconds.toFixed(3)} s`);
    db.exec('COMMIT');
    db.close(); db = null;
    await ahead.close(); ahead = null;
    // The required digest pass also reads ahead in bounded 8 MiB chunks. Doing
    // it before the full check avoids cold, random 4 KiB integrity-check I/O.
    const hashStarted = performance.now();
    const sha256 = await fileHash(candidate);
    timings.hashSeconds = (performance.now() - hashStarted) / 1000;
    console.log(`backup timing hashSeconds: ${timings.hashSeconds.toFixed(3)} s`);
    const validationStarted = performance.now();
    const copy = new DatabaseSync(candidate, { readOnly: true });
    let result;
    try { result = checkDatabase(copy); } finally { copy.close(); }
    timings.integritySeconds = (performance.now() - validationStarted) / 1000;
    console.log(`backup timing integritySeconds: ${timings.integritySeconds.toFixed(3)} s`);
    const proof = { schema: 1, method: 'online-backup-integrity-check', ...result, sha256, bytes: fs.statSync(candidate).size, pages, restarts, sourceMmapBytes, timings };
    // A fresh backup owns its directory; failure after rename has no backup.json.
    fs.renameSync(candidate, target);
    fs.writeFileSync(`${target}.integrity.json`, JSON.stringify(proof), { flag: 'wx' });
    console.log('snapshot ok (full integrity_check)');
    return proof;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (ahead) await ahead.close();
    if (db) db.close();
    for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(candidate + suffix, { force: true });
  }
}
module.exports = { snapshot, timeLimitMs, limitForBytes };
if (require.main === module) snapshot(process.env.PB_SNAPSHOT_SOURCE, process.env.PB_SNAPSHOT_TARGET).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
