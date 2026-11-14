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
test('hard caps default to 6G RAM and 4G swap and take per-job overrides',()=>{
 const caps=(extra={})=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-caps-')),bin=path.join(dir,'bin'),args=path.join(dir,'args');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'systemd-run'),'#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$SYSTEMD_RUN_ARGS"\n',{mode:0o755});
  const r=run('bash',[path.join(here,'heavy-job.sh'),'--label','caps test','--','bash','-c','echo job-ran'],{env:{...process.env,HEAVY_JOB_BASE:path.join(dir,'gate'),HEAVY_JOB_SLOTS:'1',SYSTEMD_RUN_ARGS:args,PATH:`${bin}:${process.env.PATH}`,...extra}});
  return {r,argv:fs.existsSync(args)?fs.readFileSync(args,'utf8').trim().split('\n'):[]};
 };
 const pick=(argv,key)=>{const out=[];for(let i=0;i<argv.length-1;i++)if(argv[i]==='-p'&&argv[i+1].startsWith(`${key}=`))out.push(argv[i+1]);return out};
 const defaults=caps();
 assert.equal(defaults.r.status,0,defaults.r.stderr);
 assert.deepEqual(pick(defaults.argv,'MemoryHigh'),['MemoryHigh=5G']);
 assert.deepEqual(pick(defaults.argv,'MemoryMax'),['MemoryMax=6G']);
 assert.deepEqual(pick(defaults.argv,'MemorySwapMax'),['MemorySwapMax=4G']);
 assert.deepEqual(pick(defaults.argv,'CPUWeight'),['CPUWeight=20']);
 assert.equal(defaults.argv.at(-1),'echo job-ran');
 assert.match(defaults.r.stderr,/MemoryHigh 5G, MemoryMax 6G, MemorySwapMax 4G/);
 const custom=caps({HEAVY_JOB_MEMORY_HIGH:'4G',HEAVY_JOB_MEMORY_MAX:'8G',HEAVY_JOB_SWAP_MAX:'6G'});
 assert.equal(custom.r.status,0,custom.r.stderr);
 assert.deepEqual(pick(custom.argv,'MemoryHigh'),['MemoryHigh=4G']);
 assert.deepEqual(pick(custom.argv,'MemoryMax'),['MemoryMax=8G']);
 assert.deepEqual(pick(custom.argv,'MemorySwapMax'),['MemorySwapMax=6G']);
 const off=caps({HEAVY_JOB_MEMORY_MAX:'off',HEAVY_JOB_SWAP_MAX:'off'});
 assert.equal(off.r.status,0,off.r.stderr);
 assert.deepEqual(pick(off.argv,'MemoryHigh'),['MemoryHigh=5G']);
 assert.deepEqual(pick(off.argv,'MemoryMax'),[]);
 assert.deepEqual(pick(off.argv,'MemorySwapMax'),[]);
 assert.match(off.r.stderr,/MemoryMax off, MemorySwapMax off/);
 for(const bad of [{HEAVY_JOB_MEMORY_MAX:'lots'},{HEAVY_JOB_SWAP_MAX:'0'}]) {
  const r=caps(bad);
  assert.equal(r.r.status,2);
  assert.match(r.r.stderr,/must be off or a size/);
 }
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
test('a skipped gate needs an allowlisted live-to-release diff',()=>{
 const scratch=path.join(here,'../../../../.tmp');fs.mkdirSync(scratch,{recursive:true});
 const root=fs.mkdtempSync(path.join(scratch,'tools-skip-test-'));
 try {
  const repo=path.join(root,'repo'),releases=path.join(root,'releases');
  fs.mkdirSync(path.join(repo,'apps/server/src'),{recursive:true});
  fs.mkdirSync(path.join(repo,'apps/hbots-mobile'),{recursive:true});
  fs.mkdirSync(path.join(repo,'scripts/personal/linux/hbots-release/lib'),{recursive:true});
  fs.copyFileSync(path.join(here,'../hbots-release/lib/gateScope.mjs'),path.join(repo,'scripts/personal/linux/hbots-release/lib/gateScope.mjs'));
  fs.mkdirSync(releases,{recursive:true});
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  const commit=(message)=>{git('add','-A');git('commit','-qm',message);return git('rev-parse','HEAD')};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'apps/server/src/index.ts'),'export const value=1;\n');const base=commit('baseline');
  fs.writeFileSync(path.join(repo,'apps/hbots-mobile/app.json'),'{"version":"1"}\n');const mobile=commit('mobile only');
  fs.writeFileSync(path.join(releases,'current.txt'),`${base}\n`);
  const stage=(sha)=>{const release=sha.slice(0,12),dir=path.join(releases,release);fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);return {release,dir}};
  const mobileStage=stage(mobile);
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`if(process.argv[2]==='vitest') console.log('Tests 3 passed (3)'); else if(process.argv[2]==='e2e') console.log(JSON.stringify({failed:0,journeys:Array.from({length:5},(_,i)=>({id:'j'+i,ok:true}))}));`);
  const defs=Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${kind}`]}));
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=(release)=>['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases];
  const gateEnv=jobEnv(lockBase());
  let r=node('gate-evidence.mjs',[...args(mobileStage.release),'--gates-json',defFile,'--skip-notes'],{env:gateEnv});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const mobileFile=path.join(mobileStage.dir,'gate-evidence.json'),mobileEvidence=fs.readFileSync(mobileFile,'utf8');
  const mobileJson=JSON.parse(mobileEvidence);
  assert.deepEqual(mobileJson.gates.filter(g=>g.skipped===true).map(g=>g.id).sort(),['e2e','server-tests']);
  assert.equal(node('check-gate-evidence.mjs',args(mobileStage.release)).status,0);
  fs.writeFileSync(path.join(repo,'apps/server/src/index.ts'),'export const value=2;\n');const server=commit('server change');
  const serverStage=stage(server);
  r=node('gate-evidence.mjs',[...args(serverStage.release),'--gates-json',defFile,'--skip-notes'],{env:gateEnv});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const serverJson=JSON.parse(fs.readFileSync(path.join(serverStage.dir,'gate-evidence.json'),'utf8'));
  assert.equal(serverJson.gates.some(g=>g.skipped===true),false);
  assert.ok(serverJson.gates.find(g=>g.id==='server-tests').commands.length>0);
  const forged=JSON.parse(mobileEvidence);
  forged.release=serverStage.release;forged.sha=server;forged.headAtStart=server;forged.headAtEnd=server;
  forged.stagedRelease={...forged.stagedRelease,sha:serverStage.release};
  fs.writeFileSync(path.join(serverStage.dir,'gate-evidence.json'),JSON.stringify(forged));
  r=node('check-gate-evidence.mjs',args(serverStage.release));
  assert.equal(r.status,1,r.stdout+r.stderr);
  assert.match(r.stderr,/must run/);
 } finally {fs.rmSync(root,{recursive:true,force:true})}
});
test('server-tests and e2e gates start together',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-parallel-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),starts=path.join(root,'starts');
  fs.mkdirSync(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`import fs from 'node:fs';
