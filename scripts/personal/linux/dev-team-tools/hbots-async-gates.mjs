#!/usr/bin/env node
// hbots async gate tier (Faster releases step 2, 22 Nov 2026).
//
// A release whose gate evidence is the "blocking" tier went live after preflight, the
// typechecks, the near server tests and the unit suites. The slower checks it deferred
// (the far server tests, e2e, parity, Kotlin) run here, after the release, from the same
// release worktree and against the same base (the rollback release), so the plan is the
// one the seal checked. hbots-release-finish.sh runs this before it publishes the APK or
// pushes trunk, so a rollback never leaves phones on an APK for the newer server.
//
// On a failure (gate-evidence already ran each failed job a second time) it posts a
// release notice to the Opusito thread and rolls the server back only when all of these
// hold (Harout's guard 2):
//   - the live release (current.txt) is still the release that was tested;
//   - no hbots-release-run-* unit is active and no newer release is armed or running;
//   - the release is tiered, which the planner refuses for any DB migration, and the
//     base-to-release diff has no migration path (checked again here).
// Otherwise the release stays live and the notice says why.
//
// The emulator flows (23 Nov 2026, 1.67.56): with --emulator-apk <x86_64 QA APK> it also runs
// the emulator QA flows the release deferred (verify.sh --tier async: every flow select-flows.mjs
// did not put before the release) against the live release. A failed flow is run once more on
// its own; only a flow that fails twice is a real failure (rollback-eligible under the same
// guard 2), while a setup, device or link failure (verify.sh exit 2) never rolls back. These run
// whatever the gate tier is: with untiered evidence a failure keeps the release live and alerts.
//
// Exit codes: 0 passed or nothing deferred, 10 rolled back, 11 failed and kept live,
// 12 rollback failed, 1 could not run (alerted as async_failed), 2 bad arguments.
// --dry-run runs nothing: it prints the async plan and the rollback decision as of now
// (HBOTS_ASYNC_SIMULATE=fail decides as if a gate had failed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';

const HOME=os.homedir();
const TOOLS=process.env.HBOTS_ASYNC_TOOLS||path.dirname(new URL(import.meta.url).pathname);
const RUN_DIR=process.env.HBOTS_ASYNC_RUN_DIR||path.join(HOME,'.personal-bots/run');
const RELEASES=process.env.HBOTS_ASYNC_RELEASES||path.join(HOME,'.personal-bots/releases');
const NODE=process.env.HBOTS_ASYNC_NODE||process.execPath;
const SYSTEMCTL=process.env.HBOTS_ASYNC_SYSTEMCTL||'systemctl';
const THREAD_DEFAULT='759552c5-0b8c-4680-8cc6-5c7487c8081e';
const TERMINAL=new Set(['live_verified','live_verified_doc_update_failed','rolled_back','rollback_failed','failed','dryrun_ok','guards_ok','prepared']);

const usage=`Usage: hbots-async-gates.mjs --version X.Y.Z --release <sha12> --worktree <release worktree> --qa-dir <dir>
  [--emulator-apk <x86_64 QA apk>] [--thread-id <id, default the Opusito thread>] [--no-rollback] [--dry-run]`;
let o;
try{
  o=parseArgs({options:{version:{type:'string'},release:{type:'string'},worktree:{type:'string'},'qa-dir':{type:'string'},'thread-id':{type:'string'},'no-rollback':{type:'boolean'},'dry-run':{type:'boolean'},'emulator-apk':{type:'string'}}}).values;
  if(!/^\d+\.\d+\.\d+$/.test(o.version??''))throw new Error('--version must be X.Y.Z');
  if(!/^[a-f0-9]{12}$/.test(o.release??''))throw new Error('--release must be a 12 char sha');
  if(!o.worktree||!fs.existsSync(o.worktree))throw new Error('--worktree must exist');
  if(o['emulator-apk']!==undefined&&!fs.statSync(o['emulator-apk'],{throwIfNoEntry:false})?.isFile())throw new Error('--emulator-apk must be an existing file');
  if(!o['qa-dir']||!fs.statSync(o['qa-dir'],{throwIfNoEntry:false})?.isDirectory())throw new Error('--qa-dir must be an existing folder');
}catch(e){console.error(`${e.message}\n${usage}`);process.exit(2)}
const DRY=!!o['dry-run'];
const QA=path.resolve(o['qa-dir']);
const WT=path.resolve(o.worktree);
const THREAD=o['thread-id']??THREAD_DEFAULT;
const LOG=path.join(QA,'ASYNC-GATES.log');
const lines=[];
const say=(line)=>{console.log(line);lines.push(line);if(!DRY)fs.appendFileSync(LOG,`${line}\n`)};

