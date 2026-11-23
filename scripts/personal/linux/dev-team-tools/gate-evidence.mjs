#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {options,git,hash,gatePass,validate,gateScopeOf,gateScopeModule,gateDefsOf,treeState,treeChange,resolveCommit} from './gate-common.mjs';
let v;
try {v=options()} catch(e){console.error(e.message);process.exit(2)}
const here=path.dirname(fileURLToPath(import.meta.url));
// The phone harness must be supplied until its PowerShell server control is ported.
// No evidence can pass by silently omitting this gate.
const loadGates=(baseSha,headSha)=>{
  if(!v['gates-json'])throw new Error('--gates-json FILE required: supply Linux gate commands including phone e2e; the legacy default harness requires PowerShell');
  const {defs,notes}=gateDefsOf(v,baseSha,headSha);
  const validCommands=(commands)=>Array.isArray(commands)&&commands.length>0&&commands.every(c=>typeof c==='string'&&c.trim());
  if(!Array.isArray(defs)||defs.some(d=>!/^[-a-z0-9]+$/.test(d.id)||!(validCommands(d.commands)||(Array.isArray(d.concurrent)&&d.concurrent.length>0&&d.concurrent.every(validCommands)))||new Set(defs.map(d=>d.id)).size!==defs.length))throw new Error('Invalid gate definitions');
  const wanted=v.gates?v.gates.split(','):defs.map(d=>d.id);
  if(wanted.some(id=>!defs.some(d=>d.id===id)))throw new Error('Unknown gate selection');
  return {defs,wanted,gateChanges:notes};
};
// One entry per selected gate: skip with the planned reason, or run the planned
// mode and args.
const planOf=(defs,wanted,scope,{onlyPlanned=false}={})=>defs.filter(d=>wanted.includes(d.id)&&(!onlyPlanned||scope.plans.some(p=>p.id===d.id))).map(d=>{
  const plan=scope.plans.find(p=>p.id===d.id);
  if(!plan)throw new Error(`gate ${d.id} has no row in the gate scope registry`);
  return {def:d,plan};
});
// Fan-out (Harout's guard 5, 22 Nov 2026): a selected server-tests set over 100 files
// names the changed files that pulled it in, so a wide selection is never a mystery.
// Each changed path is planned alone with the repo's own selector; the slowest part is
// one cat-file batch, cached by the reader.
const FAN_OUT_LIMIT=100;
const FAN_OUT_CHILD=`
const [mod,repo,sha,paths]=[process.argv[1],process.argv[2],process.argv[3],JSON.parse(process.argv[4])];
const m=await import(mod);const reader=m.gitReader(repo,sha);
const rows=paths.map((file)=>({file,tests:m.selectServerTests({reader,changedPaths:[file]}).length})).filter(r=>r.tests>0).sort((a,b)=>b.tests-a.tests||(a.file<b.file?-1:1));
process.stdout.write(JSON.stringify(rows));`;
// Resolves to null or {limit, selected, byChangedFile}. A tree whose selector has the
// one-pass attribution answers in seconds; an older tree re-plans each changed path
// in a child process, so the gates do not wait for it.
const fanOutOf=(repo,sha,scope)=>{
  const plan=scope.plans.find(p=>p.id==='server-tests');
  if(plan?.mode!=='selected'||!(plan.args?.length>FAN_OUT_LIMIT))return Promise.resolve(null);
  const mod=path.join(repo,'scripts/personal/linux/hbots-release/lib/serverTestSelect.mjs');
  const wrap=(rows)=>({limit:FAN_OUT_LIMIT,selected:plan.args.length,byChangedFile:rows});
  return import(mod).then((m)=>{
    if(typeof m.selectServerTestsDetailed==='function')return wrap(m.selectServerTestsDetailed({reader:m.gitReader(repo,sha),changedPaths:scope.changedPaths}).fanOut);
    return new Promise((resolve)=>{
      const child=spawn(process.execPath,['--input-type=module','-e',FAN_OUT_CHILD,mod,repo,sha,JSON.stringify(scope.changedPaths)],{stdio:['ignore','pipe','ignore']});
      let out='';child.stdout.on('data',(d)=>{out+=d});
      child.once('error',()=>resolve(null));
      child.once('exit',()=>{try{resolve(wrap(JSON.parse(out)))}catch{resolve(null)}});
    });
  }).catch(()=>null);
};
const printFanOut=(fan)=>{
  if(!fan)return;
  console.log(`fan-out: server-tests selected ${fan.selected} files (over ${fan.limit}); changed files by the tests each one selects alone:`);
  for(const r of fan.byChangedFile.slice(0,10))console.log(`  ${String(r.tests).padStart(5)}  ${r.file}`);
  if(fan.byChangedFile.length>10)console.log(`  ... ${fan.byChangedFile.length-10} more changed files`);
};
const printPlan=(scope,plan,gateChanges)=>{
  console.log(`gate scope: ${scope.summary}`);
  for(const p of plan){
    const args=p.plan.mode==='selected'?` [${p.plan.args.length}]`:'';
    console.log(`${p.def.id}: ${p.plan.mode.toUpperCase()}${args} (${p.plan.reason})`);
  }
  // A changed test that no gate command runs: say so, so a plan never looks as if it ran it.
  for(const file of scope.notRun??[])console.log(`not run by any gate: ${file}`);
  for(const line of gateChanges)console.log(line);
};
// Tiers (Faster releases step 2). GATE_TIER=blocking writes the evidence the release
// waits for: deferred checks are recorded as "deferred" and run after the release with
// GATE_TIER=async, which writes gate-evidence-async.json beside it. A release the tree's
// planner will not tier (a DB migration, a toolchain change) runs everything, blocking.
const TIER=process.env.GATE_TIER||'full';
if(!['full','blocking','async'].includes(TIER)){console.error('GATE_TIER must be blocking or async');process.exit(2)}
const tierOf=(scope,head)=>{
  if(TIER==='full')return {tier:'full',scope};
  const m=gateScopeModule(v.repo);
  if(typeof m?.tierPlans!=='function')throw new Error(`GATE_TIER=${TIER}: this tree's gate planner has no tiers; run without GATE_TIER`);
  const split=m.tierPlans(scope,{reader:m.gitReader(v.repo,head)});
  if(!split.tiered)return {tier:TIER==='async'?'none':'full',scope,reason:split.reason};
  return {tier:TIER,scope:{...scope,plans:TIER==='blocking'?split.blocking:split.async},reason:split.reason};
};
// Release track (Faster releases step 3): a release that changes nothing the phone app is
// built from skips the APK builds, the emulator QA and the latest.json publish.
const trackOf=(scope,head)=>{
  const m=gateScopeModule(v.repo);
  if(typeof m?.releaseTrack!=='function')return null;
  try{return m.releaseTrack({changedPaths:scope.changedPaths,reader:m.gitReader(v.repo,head),baseReader:m.gitReader(v.repo,scope.baseSha)})}
  catch(e){return {track:'full',reason:`cannot decide the track: ${e.message}`}}
};
const printTrack=(t)=>{
  if(!t)return;
  const stage=(name)=>`${t.track==='server-only'?'SKIP':'RUN '} ${name}`;
  console.log(`release track: ${t.track} (${t.reason})`);
  for(const name of ['x86 QA APK build','arm64 release APK build','emulator QA','latest.json publish'])console.log(`  ${stage(name)}`);
};
const printTier=(t)=>{
  if(TIER==='full')return;
  if(t.tier==='none')console.log(`async tier: nothing runs after the release (${t.reason})`);
  else if(t.tier==='full')console.log(`tier: not tiered, every check blocks (${t.reason})`);
  else console.log(`tier: ${t.tier} (${t.reason})`);
};
// --dry-run prints what the gate would run for the release against the live one,
// without the heavy-job lock, a staged release or running anything. --head plans
// the same diff with the files of another commit, for replaying an old release.
if(v['dry-run']){
  try {
    const releaseSha=resolveCommit(v.repo,v.release);
    if(!releaseSha)throw new Error(`release ${v.release} is not a commit in ${v.repo}`);
    const head=resolveCommit(v.repo,v.head??v.release);
    if(!head)throw new Error(`head ${v.head} is not a commit in ${v.repo}`);
    const fullScope=gateScopeOf(v,head,releaseSha);
    const t=tierOf(fullScope,head);printTier(t);
    if(t.tier==='none'){console.log('dry run: 0 gates would run after the release');process.exit(0)}
    const scope=t.scope;
    const {defs,wanted,gateChanges}=loadGates(scope.baseSha,head);
    const plan=planOf(defs,wanted,scope,{onlyPlanned:t.tier==='async'});
    printPlan(scope,plan,gateChanges);
    printFanOut(await fanOutOf(v.repo,head,scope));
    printTrack(trackOf(fullScope,head));
    console.log(`dry run: ${plan.filter(p=>p.plan.mode!=='skip'&&p.plan.mode!=='deferred').length} of ${plan.length} gates would run${t.tier==='full'?'':` (${t.tier} tier)`} (base ${scope.baseSha?.slice(0,12)??'none'}, release ${releaseSha.slice(0,12)}, files ${head.slice(0,12)})`);
    process.exit(0);
  } catch(e){console.error(`FAIL: ${e.message}`);process.exit(2)}
}
const MAIN_LOCK=`${process.env.HEAVY_JOB_BASE||'/home/harout/.personal-bots/run/omarchy-heavy'}.lock`;
// Gradle and the emulator share one exclusive Android lane (Harout's guard 4); the
// heavy-job android lane takes the same file.
const ANDROID_LOCK=`${process.env.HEAVY_JOB_BASE||'/home/harout/.personal-bots/run/omarchy-heavy'}-android.lock`;
const linkOf=(fd)=>{try{return fs.readlinkSync(`/proc/self/fd/${fd}`)}catch{return null}};
const holdsGate=()=>linkOf(8)===MAIN_LOCK||linkOf(9)===MAIN_LOCK;
if(process.env.HBOTS_HEAVY_JOB_HELD!=='1' || !holdsGate()) {
  // The gates run side by side inside one heavy-job scope, so the scope gets room for
  // them: 14G soft, 16G hard, and almost no swap (the laptop may have a RAM fault, and
  // a swapping gate is slower than a serial one). The caller's own values win.
  const env={...process.env};
  env.HEAVY_JOB_MEMORY_HIGH??='14G';
  env.HEAVY_JOB_MEMORY_MAX??='16G';
  env.HEAVY_JOB_SWAP_MAX??='1G';
  // A hard CPU cap at the scheduler's budget, so vitest worker pools cannot take the box.
  // Computed here, outside the scope: inside it Node reads the cgroup quota as the core
  // count (7 of 12), and 60% of that would be a budget of 4.
  const cores=os.cpus().length,budget=Number(process.env.GATE_CPU_BUDGET)||Math.max(1,Math.floor(cores*0.6));
  env.HEAVY_JOB_CPU_QUOTA??=`${budget*100}%`;
  env.GATE_CPU_BUDGET=String(budget);
  env.GATE_HOST_CORES=String(cores);
  const r=spawnSync('bash',[path.join(here,'heavy-job.sh'),'--label',`gate evidence ${v.release}`,'--',process.execPath,fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit',env});
  process.exit(r.status??1);
}
// The browser revision the server's pinned playwright-core needs. The shared
// ~/.cache/ms-playwright holds a newer one and fails server-tests (1.67.17).
const GATE_BROWSERS='/home/harout/Claude/AI/dev-team/tools/pw-browsers';
const ANDROID_SDK='/home/harout/Android/Sdk';
// Gate commands must not see the live app environment the bot shell carries.
// Each gate gets its own TMPDIR on /tmp (tmpfs, not on the server tests' deny
// list, not a git-ignored worktree folder: 1.67.5 and 1.67.19), removed after it.
const gateEnv=(cwd,tmp)=>{
  const env={};
  for(const [key,value] of Object.entries(process.env)) if(!/^(?:T3CODE_|PERSONAL_|DSH_|PB_SECRET_)/.test(key)) env[key]=value;
  env.PATH=`${cwd}/node_modules/.bin:${v.repo}/node_modules/.bin:${process.env.PATH}`;
  env.NO_COLOR='1';
  env.TMPDIR=tmp;
  env.PLAYWRIGHT_BROWSERS_PATH=process.env.PLAYWRIGHT_BROWSERS_PATH||GATE_BROWSERS;
  // A fresh slot has no android/local.properties: Gradle then needs ANDROID_HOME.
  if(!env.ANDROID_HOME&&fs.existsSync(ANDROID_SDK))env.ANDROID_HOME=ANDROID_SDK;
  return env;
};
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&!fs.existsSync(GATE_BROWSERS)) console.warn(`warning: the pinned test browser folder ${GATE_BROWSERS} is missing`);

// ---- Scheduler (Faster releases step 1, 22 Nov 2026) -----------------------------
// Gates used to run one after another (23 min for 1.67.49). Now every gate is split
// into jobs (a command list each) and jobs start while they fit a CPU budget of about
// 60% of the cores and the RAM left above a reserve for the live server. A rise in
// swap (more than GATE_SWAP_BACKOFF_MB in the last 30 s) stops new starts until it settles; with nothing running the next job always
// starts, so a busy machine degrades to the old serial order instead of stalling.
const CORES=Number(process.env.GATE_HOST_CORES)||os.cpus().length;
const intEnv=(name,fallback,min=0)=>{const n=Number(process.env[name]);return Number.isInteger(n)&&n>=min?n:fallback};
const CPU_BUDGET=intEnv('GATE_CPU_BUDGET',Math.max(1,Math.floor(CORES*0.6)),1);
const MEM_RESERVE_MB=intEnv('GATE_MEM_RESERVE_MB',6144);
const SWAP_BACKOFF_MB=intEnv('GATE_SWAP_BACKOFF_MB',512);
const SWAP_WINDOW_MS=30_000;
const SERVER_LANES=intEnv('GATE_SERVER_LANES',4,1);
const FAIL_FAST=process.env.GATE_FAIL_FAST==='1';
// Retry a failed job once: on by default in the async tier, off before the release.
const RETRY=(process.env.GATE_RETRY??(process.env.GATE_TIER==='async'?'1':'0'))==='1';
// Rough cost per job, from the 1.67.49 and 1.67.50 runs: vitest without file
// parallelism is one core; tsc is one core and the most memory; the vitest packages
// with worker pools take three. Unknown gates count as one core and 1 GB.
const COST={
  'server-tests':{cpu:1,mem:2048},
  e2e:{cpu:2,mem:2560},
  'web-tests':{cpu:3,mem:2048},
  'hbots-mobile':{cpu:3,mem:2048},
  'hbots-mobile-kotlin':{cpu:2,mem:3072,android:true},
  'server-tsc':{cpu:1,mem:3072},
  'web-tsc':{cpu:1,mem:2048},
  'personal-client':{cpu:1,mem:1536},
  'release-tools':{cpu:1,mem:1024},
  parity:{cpu:1,mem:1024},
};
const costOf=(id)=>COST[id]??{cpu:1,mem:1024};
// Longest single jobs first, so the critical path starts at once; the server-tests
// chunks fill the gaps; the short whole gates come last.
const PRIORITY=['e2e','release-tools','hbots-mobile-kotlin','server-tests','web-tests','hbots-mobile','server-tsc','personal-client','web-tsc','parity'];
const rank=(id)=>{const i=PRIORITY.indexOf(id);return i===-1?PRIORITY.length:i};
const meminfo=()=>{
  const out={};
  try{for(const line of fs.readFileSync('/proc/meminfo','utf8').split('\n')){const m=/^(\w+):\s+(\d+)/.exec(line);if(m)out[m[1]]=Number(m[2])/1024}}catch{}
  return {availMb:out.MemAvailable??Infinity,swapUsedMb:(out.SwapTotal??0)-(out.SwapFree??0)};
};
const loadavg=()=>os.loadavg()[0];

// Server-tests chunks. One vitest process runs one file at a time (fileParallelism is
// off for load-sensitive flakes), so 526 selected files took 884 s in two lanes. A
// selected set is cut into chunks balanced by the recorded weights, and up to
// GATE_SERVER_LANES chunks run at once. The plan's args are unchanged: the union of
// the chunks is exactly the planned list, which is what the seal checks.
const readJson=(file)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}};
const isolatedOf=(repo)=>{try{return fs.readFileSync(path.join(repo,'scripts/personal/node/server-isolated-tests.txt'),'utf8').split('\n').map(l=>l.replace(/#.*/,'').trim()).filter(Boolean)}catch{return []}};
function chunkServerTests(args,{weights={},isolated=[],lanes=SERVER_LANES}={}){
  const n=args.length;
  if(n<=30||lanes<=1)return [args];
  const target=Math.min(40,Math.max(lanes,lanes*3,Math.ceil(n/60)));
  const count=Math.max(1,Math.min(target,Math.floor(n/8)));
  const weightOf=(file)=>Number(weights[`src/${file.replace(/^src\//,'')}`]??weights[file])||2;
  const iso=new Set(isolated);
  // A chunk of isolated files only would make the reuse run match nothing and fail,
  // so chunks are built from ordinary files and the isolated ones are added after.
  const plain=args.filter(f=>!iso.has(f)),alone=args.filter(f=>iso.has(f));
  if(plain.length===0)return [args];
  const bins=Array.from({length:Math.min(count,plain.length)},()=>({files:[],w:0}));
  const place=(file)=>{const bin=bins.reduce((a,b)=>b.w<a.w?b:a);bin.files.push(file);bin.w+=weightOf(file)};
  for(const file of [...plain].sort((a,b)=>weightOf(b)-weightOf(a)||(a<b?-1:1)))place(file);
  for(const file of [...alone].sort((a,b)=>weightOf(b)-weightOf(a)||(a<b?-1:1)))place(file);
  return bins.filter(b=>b.files.length).sort((a,b)=>b.w-a.w).map(b=>b.files.sort());
}
const GUARD_TOKEN=/^src\/\S+\.test\.ts$/;
// The always-run guard files ride the first chunk only; the preflight runs them too.
const stripGuards=(command)=>command.split(' ').filter(t=>!GUARD_TOKEN.test(t)).join(' ');
const shellArg=(value)=>/^[A-Za-z0-9_./:@=+-]+$/.test(value)?value:`'${value.replaceAll("'",`'\\''`)}'`;

try {
  const sha=git(v.repo,'rev-parse','HEAD'), dirty=()=>git(v.repo,'status','--porcelain','--untracked-files=no');
  const startDirty=dirty();
  const startState=treeState(v.repo);
  // A gate that commits, checks out or edits a tracked file makes every later result
  // worthless, so stop at the boundary instead of running the rest and failing at the end.
  const checkStable=(when)=>{
    const change=treeChange(v.repo,startState);
    if(!change)return;
    throw new Error(`the git tree or HEAD changed ${when} (${change}); aborted before the next gate. Restore ${sha.slice(0,12)} with a clean tree and rerun.`);
  };
  const staged=Object.fromEntries(fs.readFileSync(path.join(v.dir,'VERSION'),'utf8').trim().split(/\r?\n/).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));
  if(!sha.startsWith(v.release)||staged.version!==v.version||!sha.startsWith(staged.sha)||staged.dirty!=='false')throw new Error('Stage a clean matching commit/version first');
  const binHash=hash(path.join(v.dir,'dist/bin.mjs'));
  const fullScope=gateScopeOf(v,sha);
  const scopeModule=gateScopeModule(v.repo);
  const tierRun=tierOf(fullScope,sha);printTier(tierRun);
  if(tierRun.tier==='none'){console.log('PASS: nothing to run after the release');process.exit(0)}
  const scope=tierRun.scope;
  if(tierRun.tier==='async'){v.file=path.join(v.dir,'gate-evidence-async.json');v['skip-notes']=true}
  const {defs,wanted,gateChanges}=loadGates(scope.baseSha,sha);
  const plan=planOf(defs,wanted,scope,{onlyPlanned:tierRun.tier==='async'});
  printPlan(scope,plan,gateChanges);
  const track=trackOf(fullScope,sha);printTrack(track);
  // Logged when it is ready; it never holds the gates back.
  const fanOutPromise=fanOutOf(v.repo,sha,scope).then((fan)=>{printFanOut(fan);return fan});
  let kept=[];
  if(v.merge){const old=JSON.parse(fs.readFileSync(v.file,'utf8'));if(old.sha!==sha||old.treeClean!==true||old.binSha256!==binHash)throw new Error('Cannot merge evidence from different/dirty tree or artifact');kept=old.gates.filter(g=>!wanted.includes(g.id))}
  const logDir=path.join(v.dir,tierRun.tier==='async'?'gate-evidence-async-logs':'gate-evidence-logs');fs.mkdirSync(logDir,{recursive:true});
  const startedAt=new Date().toISOString(),t0=Date.now(),gates=[...kept],results=new Map();
  const notRunNow=(p)=>p.plan.mode==='skip'||p.plan.mode==='deferred';
  const skipped=new Map(plan.filter(notRunNow).map(p=>[p.def.id,{id:p.def.id,kind:p.def.kind,title:p.def.title??p.def.id,cwd:p.def.cwd??'.',mode:p.plan.mode,...(p.plan.mode==='deferred'?{deferredMode:p.plan.deferredMode}:{}),reason:p.plan.reason,baseSha:scope.baseSha,changedPaths:scope.changedPaths,seconds:0,commands:[]}]));
  const toRun=plan.filter(p=>!notRunNow(p));
  const weights=readJson(path.join(v.repo,'apps/server/src/testUtils/shardWeights.json'))??{};
  const isolated=isolatedOf(v.repo);

  // Jobs per gate. A job is a command list run in order; the gate's jobs run in parallel.
  const jobsOf=(p)=>{
    const lanes=scopeModule.commandsFor(p.plan,p.def);
    if(p.def.id!=='server-tests')return lanes;
    const template=String((p.def.commands??[])[0]??'');
    if(p.plan.mode==='selected'&&template.includes('{args}')&&lanes.length>0){
      const chunks=chunkServerTests(p.plan.args,{weights,isolated});
      if(chunks.length<=1)return lanes;
      return chunks.map((files,i)=>[(i===0?template:stripGuards(template)).replaceAll('{args}',files.map(shellArg).join(' '))]);
    }
    // A whole run keeps its shard commands, cut into SERVER_LANES shards instead of two.
    if(p.plan.mode==='whole'&&Array.isArray(p.def.concurrent)&&lanes.length===2&&lanes.every(l=>l.length===1&&/--shard=\d+\/2\b/.test(l[0]))&&SERVER_LANES>2){
      return Array.from({length:SERVER_LANES},(_,i)=>[(i===0?lanes[0][0]:lanes[1][0]).replace(/--shard=\d+\/2\b/,`--shard=${i+1}/${SERVER_LANES}`)]);
    }
    return lanes;
  };

  const children=new Set();
  const killAll=(signal='SIGTERM')=>{for(const child of children){try{process.kill(-child.pid,signal)}catch{}}};
  // A gate can leave a process outside its own group (the 1.67.49 replay left an e2e
  // throwaway server and ten watchdog shells alive after the run was stopped). Inside the
  // collector's own heavy-job scope every other process was started by this run, so the
  // sweep stops whatever is left there, never anything outside it.
  const ownScope=()=>{try{return fs.readFileSync('/proc/self/cgroup','utf8').match(/\/(heavy-job-\d+\.scope)$/m)?.[1]??null}catch{return null}};
  let onStop=()=>{};
  const sweepScope=(why)=>{
    let rel='';
    try{rel=fs.readFileSync('/proc/self/cgroup','utf8').trim().split('\n').pop().split('::').pop()}catch{}
    if(!/\/heavy-job-\d+\.scope$/.test(rel))return 0;
    let pids=[];
    try{pids=fs.readFileSync(`/sys/fs/cgroup${rel}/cgroup.procs`,'utf8').split('\n').map(Number).filter(Boolean)}catch{return 0}
    const keep=new Set([process.pid,process.ppid]);
    const left=pids.filter((pid)=>!keep.has(pid));
    for(const pid of left){try{process.kill(pid,'SIGTERM')}catch{}}
    if(left.length)console.log(`scope sweep (${why}): stopped ${left.length} leftover process${left.length===1?'':'es'}`);
    return left.length;
  };
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{killAll();onStop();sweepScope(signal);process.exit(130)});
  const runJob=(job)=>new Promise((resolve)=>{
    const fd=fs.openSync(job.log,'w');
    const stdio=['ignore',fd,fd,'ignore','ignore','ignore','ignore','ignore','ignore','ignore'];
    if(linkOf(8)!==null) stdio[8]=8;
    if(linkOf(9)!==null) stdio[9]=9;
    const done=[];
    const next=(index)=>{
      if(index>=job.commands.length||job.aborted){fs.closeSync(fd);return resolve(done)}
      const command=job.commands[index];
      // The Android lane: Gradle waits for the emulator and other Gradle builds.
      const argv=job.android?['flock','-w','10800',ANDROID_LOCK,'bash','-o','pipefail','-c',command]:['bash','-o','pipefail','-c',command];
      const child=spawn(argv[0],argv.slice(1),{cwd:job.cwd,env:job.env,stdio,detached:true});
      children.add(child);
      let settled=false;
      const finish=(code)=>{if(settled)return;settled=true;children.delete(child);done.push({command,exit:code});next(index+1)};
      child.once('error',()=>finish(1));
      child.once('exit',(code)=>finish(code??1));
    };
    next(0);
  });

  // Build every job up front so the scheduler sees the whole queue.
  const gateRuns=new Map();
  const queue=[];
  for(const p of toRun){
    const d=p.def,cwd=path.resolve(v.repo,(d.cwd??'.').replaceAll('\\','/'));
    const probeEnv=gateEnv(cwd,os.tmpdir());
    // The repo root holds another vite-plus copy; letting it win mixes two vitest instances in one run.
    const ownVp=path.join(cwd,'node_modules/.bin/vp');
    if(fs.existsSync(ownVp)){
      const found=path.resolve(spawnSync('bash',['-c','command -v vp'],{cwd,env:probeEnv,encoding:'utf8'}).stdout.trim()||'.');
      if(found!==ownVp)throw new Error(`${d.id}: vp resolves to ${found}, expected ${ownVp}`);
    }
    const lanes=jobsOf(p),cost=costOf(d.id);
    const run={p,cwd,jobs:[],left:lanes.length,started:null,finished:null};
    gateRuns.set(d.id,run);
    lanes.forEach((commands,i)=>{
      const job={gate:d.id,index:i,commands,cwd,cpu:cost.cpu,mem:cost.mem,android:!!cost.android,
        log:lanes.length===1?path.join(logDir,`${d.id}.log`):path.join(logDir,`${d.id}.${i+1}.log`),
        needsPreflight:d.id==='server-tests',started:null,finished:null,result:null};
      run.jobs.push(job);queue.push(job);
    });
  }
  // Order by how long each gate took in the live release's own evidence (per lane for
  // server-tests), longest first, so the critical path starts at once; the fixed
  // PRIORITY list breaks ties and covers a gate the last evidence does not have.
  const lastSeconds=new Map();
  try{
    const prior=JSON.parse(fs.readFileSync(path.join(path.dirname(v.dir),scope.baseSha.slice(0,12),'gate-evidence.json'),'utf8'));
    // A selected gate scales by how many files or journeys it runs now against then.
    const nowArgs=new Map(plan.map(p=>[p.def.id,p.plan.mode==='selected'?p.plan.args?.length:null]));
    for(const g of prior.gates??[]){
      if(!(Number(g.seconds)>0))continue;
      const then=g.mode==='selected'?g.args?.length:null, now=nowArgs.get(g.id);
      lastSeconds.set(g.id,Number(g.seconds)*(then>0&&now>0?now/then:1));
    }
  }catch{}
  const lanesOf=(gate)=>gate==='server-tests'?Math.min(SERVER_LANES,queue.filter(j=>j.gate===gate).length||1):1;
  const expected=(gate)=>(lastSeconds.get(gate)??0)/lanesOf(gate);
  const keys=new Map([...new Set(queue.map(j=>j.gate))].map(g=>[g,expected(g)]));
  queue.sort((a,b)=>keys.get(b.gate)-keys.get(a.gate)||rank(a.gate)-rank(b.gate)||a.index-b.index);
  if(lastSeconds.size)console.log(`order: ${[...keys].sort((a,b)=>b[1]-a[1]).map(([g,sec])=>`${g} ${sec.toFixed(0)} s`).join(', ')} (from the live release's evidence)`);

  // Preflight (Opusito, 22 Nov, 1.67.49). server-tests always runs a few guard files
  // (context budgets, migration registry, instruction coverage). A grown budget used to
  // show up only after a 30-minute run. They run first, about a minute, beside the other
  // gates; server-tests waits for them and a failure stops everything.
  // GATE_SKIP_PREFLIGHT=1 turns it off.
  const serverTests=toRun.find(p=>p.def.id==='server-tests');
  let preflight={state:'none'};
  if(serverTests&&process.env.GATE_SKIP_PREFLIGHT!=='1'&&tierRun.tier!=='async'){
    const def=serverTests.def, first=String((def.commands??[])[0]??'');
    const guards=first.split(/\s+/).filter(t=>GUARD_TOKEN.test(t));
    if(guards.length&&first.includes('{args}')){
      const cwd=path.resolve(v.repo,(def.cwd??'.').replaceAll('\\','/'));
      const job={gate:'preflight',index:0,commands:[first.replace('{args}','')],cwd,cpu:1,mem:2048,android:false,log:path.join(logDir,'preflight-server-guards.log'),started:null,finished:null,result:null,preflight:true};
      console.log(`preflight: ${guards.length} always-run server guard tests`);
      preflight={state:'pending',job,guards:guards.length};
      queue.unshift(job);
    }
  }

  checkStable('before the gates');
  const memStart=meminfo();
  const samples={minAvailMb:memStart.availMb,maxSwapDeltaMb:0,maxLoad:loadavg(),maxCpuInUse:0};
  let cpuInUse=0,memInUse=0,running=0,abortError=null,swapPaused=false;
  const at=()=>(Date.now()-t0)/1000;
  // Swap that was used once stays used, so the back-off reads recent growth: the
  // rise over the last 30 s, not the rise since the run began (1.67.49 replay: a
  // start-relative test held every job back for minutes after swap had settled).
  const swapSeen=[];
  const recentSwapGrowth=(m)=>{
    const now=Date.now();
    while(swapSeen.length&&now-swapSeen[0].t>SWAP_WINDOW_MS)swapSeen.shift();
    const low=Math.min(m.swapUsedMb,...swapSeen.map(x=>x.mb));
    return m.swapUsedMb-low;
  };
  const sample=()=>{
    const m=meminfo();
    swapSeen.push({t:Date.now(),mb:m.swapUsedMb});
    samples.minAvailMb=Math.min(samples.minAvailMb,m.availMb);
    samples.maxSwapDeltaMb=Math.max(samples.maxSwapDeltaMb,m.swapUsedMb-memStart.swapUsedMb);
    samples.maxLoad=Math.max(samples.maxLoad,loadavg());
    return m;
  };
  const sampler=setInterval(sample,2000);sampler.unref();
  // Background arm64 build (Faster releases step 4). GATE_ANDROID_BUILD is a shell command
  // (normally build-android.sh under heavy-job --lane android) started from the repo root
  // once the gates in GATE_ANDROID_BUILD_AFTER pass (default: preflight and hbots-mobile), so
  // the APK builds while the slower gates run. Any failed gate stops it at once (its process
  // group, and the heavy-job scope it moved into). It never changes the evidence: its result
  // goes to android-build.json and a line under the waterfall.
  const bg={command:process.env.GATE_ANDROID_BUILD||'',after:(process.env.GATE_ANDROID_BUILD_AFTER||'preflight,hbots-mobile').split(',').map(x=>x.trim()).filter(Boolean),state:'off'};
  if(bg.command&&tierRun.tier!=='async'){bg.state='waiting';bg.log=path.join(logDir,'android-build.log')}
  const anyFailed=()=>preflight.state==='fail'||[...results.values()].some(g=>!gatePass(g));
  const bgReady=()=>bg.after.every(id=>{
    if(id==='preflight')return preflight.state==='pass'||preflight.state==='none';
    if(!toRun.some(p=>p.def.id===id))return true;
    const g=results.get(id);return Boolean(g&&gatePass(g));
  });
  const bgScope=()=>{try{const m=fs.readFileSync(`/proc/${bg.pid}/cgroup`,'utf8').match(/\/(heavy-job-\d+\.scope)$/m);return m&&m[1]!==ownScope()?m[1]:null}catch{return null}};
  const bgStart=()=>{
    bg.state='running';bg.started=Date.now();bg.startOffset=at();
    const tmp=fs.mkdtempSync('/tmp/hbots-gate-');bg.tmp=tmp;
    const fd=fs.openSync(bg.log,'w');
    const child=spawn('bash',['-o','pipefail','-c',bg.command],{cwd:v.repo,env:gateEnv(v.repo,tmp),detached:true,stdio:['ignore',fd,fd]});
    fs.closeSync(fd);
    bg.pid=child.pid;
    bg.done=new Promise(res=>child.on('exit',(code,signal)=>{
      bg.exit=code??(signal?128:1);bg.signal=signal;bg.seconds=(Date.now()-bg.started)/1000;
      if(bg.state==='running')bg.state=bg.exit===0?'pass':'fail';
      try{fs.rmSync(tmp,{recursive:true,force:true})}catch{}
      console.log(`arm64 build (background): ${bg.state.toUpperCase()} (exit ${bg.exit}, ${bg.seconds.toFixed(0)} s); log ${bg.log}`);
      res();
    }));
    setTimeout(()=>{if(bg.state==='running')bg.scope=bgScope()},3000).unref();
    console.log(`arm64 build (background): start at ${bg.startOffset.toFixed(0)} s after ${bg.after.join(' and ')} passed`);
  };
  const bgKill=(why)=>{
    if(bg.state==='waiting'){bg.state='not started';bg.reason=why;return}
    if(bg.state!=='running')return;
    bg.state='killed';bg.reason=why;
    const scope=bg.scope??bgScope();
    console.log(`arm64 build (background): stopping it, ${why}`);
    try{process.kill(-bg.pid,'SIGTERM')}catch{}
    if(scope)spawnSync('systemctl',['--user','stop',scope],{stdio:'ignore',timeout:30000});
  };
  onStop=()=>bgKill('the collector was stopped');
  const bgCheck=()=>{
    if(bg.state!=='waiting'&&bg.state!=='running')return;
    if(abortError)return bgKill(`the run is stopping (${abortError.message.split('\n')[0].slice(0,120)})`);
    if(anyFailed()){
      const failed=preflight.state==='fail'?'preflight':[...results.values()].find(g=>!gatePass(g))?.id;
      return bgKill(`gate ${failed} failed`);
    }
    if(bg.state==='waiting'&&bgReady())bgStart();
  };
  const finalizeGate=(run)=>{
    const d=run.p.def;
    const commands=run.jobs.flatMap(j=>j.result??[]);
    // One gate log, the job logs in order, so counts and readers see one file.
    const log=path.join(logDir,`${d.id}.log`);
    if(run.jobs.length>1){
      const parts=run.jobs.map(j=>`=== ${d.id} job ${j.index+1}/${run.jobs.length} (${((j.finished-j.started)/1000).toFixed(1)} s) ===\n${fs.existsSync(j.log)?fs.readFileSync(j.log,'utf8'):''}`);
      fs.writeFileSync(log,parts.join('\n'));
    }
    const text=fs.readFileSync(log,'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
    const g={id:d.id,kind:d.kind,title:d.title??d.id,cwd:d.cwd??'.',commands,exit:commands.find(c=>c.exit!==0)?.exit??0,seconds:(run.finished-run.started)/1000,log,
      timing:{startOffset:(run.started-t0)/1000,jobs:run.jobs.map(j=>({startOffset:(j.started-t0)/1000,seconds:(j.finished-j.started)/1000,commands:j.commands.length}))}};
    const retries=run.jobs.filter(j=>j.retryOf).map(j=>({job:j.index+1,firstAttempt:j.retryOf.commands,firstLog:j.retryOf.log,firstSeconds:j.retryOf.seconds}));
    if(retries.length)g.retries=retries;
    if(commands.length===0)g.exit=1;
    if(d.kind==='vitest'){
      const lines=text.split('\n').filter(l=>/^\s*Tests\s/.test(l));
      g.counts={passed:0,failed:0,skipped:0};
      for(const l of lines)for(const k of ['passed','failed','skipped'])g.counts[k]+=Number(l.match(new RegExp(`(\\d+)\\s+${k}`))?.[1]??0);
    } else if(d.kind==='e2e'){
      let summary={};for(const l of text.split('\n')){try{const x=JSON.parse(l);if(Array.isArray(x.journeys))summary=x}catch{}}
      g.journeys=summary.journeys??[];g.counts={journeys:g.journeys.length,passed:g.journeys.filter(j=>j.ok===true).length,failed:summary.failed??1};
    }
    results.set(d.id,g);
    console.log(`${g.id}: ${gatePass(g)?'PASS':'FAIL'} (exit ${g.exit}, ${g.seconds.toFixed(0)} s, ${run.jobs.length} job${run.jobs.length===1?'':'s'})`);
    if(!gatePass(g)&&FAIL_FAST&&!abortError)abortError=new Error(`${g.id} failed and GATE_FAIL_FAST=1; the other gates were stopped`);
  };
  await new Promise((resolveAll)=>{
    const runningOf=(gate)=>gateRuns.get(gate)?.jobs.filter(j=>j.started&&!j.finished).length??0;
    // 'ok', 'cpu' (try a smaller job behind it) or 'mem' (stop starting for now).
    // server-tests is the long pole and waits on preflight. While it waits, its lanes'
    // CPU is held back so shorter gates cannot fill the budget and start it late (the
    // 1.67.49 blocking replay: web-tests and hbots-mobile took 6 of 7 at 0 s).
    const heldForServer=()=>{
      if(preflight.state!=='pending')return 0;
      const waiting=queue.filter(j=>j.needsPreflight).reduce((n,j)=>n+j.cpu,0);
      return Math.min(waiting,SERVER_LANES,Math.max(0,CPU_BUDGET-2));
    };
    const fits=(job)=>{
      if(running===0)return 'ok';
      if(job.gate==='server-tests'&&runningOf('server-tests')>=SERVER_LANES)return 'cpu';
      if(cpuInUse+job.cpu>CPU_BUDGET-(job.needsPreflight?0:heldForServer()))return 'cpu';
      const m=sample();
      const grew=recentSwapGrowth(m);
      if(grew>SWAP_BACKOFF_MB){if(!swapPaused){swapPaused=true;console.log(`scheduler: swap grew ${grew.toFixed(0)} MB in the last 30 s; no new job starts until it settles`)}return 'mem'}
      if(swapPaused){swapPaused=false;console.log(`scheduler: swap settled at ${at().toFixed(0)} s; starting jobs again`)}
      // MemAvailable already counts the running jobs' pages as used, so only the new job's estimate is added.
      return m.availMb-job.mem>=MEM_RESERVE_MB?'ok':'mem';
    };
    // A job that waits on memory is retried when another job ends, or after 5 s.
    let retry=null;
    const pump=()=>{
      if(retry){clearTimeout(retry);retry=null}
      bgCheck();
      if(abortError){
        for(const job of queue)job.aborted=true;
        queue.length=0;
        if(running>0)killAll();
        if(running===0)return resolveAll();
        return;
      }
      for(let i=0;i<queue.length;){
        const job=queue[i];
        if(job.needsPreflight&&preflight.state==='pending'){i++;continue}
        const fit=fits(job);
        if(fit==='cpu'){i++;continue}
        if(fit==='mem')break;
        queue.splice(i,1);start(job);
      }
      if(running===0&&queue.length===0)return resolveAll();
      if(queue.length>0&&running>0){retry=setTimeout(pump,5000);retry.unref?.()}
    };
    const start=(job)=>{
      running++;cpuInUse+=job.cpu;memInUse+=job.mem;samples.maxCpuInUse=Math.max(samples.maxCpuInUse,cpuInUse);
      job.started=Date.now();
      console.log(`start ${job.gate}${job.preflight?'':` job ${job.index+1}`} at ${at().toFixed(0)} s (cpu ${cpuInUse}/${CPU_BUDGET}, ${running} running, MemAvailable ${Math.round(meminfo().availMb)} MB)`);
      const run=gateRuns.get(job.gate);
      if(run&&!run.started)run.started=job.started;
      const tmp=fs.mkdtempSync('/tmp/hbots-gate-');
      job.env=gateEnv(job.cwd,tmp);
      if(job.android){
        // Gradle heap and workers capped for the suspected RAM fault (guard 4).
        job.env.GRADLE_OPTS=[job.env.GRADLE_OPTS,'-Dorg.gradle.jvmargs=-Xmx2g','-Dorg.gradle.workers.max=2'].filter(Boolean).join(' ');
      }
      runJob(job).then((result)=>{
        job.finished=Date.now();job.result=result;
        running--;cpuInUse-=job.cpu;memInUse-=job.mem;
        try{fs.rmSync(tmp,{recursive:true,force:true})}catch(err){console.warn(`warning: could not remove ${tmp}: ${err.message}`)}
        try{checkStable(`after ${job.gate}`)}catch(err){abortError??=err}
        if(job.preflight){
          const ok=result.length>0&&result.every(c=>c.exit===0);
          preflight.state=ok?'pass':'fail';preflight.seconds=(job.finished-job.started)/1000;
          if(ok)console.log(`preflight: PASS (${preflight.seconds.toFixed(0)} s)`);
          else abortError??=new Error(`preflight: the always-run server guard tests fail (exit ${result.find(c=>c.exit!==0)?.exit??1}); see ${job.log}. Fix them before the full gate. Raising a context budget needs Harout's OK.`);
        } else if(run&&!job.aborted&&RETRY&&!job.retryOf&&!(result.length>0&&result.every(c=>c.exit===0))){
          // Async tier (Harout's guard 2): a failed job is run once more before anyone
          // is alerted or anything rolls back. Both attempts stay in the evidence.
          const first=`${job.log.replace(/\.log$/,'')}.try1.log`;
          try{fs.renameSync(job.log,first)}catch{}
          console.log(`retry ${job.gate} job ${job.index+1}: failed (exit ${result.find(c=>c.exit!==0)?.exit??1}); running it once more`);
          const again={...job,started:null,finished:null,result:null,retryOf:{log:first,commands:result,seconds:(job.finished-job.started)/1000}};
          run.jobs[run.jobs.indexOf(job)]=again;
          queue.unshift(again);
        } else if(run&&!job.aborted){
          run.left--;
          if(run.left===0){run.finished=job.finished;finalizeGate(run)}
        }
        pump();
      });
    };
    pump();
  });
  bgCheck();
  if(bg.state==='waiting')bgKill('its trigger gates did not all pass');
  if(bg.state==='running')console.log('arm64 build (background): the gates are done; waiting for the build');
  if(bg.done)await bg.done;
  if(bg.state!=='off')fs.writeFileSync(path.join(logDir,'android-build.json'),JSON.stringify({command:bg.command,after:bg.after,state:bg.state,reason:bg.reason??null,exit:bg.exit??null,startOffset:bg.startOffset??null,seconds:bg.seconds??null,scope:bg.scope??null,log:bg.log??null},null,2)+'\n');
  clearInterval(sampler);
  sweepScope('end of run');
  if(abortError)throw abortError;
  checkStable('after the gates');
  gates.push(...plan.map(p=>{
    const result=results.get(p.def.id)??skipped.get(p.def.id)??null;
    if(!result)return null;
    if(notRunNow(p))return result;
    return {
      ...result,
      mode:p.plan.mode,
      reason:p.plan.reason,
      baseSha:scope.baseSha,
      changedPaths:scope.changedPaths,
      ...(p.plan.mode==='selected'?{selector:p.plan.selector}:{}),
      ...(p.plan.args?{args:p.plan.args}:{}),
    };
  }).filter(Boolean));
  const fanOut=await fanOutPromise;
  const wallSeconds=(Date.now()-t0)/1000;
  // Timing waterfall: every gate's mode, start and length, printed, kept in the
  // evidence and in the notes, so each handoff and LIVE-RECORD can show it.
  const rows=plan.map(p=>{
    const g=results.get(p.def.id);
    return g?{id:p.def.id,mode:p.plan.mode,start:g.timing.startOffset,seconds:g.seconds,jobs:g.timing.jobs.length,pass:gatePass(g)}:{id:p.def.id,mode:p.plan.mode,start:0,seconds:0,jobs:0,pass:null};
  });
  if(preflight.state!=='none')rows.unshift({id:'preflight',mode:'guards',start:0,seconds:preflight.seconds??0,jobs:1,pass:preflight.state==='pass'});
  const serialSeconds=rows.reduce((s,r)=>s+r.seconds,0);
  const timing={wallSeconds,serialSeconds,cpuBudget:CPU_BUDGET,cores:CORES,serverLanes:SERVER_LANES,memReserveMb:MEM_RESERVE_MB,minMemAvailableMb:Math.round(samples.minAvailMb),maxSwapGrowthMb:Math.round(samples.maxSwapDeltaMb),maxLoad1:Number(samples.maxLoad.toFixed(1)),maxCpuInUse:samples.maxCpuInUse,rows};
  const bar=(r)=>{const scale=60/Math.max(wallSeconds,1);const a=Math.round(r.start*scale),b=Math.max(r.seconds>0?1:0,Math.round(r.seconds*scale));return ' '.repeat(a)+'#'.repeat(b)};
  const waterfall=[`gate timing: ${wallSeconds.toFixed(0)} s wall, ${serialSeconds.toFixed(0)} s if serial; budget ${CPU_BUDGET} of ${CORES} cores, server lanes ${SERVER_LANES}; min MemAvailable ${timing.minMemAvailableMb} MB, swap growth ${timing.maxSwapGrowthMb} MB, peak load ${timing.maxLoad1}`,
    ...rows.map(r=>`  ${r.id.padEnd(20)} ${r.mode.padEnd(8)} start ${r.start.toFixed(0).padStart(4)} s  ${r.seconds.toFixed(0).padStart(5)} s  ${String(r.jobs).padStart(2)} job${r.jobs===1?' ':'s'} ${r.mode==='skip'?'SKIP':r.mode==='deferred'?'DEFR':r.pass?'PASS':'FAIL'}  |${bar(r)}`)];
  if(bg.state!=='off'){
    const r={start:bg.startOffset??0,seconds:bg.seconds??0};
    waterfall.push(`  ${'arm64 build (bg)'.padEnd(20)} ${'android'.padEnd(8)} start ${r.start.toFixed(0).padStart(4)} s  ${r.seconds.toFixed(0).padStart(5)} s   1 job  ${({pass:'PASS',fail:'FAIL',killed:'KILL'})[bg.state]??'NONE'}  |${bar(r)}`);
    timing.androidBuild={state:bg.state,startOffset:bg.startOffset??null,seconds:bg.seconds??null};
  }
  console.log(waterfall.join('\n'));
  fs.writeFileSync(path.join(logDir,'waterfall.txt'),waterfall.join('\n')+'\n');
  const endDirty=dirty();
  const e={schema:1,version:v.version,release:v.release,sha,branch:git(v.repo,'branch','--show-current'),headAtStart:sha,headAtEnd:git(v.repo,'rev-parse','HEAD'),treeClean:!startDirty&&!endDirty,dirtyPaths:[...new Set((startDirty+'\n'+endDirty).split('\n').filter(Boolean))],stagedRelease:{...staged,dirty:staged.dirty==='true'},binSha256:binHash,startedAt,finishedAt:new Date().toISOString(),ok:true,...(tierRun.tier!=='full'?{tier:tierRun.tier,tierReason:tierRun.reason}:{}),gateScope:{summary:scope.summary,baseSha:scope.baseSha,changedPaths:scope.changedPaths,notRun:scope.notRun??[],gateChanges,...(fanOut?{fanOut}:{}),...(track?{releaseTrack:{track:track.track,reason:track.reason}}:{})},timing,gates};
  e.ok=validate(e,{...v,commit:undefined}).length===0;
  fs.writeFileSync(v.file,JSON.stringify(e,null,2)+'\n');
  if(!v['skip-notes']){
    const notesFile=path.join(v.repo,'docs/releases',v.notes);fs.mkdirSync(path.dirname(notesFile),{recursive:true});
    const line=g=>{
      const status=g.mode==='skip'?'SKIPPED':g.mode==='deferred'?'DEFERRED':gatePass(g)?'PASS':'FAIL';
      const detail=g.mode==='skip'||g.mode==='selected'||g.mode==='deferred'?`, ${g.mode}: ${g.reason}`:(g.exit!==undefined?`, exit ${g.exit}`:'');
      return `- ${g.id}: ${status}${detail}`;
    };
    const unrun=[...(scope.notRun??[]).map(file=>`- not run by any gate: ${file}`),...gateChanges.map(line=>`- ${line}`)];
    const section=`<!-- gate-evidence:begin sha=${sha} release=${v.release} json-sha256=${hash(v.file)} result=${e.ok?'PASS':'FAIL'} -->\n${[...gates.map(line),...unrun].join('\n')}\n<!-- gate-evidence:end -->`;
    const timingSection=`<!-- gate-timing:begin -->\n\`\`\`\n${waterfall.join('\n')}\n\`\`\`\n<!-- gate-timing:end -->`;
    let old=fs.existsSync(notesFile)?fs.readFileSync(notesFile,'utf8'):`# HANDOFF ${v.version}\n`;
    old=old.includes('<!-- gate-evidence:begin')?old.replace(/<!-- gate-evidence:begin[^]*?<!-- gate-evidence:end -->/,section):old.trimEnd()+'\n\n## Gate evidence\n\n'+section+'\n';
    old=old.includes('<!-- gate-timing:begin')?old.replace(/<!-- gate-timing:begin[^]*?<!-- gate-timing:end -->/,timingSection):old.replace(/<!-- gate-evidence:end -->/,`<!-- gate-evidence:end -->\n\n${timingSection}`);
    fs.writeFileSync(notesFile,old);
  }
  console.log(`${e.ok?'PASS':'FAIL'}: ${v.file}`);process.exitCode=e.ok?0:1;
} catch(e){console.error(`FAIL: ${e.stack??e.message}`);process.exitCode=2}