const kind=process.argv[2];
if(kind.startsWith('server-tests')||kind==='e2e'){
  fs.appendFileSync(process.env.STARTS,String(Date.now())+'\\n');
  await new Promise((resolve)=>setTimeout(resolve,1500));
}
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:Array.from({length:5},(_,i)=>({id:'j'+i,ok:true}))}));
else console.log('Tests 3 passed (3)');`);
  const defs=Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}`]}));
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile];
  const r=node('gate-evidence.mjs',args,{env:jobEnv(lockBase(),{STARTS:starts})});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const times=fs.readFileSync(starts,'utf8').trim().split('\n').map(Number);
  assert.equal(times.length,2);
  assert.ok(Math.max(...times)-Math.min(...times)<500,`start spread ${Math.max(...times)-Math.min(...times)} ms`);
  const evidence=JSON.parse(fs.readFileSync(path.join(dir,'gate-evidence.json'),'utf8'));
  assert.equal(evidence.gates.find((gate)=>gate.id==='server-tests').counts.passed,3);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('e2e waits when server-tests has two lanes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-serial-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),starts=path.join(root,'starts');
  fs.mkdirSync(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`import fs from 'node:fs';
const kind=process.argv[2];
if(kind.startsWith('server-tests')||kind==='e2e'){
  fs.appendFileSync(process.env.STARTS,kind+':'+Date.now()+'\\n');
  if(kind.startsWith('server-tests')) await new Promise((resolve)=>setTimeout(resolve,400));
}
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:Array.from({length:5},(_,i)=>({id:'j'+i,ok:true}))}));
else console.log('Tests 3 passed (3)');`);
  const defs=Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}`]}));
  defs[0].concurrent=[[`node '${fixture}' server-tests-1`],[`node '${fixture}' server-tests-2`]];
  delete defs[0].commands;
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile];
  const r=node('gate-evidence.mjs',args,{env:jobEnv(lockBase(),{STARTS:starts})});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const rows=fs.readFileSync(starts,'utf8').trim().split('\n').map((line)=>line.split(':'));
  const lanes=rows.filter(([id])=>id.startsWith('server-tests')).map(([,at])=>Number(at));
  const e2e=rows.find(([id])=>id==='e2e');
  assert.equal(lanes.length,2);
  assert.ok(e2e,'e2e ran');
  assert.ok(Number(e2e[1])-Math.max(...lanes)>=350,`e2e started ${Number(e2e[1])-Math.max(...lanes)} ms after both lanes`);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('server-tests gate runs two weighted shards over the same folders',()=>{
 const root=path.resolve(here,'../../../..');
 const defs=JSON.parse(fs.readFileSync(path.join(root,'scripts/personal/node/gates-linux.json'),'utf8'));
 const gate=defs.find((d)=>d.id==='server-tests');
 assert.ok(gate,'server-tests gate exists');
 assert.equal(gate.concurrent?.length,2,'server-tests has two lanes');
 const folders=(command)=>command.split(/\s+/).filter((word)=>word.startsWith('src/')).sort();
 for(const [index,lane] of gate.concurrent.entries()){
  assert.equal(lane.length,1);
  assert.match(lane[0],new RegExp(`--shard=${index+1}/2`));
  assert.deepEqual(folders(lane[0]),folders(gate.concurrent[0][0]));
 }
});
test('gate commands run without the live app environment',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-env-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),seen=path.join(root,'env');
  fs.mkdirSync(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`import fs from 'node:fs';
