const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
async function main() {
 const file = process.argv[2];
 if (process.argv[3] === '--verified-backup') {
  // The sealed backup tool did the full check. Bind its proof to every byte of
  // the fresh database rather than repeating the expensive integrity walk.
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'backup.json'), 'utf8').replace(/^\uFEFF/, ''));
  const proof = manifest.validation;
  if (proof?.schema !== 1 || proof.method !== 'online-backup-integrity-check' || proof.ic !== 'ok' ||
      !Number.isSafeInteger(proof.mig) || !Number.isSafeInteger(proof.rows) || !Number.isSafeInteger(proof.mem) ||
      proof.rows < 0 || proof.mem < 0 || proof.bytes !== fs.statSync(file).size) throw new Error('Missing or invalid full integrity proof');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 })) hash.update(chunk);
  if (hash.digest('hex') !== proof.sha256) throw new Error('Verified backup digest mismatch');
  console.log(JSON.stringify({ic:proof.ic, rows:proof.rows, mem:proof.mem, mig:proof.mig}));
  return;
 }
 // Read-ahead is only an I/O hint; SQLite still performs the entire full check
 // using its own read transaction, including any live WAL. Never trust the raw
 // stream as a snapshot or an integrity verdict.
 for await (const chunk of fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 })) { /* discard */ }
 const db = new DatabaseSync(file, { readOnly: true });
 try {
  db.exec('PRAGMA cache_size = -65536; PRAGMA mmap_size = 0');
  const verdicts = db.prepare('PRAGMA integrity_check').all();
  if (verdicts.length !== 1 || Object.values(verdicts[0])[0] !== 'ok') throw new Error(`integrity_check failed: ${JSON.stringify(verdicts)}`);
  console.log(JSON.stringify({ic:'ok',
   rows: db.prepare('SELECT count(*) n FROM projection_thread_activities').get().n,
   mem: db.prepare('SELECT count(*) n FROM personal_memory').get().n,
   mig: db.prepare('SELECT max(migration_id) m FROM effect_sql_migrations').get().m
  }));
 } finally { db.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
