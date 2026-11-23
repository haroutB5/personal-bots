import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
// The tests run their own fixture collectors: a collector control inherited from the shell or a
// release run (GATE_TIER, GATE_ANDROID_BUILD, ...) must not leak into them (1.67.53 started the
// real arm64 build once per fixture run). Each test sets what it needs explicitly.
for(const key of Object.keys(process.env))if(key.startsWith('GATE_'))delete process.env[key];
// So must the scope caps gate-evidence sets for its own heavy-job scope (HEAVY_JOB_MEMORY_HIGH=14G,
// HEAVY_JOB_CPU_QUOTA, ...): the heavy-job tests check the defaults.
for(const key of ['HEAVY_JOB_MEMORY_HIGH','HEAVY_JOB_MEMORY_MAX','HEAVY_JOB_SWAP_MAX','HEAVY_JOB_CPU_QUOTA'])delete process.env[key];
const run=(cmd,args,opts={})=>spawnSync(cmd,args,{encoding:'utf8',timeout:15000,...opts});
const node=(name,args,opts={})=>run(process.execPath,[path.join(here,name),...args],opts);
const installScope=(repo)=>{
 const lib=path.join(repo,'scripts/personal/linux/hbots-release/lib');
 fs.mkdirSync(lib,{recursive:true});
 const source=path.join(here,'../hbots-release/lib');
 for(const file of fs.readdirSync(source).filter(f=>f.endsWith('.mjs')))fs.copyFileSync(path.join(source,file),path.join(lib,file));
};
const lockBase=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),'hbots-heavy-')),'gate');
const jobEnv=(base,extra={})=>({...process.env,HEAVY_JOB_BASE:base,HEAVY_JOB_MEMORY_HIGH:'off',...extra});
// The gates every plan covers besides the five required ones; each only has to exit 0.
// They sit before e2e so the tests that read the last gate still read e2e.
const withExtra=(defs,commandOf=()=>'true')=>[...defs.filter(d=>d.id!=='e2e'),...['personal-client','hbots-mobile','hbots-mobile-kotlin','parity','release-tools'].map(id=>({id,kind:'node',cwd:'.',commands:[commandOf(id)]})),...defs.filter(d=>d.id==='e2e')];
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
 // "off" opens no scope of its own: the job stays in the caller's cgroup. Comparing with
 // this process keeps the test true when the gate tool runs it inside a heavy-job scope.
 assert.equal(off.status,0,off.stderr);assert.equal(off.stdout,fs.readFileSync('/proc/self/cgroup','utf8'));
 assert.notEqual(scoped.stdout.split('\n')[0]+'\n',fs.readFileSync('/proc/self/cgroup','utf8'));
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
 assert.deepEqual(pick(defaults.argv,'MemoryHigh'),['MemoryHigh=7G']);
 assert.deepEqual(pick(defaults.argv,'MemoryMax'),['MemoryMax=8G']);
 assert.deepEqual(pick(defaults.argv,'MemorySwapMax'),['MemorySwapMax=8G']);
 assert.deepEqual(pick(defaults.argv,'CPUWeight'),['CPUWeight=20']);
 assert.equal(defaults.argv.at(-1),'echo job-ran');
 assert.match(defaults.r.stderr,/MemoryHigh 7G, MemoryMax 8G, MemorySwapMax 8G/);
 const custom=caps({HEAVY_JOB_MEMORY_HIGH:'4G',HEAVY_JOB_MEMORY_MAX:'8G',HEAVY_JOB_SWAP_MAX:'6G'});
 assert.equal(custom.r.status,0,custom.r.stderr);
 assert.deepEqual(pick(custom.argv,'MemoryHigh'),['MemoryHigh=4G']);
 assert.deepEqual(pick(custom.argv,'MemoryMax'),['MemoryMax=8G']);
 assert.deepEqual(pick(custom.argv,'MemorySwapMax'),['MemorySwapMax=6G']);
 const off=caps({HEAVY_JOB_MEMORY_MAX:'off',HEAVY_JOB_SWAP_MAX:'off'});
 assert.equal(off.r.status,0,off.r.stderr);
 assert.deepEqual(pick(off.argv,'MemoryHigh'),['MemoryHigh=7G']);
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
test('no new job starts while an hbots release is armed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-rel-')),bin=path.join(dir,'bin');fs.mkdirSync(bin);
 const stub=(out)=>fs.writeFileSync(path.join(bin,'systemctl'),`#!/usr/bin/env bash\nprintf '%s' '${out}'\n`,{mode:0o755});
 const env=(extra={})=>jobEnv(lockBase(),{HEAVY_JOB_RELEASE_CHECK:'1',PATH:`${bin}:${process.env.PATH}`,...extra});
 stub('hbots-release-run-9.9.9.service loaded active running x');
 const held=run('bash',[path.join(here,'heavy-job.sh'),'--label','during-release','--wait-seconds','0','--','true'],{env:env()});
 assert.equal(held.status,75);assert.match(held.stderr,/release is armed/);
 const bypass=run('bash',[path.join(here,'heavy-job.sh'),'--label','bypass','--wait-seconds','0','--','true'],{env:env({HEAVY_JOB_IGNORE_RELEASE:'1'})});
 assert.equal(bypass.status,0,bypass.stderr);
 stub('');
 const free=run('bash',[path.join(here,'heavy-job.sh'),'--label','after-release','--wait-seconds','0','--','true'],{env:env()});
 assert.equal(free.status,0,free.stderr);
});
test('four slots by default: four jobs run at once and a fifth waits',async()=>{
 const base=lockBase();
 const env={...jobEnv(base,{HEAVY_JOB_MIN_FREE_GB:'0'})};delete env.HEAVY_JOB_SLOTS;
 const started=(label)=>new Promise((resolve)=>{
   const p=spawn('bash',[path.join(here,'heavy-job.sh'),'--label',label,'--','sleep','3'],{stdio:['ignore','ignore','pipe'],env});
   p.stderr.on('data',(d)=>{if(/nice 10/.test(String(d)))resolve(p);});
   p.once('exit',()=>resolve(p));
 });
 const jobs=[];for(const l of ['s1','s2','s3','s4'])jobs.push(await started(l));
 for(let i=1;i<=4;i++)assert.match(fs.readFileSync(`${base}-${i}.lock`,'utf8'),/label=s[1-4]/);
 const fifth=run('bash',[path.join(here,'heavy-job.sh'),'--label','fifth','--wait-seconds','0','--','true'],{env});
 assert.equal(fifth.status,75);
 await Promise.all(jobs.map(p=>p.exitCode!==null?null:new Promise(r=>p.once('exit',r))));
 const bad=run('bash',[path.join(here,'heavy-job.sh'),'--label','bad','--','true'],{env:{...env,HEAVY_JOB_SLOTS:'9'}});
 assert.equal(bad.status,2);assert.match(bad.stderr,/1 to 8/);
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
 const repo=path.join(root,'repo'),releases=path.join(root,'releases');fs.mkdirSync(repo);installScope(repo);
 const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
 const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
 fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
 fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
 fs.writeFileSync(path.join(releases,'current.txt'),`${release}\n`);
 const fixture=path.join(root,'command.mjs');fs.writeFileSync(fixture,`if(process.argv[2]==='vitest') console.log('Tests 3 passed (3)'); else if(process.argv[2]==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0,j1,j2,j3,j4').split(',').map(id=>({id,ok:true}))}));`);
 const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${kind}${id==='e2e'?' {args}':''}`]})));
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
  installScope(repo);
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
  fs.writeFileSync(fixture,`if(process.argv[2]==='vitest') console.log('Tests 3 passed (3)'); else if(process.argv[2]==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0,j1,j2,j3,j4').split(',').map(id=>({id,ok:true}))}));`);
  const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${kind}${id==='e2e'?' {args}':''}`]})));
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=(release)=>['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases];
  const gateEnv=jobEnv(lockBase());
  let r=node('gate-evidence.mjs',[...args(mobileStage.release),'--gates-json',defFile,'--skip-notes'],{env:gateEnv});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const mobileFile=path.join(mobileStage.dir,'gate-evidence.json'),mobileEvidence=fs.readFileSync(mobileFile,'utf8');
  const mobileJson=JSON.parse(mobileEvidence);
  assert.deepEqual(mobileJson.gates.filter(g=>g.mode==='skip').map(g=>g.id).sort(),['e2e','hbots-mobile-kotlin','personal-client','release-tools','server-tests','server-tsc','web-tests','web-tsc']);
  assert.equal(node('check-gate-evidence.mjs',args(mobileStage.release)).status,0);
  fs.writeFileSync(path.join(repo,'apps/server/src/index.ts'),'export const value=2;\n');const server=commit('server change');
  const serverStage=stage(server);
  r=node('gate-evidence.mjs',[...args(serverStage.release),'--gates-json',defFile,'--skip-notes'],{env:gateEnv});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const serverJson=JSON.parse(fs.readFileSync(path.join(serverStage.dir,'gate-evidence.json'),'utf8'));
  assert.equal(serverJson.gates.find(g=>g.id==='server-tests').mode,'selected');
  assert.equal(serverJson.gates.find(g=>g.id==='web-tests').mode,'skip');
  assert.ok(serverJson.gates.find(g=>g.id==='server-tests').commands.length>0);
  const forged=JSON.parse(mobileEvidence);
  forged.release=serverStage.release;forged.sha=server;forged.headAtStart=server;forged.headAtEnd=server;
  forged.stagedRelease={...forged.stagedRelease,sha:serverStage.release};
  fs.writeFileSync(path.join(serverStage.dir,'gate-evidence.json'),JSON.stringify(forged));
  r=node('check-gate-evidence.mjs',args(serverStage.release));
  assert.equal(r.status,1,r.stdout+r.stderr);
  assert.match(r.stderr,/the recomputed plan is selected/);
 } finally {fs.rmSync(root,{recursive:true,force:true})}
});
test('server-tests and e2e gates start together',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-parallel-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),starts=path.join(root,'starts');
  fs.mkdirSync(repo);installScope(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${release}\n`);
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`import fs from 'node:fs';
const kind=process.argv[2];
if(kind.startsWith('server-tests')||kind==='e2e'){
  fs.appendFileSync(process.env.STARTS,String(Date.now())+'\\n');
  await new Promise((resolve)=>setTimeout(resolve,1500));
}
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0,j1,j2,j3,j4').split(',').map(id=>({id,ok:true}))}));
else console.log('Tests 3 passed (3)');`);
  const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}${id==='e2e'?' {args}':''}`]})),id=>`node '${fixture}' ${id}`);
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

test('server-tests lanes and e2e run together within the CPU budget, one at a time with a budget of 1',()=>{
 const once=(extra)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-lanes-'));
  try{
   const repo=path.join(root,'repo'),releases=path.join(root,'releases'),starts=path.join(root,'starts');
   fs.mkdirSync(repo);installScope(repo);
   const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
   git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
   fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
   const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
   fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
   fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
   fs.writeFileSync(path.join(releases,'current.txt'),`${release}\n`);
   const fixture=path.join(root,'command.mjs');
   fs.writeFileSync(fixture,`import fs from 'node:fs';