const kind=process.argv[2];
if(kind==='server-tests') fs.writeFileSync(process.env.SEEN,JSON.stringify({t3:process.env.T3CODE_ENVIRONMENT_LABEL??'unset',personal:process.env.PERSONAL_SEED_MODEL??'unset',dsh:process.env.DSH_PROBE??'unset',keep:process.env.KEEP_ME??'unset'}));
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:Array.from({length:5},(_,i)=>({id:'j'+i,ok:true}))}));
else console.log('Tests 3 passed (3)');`);
  const defs=Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}`]}));
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile];
  const r=node('gate-evidence.mjs',args,{env:jobEnv(lockBase(),{SEEN:seen,T3CODE_ENVIRONMENT_LABEL:'Bots',PERSONAL_SEED_MODEL:'live',DSH_PROBE:'live',KEEP_ME:'ok'})});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(seen,'utf8')),{t3:'unset',personal:'unset',dsh:'unset',keep:'ok'});
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('each gate gets a private TMPDIR under /tmp, removed after it, and the pinned test browser',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-tmp-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),seen=path.join(root,'seen');
  fs.mkdirSync(repo);fs.mkdirSync(seen);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`import fs from 'node:fs';
const id=process.argv[2];
fs.writeFileSync(process.env.SEEN+'/'+id+'.json',JSON.stringify({tmp:process.env.TMPDIR,exists:fs.existsSync(process.env.TMPDIR),browsers:process.env.PLAYWRIGHT_BROWSERS_PATH??'unset'}));
if(id==='e2e') console.log(JSON.stringify({failed:0,journeys:Array.from({length:5},(_,i)=>({id:'j'+i,ok:true}))}));
else console.log('Tests 3 passed (3)');`);
  const defs=Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}`]}));
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile];
  // The 1.67.19 chain exported a TMPDIR inside a git-ignored worktree folder.
  const badTmp=path.join(repo,'.tmp');fs.mkdirSync(badTmp);
  const env={...jobEnv(lockBase(),{SEEN:seen}),TMPDIR:badTmp};delete env.PLAYWRIGHT_BROWSERS_PATH;
  let r=node('gate-evidence.mjs',args,{env});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const read=(id)=>JSON.parse(fs.readFileSync(path.join(seen,`${id}.json`),'utf8'));
  const tmps=new Set();
  for(const {id} of defs){
   const s=read(id);
   assert.match(s.tmp,/^\/tmp\/hbots-gate-/,id);
   assert.equal(s.exists,true,id);
   assert.equal(fs.existsSync(s.tmp),false,`${id}: ${s.tmp} is removed after the gate`);
   assert.equal(s.browsers,'/home/harout/Claude/AI/dev-team/tools/pw-browsers',id);
   tmps.add(s.tmp);
  }
  assert.equal(tmps.size,defs.length,'no two gates share a TMPDIR');
  r=node('gate-evidence.mjs',args,{env:{...env,PLAYWRIGHT_BROWSERS_PATH:'/opt/caller-browsers'}});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(read('server-tests').browsers,'/opt/caller-browsers','a caller-set browser path wins');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('a dry run prints each gate with the table reason and runs nothing',()=>{
 const scratch=path.join(here,'../../../../.tmp');fs.mkdirSync(scratch,{recursive:true});
 const root=fs.mkdtempSync(path.join(scratch,'tools-dry-run-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),ran=path.join(root,'ran');
  fs.mkdirSync(path.join(repo,'apps/server/src'),{recursive:true});
  fs.mkdirSync(path.join(repo,'scripts/personal/linux/hbots-release/lib'),{recursive:true});
  fs.copyFileSync(path.join(here,'../hbots-release/lib/gateScope.mjs'),path.join(repo,'scripts/personal/linux/hbots-release/lib/gateScope.mjs'));
  fs.mkdirSync(releases,{recursive:true});
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  const commit=(message)=>{git('add','-A');git('commit','-qm',message);return git('rev-parse','HEAD')};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'apps/server/src/index.ts'),'export const value=1;\n');const base=commit('baseline');
  fs.mkdirSync(path.join(repo,'docs'));fs.writeFileSync(path.join(repo,'docs/notes.md'),'notes\n');const docs=commit('docs only');
  fs.writeFileSync(path.join(repo,'apps/server/src/index.ts'),'export const value=2;\n');const server=commit('server');
  fs.mkdirSync(path.join(repo,'tools'));fs.writeFileSync(path.join(repo,'tools/new.mjs'),'new\n');const unknown=commit('unknown area');
  fs.writeFileSync(path.join(releases,'current.txt'),`${base}\n`);
  const ids=['server-tests','server-tsc','web-tests','web-tsc','e2e','personal-client','hbots-mobile','hbots-mobile-kotlin','parity'];
  const defs=ids.map((id)=>({id,kind:'node',cwd:'.',commands:[`touch '${ran}'`]}));
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const dry=(sha)=>node('gate-evidence.mjs',['--version','1.2.3','--release',sha.slice(0,12),'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile,'--dry-run'],{env:{...process.env,HBOTS_HEAVY_JOB_HELD:''}});
  let r=dry(docs);
  assert.equal(r.status,0,r.stdout+r.stderr);
  for(const id of ['server-tests','e2e','hbots-mobile-kotlin']) assert.match(r.stdout,new RegExp(`^${id}: SKIPPED \\(no changed path is a ${id} input`,'m'));
  assert.match(r.stdout,/^parity: RUN$/m);
  assert.match(r.stdout,/dry run: 6 of 9 gates would run/);
  r=dry(server);
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/^server-tests: RUN \(server-tests inputs changed: apps\/server\/src\/index\.ts\)$/m);
  assert.match(r.stdout,/^hbots-mobile-kotlin: SKIPPED /m);
  assert.match(r.stdout,/dry run: 8 of 9 gates would run/);
  r=dry(unknown);
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.doesNotMatch(r.stdout,/SKIPPED/);
  assert.match(r.stdout,/^e2e: RUN \(paths outside every known area: tools\/new\.mjs\)$/m);
  assert.match(r.stdout,/dry run: 9 of 9 gates would run/);
  assert.equal(fs.existsSync(ran),false,'a dry run runs no gate command');
  assert.equal(fs.existsSync(path.join(releases,docs.slice(0,12))),false,'a dry run writes no evidence');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('e2e step and journey budgets follow the gate environment',()=>{
 const lib=new URL('../../e2e/lib.mjs',import.meta.url).href;
 const read=(extra)=>run(process.execPath,['-e',`import(${JSON.stringify(lib)}).then((m)=>console.log(m.STEP_TIMEOUT_MS,m.JOURNEY_LIMIT_MS))`],{env:{...process.env,E2E_STEP_TIMEOUT_MS:'',E2E_JOURNEY_LIMIT_MS:'',...extra}}).stdout.trim();
 assert.equal(read({}),'15000 30000');
 assert.equal(read({E2E_STEP_TIMEOUT_MS:'30000',E2E_JOURNEY_LIMIT_MS:'60000'}),'30000 60000');
});
test('server-tests gate covers the folders behind the 1.67.1 rollbacks',()=>{
 const root=path.resolve(here,'../../../..');
 const defs=JSON.parse(fs.readFileSync(path.join(root,'scripts/personal/node/gates-linux.json'),'utf8'));
 const gate=defs.find((d)=>d.id==='server-tests');
 assert.ok(gate,'server-tests gate exists');
 const command=(gate.commands??gate.concurrent.flat()).join(' ');
 for(const folder of ['orchestration-v2','cloud','provider','process']){
  const tests=fs.readdirSync(path.join(root,'apps/server/src',folder),{recursive:true}).filter((file)=>String(file).endsWith('.test.ts')).length;
  assert.ok(tests>0,`src/${folder} has test files`);
  assert.match(command,new RegExp(`(?:^|\\s)src/${folder}(?:\\s|$)`),`server-tests gate runs src/${folder}`);
 }
});
test('a gate cwd with its own vp wins over the repo root copy',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-vp-'));
 try {
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),cwd=path.join(repo,'packages/personal-client');
  for(const dir of [path.join(repo,'node_modules/.bin'),path.join(cwd,'node_modules/.bin')])fs.mkdirSync(dir,{recursive:true});
  for(const [dir,out] of [[path.join(repo,'node_modules/.bin'),'root-vp'],[path.join(cwd,'node_modules/.bin'),'local-vp']]){
   fs.writeFileSync(path.join(dir,'vp'),`#!/bin/sh\necho ${out}\n`);fs.chmodSync(path.join(dir,'vp'),0o755);
  }
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  const fixture=path.join(root,'command.mjs');fs.writeFileSync(fixture,`if(process.argv[2]==='vitest') console.log('Tests 3 passed (3)'); else if(process.argv[2]==='e2e') console.log(JSON.stringify({failed:0,journeys:Array.from({length:5},(_,i)=>({id:'j'+i,ok:true}))}));`);
  const defs=Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${kind}`]}));
  defs.push({id:'personal-client',kind:'vitest',cwd:'packages/personal-client',commands:['vp test; echo "Tests 1 passed (1)"']});
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases];
  const r=node('gate-evidence.mjs',[...args,'--gates-json',defFile],{env:jobEnv(lockBase())});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const pc=JSON.parse(fs.readFileSync(path.join(dir,'gate-evidence.json'),'utf8')).gates.find(g=>g.id==='personal-client');
  assert.equal(pc.exit,0);
  assert.match(fs.readFileSync(pc.log,'utf8'),/local-vp/);
 } finally {fs.rmSync(root,{recursive:true,force:true})}
});
test('gate evidence aborts at the gate boundary when HEAD or the tree moves',()=>{
 const fixture=(mutation)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-moved-'));
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),ran=path.join(root,'ran');
  fs.mkdirSync(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  const command=path.join(root,'command.mjs');
  fs.writeFileSync(command,`import fs from 'node:fs';
