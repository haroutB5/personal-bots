// Connection-local cache: no journal, durability or schema changes.
const { createHash } = require('node:crypto');
const { createReadStream, openSync, readSync, closeSync } = require('node:fs');
// A small rolling window warms the OS file cache immediately before SQLite
// consumes it. Raw bytes are discarded; SQLite/WAL remains the snapshot authority.
function openReadAhead(path, pageSize) {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  let start = -1, end = -1, closed = false;
  return {
    warm(copiedPages) {
      const offset = copiedPages * pageSize;
      if (offset < start || offset >= end) {
        readSync(fd, buffer, 0, buffer.length, offset);
        start = offset; end = offset + buffer.length;
      }
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
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
module.exports = { configureCheck, checkDatabase, fileHash, openReadAhead };
