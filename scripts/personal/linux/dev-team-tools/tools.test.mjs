import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const run=(cmd,args,opts={})=>spawnSync(cmd,args,{encoding:'utf8',timeout:15000,...opts});
const node=(name,args,opts={})=>run(process.execPath,[path.join(here,name),...args],opts);
const lockBase=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),'hbots-heavy-')),'gate');
const jobEnv=(base,extra={})=>({...process.env,HEAVY_JOB_BASE:base,HEAVY_JOB_MEMORY_HIGH:'off',...extra});
test('lock gives exact nice 10, idle I/O, nested execution and preserves failures',()=>{
 const base=lockBase();
 const r=run('bash',[path.join(here,'heavy-job.sh'),'--label','test priority','--','bash','-c',`ps -o ni= -p $$; ionice -p $$; bash '${here}/heavy-job.sh' --label nested -- bash -c 'exit 23'`],{env:jobEnv(base)});
 assert.equal(r.status,23,r.stderr);assert.match(r.stdout,/10/);assert.match(r.stdout,/idle/);
});
test('job runs in its own scope with a soft MemoryHigh; off is the kill switch',()=>{
 const probe=`cat /proc/self/cgroup; cat /sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.high`;
 const scoped=run('bash',[path.join(here,'heavy-job.sh'),'--label','test scope','--','bash','-c',probe],{env:{...process.env,HEAVY_JOB_BASE:lockBase(),HEAVY_JOB_MEMORY_HIGH:'64M'}});
 assert.equal(scoped.status,0,scoped.stderr);assert.match(scoped.stdout,/heavy-job-\d+\.scope/);assert.match(scoped.stdout,/^67108864$/m);
 const off=run('bash',[path.join(here,'heavy-job.sh'),'--label','test off','--','bash','-c','cat /proc/self/cgroup'],{env:jobEnv(lockBase())});
 assert.equal(off.status,0,off.stderr);assert.doesNotMatch(off.stdout,/heavy-job-/);
 const bad=run('bash',[path.join(here,'heavy-job.sh'),'--label','test bad','--','true'],{env:jobEnv(lockBase(),{HEAVY_JOB_MEMORY_HIGH:'lots'})});
 assert.equal(bad.status,2);
});
test('contending lock reports holder and times out',async()=>{
 const base=lockBase();
 const env=jobEnv(base,{HEAVY_JOB_SLOTS:'1'});
 const p=spawn('bash',[path.join(here,'heavy-job.sh'),'--label','fixture-holder','--','sleep','2'],{stdio:['ignore','ignore','pipe'],env});
 await new Promise(resolve=>p.stderr.once('data',resolve));
 const r=run('bash',[path.join(here,'heavy-job.sh'),'--label','contender','--wait-seconds','0','--','true'],{env});
 assert.equal(r.status,75);assert.match(r.stderr,/fixture-holder/);
 await new Promise(resolve=>p.once('exit',resolve));
});
test('two jobs run at once, a third waits, and both hold the shared release gate',async()=>{
 const base=lockBase();
 const env=jobEnv(base,{HEAVY_JOB_SLOTS:'2',HEAVY_JOB_MIN_FREE_GB:'0'});
 const started=(label)=>new Promise((resolve)=>{
   const p=spawn('bash',[path.join(here,'heavy-job.sh'),'--label',label,'--','sleep','3'],{stdio:['ignore','ignore','pipe'],env});
   p.stderr.on('data',(d)=>{if(/nice 10/.test(String(d)))resolve(p);});
   p.once('exit',()=>resolve(p));
 });
 const a=await started('slot-a');
 const b=await started('slot-b');
 // both slots carry their own holder metadata
 const meta=[fs.readFileSync(`${base}-1.lock`,'utf8'),fs.readFileSync(`${base}-2.lock`,'utf8')].join('\n');
 assert.match(meta,/label=slot-a|label=slot-b/);
 assert.match(meta,/label=slot-(a|b)[\s\S]*label=slot-(a|b)/);
 // a third job cannot start while both slots are busy
 const third=run('bash',[path.join(here,'heavy-job.sh'),'--label','third','--wait-seconds','0','--','true'],{env});
 assert.equal(third.status,75);assert.match(third.stderr,/slot-a|slot-b/);
 // each running job holds a FLOCK on the shared gate, which is what hbots reads
 const ino=fs.statSync(`${base}.lock`).ino;
 const locks=fs.readFileSync('/proc/locks','utf8').split('\n').filter((l)=>l.includes(`:${ino} `));
 assert.ok(locks.some((l)=>/FLOCK/.test(l)&&/READ/.test(l)),`a shared lock is held: ${locks.join(' | ')}`);
 a.kill('SIGTERM');b.kill('SIGTERM');
 await Promise.all([new Promise((r)=>a.once('exit',r)),new Promise((r)=>b.once('exit',r))]);
});
test('evidence real commands, notes ancestry, failures and tampering',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-linux-tools-test-'));
 try {
 const repo=path.join(root,'repo'),releases=path.join(root,'releases');fs.mkdirSync(repo);
 const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
 const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
 fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
 fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
 const fixture=path.join(root,'command.mjs');fs.writeFileSync(fixture,`if(process.argv[2]==='vitest') console.log('Tests 3 passed (3)'); else if(process.argv[2]==='e2e') console.log(JSON.stringify({failed:0,journeys:Array.from({length:5},(_,i)=>({id:'j'+i,ok:true}))}));`);
 const defs=Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${kind}`]}));
 const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
 const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases];
 const gateEnv=jobEnv(lockBase());
 let r=node('gate-evidence.mjs',[...args,'--gates-json',defFile],{env:gateEnv});assert.equal(r.status,0,r.stdout+r.stderr);
 r=node('check-gate-evidence.mjs',args);assert.equal(r.status,0,r.stderr);
 git('add','docs');git('commit','-qm','notes');r=node('check-gate-evidence.mjs',[...args,'--commit',git('rev-parse','HEAD')]);assert.equal(r.status,0,r.stderr);
 const file=path.join(dir,'gate-evidence.json'), original=fs.readFileSync(file,'utf8');
 for(const mutate of [e=>{e.gates=e.gates.filter(g=>g.id!=='e2e')},e=>{e.gates[0].exit=1},e=>{e.gates[0].counts.passed=0},e=>{e.gates.at(-1).journeys.pop()},e=>{e.treeClean=false},e=>{e.headAtEnd='0'.repeat(40)},e=>{delete e.gates[1].commands[0].exit},e=>{e.gates.at(-1).kind='tsc'}]){
  const e=JSON.parse(original);mutate(e);fs.writeFileSync(file,JSON.stringify(e));assert.equal(node('check-gate-evidence.mjs',args).status,1);
 }
 fs.writeFileSync(file,original);fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'tampered');assert.equal(node('check-gate-evidence.mjs',args).status,1);
 fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');fs.writeFileSync(path.join(repo,'source'),'code change');git('add','.');git('commit','-qm','code');assert.equal(node('check-gate-evidence.mjs',[...args,'--commit',git('rev-parse','HEAD')]).status,1);
 assert.equal(node('check-gate-evidence.mjs',[]).status,2);
 } finally {fs.rmSync(root,{recursive:true,force:true})}
});
test('staging wrapper uses build and copied externals without activation',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-stage-wrapper-test-'));
 try {fs.mkdirSync(path.join(root,'scripts/personal/node'),{recursive:true});fs.writeFileSync(path.join(root,'scripts/personal/node/hbots.mjs'),"console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=17");const r=run('bash',[path.join(here,'build.sh'),root],{env:jobEnv(lockBase())});assert.equal(r.status,17,r.stderr);assert.deepEqual(JSON.parse(r.stdout),['build','--copy-externals'])}finally{fs.rmSync(root,{recursive:true,force:true})}
});
