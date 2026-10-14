const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { snapshot } = require('./sqlite-snapshot.cjs');
const { fileHash } = require('./sqlite-check.cjs');

function fixture() {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-snapshot-test-'));
 const source = path.join(root, 'source.sqlite');
 const db = new DatabaseSync(source);
 db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE data(id INTEGER PRIMARY KEY, value BLOB);
  WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4096)
  INSERT INTO data SELECT x, zeroblob(4096) FROM n;
  CREATE TABLE projection_thread_activities(id); INSERT INTO projection_thread_activities VALUES(1);
  CREATE TABLE personal_memory(id); INSERT INTO personal_memory VALUES(1);
  CREATE TABLE effect_sql_migrations(migration_id); INSERT INTO effect_sql_migrations VALUES(106);`);
 db.close();
 return {root,source,target:path.join(root,'state.sqlite')};
}
function cleanup(f) {
 const resolved=path.resolve(f.root);
 assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
 assert.ok(path.basename(resolved).startsWith('pb-snapshot-test-'));
 fs.rmSync(resolved,{recursive:true,force:true});
}
async function startWriter(source) {
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','-e',`
  const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1],{timeout:1000});
  let n=0; const timer=setInterval(()=>{db.prepare('UPDATE data SET value=? WHERE id=1').run(Buffer.alloc(4096,++n%256));},2);
  process.send('ready'); setTimeout(()=>{clearInterval(timer);db.close();process.exit(0)},250);
 `,source],{stdio:['ignore','ignore','inherit','ipc']});
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});
 return child;
}
async function stopWriter(child) {
 if(child && child.exitCode===null && child.signalCode===null) {
  const exited=new Promise(resolve=>child.once('exit',resolve)); child.kill(); await exited;
 }
}

test('valid full snapshot preserves source, report and migration; existing destination is refused', async () => {
 const f=fixture();
 try {
  const before=await fileHash(f.source);
  const proof=await snapshot(f.source,f.target);
  assert.equal(proof.ic,'ok'); assert.equal(proof.mig,106);
  assert.equal(proof.sha256,await fileHash(f.target));
  assert.equal(before,await fileHash(f.source));
  await assert.rejects(snapshot(f.source,f.target),/already exists/);
  assert.equal(proof.sha256,await fileHash(f.target));
 } finally { cleanup(f); }
});
test('bounded copy fails without publishing or harming previous verified copy', async () => {
 const f=fixture();
 try {
  fs.writeFileSync(path.join(f.root,'previous.sqlite'),'previous verified backup');
  await assert.rejects(snapshot(f.source,f.target,{maxMs:0,rate:1}),/limit exceeded/);
  assert.equal(fs.existsSync(f.target),false);
  assert.equal(fs.existsSync(f.target+'.integrity.json'),false);
  assert.equal(fs.readdirSync(f.root).some(n=>n.includes('candidate-')),false);
  assert.equal(fs.readFileSync(path.join(f.root,'previous.sqlite'),'utf8'),'previous verified backup');
 } finally { cleanup(f); }
});
test('exclusive source lock fails safely within the retry bound', async () => {
 const f=fixture(); const lock=new DatabaseSync(f.source);
 try {
  lock.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
  const started=Date.now();
  await assert.rejects(snapshot(f.source,f.target,{maxMs:50,rate:1}));
  assert.ok(Date.now()-started<5000);
  assert.equal(fs.existsSync(f.target),false);
 } finally {lock.exec('ROLLBACK');lock.close();cleanup(f);}
});
test('corrupt source fails closed', async () => {
 const f=fixture();
 try {
  fs.writeFileSync(f.source,'not a sqlite database');
  await assert.rejects(snapshot(f.source,f.target));
  assert.equal(fs.existsSync(f.target),false);
  assert.equal(fs.existsSync(f.target+'.integrity.json'),false);
 } finally { cleanup(f); }
});
test('full check catches index corruption that quick_check accepts', async () => {
 const f=fixture();
 try {
  const db=new DatabaseSync(f.source);
  db.exec("CREATE TABLE indexed(value TEXT UNIQUE); INSERT INTO indexed VALUES('abc'),('def'); PRAGMA wal_checkpoint(TRUNCATE)");
  const page=db.prepare("SELECT rootpage FROM sqlite_master WHERE name='sqlite_autoindex_indexed_1'").get().rootpage;
  const pageSize=Object.values(db.prepare('PRAGMA page_size').get())[0];db.close();
  const fd=fs.openSync(f.source,'r+'); const buffer=Buffer.alloc(pageSize);
  fs.readSync(fd,buffer,0,pageSize,(page-1)*pageSize);
  const offset=buffer.indexOf(Buffer.from('abc'));assert.ok(offset>0);
  fs.writeSync(fd,Buffer.from('abx'),0,3,(page-1)*pageSize+offset);fs.closeSync(fd);
  const broken=new DatabaseSync(f.source,{readOnly:true});
  try {assert.equal(Object.values(broken.prepare('PRAGMA quick_check').get())[0],'ok');} finally {broken.close();}
  await assert.rejects(snapshot(f.source,f.target),/integrity_check failed/);
  assert.equal(fs.existsSync(f.target),false);assert.equal(fs.existsSync(f.target+'.integrity.json'),false);
 } finally {cleanup(f);}
});
test('interrupted process leaves no published backup or proof', async () => {
 const f=fixture();let child;
 try {
  child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',path.join(__dirname,'sqlite-snapshot.cjs')],{
   env:{...process.env,PB_SNAPSHOT_SOURCE:f.source,PB_SNAPSHOT_TARGET:f.target},stdio:'ignore'});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  await new Promise((resolve,reject)=>{
   const deadline=Date.now()+5000;
   const timer=setInterval(()=>{
    if(fs.readdirSync(f.root).some(n=>n.includes('candidate-'))) {clearInterval(timer);child.kill();resolve();}
    else if(Date.now()>deadline || child.exitCode!==null) {clearInterval(timer);reject(new Error('Missed candidate interruption'));}
   },1);
  });
  await exited;
  assert.equal(fs.existsSync(f.target),false);assert.equal(fs.existsSync(f.target+'.integrity.json'),false);
 } finally {
  if(child && child.exitCode===null && child.signalCode===null) {child.kill();await new Promise(resolve=>child.once('exit',resolve));}
  cleanup(f);
 }
});
test('external writer can restart copy; completed snapshot remains consistent', async () => {
 const f=fixture(); let child;
 try {
  child=await startWriter(f.source);
  const proof=await snapshot(f.source,f.target,{rate:16,maxMs:5000,maxRestarts:10000});
  console.log(`concurrent writer: ${proof.restarts} observed backup restarts`);
  assert.ok(proof.restarts>0);
  assert.equal(proof.ic,'ok'); assert.equal(proof.mig,106);
  const copy=new DatabaseSync(f.target,{readOnly:true});
  try { assert.equal(copy.prepare('SELECT count(*) n FROM data').get().n,4096); } finally {copy.close();}
  await new Promise(resolve=> child.exitCode !== null ? resolve() : child.once('exit',resolve));
 } finally {
  await stopWriter(child);
  cleanup(f);
 }
});
test('repeated external writes exceed restart bound without publishing', async () => {
 const f=fixture();let child;
 try {
  child=await startWriter(f.source);
  await assert.rejects(snapshot(f.source,f.target,{rate:1,maxMs:5000,maxRestarts:0}),/limit exceeded/);
  assert.equal(fs.existsSync(f.target),false);assert.equal(fs.existsSync(f.target+'.integrity.json'),false);
 } finally {await stopWriter(child);cleanup(f);}
});
test('verified runner rejects a changed backup byte and a missing proof', async () => {
 const { spawnSync }=require('node:child_process');
 const f=fixture();
 try {
  const proof=await snapshot(f.source,f.target);
  const helper=path.join(__dirname,'release-runner/hbots-release/release-db-check.cjs');
  fs.writeFileSync(path.join(f.root,'backup.json'),JSON.stringify({validation:proof}));
  const check=()=>spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',helper,f.target,'--verified-backup'],{encoding:'utf8'});
  assert.equal(check().status,0);
  const fd=fs.openSync(f.target,'r+');fs.writeSync(fd,Buffer.from([1]),0,1,1000);fs.closeSync(fd);
  const bad=check();assert.notEqual(bad.status,0);assert.match(bad.stderr,/digest mismatch/);
  fs.writeFileSync(path.join(f.root,'backup.json'),'{}');assert.notEqual(check().status,0);
 } finally {cleanup(f);}
});