const kind=process.argv[2];
if(kind==='mutate'){${mutation}}
if(kind==='marker')fs.writeFileSync(process.env.RAN,'ran');
console.log('Tests 3 passed (3)');`);
  const defs=[{id:'server-tests',kind:'vitest',cwd:'.',commands:[`node '${command}' mutate`]},{id:'server-tsc',kind:'tsc',cwd:'.',commands:[`node '${command}' marker`]}];
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile,'--skip-notes'];
  return {root,repo,dir,args,ran,sha};
 };
 for(const {mutation,pattern} of [
  {mutation:`fs.appendFileSync('source','moved\\n');(await import('node:child_process')).execFileSync('git',['commit','-qam','gate moved HEAD']);`,pattern:/HEAD [a-f0-9]{12} -> [a-f0-9]{12}/},
  {mutation:`fs.appendFileSync('source','dirty\\n');`,pattern:/tracked files changed: .*source/},
 ]){
  const f=fixture(mutation);
  try{
   const r=node('gate-evidence.mjs',f.args,{env:jobEnv(lockBase(),{RAN:f.ran})});
   assert.equal(r.status,2,r.stdout+r.stderr);
   assert.match(r.stderr,/the git tree or HEAD changed after server-tests/);
   assert.match(r.stderr,pattern);
   assert.match(r.stderr,/aborted before the next gate/);
   assert.equal(fs.existsSync(f.ran),false,'the next gate never started');
   assert.equal(fs.existsSync(path.join(f.dir,'gate-evidence.json')),false,'no evidence written for a moved tree');
  }finally{fs.rmSync(f.root,{recursive:true,force:true})}
 }
});

test('staging wrapper uses build and copied externals without activation',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-stage-wrapper-test-'));
 try {fs.mkdirSync(path.join(root,'scripts/personal/node'),{recursive:true});fs.writeFileSync(path.join(root,'scripts/personal/node/hbots.mjs'),"console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=17");const r=run('bash',[path.join(here,'build.sh'),root],{env:jobEnv(lockBase())});assert.equal(r.status,17,r.stderr);assert.deepEqual(JSON.parse(r.stdout),['build','--copy-externals'])}finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('startup scan requires the Claude SDK warning filter marker',async()=>{
 const {checksB}=await import('../hbots-release/lib/verify.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-marker-log-'));
 try{
  const log=path.join(dir,'server.log');
  const stall="[10:00:00.000] INFO (#1): stall recorder on profiler: 'continuous'";
  fs.writeFileSync(log,`${stall}\n`);
  const check=()=>checksB({}, {'migration-before':'1','migration-after':'1'}, {serverLog:log,logByte:0}, {}, ()=>{});
  assert.throws(check,/Claude SDK warning filter startup marker absent/);
  fs.writeFileSync(log,`${stall}\nclaude sdk warning filter installed\n`);
  assert.doesNotThrow(check);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('restore staging copies every database in the backup and nothing else',async()=>{
 const {stageDatabases}=await import('./restore-test.mjs');
 const {DatabaseSync}=await import('node:sqlite');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-restore-stage-'));
 try{
  const make=(dir,names)=>{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'backup.json'),'{}');for(const n of names){const d=new DatabaseSync(path.join(dir,n));d.exec(`CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('${n}')`);d.close();}return dir;};
  const read=f=>{const d=new DatabaseSync(f,{readOnly:true});const v=d.prepare('SELECT v FROM t').get().v;d.close();return v;};
  const both=make(path.join(tmp,'both'),['state.sqlite','statev2.sqlite']);
  const dest=path.join(tmp,'dest-both');fs.mkdirSync(dest);
  assert.deepEqual(stageDatabases(both,dest),['state.sqlite','statev2.sqlite']);
  assert.deepEqual(fs.readdirSync(dest).sort(),['state.sqlite','statev2.sqlite']);
  assert.equal(read(path.join(dest,'statev2.sqlite')),'statev2.sqlite');
  const v1=make(path.join(tmp,'v1'),['state.sqlite']);
  const dest1=path.join(tmp,'dest-v1');fs.mkdirSync(dest1);
  assert.deepEqual(stageDatabases(v1,dest1),['state.sqlite']);
  assert.deepEqual(fs.readdirSync(dest1),['state.sqlite']);
  fs.writeFileSync(path.join(both,'statev2.sqlite-wal'),'');
  assert.throws(()=>stageDatabases(both,path.join(tmp,'dest-wal')),/completed SQLite snapshot/);
  assert.throws(()=>stageDatabases(make(path.join(tmp,'none'),[]),path.join(tmp,'dest-none')),/no database/);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
