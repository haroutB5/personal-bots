import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
export const required = {'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'};
export const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function options() {
  const {values:v} = parseArgs({options:Object.fromEntries(['version','release','repo-root','releases-dir','commit','gates-json','gates','head'].map(x=>[x,{type:'string'}]).concat(['skip-notes','merge','dry-run'].map(x=>[x,{type:'boolean'}])))});
  if (!/^\d+\.\d+\.\d+$/.test(v.version??'') || !/^[a-f0-9]{12}$/.test(v.release??'')) throw new Error('Required: --version x.y.z --release sha12 [--repo-root DIR] [--releases-dir DIR]');
  v.repo = path.resolve(v['repo-root']??process.cwd());
  v.dir = path.join(v['releases-dir']??path.join(os.homedir(),'.personal-bots/releases'),v.release);
  v.file = path.join(v.dir,'gate-evidence.json');
  v.notes = `HANDOFF-${v.version.replaceAll('.','')}.md`;
  return v;
}
export function git(repo,...args) {
  const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});
  if(r.status!==0) throw new Error(`git ${args[0]} failed`);
  return r.stdout.trim();
}
// The planner, the selector and the seal live in the repo under test, so the
// collector, the checker and the runner all read one registry. A repo without
// it cannot plan and the gate refuses instead of running everything.
export function gateScopeModule(repo) {
  try {
    const req=createRequire(path.join(repo,'package.json'));
    const m=req(path.join(repo,'scripts/personal/linux/hbots-release/lib/gateScope.mjs'));
    return typeof m?.planChecks==='function'?m:null;
  } catch { return null }
}
export function liveReleaseSha(releasesDir) {
  try { return fs.readFileSync(path.join(releasesDir,'current.txt'),'utf8').trim() } catch { return '' }
}
export function resolveCommit(repo,rev) {
  try { return git(repo,'rev-parse','--verify',`${rev}^{commit}`) } catch { return null }
}
// The evidence is only valid for the exact commit and clean tree the gates started on.
// A gate that moves HEAD or edits a tracked file invalidates everything after it.
export function treeState(repo) {
  return {sha:git(repo,'rev-parse','HEAD'),dirty:git(repo,'status','--porcelain','--untracked-files=no')};
}
export function treeChange(repo,expected) {
  const now=treeState(repo);
  const changes=[];
  if(now.sha!==expected.sha) changes.push(`HEAD ${expected.sha.slice(0,12)} -> ${now.sha.slice(0,12)}`);
  if(now.dirty) changes.push(`tracked files changed: ${now.dirty.split('\n').slice(0,5).join('; ')}${now.dirty.split('\n').length>5?' ...':''}`);
  return changes.length?changes.join('; '):null;
}
export function diffPaths(repo,base,head) {
  const r=spawnSync('git',['-C',repo,'diff','--no-renames','--name-only','-z',base,head],{encoding:'utf8',maxBuffer:64*1024*1024});
  if(r.status!==0) throw new Error('git diff failed');
  return r.stdout.split('\0').filter(Boolean);
}
function readerFor(scope,repo,sha) {
  if(typeof scope.gitReader==='function') return scope.gitReader(repo,sha);
  if(typeof scope.fsReader==='function') return scope.fsReader(repo);
  throw new Error('gate scope module has no repo reader');
}
// Plan every check from the live release to `headSha`. An unmapped path is a
// hard stop: the message names the file and where its row belongs.
export function gateScopeOf(v,headSha,pathsSha=headSha) {
  const scope=gateScopeModule(v.repo);
  if(!scope) throw new Error('gate scope classifier missing; a gate cannot be planned');
  const live=liveReleaseSha(path.dirname(v.dir));
  const baseSha=resolveCommit(v.repo,live);
  if(!baseSha) throw new Error(`live release ${live||'(missing)'} is not a commit in ${v.repo}; a gate cannot be planned`);
  const changedPaths=diffPaths(v.repo,baseSha,pathsSha);
  let result;
  try { result=scope.planChecks(changedPaths,{reader:readerFor(scope,v.repo,headSha)}) }
  catch(err) { throw new Error(`cannot plan the gates: ${err.message}`) }
  if(result?.error==='unmapped') throw new Error(`unmapped path${result.paths.length===1?'':'s'} ${result.paths.join(', ')}: add each to a CHECKS row, NO_CHECK or TOOLCHAIN in scripts/personal/linux/hbots-release/lib/gateScope.mjs`);
  if(!Array.isArray(result?.plans)) throw new Error('gate scope classifier gave no per-check plan');
  return {...result,baseSha,changedPaths:result.changedPaths??changedPaths};
}
// Recompute every plan from the live-to-release diff; never trust the evidence.
export function planProblems(e,v) {
  const scope=gateScopeModule(v.repo);
  if(!scope) return ['cannot verify gate plans: the repository has no gate scope classifier'];
  const live=liveReleaseSha(path.dirname(v.dir));
  const baseSha=resolveCommit(v.repo,live), releaseSha=resolveCommit(v.repo,e.release);
  if(!baseSha||!releaseSha) return [`cannot verify gate plans: live ${live||'(missing)'} and release ${e.release} are not both commits in ${v.repo}`];
  try {
    return scope.verifyPlans({
      evidence:e,
      liveSha:baseSha,
      releaseSha,
      changedPaths:diffPaths(v.repo,baseSha,releaseSha),
      reader:readerFor(scope,v.repo,releaseSha),
    });
  } catch(err) { return [`cannot verify gate plans: ${err.message}`] }
}
export function gatePass(g,{skipAllowed=false}={}) {
  if(!g) return false;
  if(g.mode==='skip') return skipAllowed===true && typeof g.reason==='string' && g.reason.trim().length>0 && typeof g.baseSha==='string' && Array.isArray(g.changedPaths) && g.changedPaths.length>0;
  if(g.exit!==0 || !Array.isArray(g.commands) || !g.commands.length || g.commands.some(c=>c.exit!==0)) return false;
  if(g.kind==='vitest') return Number.isInteger(g.counts?.passed) && g.counts.passed>0 && g.counts.failed===0;
  if(g.kind==='e2e') return Array.isArray(g.journeys) && g.journeys.length>=5 && new Set(g.journeys.map(j=>j.id)).size===g.journeys.length && g.journeys.every(j=>typeof j.id==='string' && j.id && j.ok===true) && g.counts?.failed===0 && g.counts.passed===g.journeys.length && g.counts.journeys===g.journeys.length;
  if(g.kind==='ps') return g.counts?.checks>0 && g.counts.failedChecks===0;
  return ['tsc','lint','node'].includes(g.kind);
}
export function validate(e,v) {
  const errors=[];
  const check=(ok,msg)=>{if(!ok)errors.push(msg)};
  check(e.schema===1 && e.version===v.version && e.release===v.release,'Wrong schema/version/release');
  check(/^[a-f0-9]{40}$/.test(e.sha??'') && e.sha.startsWith(v.release),'Wrong evidence commit');
  check(e.headAtStart===e.sha && e.headAtEnd===e.sha && e.treeClean===true,'Dirty tree or moved HEAD');
  check(e.stagedRelease?.dirty===false && /^[a-f0-9]{12,40}$/.test(e.stagedRelease?.sha??'') && e.sha?.startsWith(e.stagedRelease?.sha??'!') && e.stagedRelease?.version===v.version,'Staged metadata mismatch');
  check(e.binSha256===hash(path.join(v.dir,'dist/bin.mjs')),'Artifact hash mismatch');
  const staged=Object.fromEntries(fs.readFileSync(path.join(v.dir,'VERSION'),'utf8').trim().split(/\r?\n/).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));
  check(staged.dirty==='false' && staged.version===v.version && staged.sha===e.stagedRelease?.sha,'Staged VERSION changed or dirty');
  const gates=Array.isArray(e.gates)?e.gates:[];
  const planProblemsFound=planProblems(e,v);
  errors.push(...planProblemsFound);
  const skipAllowed=planProblemsFound.length===0;
  check(new Set(gates.map(g=>g.id)).size===gates.length,'Duplicate gate ids');
  for(const [id,kind] of Object.entries(required)) check(gates.some(g=>g.id===id && g.kind===kind),`Missing required gate ${id}`);
  for(const g of gates) {
    check(['skip','whole','selected'].includes(g.mode),`Gate ${g.id} has no plan mode`);
    check(gatePass(g,{skipAllowed}),`Gate failed: ${g.id}`);
  }
  check(e.ok===true,'Evidence says FAIL');
  if(v.commit){
    try {
      git(v.repo,'merge-base','--is-ancestor',e.sha,v.commit);
      check(git(v.repo,'diff','--name-only',e.sha,v.commit).split('\n').every(p=>!p||p.startsWith('docs/releases/')),'Code changed after gates');
      let notes;
      try {notes=git(v.repo,'show',`${v.commit}:docs/releases/${v.notes}`)} catch(err){if(!v.version.endsWith('.0'))throw err;notes=git(v.repo,'show',`${v.commit}:docs/releases/HANDOFF-${v.version.split('.').slice(0,2).join('')}.md`)}
      check(notes.includes(`<!-- gate-evidence:begin sha=${e.sha} release=${e.release} json-sha256=${hash(v.file)} result=PASS -->`),'Missing or mismatched notes evidence marker');
    } catch(err){errors.push(err.message)}
  }
  return errors;
}