const run=(cmd,args,opts={})=>{
  const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:64*1024*1024,...opts});
  return {code:r.status??(r.error?127:1),out:(r.stdout??'')+(r.stderr??'')};
};
const git=(...args)=>{const r=run('git',['-C',WT,...args]);if(r.code!==0)throw new Error(`git ${args[0]} failed: ${r.out.slice(0,200)}`);return r.out.trim()};
const readJson=(file)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}};
const cmpVersion=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0};

// Everything a decision reads, gathered once so --dry-run and the real run agree.
function facts(){
  const result=readJson(path.join(RUN_DIR,`restart-${o.version}-result.json`));
  if(!result)throw new Error(`no runner result restart-${o.version}-result.json in ${RUN_DIR}`);
  if(!String(result.release??'').startsWith(o.release))throw new Error(`runner result is for release ${result.release}, not ${o.release}`);
  if(!/^live_verified/.test(result.status??''))throw new Error(`runner status is ${result.status}: the release is not live, nothing runs after it`);
  const rollback=String(result.rollback??'');
  if(!/^[a-f0-9]{12}$/.test(rollback))throw new Error(`runner result has no rollback release (${rollback||'missing'})`);
  const evidence=readJson(path.join(RELEASES,o.release,'gate-evidence.json'));
  if(!evidence)throw new Error(`no gate-evidence.json for ${o.release} in ${RELEASES}`);
  const head=git('rev-parse','HEAD');
  const tested=String(evidence.sha||head);
  if(!tested.startsWith(o.release))throw new Error(`tested commit ${tested.slice(0,12)} is not release ${o.release}`);
  if(head!==tested){
    // The release flow commits the handoff/QA docs on top of the tested commit (that docs commit is --main-sha).
    // Accept it only when the tested commit is its ancestor and nothing but docs changed, so the code is identical.
    if(run('git',['-C',WT,'merge-base','--is-ancestor',tested,head]).code!==0)throw new Error(`worktree HEAD ${head.slice(0,12)} does not descend from the tested commit ${tested.slice(0,12)}`);
    const extra=git('diff','--no-renames','--name-only',tested,head).split('\n').filter(Boolean).filter((f)=>!/^docs\//.test(f)&&!/\.md$/.test(f));
    if(extra.length)throw new Error(`worktree HEAD ${head.slice(0,12)} changes code after the tested commit ${tested.slice(0,12)}: ${extra.slice(0,5).join(', ')}`);
  }
  return {result,rollback,evidence,head,tested};
}

// Harout's guard 2. Returns {allowed, reasons[]} where reasons say why not.
function rollbackDecision({rollback,evidence,head}){
  const reasons=[];
  if(o['no-rollback'])reasons.push('--no-rollback was given');
  let live='';
  try{live=fs.readFileSync(path.join(RELEASES,'current.txt'),'utf8').trim()}catch{}
  if(live!==o.release)reasons.push(`the live release is ${live||'(unknown)'}, not the tested ${o.release}`);
  const units=run(SYSTEMCTL,['--user','list-units','--all','--plain','--no-legend','hbots-release-run-*']);
  if(units.code!==0)reasons.push(`cannot list release units (${units.out.slice(0,120).trim()})`);
  for(const line of units.out.split('\n')){
    const m=/^(hbots-release-run-\S+)\.service\s+\S+\s+(active|activating|deactivating|reloading)/.exec(line.trim());
    if(m)reasons.push(`release unit ${m[1]} is ${m[2]}`);
  }
  for(const name of fs.readdirSync(RUN_DIR)){
    const m=/^restart-(\d+\.\d+\.\d+)-result\.json$/.exec(name);
    if(!m||cmpVersion(m[1],o.version)<=0)continue;
    const r=readJson(path.join(RUN_DIR,name));
    if(r&&!TERMINAL.has(r.status))reasons.push(`release ${m[1]} is ${r.status} (armed or running)`);
    else if(r&&/^live_verified/.test(r.status))reasons.push(`a newer release ${m[1]} went live`);
  }
  if(evidence.tier!=='blocking')reasons.push(`the evidence tier is ${evidence.tier??'full'}, not blocking`);
  try{
    const req=createRequire(path.join(WT,'package.json'));
    const scope=req(path.join(WT,'scripts/personal/linux/hbots-release/lib/gateScope.mjs'));
    const changed=git('diff','--no-renames','--name-only',`${rollback}`,head).split('\n').filter(Boolean);
    const migrations=changed.filter((file)=>scope.isMigrationPath(file));
    if(migrations.length)reasons.push(`the release changes DB migrations (${migrations.slice(0,3).join(', ')})`);
  }catch(e){reasons.push(`cannot check for DB migrations: ${e.message}`)}
  return {allowed:reasons.length===0,reasons};
}

// The async run gets its own releases dir whose current.txt is the rollback release, so
// the collector plans the same base-to-release diff the blocking tier was sealed with.
function privateReleases(rollback){
  const dir=path.join(QA,'async-releases');
  const own=path.join(dir,o.release);
  fs.mkdirSync(path.join(own,'dist'),{recursive:true});
  fs.writeFileSync(path.join(dir,'current.txt'),`${rollback}\n`);
  fs.copyFileSync(path.join(RELEASES,o.release,'VERSION'),path.join(own,'VERSION'));
  fs.copyFileSync(path.join(RELEASES,o.release,'dist/bin.mjs'),path.join(own,'dist/bin.mjs'));
  return dir;
}

function gates(dir,{dryRun}){
  const collector=process.env.HBOTS_ASYNC_COLLECTOR||path.join(TOOLS,'gate-evidence.mjs');
  const args=[collector,'--version',o.version,'--release',o.release,'--repo-root',WT,'--releases-dir',dir,'--gates-json',process.env.HBOTS_ASYNC_GATES_JSON||'scripts/personal/node/gates-linux.scoped.json',...(dryRun?['--dry-run']:[])];
  const env={...process.env,GATE_TIER:'async'};
  delete env.NODE_ENV;
  const r=run(NODE,args,{env,cwd:WT});
  for(const line of r.out.trimEnd().split('\n'))say(`  ${line}`);
  return r.code;
}

// The deferred emulator flows. verify.sh exits 0 (every flow PASS), 1 (a flow FAILED) or 2 (setup,
// device or link). A failed flow runs once more on its own; this returns 1 only for a flow that
// failed both times, and 2 for anything that is not a flow verdict.
const SKILL='apps/hbots-mobile/.claude/skills/verify-hbots-android/scripts';
function emulatorPlan(rollback){
  const r=run(NODE,[path.join(WT,SKILL,'select-flows.mjs'),'--repo',WT,'--base',rollback,'--head','HEAD'],{cwd:WT});
  return {code:r.code,text:r.out.trimEnd()};
}
function emulator(rollback){
  const verify=process.env.HBOTS_ASYNC_VERIFY||path.join(WT,SKILL,'verify.sh');
  const ev=path.join(QA,'emulator-async');
  fs.mkdirSync(ev,{recursive:true});
  const env={...process.env,HBOTS_VERIFY_EVIDENCE:ev,VERIFY_RELEASE:o.release};
  delete env.NODE_ENV;
  const apk=path.resolve(o['emulator-apk']);
  const once=(label,args)=>{
    const t=Date.now();
    const r=run('bash',[verify,apk,label,...args],{env,cwd:WT});
    fs.writeFileSync(path.join(QA,`${label}.out`),r.out);
    const flows=r.out.split('\n').filter((l)=>/^\S+ flow \d+ \S+ (?:PASS|FAIL|LINK-LOST)\b|^emulator flows |^RESULT /.test(l));
    for(const line of flows)say(`  ${line}`);
    say(`emulator ${label}: exit ${r.code} after ${Math.round((Date.now()-t)/1000)} s`);
    return r;
  };
  const first=once(`async-${o.version}`,['--tier','async','--base',rollback]);
  if(first.code===0)return 0;
  if(first.code!==1)return 2;
  const failed=[...new Set([...first.out.matchAll(/^\S+ flow (\d+) \S+ FAIL\b/gm)].map((m)=>m[1]))];
  if(!failed.length){say('emulator: exit 1 but no FAIL line names a flow; not a flow verdict');return 2}
  say(`emulator: flows ${failed.join(',')} failed; running them once more`);
  const again=once(`async-${o.version}-retry`,['--only',failed.join(',')]);
  if(again.code===0){say(`emulator: flows ${failed.join(',')} passed on the second run (flaky, not a failure)`);return 0}
  return again.code===1?1:2;
}

function rollBack(rollback,version){
  const cli=process.env.HBOTS_ASYNC_CLI||path.join(RUN_DIR,`release-tools-${version}`,'scripts/personal/node/hbots.mjs');
  const restart=run(NODE,[cli,'restart','--root','dev','--release',rollback]);
  say(`rollback: hbots.mjs restart --release ${rollback} exit ${restart.code}`);
  for(const line of restart.out.trimEnd().split('\n').slice(-6))say(`  ${line}`);
  if(restart.code!==0)return {rollbackExit:restart.code,rollbackSmokeExit:null};
  const smoke=run(NODE,[cli,'smoke','--root','dev','--expect-release',rollback,'--stable-seconds','60','--start-timeout','120']);
  say(`rollback smoke exit ${smoke.code}`);
  for(const line of smoke.out.trimEnd().split('\n').slice(-6))say(`  ${line}`);
  return {rollbackExit:restart.code,rollbackSmokeExit:smoke.code};
}

function notify(outcome,extra){
  const notifier=process.env.HBOTS_ASYNC_NOTIFY||path.join(TOOLS,'notify-release.mjs');
  const args=[notifier,'--thread-id',THREAD,'--version',o.version,'--release',o.release,'--outcome',outcome,'--log-path',LOG];
  for(const [flag,value] of Object.entries(extra))if(value!==null&&value!==undefined)args.push(`--${flag}`,String(value));
  const r=run(NODE,args);
  say(`notice ${outcome}: exit ${r.code} ${r.out.trim().slice(0,200)}`);
}

function record(status,{seconds,decision}){
  const waterfall=(file)=>{try{return fs.readFileSync(file,'utf8').trimEnd()}catch{return '(none)'}};
  const body=[
    `# hbots ${o.version} async gates`,'',
    `- **Release:** \`${o.release}\``,
    `- **Outcome:** \`${status}\` after ${seconds} s`,
    ...(decision?[`- **Rollback:** ${decision.allowed?'allowed':`not allowed: ${decision.reasons.join('; ')}`}`]:[]),
    `- **Log:** \`ASYNC-GATES.log\``,
    ...(o['emulator-apk']?['- **Emulator flows:** evidence in `emulator-async/`, output in `async-<version>*.out`']:[]),'',
    '## Blocking tier timing','','```',waterfall(path.join(RELEASES,o.release,'gate-evidence-logs/waterfall.txt')),'```','',
    '## Async tier timing','','```',waterfall(path.join(QA,'async-releases',o.release,'gate-evidence-async-logs/waterfall.txt')),'```',''];
  fs.writeFileSync(path.join(QA,'ASYNC-RECORD.md'),body.join('\n'));
}

const t0=Date.now();
const secs=()=>Math.round((Date.now()-t0)/1000);
let f;
try{f=facts()}catch(e){
  say(`async gates: cannot run: ${e.message}`);
  if(DRY)process.exit(1);
  notify('async_failed',{detail:`async gates could not run: ${e.message}`.slice(0,400)});
  record('could_not_run',{seconds:secs()});
  process.exit(1);
}
const TIERED=f.evidence.tier==='blocking';
const EMU=!!o['emulator-apk'];
if(!TIERED&&!EMU){
  say(`async gates: the evidence tier is ${f.evidence.tier??'full'}; nothing was deferred, nothing runs`);
  process.exit(0);
}
say(`async gates for ${o.version} (${o.release}), base ${f.rollback}, worktree ${WT}${DRY?' [dry run]':''}`);
if(!TIERED)say(`async gates: the evidence tier is ${f.evidence.tier??'full'}; no gate was deferred, only the emulator flows run`);
if(DRY){
  if(TIERED){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hbots-async-dry-'));
    try{
      fs.mkdirSync(path.join(dir,o.release,'dist'),{recursive:true});
      fs.writeFileSync(path.join(dir,'current.txt'),`${f.rollback}\n`);
      gates(dir,{dryRun:true});
    }finally{fs.rmSync(dir,{recursive:true,force:true})}
  }
  if(EMU){const p=emulatorPlan(f.rollback);for(const line of p.text.split('\n'))say(`  ${line}`);if(p.code!==0)say(`emulator plan: select-flows.mjs exit ${p.code}`)}
  const failed=process.env.HBOTS_ASYNC_SIMULATE==='fail';
  const d=rollbackDecision(f);
  say(`dry run: on a failure the release would ${d.allowed?`roll back to ${f.rollback}`:`stay live (${d.reasons.join('; ')})`}${failed?' [simulated failure]':''}`);
  process.exit(0);
}
// gate-evidence only runs on the exact tested commit. When the docs commit sits on top of it,
// check the tested commit out (detached) for the run and put the worktree back afterwards.
function onTested(fn){
  if(f.head===f.tested)return fn();
  if(git('status','--porcelain','--untracked-files=no'))throw new Error('worktree has uncommitted tracked changes; cannot switch to the tested commit');
  const branch=run('git',['-C',WT,'symbolic-ref','-q','--short','HEAD']).out.trim();
  git('checkout','--quiet','--detach',f.tested);
  say(`worktree switched to the tested commit ${f.tested.slice(0,12)} for the run`);
  try{return fn()}finally{
    if(branch)git('checkout','--quiet',branch);else git('checkout','--quiet','--detach',f.head);
    say(`worktree back on ${branch||f.head.slice(0,12)}`);
  }
}
let code;
try{
  code=onTested(()=>{
    const g=TIERED?gates(privateReleases(f.rollback),{dryRun:false}):0;
    if(TIERED)say(`async gates: the deferred gates exit ${g}`);
    const e=EMU?emulator(f.rollback):0;
    if(EMU)say(`async gates: the deferred emulator flows exit ${e}`);
    // A real failure in either is a real failure; otherwise the first could-not-run code.
    return g===1||e===1?1:g||e;
  });
}catch(e){say(`async gates: ${e.message}`);code=2}
if(code===0){
  say(`async gates: PASS in ${secs()} s`);
  record('passed',{seconds:secs()});
  process.exit(0);
}
say(`async gates: FAIL (exit ${code}) after ${secs()} s; failed jobs were already run twice`);
const d=rollbackDecision(f);
// Only real gate failures (exit 1) may roll back; a tool or setup error (exit 2 and others) never does.
if(code!==1){d.allowed=false;d.reasons.unshift(`the gates could not run (exit ${code}), so no test failed`)}
if(!d.allowed){
  say(`no rollback: ${d.reasons.join('; ')}`);
  notify('async_failed',{detail:`kept live: ${d.reasons.join('; ')}`.slice(0,400)});
  record('async_failed',{seconds:secs(),decision:d});
  process.exit(11);
}
const rb=rollBack(f.rollback,o.version);
const ok=rb.rollbackExit===0&&rb.rollbackSmokeExit===0;
notify(ok?'async_rolled_back':'async_rollback_failed',{'rollback-release':f.rollback,'rollback-exit':rb.rollbackExit,'rollback-smoke-exit':rb.rollbackSmokeExit});
record(ok?'async_rolled_back':'async_rollback_failed',{seconds:secs(),decision:d});
process.exit(ok?10:12);