const kind=process.argv[2];
if(kind.startsWith('server-tests')||kind==='e2e'){
  fs.appendFileSync(process.env.STARTS,kind+':'+Date.now()+'\\n');
  await new Promise((resolve)=>setTimeout(resolve,400));
}
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0,j1,j2,j3,j4').split(',').map(id=>({id,ok:true}))}));
else console.log('Tests 3 passed (3)');`);
   const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}${id==='e2e'?' {args}':''}`]})),id=>`node '${fixture}' ${id}`);
   defs[0].concurrent=[[`node '${fixture}' server-tests-1`],[`node '${fixture}' server-tests-2`]];
   delete defs[0].commands;
   const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
   const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile];
   const r=node('gate-evidence.mjs',args,{env:jobEnv(lockBase(),{STARTS:starts,GATE_MEM_RESERVE_MB:'0',...extra})});
   assert.equal(r.status,0,r.stdout+r.stderr);
   const rows=fs.readFileSync(starts,'utf8').trim().split('\n').map((line)=>line.split(':')).map(([id,at])=>[id,Number(at)]);
   const evidence=JSON.parse(fs.readFileSync(path.join(dir,'gate-evidence.json'),'utf8'));
   return {rows,evidence,stdout:r.stdout,dir};
  }finally{fs.rmSync(root,{recursive:true,force:true})}
 };
 const together=once({});
 const times=together.rows.map(([,at])=>at);
 assert.equal(together.rows.length,3,'two lanes and e2e');
 assert.ok(Math.max(...times)-Math.min(...times)<350,`all three start together: spread ${Math.max(...times)-Math.min(...times)} ms`);
 // The waterfall: printed, and kept in the evidence with every planned gate.
 assert.match(together.stdout,/^gate timing: \d+ s wall, \d+ s if serial; budget \d+ of \d+ cores/m);
 assert.match(together.stdout,/^  server-tests +whole +start +\d+ s +\d+ s +2 jobs PASS/m);
 assert.equal(together.evidence.timing.rows.length,10);
 assert.equal(together.evidence.gates.find(g=>g.id==='server-tests').timing.jobs.length,2);
 const serial=once({GATE_CPU_BUDGET:'1'});
 const sorted=serial.rows.map(([,at])=>at).sort((a,b)=>a-b);
 for(let i=1;i<sorted.length;i++)assert.ok(sorted[i]-sorted[i-1]>=350,`budget 1 runs one job at a time: gap ${sorted[i]-sorted[i-1]} ms`);
 assert.equal(serial.evidence.timing.cpuBudget,1);
});
test('a selected server-tests set is cut into balanced chunks whose union is the plan, guards in the first only',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-chunks-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases');
  fs.mkdirSync(path.join(repo,'apps/server/src/personal'),{recursive:true});installScope(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'apps/server/src/personal/shared.ts'),'export const value=1;\n');
  for(let i=0;i<120;i++)fs.writeFileSync(path.join(repo,`apps/server/src/personal/t${String(i).padStart(3,'0')}.test.ts`),"import {value} from './shared.ts';\nexport const seen=value;\n");
  git('add','-A');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  fs.writeFileSync(path.join(repo,'apps/server/src/personal/shared.ts'),'export const value=2;\n');git('add','-A');git('commit','-qm','shared change');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${base.slice(0,12)}\n`);
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`const kind=process.argv[2];
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0,j1,j2,j3,j4').split(',').map(id=>({id,ok:true}))}));
else { console.log('ARGS '+process.argv.slice(3).join(' ')); console.log('Tests '+Math.max(1,process.argv.length-3)+' passed'); }`);
  const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:id==='server-tests'?'apps/server':'.',commands:[`node '${fixture}' ${id}${id==='e2e'?' {args}':id==='server-tests'?' {args} src/persistence/Migrations.registry.test.ts':''}`]})),id=>`node '${fixture}' ${id}`);
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile,'--skip-notes'];
  const dry=node('gate-evidence.mjs',[...args,'--dry-run'],{env:{...process.env,HBOTS_HEAVY_JOB_HELD:''}});
  assert.equal(dry.status,0,dry.stdout+dry.stderr);
  // Harout's guard 5: over 100 selected files names the changed file behind the fan-out.
  assert.match(dry.stdout,/^fan-out: server-tests selected 120 files \(over 100\)/m);
  assert.match(dry.stdout,/^ +120 +apps\/server\/src\/personal\/shared\.ts$/m);
  const r=node('gate-evidence.mjs',args,{env:jobEnv(lockBase(),{GATE_MEM_RESERVE_MB:'0',GATE_SKIP_PREFLIGHT:'1'})});
  assert.equal(r.status,0,r.stdout+r.stderr);
  const evidence=JSON.parse(fs.readFileSync(path.join(dir,'gate-evidence.json'),'utf8'));
  const gate=evidence.gates.find(g=>g.id==='server-tests');
  assert.equal(gate.mode,'selected');assert.equal(gate.args.length,120);
  assert.ok(gate.commands.length>=4,`chunks: ${gate.commands.length}`);
  const named=gate.commands.flatMap(c=>c.command.split(' ').filter(t=>/^src\/personal\/t\d+\.test\.ts$/.test(t)));
  assert.deepEqual([...named].sort(),[...gate.args].sort(),'every planned file runs exactly once');
  assert.equal(gate.commands.filter(c=>c.command.includes('Migrations.registry.test.ts')).length,1,'the guards ride one chunk');
  assert.deepEqual(evidence.gateScope.fanOut.byChangedFile,[{file:'apps/server/src/personal/shared.ts',tests:120}]);
  assert.equal(node('check-gate-evidence.mjs',args.filter(a=>!['--gates-json',defFile,'--skip-notes'].includes(a))).status,0);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('the android lane runs one Gradle or emulator job at a time; light jobs pass beside it',async()=>{
 const base=lockBase();
 const env=jobEnv(base,{HEAVY_JOB_MIN_FREE_GB:'0'});
 const p=spawn('bash',[path.join(here,'heavy-job.sh'),'--label','gradle-a','--lane','android','--','sleep','2'],{stdio:['ignore','ignore','pipe'],env});
 await new Promise(resolve=>p.stderr.on('data',(d)=>{if(/nice 10/.test(String(d)))resolve()}));
 assert.match(fs.readFileSync(`${base}-android.lock`,'utf8'),/label=gradle-a .*lane=android/);
 const second=run('bash',[path.join(here,'heavy-job.sh'),'--label','emulator-b','--lane','android','--wait-seconds','0','--','true'],{env});
 assert.equal(second.status,75,second.stderr);assert.match(second.stderr,/waiting for the Android lane.*gradle-a/s);
 const light=run('bash',[path.join(here,'heavy-job.sh'),'--label','tsc-c','--wait-seconds','0','--','true'],{env});
 assert.equal(light.status,0,light.stderr);
 const bad=run('bash',[path.join(here,'heavy-job.sh'),'--label','bad','--lane','gpu','--','true'],{env});
 assert.equal(bad.status,2);
 await new Promise(resolve=>p.once('exit',resolve));
 const after=run('bash',[path.join(here,'heavy-job.sh'),'--label','emulator-b','--lane','android','--wait-seconds','0','--','true'],{env});
 assert.equal(after.status,0,after.stderr);
});
test('a CPU quota is passed to the scope only when set',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-quota-')),bin=path.join(dir,'bin'),args=path.join(dir,'args');
 fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,'systemd-run'),'#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$SYSTEMD_RUN_ARGS"\n',{mode:0o755});
 const once=(extra)=>{const r=run('bash',[path.join(here,'heavy-job.sh'),'--label','quota','--','true'],{env:{...process.env,HEAVY_JOB_BASE:path.join(dir,'gate'),HEAVY_JOB_SLOTS:'1',SYSTEMD_RUN_ARGS:args,PATH:`${bin}:${process.env.PATH}`,...extra}});return {r,argv:fs.existsSync(args)?fs.readFileSync(args,'utf8').trim().split('\n'):[]}};
 const set=once({HEAVY_JOB_CPU_QUOTA:'700%'});
 assert.equal(set.r.status,0,set.r.stderr);assert.ok(set.argv.includes('CPUQuota=700%'));
 const unset=once({});
 assert.ok(!unset.argv.some(a=>a.startsWith('CPUQuota=')));
 assert.equal(once({HEAVY_JOB_CPU_QUOTA:'lots'}).r.status,2);
});
test('a changed test that no gate runs is printed, recorded and noted',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-notrun-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases');
  fs.mkdirSync(repo);installScope(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','base');
  const base=git('rev-parse','HEAD');
  fs.mkdirSync(path.join(repo,'packages/shared/src'),{recursive:true});
  fs.writeFileSync(path.join(repo,'packages/shared/src/Orphan.test.ts'),'export {};\n');
  git('add','-A');git('commit','-qm','a test no gate runs');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${base.slice(0,12)}\n`);
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`const kind=process.argv[2];
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0,j1,j2,j3,j4').split(',').map(id=>({id,ok:true}))}));
else console.log('Tests 3 passed (3)');`);
  const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}${id==='e2e'?' {args}':''}`]})),id=>`node '${fixture}' ${id}`);
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile];
  const dry=node('gate-evidence.mjs',[...args,'--dry-run'],{env:{...process.env,HBOTS_HEAVY_JOB_HELD:''}});
  assert.equal(dry.status,0,dry.stdout+dry.stderr);
  assert.match(dry.stdout,/^not run by any gate: packages\/shared\/src\/Orphan\.test\.ts$/m);
  const r=node('gate-evidence.mjs',args,{env:jobEnv(lockBase())});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/^not run by any gate: packages\/shared\/src\/Orphan\.test\.ts$/m);
  const evidence=JSON.parse(fs.readFileSync(path.join(dir,'gate-evidence.json'),'utf8'));
  assert.deepEqual(evidence.gateScope.notRun,['packages/shared/src/Orphan.test.ts']);
  const notes=fs.readFileSync(path.join(repo,'docs/releases',fs.readdirSync(path.join(repo,'docs/releases'))[0]),'utf8');
  assert.match(notes,/^- not run by any gate: packages\/shared\/src\/Orphan\.test\.ts$/m);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('a change that edits a gate command in its own gates file runs the base command and the edit is reported',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-linux-tools-test-'));
 try {
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),gatesPath='scripts/personal/node/gates-linux.scoped.json';
  fs.mkdirSync(repo);installScope(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`const kind=process.argv[2];
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0,j1,j2,j3,j4').split(',').map(id=>({id,ok:true}))}));
else console.log('Tests 3 passed (3)');
if(kind==='server-tests') console.log('MARK '+process.argv[3]);`);
  const defsWith=(mark)=>withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}${id==='e2e'?' {args}':id==='server-tests'?` ${mark}`:''}`]})),id=>`node '${fixture}' ${id}`);
  const writeGates=(mark)=>{fs.mkdirSync(path.dirname(path.join(repo,gatesPath)),{recursive:true});fs.writeFileSync(path.join(repo,gatesPath),JSON.stringify(defsWith(mark),null,1))};
  fs.writeFileSync(path.join(repo,'source'),'fixture');writeGates('BASE-COMMAND');git('add','.');git('commit','-qm','base');
  const base=git('rev-parse','HEAD');
  writeGates('HEAD-EDITED-COMMAND');git('add','-A');git('commit','-qm','edit a gate command');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${base.slice(0,12)}\n`);
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',path.join(repo,gatesPath)];
  const edited=/^gate command changed in this change: server-tests; the base command runs$/m;
  const dry=node('gate-evidence.mjs',[...args,'--dry-run'],{env:{...process.env,HBOTS_HEAVY_JOB_HELD:''}});
  assert.equal(dry.status,0,dry.stdout+dry.stderr);
  assert.match(dry.stdout,edited);
  const r=node('gate-evidence.mjs',args,{env:jobEnv(lockBase())});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,edited);
  const log=fs.readFileSync(path.join(dir,'gate-evidence-logs/server-tests.log'),'utf8');
  assert.match(log,/MARK BASE-COMMAND/);
  assert.doesNotMatch(log,/HEAD-EDITED-COMMAND/);
  const evidence=JSON.parse(fs.readFileSync(path.join(dir,'gate-evidence.json'),'utf8'));
  assert.match(evidence.gates.find((gate)=>gate.id==='server-tests').commands[0].command,/BASE-COMMAND/);
  assert.deepEqual(evidence.gateScope.gateChanges,['gate command changed in this change: server-tests; the base command runs']);
  const notes=fs.readFileSync(path.join(repo,'docs/releases',fs.readdirSync(path.join(repo,'docs/releases'))[0]),'utf8');
  assert.match(notes,/^- gate command changed in this change: server-tests; the base command runs$/m);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('server-tests gate runs two whole shards and one selected lane',()=>{
 const root=path.resolve(here,'../../../..');
 const defs=JSON.parse(fs.readFileSync(path.join(root,'scripts/personal/node/gates-linux.scoped.json'),'utf8'));
 const gate=defs.find((d)=>d.id==='server-tests');
 assert.ok(gate,'server-tests gate exists');
 assert.equal(gate.concurrent?.length,2,'server-tests has two whole lanes');
 for(const [index,lane] of gate.concurrent.entries()){
  assert.equal(lane.length,1);
  assert.match(lane[0],new RegExp(`--shard=${index+1}/2`));
  assert.match(lane[0],/\{args\}/,'the planner fills the folders or the selected tests');
 }
 assert.match(gate.concurrent[0][0],/Migrations\.registry\.test\.ts/,'the always-run list rides the whole first shard');
 assert.equal(gate.commands?.length,1,'a selected set uses one lane');
 assert.match(gate.commands[0],/\{args\}/);
 assert.doesNotMatch(gate.commands[0],/--shard/);
});
test('gate commands run without the live app environment',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-env-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),seen=path.join(root,'env');
  fs.mkdirSync(repo);installScope(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${release}\n`);
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`import fs from 'node:fs';
const kind=process.argv[2];
if(kind==='server-tests') fs.writeFileSync(process.env.SEEN,JSON.stringify({t3:process.env.T3CODE_ENVIRONMENT_LABEL??'unset',personal:process.env.PERSONAL_SEED_MODEL??'unset',dsh:process.env.DSH_PROBE??'unset',gate:process.env.GATE_FIXTURE_PROBE??'unset',keep:process.env.KEEP_ME??'unset'}));
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0,j1,j2,j3,j4').split(',').map(id=>({id,ok:true}))}));
else console.log('Tests 3 passed (3)');`);
  const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}${id==='e2e'?' {args}':''}`]})),id=>`node '${fixture}' ${id}`);
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile];
  const r=node('gate-evidence.mjs',args,{env:jobEnv(lockBase(),{SEEN:seen,T3CODE_ENVIRONMENT_LABEL:'Bots',PERSONAL_SEED_MODEL:'live',DSH_PROBE:'live',GATE_FIXTURE_PROBE:'live',KEEP_ME:'ok'})});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(seen,'utf8')),{t3:'unset',personal:'unset',dsh:'unset',gate:'unset',keep:'ok'});
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('each gate gets a private TMPDIR under /tmp, removed after it, and the pinned test browser',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-tmp-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),seen=path.join(root,'seen');
  fs.mkdirSync(repo);installScope(repo);fs.mkdirSync(seen);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${release}\n`);
  const fixture=path.join(root,'command.mjs');
  fs.writeFileSync(fixture,`import fs from 'node:fs';
const id=process.argv[2];
fs.writeFileSync(process.env.SEEN+'/'+id+'.json',JSON.stringify({tmp:process.env.TMPDIR,exists:fs.existsSync(process.env.TMPDIR),browsers:process.env.PLAYWRIGHT_BROWSERS_PATH??'unset'}));
if(id==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0,j1,j2,j3,j4').split(',').map(id=>({id,ok:true}))}));
else console.log('Tests 3 passed (3)');`);
  const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}${id==='e2e'?' {args}':''}`]})),id=>`node '${fixture}' ${id}`);
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
  installScope(repo);
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
  for(const id of ['server-tests','e2e','hbots-mobile-kotlin','parity']) assert.match(r.stdout,new RegExp(`^${id}: SKIP \\(no changed path is an input of ${id}: `,'m'));
  assert.match(r.stdout,/dry run: 0 of 9 gates would run/);
  r=dry(server);
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/^server-tests: SELECTED \[5\] \(server-tests inputs changed: apps\/server\/src\/index\.ts; selected 5 test files\)$/m);
  assert.match(r.stdout,/^server-tsc: WHOLE \(server-tsc inputs changed: apps\/server\/src\/index\.ts\)$/m);
  assert.match(r.stdout,/^e2e: SELECTED \[12\] /m);
  assert.match(r.stdout,/^hbots-mobile-kotlin: SKIP /m);
  assert.match(r.stdout,/dry run: 3 of 9 gates would run/);
  r=dry(unknown);
  assert.equal(r.status,2,r.stdout+r.stderr);
  assert.match(r.stderr,/FAIL: unmapped path tools\/new\.mjs: add each to a CHECKS row, NO_CHECK or TOOLCHAIN/);
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
test('server-tests gate covers the folders behind the 1.67.1 rollbacks',async()=>{
 const root=path.resolve(here,'../../../..');
 const {planChecks}=await import('../hbots-release/lib/gateScope.mjs');
 const {fsReader}=await import('../hbots-release/lib/serverTestSelect.mjs');
 const plan=planChecks(['package.json'],{reader:fsReader(root)}).plans.find((p)=>p.id==='server-tests');
 assert.ok(plan,'server-tests plan exists');
 assert.equal(plan.mode,'whole');
 for(const folder of ['orchestration-v2','cloud','provider','process']){
  const tests=fs.readdirSync(path.join(root,'apps/server/src',folder),{recursive:true}).filter((file)=>String(file).endsWith('.test.ts')).length;
  assert.ok(tests>0,`src/${folder} has test files`);
  assert.ok(plan.args.includes(`src/${folder}`),`server-tests gate runs src/${folder}`);
 }
});
test('a gate cwd with its own vp wins over the repo root copy',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-vp-'));
 try {
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),cwd=path.join(repo,'packages/personal-client');
  for(const dir of [path.join(repo,'node_modules/.bin'),path.join(cwd,'node_modules/.bin')])fs.mkdirSync(dir,{recursive:true});
  installScope(repo);
  for(const [dir,out] of [[path.join(repo,'node_modules/.bin'),'root-vp'],[path.join(cwd,'node_modules/.bin'),'local-vp']]){
   fs.writeFileSync(path.join(dir,'vp'),`#!/bin/sh\necho ${out}\n`);fs.chmodSync(path.join(dir,'vp'),0o755);
  }
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${release}\n`);
  const fixture=path.join(root,'command.mjs');fs.writeFileSync(fixture,`if(process.argv[2]==='vitest') console.log('Tests 3 passed (3)'); else if(process.argv[2]==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0,j1,j2,j3,j4').split(',').map(id=>({id,ok:true}))}));`);
  const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${kind}${id==='e2e'?' {args}':''}`]})));
  defs.splice(defs.findIndex(d=>d.id==='personal-client'),1,{id:'personal-client',kind:'vitest',cwd:'packages/personal-client',commands:['vp test; echo "Tests 1 passed (1)"']});
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
  fs.mkdirSync(repo);installScope(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${release}\n`);
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
   // One job at a time, so "the next gate never started" holds; in parallel the abort
   // still kills the others and writes no evidence (the same assertions below).
   const r=node('gate-evidence.mjs',f.args,{env:jobEnv(lockBase(),{RAN:f.ran,GATE_CPU_BUDGET:'1'})});
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
// BOOTSTRAP RULE. gates-linux.json is the file the INSTALLED gate-evidence.mjs reads
// (--gates-json) while it gates the release that replaces it. That tool runs every
// command as plain text and knows no placeholder, so a `{args}` in this file reaches
// vitest, gradle, node --test and the e2e runner as the literal text "{args}" and fails
// four gates (1.67.28, 16 Nov: server-tests, e2e, hbots-mobile-kotlin, release-tools).
// Templated definitions live in gates-linux.scoped.json, which only the new tool and
// the planner read. A change to a file the installed tool reads must stay readable by
// the installed tool for one release.
test('gates-linux.json (read by the installed tool) holds no placeholder the old format does not know',()=>{
 const root=path.resolve(here,'../../../..');
 const defs=JSON.parse(fs.readFileSync(path.join(root,'scripts/personal/node/gates-linux.json'),'utf8'));
 assert.ok(Array.isArray(defs)&&defs.length>0);
 const placeholder=/(?<!\$)\{[A-Za-z_][\w-]*\}/;
 for(const d of defs){
  const lanes=d.concurrent??[d.commands];
  for(const command of lanes.flat())assert.doesNotMatch(command,placeholder,`${d.id}: "${command}" has a placeholder; put templated gates in gates-linux.scoped.json`);
  assert.deepEqual(Object.keys(d).filter(k=>!['id','kind','title','cwd','commands','concurrent'].includes(k)),[],`${d.id}: a field the installed tool does not read`);
 }
 const scoped=JSON.parse(fs.readFileSync(path.join(root,'scripts/personal/node/gates-linux.scoped.json'),'utf8'));
 for(const d of defs)assert.ok(scoped.some(s=>s.id===d.id),`${d.id} is missing from gates-linux.scoped.json`);
 assert.match(JSON.stringify(scoped),/\{args\}/,'the scoped file carries the templates');
});
// ---- async gate tier (Faster releases step 2) ----
// A fixture world: a release worktree, the releases and run dirs, and stand-ins for the
// collector, systemctl, hbots.mjs and the notifier, each driven by a file it reads.
const asyncWorld=({tier='blocking',current,units='',newer=null,migration=false,onTop=null}={})=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-async-'));
 const wt=path.join(root,'wt'),releases=path.join(root,'releases'),runDir=path.join(root,'run'),qa=path.join(root,'qa'),bin=path.join(root,'bin');
 for(const d of [wt,releases,runDir,qa,bin])fs.mkdirSync(d,{recursive:true});
 installScope(wt);
 const g=(...a)=>{const r=run('git',['-C',wt,...a]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
 g('init','-q');g('config','user.email','f@example.invalid');g('config','user.name','F');
 fs.writeFileSync(path.join(wt,'a.ts'),'1\n');g('add','-A');g('commit','-qm','base');const base=g('rev-parse','HEAD');
 fs.writeFileSync(path.join(wt,'a.ts'),'2\n');
 if(migration){fs.mkdirSync(path.join(wt,'apps/server/src/persistence/Migrations'),{recursive:true});fs.writeFileSync(path.join(wt,'apps/server/src/persistence/Migrations/099_x.ts'),'x\n')}
 g('add','-A');g('commit','-qm','release');const head=g('rev-parse','HEAD');
 // The release flow commits its docs on top of the tested commit; onTop adds such a commit (or a code one).
 if(onTop==='docs'){fs.mkdirSync(path.join(wt,'docs/releases'),{recursive:true});fs.writeFileSync(path.join(wt,'docs/releases/HANDOFF.md'),'# evidence\n');fs.writeFileSync(path.join(wt,'NOTES.md'),'n\n');g('add','-A');g('commit','-qm','docs')}
 if(onTop==='code'){fs.writeFileSync(path.join(wt,'b.ts'),'3\n');fs.writeFileSync(path.join(wt,'NOTES.md'),'n\n');g('add','-A');g('commit','-qm','code after the gates')}
 const rel=head.slice(0,12),rb=base.slice(0,12);
 fs.mkdirSync(path.join(releases,rel,'dist'),{recursive:true});
 fs.writeFileSync(path.join(releases,rel,'VERSION'),'version=1.68.0\n');fs.writeFileSync(path.join(releases,rel,'dist/bin.mjs'),'//\n');
 fs.writeFileSync(path.join(releases,rel,'gate-evidence.json'),JSON.stringify({sha:head,release:rel,...(tier?{tier}:{})}));
 fs.writeFileSync(path.join(releases,'current.txt'),`${current??rel}\n`);
 fs.writeFileSync(path.join(runDir,'restart-1.68.0-result.json'),JSON.stringify({status:'live_verified',release:rel,rollback:rb}));
 if(newer)fs.writeFileSync(path.join(runDir,'restart-1.68.1-result.json'),JSON.stringify({status:newer}));
 const sh=(name,body)=>{fs.writeFileSync(path.join(bin,name),`#!/usr/bin/env bash\n${body}\n`);fs.chmodSync(path.join(bin,name),0o755)};
 // The collector stand-in: exits with the code in gate.exit and notes its env and args.
 fs.writeFileSync(path.join(bin,'collector.mjs'),`import fs from 'node:fs';import {execFileSync} from 'node:child_process';fs.appendFileSync(${JSON.stringify(path.join(root,'collector.calls'))},JSON.stringify({tier:process.env.GATE_TIER,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),args:process.argv.slice(2)})+'\\n');const a=process.argv;const d=a[a.indexOf('--releases-dir')+1];fs.appendFileSync(${JSON.stringify(path.join(root,'collector.calls'))},'current='+fs.readFileSync(d+'/current.txt','utf8'));process.exit(Number(fs.readFileSync(${JSON.stringify(path.join(root,'gate.exit'))},'utf8')))`);
 fs.writeFileSync(path.join(root,'gate.exit'),'0');
 sh('systemctl',`printf '%s' ${JSON.stringify(units)}`);
 fs.writeFileSync(path.join(bin,'cli.mjs'),`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(path.join(root,'cli.calls'))},process.argv.slice(2).join(' ')+'\\n');process.exit(process.argv[2]==='smoke'?Number(process.env.FAKE_SMOKE_EXIT??0):0)`);
 fs.writeFileSync(path.join(bin,'notify.mjs'),`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(path.join(root,'notices'))},process.argv.slice(2).join(' ')+'\\n')`);
 const env=(extra={})=>({...process.env,HBOTS_ASYNC_RUN_DIR:runDir,HBOTS_ASYNC_RELEASES:releases,HBOTS_ASYNC_SYSTEMCTL:path.join(bin,'systemctl'),HBOTS_ASYNC_COLLECTOR:path.join(bin,'collector.mjs'),HBOTS_ASYNC_CLI:path.join(bin,'cli.mjs'),HBOTS_ASYNC_NOTIFY:path.join(bin,'notify.mjs'),...extra});
 const go=(args=[],extra={})=>node('hbots-async-gates.mjs',['--version','1.68.0','--release',rel,'--worktree',wt,'--qa-dir',qa,...args],{env:env(extra)});
 const read=(name)=>{try{return fs.readFileSync(path.join(root,name),'utf8')}catch{return ''}};
 return {root,rel,rb,go,read,setExit:(n)=>fs.writeFileSync(path.join(root,'gate.exit'),String(n)),qa,wt,tested:head,g};
};
test('async gates: a pass runs the async tier against the rollback base and posts nothing',()=>{
 const w=asyncWorld();
 const r=w.go();
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.match(w.read('collector.calls'),/"tier":"async"/);
 assert.match(w.read('collector.calls'),new RegExp(`current=${w.rb}`));
 assert.equal(w.read('notices'),'');assert.equal(w.read('cli.calls'),'');
 assert.match(fs.readFileSync(path.join(w.qa,'ASYNC-RECORD.md'),'utf8'),/Outcome:\*\* `passed`/);
});
test('async gates: a failure on the tested live release rolls back, smokes and posts async_rolled_back',()=>{
 const w=asyncWorld();w.setExit(1);
 const r=w.go();
 assert.equal(r.status,10,r.stdout+r.stderr);
 assert.match(w.read('cli.calls'),new RegExp(`^restart --root dev --release ${w.rb}\\nsmoke --root dev --expect-release ${w.rb}`));
 assert.match(w.read('notices'),/--thread-id 759552c5-0b8c-4680-8cc6-5c7487c8081e .*--outcome async_rolled_back .*--rollback-release [0-9a-f]{12} --rollback-exit 0 --rollback-smoke-exit 0/);
 const bad=asyncWorld();bad.setExit(1);
 assert.equal(bad.go([],{FAKE_SMOKE_EXIT:'1'}).status,12);
 assert.match(bad.read('notices'),/--outcome async_rollback_failed/);
});
test('async gates: no rollback when a newer release is live, armed or running, or on a migration',()=>{
 const cases=[
  [{current:'f'.repeat(12)},/live release is f{12}, not the tested/],
  [{units:'hbots-release-run-1.68.1.service loaded active running x\n'},/hbots-release-run-1\.68\.1 is active/],
  [{newer:'waiting_for_idle'},/release 1\.68\.1 is waiting_for_idle/],
  [{migration:true},/DB migrations/],
  [{},/--no-rollback was given/,['--no-rollback']],
 ];
 for(const [opts,why,args=[]] of cases){
  const w=asyncWorld(opts);w.setExit(1);
  const r=w.go(args);
  assert.equal(r.status,11,`${why}: ${r.stdout}${r.stderr}`);
  assert.equal(w.read('cli.calls'),'',`${why}: nothing restarted`);
  assert.match(w.read('notices'),/--outcome async_failed/);
  assert.match(r.stdout,why);
 }
});
// Regression tests for the 1.67.52 async-tier stop (the slot HEAD was the docs commit on top of
// the tested commit) and the exit-code rule: only a real gate failure (exit 1) may roll back.
const collectorHeads=(w)=>w.read('collector.calls').split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l).head);
test('async gates (a): a docs-only commit on top runs on the tested commit and puts HEAD and the branch back',()=>{
 for(const exit of [0,1]){
  const w=asyncWorld({onTop:'docs'});w.setExit(exit);
  const branch=w.g('symbolic-ref','--short','HEAD'),docsHead=w.g('rev-parse','HEAD');
  assert.notEqual(docsHead,w.tested);
  const r=w.go(exit?['--no-rollback']:[]);
  assert.equal(r.status,exit?11:0,r.stdout+r.stderr);
  assert.deepEqual(collectorHeads(w),[w.tested],'the collector ran once, on the tested commit');
  assert.match(r.stdout,new RegExp(`worktree switched to the tested commit ${w.rel}`));
  assert.match(r.stdout,new RegExp(`worktree back on ${branch}`));
  assert.equal(w.g('rev-parse','HEAD'),docsHead,'HEAD restored');
  assert.equal(w.g('symbolic-ref','--short','HEAD'),branch,'branch restored, not detached');
  assert.equal(w.g('status','--porcelain','--untracked-files=no'),'');
  assert.equal(w.read('cli.calls'),'');
 }
});
test('async gates (b): a code commit on top of the tested commit is refused and never rolls back',()=>{
 const w=asyncWorld({onTop:'code'});w.setExit(1);
 const before=w.g('rev-parse','HEAD');
 const r=w.go();
 assert.equal(r.status,1,r.stdout+r.stderr);
 assert.match(r.stdout,/cannot run: worktree HEAD [0-9a-f]{12} changes code after the tested commit [0-9a-f]{12}: b\.ts/);
 assert.doesNotMatch(r.stdout,/NOTES\.md/,'the .md file is not counted as code');
 assert.equal(w.read('collector.calls'),'','no gate ran');
 assert.equal(w.read('cli.calls'),'','nothing restarted');
 assert.match(w.read('notices'),/--outcome async_failed/);
 assert.equal(w.g('rev-parse','HEAD'),before);
 assert.match(fs.readFileSync(path.join(w.qa,'ASYNC-RECORD.md'),'utf8'),/Outcome:\*\* `could_not_run`/);
});
test('async gates (c): a collector that exits 2 (it could not run) never rolls back',()=>{
 for(const exit of [2,3]){
  const w=asyncWorld({onTop:'docs'});w.setExit(exit);
  const r=w.go();
  assert.equal(r.status,11,r.stdout+r.stderr);
  assert.match(r.stdout,new RegExp(`no rollback: the gates could not run \\(exit ${exit}\\), so no test failed`));
  assert.equal(w.read('cli.calls'),'',`exit ${exit}: nothing restarted`);
  assert.match(w.read('notices'),/--outcome async_failed/);
  assert.doesNotMatch(w.read('notices'),/rolled_back/);
 }
});
test('async gates (d): a collector that exits 1 with rollback allowed rolls back to the base',()=>{
 const w=asyncWorld({onTop:'docs'});w.setExit(1);
 const r=w.go();
 assert.equal(r.status,10,r.stdout+r.stderr);
 assert.deepEqual(collectorHeads(w),[w.tested]);
 assert.match(w.read('cli.calls'),new RegExp(`^restart --root dev --release ${w.rb}\\nsmoke --root dev --expect-release ${w.rb}`));
 assert.match(w.read('notices'),/--outcome async_rolled_back/);
 assert.match(fs.readFileSync(path.join(w.qa,'ASYNC-RECORD.md'),'utf8'),/Rollback:\*\* allowed/);
});
test('async gates: untiered evidence runs nothing; --dry-run decides without running or posting',()=>{
 const full=asyncWorld({tier:null});
 const r=full.go();
 assert.equal(r.status,0);assert.match(r.stdout,/nothing was deferred/);assert.equal(full.read('collector.calls'),'');
 const w=asyncWorld();
 const d=w.go(['--dry-run'],{HBOTS_ASYNC_SIMULATE:'fail'});
 assert.equal(d.status,0,d.stdout+d.stderr);
 assert.match(w.read('collector.calls'),/--dry-run/);
 assert.match(d.stdout,new RegExp(`would roll back to ${w.rb}`));
 assert.equal(w.read('notices'),'');assert.equal(w.read('cli.calls'),'');
 assert.ok(!fs.existsSync(path.join(w.qa,'ASYNC-GATES.log')));
});
// The deferred emulator flows (1.67.56): a verify.sh stand-in answers each call with the next
// line of emu.exits ("<exit> <flow lines ...>") and notes its args and env.
const emuWorld=(opts,answers)=>{
 const w=asyncWorld(opts);
 const verify=path.join(w.root,'verify.sh'),apk=path.join(w.root,'qa.apk');
 fs.writeFileSync(apk,'apk');
 fs.writeFileSync(path.join(w.root,'emu.exits'),answers.join('\n')+'\n');
 fs.writeFileSync(verify,`#!/usr/bin/env bash
n=$(cat ${JSON.stringify(path.join(w.root,'emu.n'))} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(path.join(w.root,'emu.n'))}
echo "$* | release=$VERIFY_RELEASE ev=$HBOTS_VERIFY_EVIDENCE node_env=\${NODE_ENV-unset}" >> ${JSON.stringify(path.join(w.root,'emu.calls'))}
line=$(sed -n "\${n}p" ${JSON.stringify(path.join(w.root,'emu.exits'))})
code=\${line%% *}; rest=\${line#* }
[[ $rest == "$line" ]] || printf '%b\\n' "$rest"
echo "RESULT exit $code"
exit $code
`);
 const go=(args=[],extra={})=>w.go(['--emulator-apk',apk,...args],{HBOTS_ASYNC_VERIFY:verify,NODE_ENV:'production',...extra});
 return {...w,go,calls:()=>w.read('emu.calls').trim().split('\n').filter(Boolean)};
};
test('async emulator: deferred flows run against the live release, even with untiered evidence',()=>{
 const w=emuWorld({tier:null},['0 10:00:00 flow 4 work-card-unread-only PASS (30 s): ok']);
 const r=w.go();
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.equal(w.read('collector.calls'),'','no gate deferred, so the collector never ran');
 const [call]=w.calls();
 assert.match(call,new RegExp(`qa\\.apk async-1\\.68\\.0 --tier async --base ${w.rb} \\| release=${w.rel} ev=${w.qa}/emulator-async node_env=unset`));
 assert.match(r.stdout,/flow 4 work-card-unread-only PASS/);
 assert.match(fs.readFileSync(path.join(w.qa,'ASYNC-RECORD.md'),'utf8'),/Outcome:\*\* `passed`[\s\S]*Emulator flows/);
});
test('async emulator: a flow that fails then passes on its own rerun is flaky, not a failure',()=>{
 const w=emuWorld({},['1 10:00:00 flow 10 tool-approval-card FAIL (9 s): x\\n10:01:00 flow 11 restart-laptop-dry-run PASS (5 s): y','0 10:02:00 flow 10 tool-approval-card PASS (9 s): z']);
 const r=w.go();
 assert.equal(r.status,0,r.stdout+r.stderr);
 assert.match(w.calls()[1],/async-1\.68\.0-retry --only 10 \|/);
 assert.match(r.stdout,/flows 10 passed on the second run/);
 assert.equal(w.read('cli.calls'),'');assert.equal(w.read('notices'),'');
});
test('async emulator: a flow that fails twice rolls back under guard 2, or stays live with untiered evidence',()=>{
 const fail=['1 10:00:00 flow 12 secret-card-problem FAIL (9 s): x','1 10:02:00 flow 12 secret-card-problem FAIL (9 s): x'];
 const w=emuWorld({},fail);
 const r=w.go();
 assert.equal(r.status,10,r.stdout+r.stderr);
 assert.match(w.read('cli.calls'),new RegExp(`^restart --root dev --release ${w.rb}`));
 assert.match(r.stdout,/deferred emulator flows exit 1/);
 const full=emuWorld({tier:null},fail);
 const k=full.go();
 assert.equal(k.status,11,k.stdout+k.stderr);
 assert.match(k.stdout,/no rollback: .*the evidence tier is full, not blocking/);
 assert.equal(full.read('cli.calls'),'');
 assert.match(full.read('notices'),/--outcome async_failed/);
});
test('async emulator: a setup or link failure (exit 2), or exit 1 with no FAIL line, never rolls back',()=>{
 for(const answers of [['2 10:00:00 SETUP FAILED: no device'],['1 nothing named']]){
  const w=emuWorld({},answers);
  const r=w.go();
  assert.equal(r.status,11,r.stdout+r.stderr);
  assert.equal(w.calls().length,1,'no retry without a failed flow');
  assert.match(r.stdout,/no rollback: the gates could not run \(exit 2\)/);
  assert.equal(w.read('cli.calls'),'');
 }
});
test('async emulator: a gate pass does not hide an emulator failure, and the gates run first',()=>{
 const w=emuWorld({},['1 10:00:00 flow 5 in-app-on-tasks-tab FAIL (9 s): x','1 10:00:00 flow 5 in-app-on-tasks-tab FAIL (9 s): x']);
 const r=w.go(['--no-rollback']);
 assert.equal(r.status,11,r.stdout+r.stderr);
 assert.match(w.read('collector.calls'),/"tier":"async"/);
 assert.ok(r.stdout.indexOf('deferred gates exit 0')<r.stdout.indexOf('deferred emulator flows exit 1'));
 const bad=emuWorld({},['0']);
 fs.writeFileSync(path.join(bad.root,'gate.exit'),'1');
 assert.equal(bad.go(['--no-rollback']).status,11,'a gate failure with a passing emulator still fails');
 assert.equal(emuWorld({},['0']).go(['--emulator-apk','/nonexistent.apk']).status,2);
});
test('GATE_TIER: blocking defers e2e and the far server tests; async runs them and retries a failed job once',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-tier-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),src=path.join(repo,'apps/server/src/personal/tier');
  fs.mkdirSync(src,{recursive:true});installScope(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(src,'core.ts'),'export const core=1;\n');
  fs.writeFileSync(path.join(src,'mid.ts'),"import {core} from './core.ts';\nexport const mid=core;\n");
  fs.writeFileSync(path.join(src,'far.ts'),"import {mid} from './mid.ts';\nexport const far=mid;\n");
  fs.writeFileSync(path.join(src,'core.test.ts'),"import {core} from './core.ts';\ncore;\n");
  fs.writeFileSync(path.join(src,'far.test.ts'),"import {far} from './far.ts';\nfar;\n");
  git('add','-A');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  fs.writeFileSync(path.join(src,'core.ts'),'export const core=2;\n');git('add','-A');git('commit','-qm','core change');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${base.slice(0,12)}\n`);
  const fixture=path.join(root,'command.mjs'),flaky=path.join(root,'flaky-once');
  // far.test.ts fails on its first run only, so the async retry is what passes it.
  fs.writeFileSync(fixture,`import fs from 'node:fs';
