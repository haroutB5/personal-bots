#!/usr/bin/env node
import fs from 'node:fs';
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
const planOf=(defs,wanted,scope)=>defs.filter(d=>wanted.includes(d.id)).map(d=>{
  const plan=scope.plans.find(p=>p.id===d.id);
  if(!plan)throw new Error(`gate ${d.id} has no row in the gate scope registry`);
  return {def:d,plan};
});
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
// --dry-run prints what the gate would run for the release against the live one,
// without the heavy-job lock, a staged release or running anything. --head plans
// the same diff with the files of another commit, for replaying an old release.
if(v['dry-run']){
  try {
    const releaseSha=resolveCommit(v.repo,v.release);
    if(!releaseSha)throw new Error(`release ${v.release} is not a commit in ${v.repo}`);
    const head=resolveCommit(v.repo,v.head??v.release);
    if(!head)throw new Error(`head ${v.head} is not a commit in ${v.repo}`);
    const scope=gateScopeOf(v,head,releaseSha);
    const {defs,wanted,gateChanges}=loadGates(scope.baseSha,head);
    const plan=planOf(defs,wanted,scope);
    printPlan(scope,plan,gateChanges);
    console.log(`dry run: ${plan.filter(p=>p.plan.mode!=='skip').length} of ${wanted.length} gates would run (base ${scope.baseSha?.slice(0,12)??'none'}, release ${releaseSha.slice(0,12)}, files ${head.slice(0,12)})`);
    process.exit(0);
  } catch(e){console.error(`FAIL: ${e.message}`);process.exit(2)}
}
const MAIN_LOCK=`${process.env.HEAVY_JOB_BASE||'/home/harout/.personal-bots/run/omarchy-heavy'}.lock`;
const linkOf=(fd)=>{try{return fs.readlinkSync(`/proc/self/fd/${fd}`)}catch{return null}};
const holdsGate=()=>linkOf(8)===MAIN_LOCK||linkOf(9)===MAIN_LOCK;
if(process.env.HBOTS_HEAVY_JOB_HELD!=='1' || !holdsGate()) {
  const r=spawnSync('bash',[path.join(here,'heavy-job.sh'),'--label',`gate evidence ${v.release}`,'--',process.execPath,fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit'});
  process.exit(r.status??1);
}
// The browser revision the server's pinned playwright-core needs. The shared
// ~/.cache/ms-playwright holds a newer one and fails server-tests (1.67.17).
const GATE_BROWSERS='/home/harout/Claude/AI/dev-team/tools/pw-browsers';
// Gate commands must not see the live app environment the bot shell carries.
// Each gate gets its own TMPDIR on /tmp (tmpfs, not on the server tests' deny
// list, not a git-ignored worktree folder: 1.67.5 and 1.67.19), removed after it.
const gateEnv=(cwd,tmp)=>{
  const env={};
  for(const [key,value] of Object.entries(process.env)) if(!/^(?:T3CODE_|PERSONAL_|DSH_)/.test(key)) env[key]=value;
  env.PATH=`${cwd}/node_modules/.bin:${v.repo}/node_modules/.bin:${process.env.PATH}`;
  env.NO_COLOR='1';
  env.TMPDIR=tmp;
  env.PLAYWRIGHT_BROWSERS_PATH=process.env.PLAYWRIGHT_BROWSERS_PATH||GATE_BROWSERS;
  return env;
};
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&!fs.existsSync(GATE_BROWSERS)) console.warn(`warning: the pinned test browser folder ${GATE_BROWSERS} is missing`);
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
  const scope=gateScopeOf(v,sha);
  const scopeModule=gateScopeModule(v.repo);
  const {defs,wanted,gateChanges}=loadGates(scope.baseSha,sha);
  const plan=planOf(defs,wanted,scope);
  printPlan(scope,plan,gateChanges);
  let kept=[];
  if(v.merge){const old=JSON.parse(fs.readFileSync(v.file,'utf8'));if(old.sha!==sha||old.treeClean!==true||old.binSha256!==binHash)throw new Error('Cannot merge evidence from different/dirty tree or artifact');kept=old.gates.filter(g=>!wanted.includes(g.id))}
  const logDir=path.join(v.dir,'gate-evidence-logs');fs.mkdirSync(logDir,{recursive:true});
  const startedAt=new Date().toISOString(),gates=[...kept],results=new Map();
  const runCommands=(commands,cwd,env,stdio)=>new Promise((resolve)=>{
    const done=[];
    const next=(index)=>{
      if(index>=commands.length)return resolve(done);
      const command=commands[index];
      const child=spawn('bash',['-o','pipefail','-c',command],{cwd,env,stdio});
      let settled=false;
      const finish=(code)=>{if(settled)return;settled=true;done.push({command,exit:code});next(index+1)};
      child.once('error',()=>finish(1));
      child.once('exit',(code)=>finish(code??1));
    };
    next(0);
  });
  const runGate=async(d,lanes)=>{
    const log=path.join(logDir,`${d.id}.log`),fd=fs.openSync(log,'w'),started=Date.now();
    const stdio=['ignore',fd,fd,'ignore','ignore','ignore','ignore','ignore','ignore','ignore'];
    if(linkOf(8)!==null) stdio[8]=8;
    if(linkOf(9)!==null) stdio[9]=9;
    const cwd=path.resolve(v.repo,(d.cwd??'.').replaceAll('\\','/'));
    const tmp=fs.mkdtempSync('/tmp/hbots-gate-');
    const env=gateEnv(cwd,tmp);
    try {
      // The repo root holds another vite-plus copy; letting it win mixes two vitest instances in one run.
      const ownVp=path.join(cwd,'node_modules/.bin/vp');
      if(fs.existsSync(ownVp)){
        const found=path.resolve(spawnSync('bash',['-c','command -v vp'],{cwd,env,encoding:'utf8'}).stdout.trim()||'.');
        if(found!==ownVp)throw new Error(`${d.id}: vp resolves to ${found}, expected ${ownVp}`);
      }
      const laneResults=await Promise.all(lanes.map((commands)=>runCommands(commands,cwd,env,stdio)));
      const commands=laneResults.flat();
      const text=fs.readFileSync(log,'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');
      const g={id:d.id,kind:d.kind,title:d.title??d.id,cwd:d.cwd??'.',commands,exit:commands.find(c=>c.exit!==0)?.exit??0,seconds:(Date.now()-started)/1000,log};
      if(d.kind==='vitest'){
        const lines=text.split('\n').filter(l=>/^\s*Tests\s/.test(l));
        g.counts={passed:0,failed:0,skipped:0};
        for(const l of lines)for(const k of ['passed','failed','skipped'])g.counts[k]+=Number(l.match(new RegExp(`(\\d+)\\s+${k}`))?.[1]??0);
      } else if(d.kind==='e2e'){
        let summary={};for(const l of text.split('\n')){try{const x=JSON.parse(l);if(Array.isArray(x.journeys))summary=x}catch{}}
        g.journeys=summary.journeys??[];g.counts={journeys:g.journeys.length,passed:g.journeys.filter(j=>j.ok===true).length,failed:summary.failed??1};
      }
      results.set(d.id,g);console.log(`${g.id}: ${gatePass(g)?'PASS':'FAIL'} (exit ${g.exit})`);
    } finally{
      fs.closeSync(fd);
      try{fs.rmSync(tmp,{recursive:true,force:true})}catch(err){console.warn(`warning: could not remove ${tmp}: ${err.message}`)}
    }
  };
  const selected=plan.map(p=>p.def);
  const skipped=new Map(plan.filter(p=>p.plan.mode==='skip').map(p=>[p.def.id,{id:p.def.id,kind:p.def.kind,title:p.def.title??p.def.id,cwd:p.def.cwd??'.',mode:'skip',reason:p.plan.reason,baseSha:scope.baseSha,changedPaths:scope.changedPaths,seconds:0,commands:[]}]));
  const lanes=p=>scopeModule.commandsFor(p.plan,p.def);
  const toRun=plan.filter(p=>p.plan.mode!=='skip');
  const serverTests=toRun.find(p=>p.def.id==='server-tests');
  const e2eGate=toRun.find(p=>p.def.id==='e2e');
  // Two shards plus the browser peaked at the 5 GiB soft cap and starved e2e, so only a single-lane server-tests shares the window.
  const together=serverTests!==undefined&&e2eGate!==undefined&&lanes(serverTests).length===1;
  const run=(p)=>runGate(p.def,lanes(p));
  if(together){
    checkStable('before server-tests and e2e');
    await Promise.all([run(serverTests),run(e2eGate)]);
    checkStable('after server-tests and e2e');
  }
  for(const p of toRun) if(!(together&&(p===serverTests||p===e2eGate))){checkStable(`before ${p.def.id}`);await run(p);checkStable(`after ${p.def.id}`)}
  gates.push(...plan.map(p=>{
    const result=results.get(p.def.id)??skipped.get(p.def.id)??null;
    if(!result)return null;
    if(p.plan.mode==='skip')return result;
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
  const endDirty=dirty();
  const e={schema:1,version:v.version,release:v.release,sha,branch:git(v.repo,'branch','--show-current'),headAtStart:sha,headAtEnd:git(v.repo,'rev-parse','HEAD'),treeClean:!startDirty&&!endDirty,dirtyPaths:[...new Set((startDirty+'\n'+endDirty).split('\n').filter(Boolean))],stagedRelease:{...staged,dirty:staged.dirty==='true'},binSha256:binHash,startedAt,finishedAt:new Date().toISOString(),ok:true,gateScope:{summary:scope.summary,baseSha:scope.baseSha,changedPaths:scope.changedPaths,notRun:scope.notRun??[],gateChanges},gates};
  e.ok=validate(e,{...v,commit:undefined}).length===0;
  fs.writeFileSync(v.file,JSON.stringify(e,null,2)+'\n');
  if(!v['skip-notes']){
    const notesFile=path.join(v.repo,'docs/releases',v.notes);fs.mkdirSync(path.dirname(notesFile),{recursive:true});
    const line=g=>{
      const status=g.mode==='skip'?'SKIPPED':gatePass(g)?'PASS':'FAIL';
      const detail=g.mode==='skip'||g.mode==='selected'?`, ${g.mode}: ${g.reason}`:(g.exit!==undefined?`, exit ${g.exit}`:'');
      return `- ${g.id}: ${status}${detail}`;
    };
    const unrun=[...(scope.notRun??[]).map(file=>`- not run by any gate: ${file}`),...gateChanges.map(line=>`- ${line}`)];
    const section=`<!-- gate-evidence:begin sha=${sha} release=${v.release} json-sha256=${hash(v.file)} result=${e.ok?'PASS':'FAIL'} -->\n${[...gates.map(line),...unrun].join('\n')}\n<!-- gate-evidence:end -->`;
    const old=fs.existsSync(notesFile)?fs.readFileSync(notesFile,'utf8'):`# HANDOFF ${v.version}\n`;
    fs.writeFileSync(notesFile,old.includes('<!-- gate-evidence:begin')?old.replace(/<!-- gate-evidence:begin[^]*?<!-- gate-evidence:end -->/,section):old.trimEnd()+'\n\n## Gate evidence\n\n'+section+'\n');
  }
  console.log(`${e.ok?'PASS':'FAIL'}: ${v.file}`);process.exitCode=e.ok?0:1;
} catch(e){console.error(`FAIL: ${e.stack??e.message}`);process.exitCode=2}