const kind=process.argv[2];
fs.appendFileSync(${JSON.stringify(path.join(root,'ran'))},kind+' '+process.argv.slice(3).join(' ')+'\\n');
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0').split(',').map(id=>({id,ok:true}))}));
else if(kind==='server-tests'&&process.argv.includes('src/personal/tier/far.test.ts')&&!fs.existsSync(${JSON.stringify(flaky)})){fs.writeFileSync(${JSON.stringify(flaky)},'1');console.log('Tests 1 failed (1)');process.exit(1)}
else console.log('Tests 1 passed (1)');`);
  const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:id==='server-tests'?'apps/server':'.',commands:[`node '${fixture}' ${id}${id==='e2e'||id==='server-tests'?' {args}':''}`]})),id=>`node '${fixture}' ${id}`);
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile,'--skip-notes'];
  const env=(tier)=>jobEnv(lockBase(),{GATE_MEM_RESERVE_MB:'0',GATE_SKIP_PREFLIGHT:'1',GATE_TIER:tier});
  const dry=node('gate-evidence.mjs',[...args,'--dry-run'],{env:{...env('blocking'),HBOTS_HEAVY_JOB_HELD:''}});
  assert.equal(dry.status,0,dry.stdout+dry.stderr);
  assert.match(dry.stdout,/^tier: blocking \(tiered: .*e2e.*\)/m);
  const blocking=node('gate-evidence.mjs',args,{env:env('blocking')});
  assert.equal(blocking.status,0,blocking.stdout+blocking.stderr);
  const e=JSON.parse(fs.readFileSync(path.join(dir,'gate-evidence.json'),'utf8'));
  assert.equal(e.tier,'blocking');
  const e2e=e.gates.find(g=>g.id==='e2e');
  assert.equal(e2e.mode,'deferred');assert.equal(e2e.deferredMode,'selected');assert.deepEqual(e2e.commands,[]);
  const near=e.gates.find(g=>g.id==='server-tests');
  assert.ok(near.args.includes('src/personal/tier/core.test.ts'));assert.ok(!near.args.includes('src/personal/tier/far.test.ts'));
  assert.ok(!fs.readFileSync(path.join(root,'ran'),'utf8').includes('far.test.ts'),'the far test does not run before the release');
  const checkArgs=args.filter(a=>!['--gates-json',defFile,'--skip-notes'].includes(a));
  assert.equal(node('check-gate-evidence.mjs',checkArgs).status,0,'blocking evidence passes the checker');
  const later=node('gate-evidence.mjs',args,{env:env('async')});
  assert.equal(later.status,0,later.stdout+later.stderr);
  assert.match(later.stdout,/^retry server-tests job 1: failed \(exit 1\); running it once more$/m);
  const a=JSON.parse(fs.readFileSync(path.join(dir,'gate-evidence-async.json'),'utf8'));
  assert.equal(a.tier,'async');
  assert.deepEqual(a.gates.map(g=>g.id).sort(),['e2e','server-tests']);
  const far=a.gates.find(g=>g.id==='server-tests');
  assert.deepEqual(far.args,['src/personal/tier/far.test.ts']);
  assert.equal(far.retries.length,1);assert.equal(far.retries[0].firstAttempt[0].exit,1);
  assert.ok(fs.existsSync(far.retries[0].firstLog),'the first attempt log is kept');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'gate-evidence.json'),'utf8')).tier,'blocking','the blocking evidence is untouched');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('a process a gate leaves behind in the collector scope is stopped at the end of the run',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-sweep-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),pidFile=path.join(root,'leftover.pid');
  fs.mkdirSync(repo);installScope(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'source'),'fixture');git('add','.');git('commit','-qm','fixture');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${release}\n`);
  const fixture=path.join(root,'command.mjs');
  // web-tests starts a process in a new session (outside its group) and exits.
  fs.writeFileSync(fixture,`import {spawn} from 'node:child_process';import fs from 'node:fs';
const kind=process.argv[2];
if(kind==='web-tests'){const c=spawn('sleep',['300'],{detached:true,stdio:'ignore'});c.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid))}
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0').split(',').map(id=>({id,ok:true}))}));
else console.log('Tests 1 passed (1)');`);
  const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:'.',commands:[`node '${fixture}' ${id}${id==='e2e'?' {args}':''}`]})),id=>`node '${fixture}' ${id}`);
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile,'--skip-notes'];
  const r=node('gate-evidence.mjs',args,{env:jobEnv(lockBase(),{HEAVY_JOB_MEMORY_HIGH:'8G',GATE_MEM_RESERVE_MB:'0',GATE_SKIP_PREFLIGHT:'1'})});
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/^scope sweep \(end of run\): stopped 1 leftover process$/m);
  const pid=Number(fs.readFileSync(pidFile,'utf8'));
  let alive=true;for(let i=0;i<20&&alive;i++){try{process.kill(pid,0);spawnSync('sleep',['0.1'])}catch{alive=false}}
  assert.equal(alive,false,'the leftover sleep is gone');
  // Nested in a heavy-job scope it does not own, the collector leaves that scope alone.
  const sibling=path.join(root,'sibling.pid'),unit=`heavy-job-${process.pid}${Date.now()%100000}`;
  const nested=run('systemd-run',['--user','--scope','--quiet','--collect',`--unit=${unit}`,'--','bash','-c',
   `sleep 300 & echo $! > '${sibling}'; '${process.execPath}' '${path.join(here,'gate-evidence.mjs')}' "$@"`,'x',...args],
   {env:jobEnv(lockBase(),{GATE_MEM_RESERVE_MB:'0',GATE_SKIP_PREFLIGHT:'1'}),timeout:60000});
  const sib=Number(fs.readFileSync(sibling,'utf8'));
  let sibAlive=true;try{process.kill(sib,0)}catch{sibAlive=false}
  try{process.kill(sib,'SIGTERM')}catch{}
  assert.equal(nested.status,0,nested.stdout+nested.stderr);
  assert.doesNotMatch(nested.stdout,/scope sweep/);
  assert.equal(sibAlive,true,'a process of the outer scope survives the run');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('release slots: a lease per task, switch cleans untracked files but keeps ignored caches, only slot paths',()=>{
 const root=fs.mkdtempSync('/tmp/hbots-slot-test.');
 try{
  const repo=path.join(root,'repo'),wt=path.join(root,'wt');
  const git=(cwd,...args)=>{const r=run('git',['-C',cwd,'-c','user.email=t@t','-c','user.name=t',...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  fs.mkdirSync(repo);git(repo,'init','-q','-b','main');
  fs.writeFileSync(path.join(repo,'.gitignore'),'.env\nnode_modules/\nandroid/\n');fs.writeFileSync(path.join(repo,'a.txt'),'one\n');
  git(repo,'add','.');git(repo,'commit','-qm','one');
  fs.writeFileSync(path.join(repo,'a.txt'),'two\n');git(repo,'commit','-qam','two');
  for(const n of [1,2])git(repo,'worktree','add','-q','--detach',path.join(wt,`hbots-slot-${n}`),'HEAD~1');
  fs.writeFileSync(path.join(repo,'.env'),'SECRET=x\n');
  const env={...process.env,HBOTS_SLOT_ROOT:wt,HBOTS_SLOT_REPO:repo,HBOTS_SLOT_STATE:path.join(root,'state'),HBOTS_SLOT_TEST:'1'};
  const slot=(...args)=>run('bash',[path.join(here,'hbots-slot.sh'),...args],{env});
  const a=slot('lease','--label','task A');assert.equal(a.status,0,a.stderr);assert.equal(a.stdout.trim(),path.join(wt,'hbots-slot-1'));
  const b=slot('lease','--label','task B');assert.equal(b.status,0,b.stderr);assert.equal(b.stdout.trim(),path.join(wt,'hbots-slot-2'));
  const c=slot('lease','--label','task C');assert.equal(c.status,1);assert.match(c.stderr,/no free slot.*task A.*task B/);
  const s1=path.join(wt,'hbots-slot-1');
  fs.writeFileSync(path.join(s1,'stray.txt'),'left from the last release\n');
  fs.mkdirSync(path.join(s1,'android'));fs.writeFileSync(path.join(s1,'android','cache.bin'),'warm\n');
  // Only the holder switches, and never over tracked changes.
  assert.match(slot('switch','--slot','1','--label','task B','--detach','main').stderr,/leased by 'task A'/);
  fs.writeFileSync(path.join(s1,'a.txt'),'edited\n');
  assert.match(slot('switch','--slot','1','--label','task A','--detach','main').stderr,/tracked changes/);
  git(s1,'checkout','--','a.txt');
  const sw=slot('switch','--slot','1','--label','task A','--branch','release/x','--from','main');
  assert.equal(sw.status,0,sw.stderr);
  assert.equal(fs.readFileSync(path.join(s1,'a.txt'),'utf8'),'two\n');
  assert.equal(git(s1,'rev-parse','--abbrev-ref','HEAD'),'release/x');
  assert.ok(!fs.existsSync(path.join(s1,'stray.txt')),'untracked file removed');
  assert.equal(fs.readFileSync(path.join(s1,'android','cache.bin'),'utf8'),'warm\n','ignored cache kept');
  assert.equal(fs.readFileSync(path.join(s1,'.env'),'utf8'),'SECRET=x\n');assert.doesNotMatch(sw.stdout+sw.stderr,/SECRET/);
  assert.match(slot('release','--slot','1','--label','task B').stderr,/leased by 'task A'/);
  assert.equal(slot('release','--slot','1','--label','task A').status,0);
  assert.match(slot('status').stdout,/slot 1 .*: free/);
  // A slot root that is not the real slot path is refused before any git clean.
  const other=fs.mkdtempSync('/tmp/hbots-other-');
  try{
   git(repo,'worktree','add','-q','--detach',path.join(other,'hbots-slot-1'),'main');
   fs.writeFileSync(path.join(other,'hbots-slot-1','keep.txt'),'mine\n');
   const bad=run('bash',[path.join(here,'hbots-slot.sh'),'lease','--label','x'],{env:{...env,HBOTS_SLOT_ROOT:other,HBOTS_SLOT_STATE:path.join(other,'state')}});
   assert.equal(bad.status,1);assert.match(bad.stderr,/not a release slot path/);
   assert.ok(fs.existsSync(path.join(other,'hbots-slot-1','keep.txt')));
  }finally{git(repo,'worktree','remove','--force',path.join(other,'hbots-slot-1'));fs.rmSync(other,{recursive:true,force:true});}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('the finisher releases the slot lease once trunk is pushed, and keeps it when the push fails',()=>{
 const root=fs.mkdtempSync('/tmp/hbots-slot-test.');
 try{
  const repo=path.join(root,'repo'),origin=path.join(root,'origin.git'),wt=path.join(root,'wt'),runDir=path.join(root,'run'),out=path.join(root,'out'),qa=path.join(root,'qa'),state=path.join(root,'state');
  for(const d of [runDir,out,qa])fs.mkdirSync(d,{recursive:true});
  const git=(cwd,...args)=>{const r=run('git',['-C',cwd,'-c','user.email=t@t','-c','user.name=t',...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  run('git',['init','-q','--bare','-b','main',origin]);
  fs.mkdirSync(repo);git(repo,'init','-q','-b','main');git(repo,'remote','add','origin',origin);
  fs.writeFileSync(path.join(repo,'a.txt'),'one\n');git(repo,'add','.');git(repo,'commit','-qm','one');git(repo,'push','-q','origin','main');
  const env={...process.env,HOME:root,HBOTS_SLOT_ROOT:wt,HBOTS_SLOT_REPO:repo,HBOTS_SLOT_STATE:state,HBOTS_SLOT_TEST:'1',
   HBOTS_FINISH_TOOLS:here,HBOTS_FINISH_RUN_DIR:runDir,HBOTS_FINISH_LOG_DIR:runDir,HBOTS_FINISH_URL:'http://127.0.0.1:9'};
  const slot=(...args)=>run('bash',[path.join(here,'hbots-slot.sh'),...args],{env});
  const s1=path.join(wt,'hbots-slot-1');
  git(repo,'worktree','add','-q','--detach',s1,'HEAD');git(repo,'worktree','add','-q','--detach',path.join(wt,'hbots-slot-2'),'HEAD');
  const finish=(version)=>{
   assert.equal(slot('lease','--slot','1','--label','ship '+version).status,0);
   assert.equal(slot('switch','--slot','1','--label','ship '+version,'--branch','release/'+version,'--from','main').status,0);
   fs.mkdirSync(path.join(s1,'scripts/personal'),{recursive:true});fs.writeFileSync(path.join(s1,'scripts/personal/app-version.txt'),version+'\n');
   git(s1,'add','-A');git(s1,'commit','-qm','release '+version);const sha=git(s1,'rev-parse','HEAD');
   fs.writeFileSync(path.join(runDir,`restart-${version}-result.json`),JSON.stringify({status:'live_verified',release:sha.slice(0,12),rollback:'a'.repeat(12)}));
   const r=run('bash',[path.join(here,'hbots-release-finish.sh'),'--run','--server-only','--version',version,'--release',sha.slice(0,12),'--main-sha',sha,
    '--worktree',s1,'--qa-dir',qa,'--repo',repo,'--trunk','main','--out',out,'--node',process.execPath,'--no-livecheck','--timeout-sec','30'],{env,timeout:60000});
   return {r,sha,log:fs.readFileSync(path.join(qa,'finish.log'),'utf8'),record:fs.readFileSync(path.join(qa,'LIVE-RECORD.md'),'utf8')};
  };
  // Pushed: the finisher releases the lease itself and keeps the slot.
  const a=finish('9.9.1');
  assert.equal(a.r.status,0,a.log);
  assert.equal(git(origin,'rev-parse','main'),a.sha,'trunk pushed');
  assert.match(a.log,/release slot 1, lease label 'ship 9\.9\.1'/);
  assert.match(a.log,/lease 'ship 9\.9\.1' released/);
  assert.match(a.record,/Worktree removed:\*\* slot \(lease released\)/);
  assert.match(slot('status').stdout,/slot 1 .*: free/);
  assert.ok(fs.existsSync(s1),'the slot itself is kept');
  // The push fails: the slot keeps its lease for the ship task to look at.
  git(repo,'remote','set-url','origin',path.join(root,'missing.git'));
  const b=finish('9.9.2');
  assert.notEqual(b.r.status,0);
  assert.match(b.log,/lease 'ship 9\.9\.2' kept: published=skipped ffmain=no/);
  assert.match(slot('status').stdout,/slot 1 .*: leased by "ship 9\.9\.2"/);
 }finally{
  run('git',['-C',path.join(root,'repo'),'worktree','remove','--force',path.join(root,'wt','hbots-slot-1')]);
  run('git',['-C',path.join(root,'repo'),'worktree','remove','--force',path.join(root,'wt','hbots-slot-2')]);
  fs.rmSync(root,{recursive:true,force:true});
 }
});
test('the background arm64 build starts once its trigger gates pass, and is stopped when a gate fails',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-gate-bg-'));
 try{
  const repo=path.join(root,'repo'),releases=path.join(root,'releases'),src=path.join(repo,'apps/server/src/personal/bg');
  fs.mkdirSync(src,{recursive:true});installScope(repo);
  const git=(...args)=>{const r=run('git',['-C',repo,...args]);assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(src,'core.ts'),'export const core=1;\n');fs.writeFileSync(path.join(src,'core.test.ts'),"import {core} from './core.ts';\ncore;\n");
  git('add','-A');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  fs.writeFileSync(path.join(src,'core.ts'),'export const core=2;\n');git('add','-A');git('commit','-qm','change');
  const sha=git('rev-parse','HEAD'),release=sha.slice(0,12),dir=path.join(releases,release);
  fs.mkdirSync(path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'dist/bin.mjs'),'fixture artifact');
  fs.writeFileSync(path.join(dir,'VERSION'),`version=1.2.3\nsha=${release}\ndirty=false\n`);
  fs.writeFileSync(path.join(releases,'current.txt'),`${base.slice(0,12)}\n`);
  const fixture=path.join(root,'command.mjs'),failFlag=path.join(root,'server-tsc-fails'),order=path.join(root,'order');
  fs.writeFileSync(fixture,`import fs from 'node:fs';
const kind=process.argv[2];
fs.appendFileSync(${JSON.stringify(order)},'gate '+kind+'\\n');
if(kind==='e2e') console.log(JSON.stringify({failed:0,journeys:(process.argv[3]||'j0').split(',').map(id=>({id,ok:true}))}));
else if(kind==='server-tsc'){await new Promise(r=>setTimeout(r,1500));if(fs.existsSync(${JSON.stringify(failFlag)})){console.log('error TS1');process.exit(2)}}
else console.log('Tests 1 passed (1)');`);
  const defs=withExtra(Object.entries({'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'}).map(([id,kind])=>({id,kind,cwd:id==='server-tests'?'apps/server':'.',commands:[`node '${fixture}' ${id}${id==='e2e'||id==='server-tests'?' {args}':''}`]})),id=>`node '${fixture}' ${id}`);
  const defFile=path.join(root,'gates.json');fs.writeFileSync(defFile,JSON.stringify(defs));
  const args=['--version','1.2.3','--release',release,'--repo-root',repo,'--releases-dir',releases,'--gates-json',defFile,'--skip-notes'];
  const env=(build)=>jobEnv(lockBase(),{GATE_MEM_RESERVE_MB:'0',GATE_SKIP_PREFLIGHT:'1',GATE_ANDROID_BUILD:build,GATE_ANDROID_BUILD_AFTER:'preflight,server-tests'});
  const bgJson=()=>JSON.parse(fs.readFileSync(path.join(dir,'gate-evidence-logs','android-build.json'),'utf8'));
  // Pass: the build starts after its trigger gate passed (hbots-mobile by default; server-tests here, which this diff runs) and the run waits for it.
  const ok=node('gate-evidence.mjs',args,{env:env(`echo build >> '${order}'; sleep 1; echo apk-sha256=abc`),timeout:60000});
  assert.equal(ok.status,0,ok.stdout+ok.stderr);
  const lines=fs.readFileSync(order,'utf8').trim().split('\n');
  assert.ok(lines.indexOf('build')>lines.indexOf('gate server-tests'),lines.join(' | '));
  assert.equal(bgJson().state,'pass');
  assert.match(ok.stdout,/^arm64 build \(background\): PASS \(exit 0, \d+ s\)/m);
  assert.match(ok.stdout,/^ {2}arm64 build \(bg\) +android .* PASS +\|/m);
  assert.match(fs.readFileSync(path.join(dir,'gate-evidence-logs','android-build.log'),'utf8'),/apk-sha256=abc/);
  // Fail: server-tsc fails while the build runs; the build is stopped, not waited out.
  fs.writeFileSync(failFlag,'1');fs.rmSync(order);
  const started=Date.now();
  const bad=node('gate-evidence.mjs',args,{env:env(`echo $$ > '${path.join(root,'bg.pid')}'; exec sleep 60`),timeout:60000});
  assert.notEqual(bad.status,0);
  assert.ok(Date.now()-started<30000,'the build was not waited out: '+bad.stdout.slice(-1500));
  assert.match(bad.stdout,/^arm64 build \(background\): stopping it, gate server-tsc failed$/m);
  assert.equal(bgJson().state,'killed');
  const pid=Number(fs.readFileSync(path.join(root,'bg.pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),'the build process is gone');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
