import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
export const required = {'server-tests':'vitest','server-tsc':'tsc','web-tests':'vitest','web-tsc':'tsc',e2e:'e2e'};
export const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function options() {
  const {values:v} = parseArgs({options:Object.fromEntries(['version','release','repo-root','releases-dir','commit','gates-json','gates'].map(x=>[x,{type:'string'}]).concat(['skip-notes','merge'].map(x=>[x,{type:'boolean'}])))});
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
export function gatePass(g) {
  if(!g || g.exit!==0 || !Array.isArray(g.commands) || !g.commands.length || g.commands.some(c=>c.exit!==0)) return false;
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
  check(new Set(gates.map(g=>g.id)).size===gates.length,'Duplicate gate ids');
  for(const [id,kind] of Object.entries(required)) check(gates.some(g=>g.id===id && g.kind===kind),`Missing required gate ${id}`);
  for(const g of gates) check(gatePass(g),`Gate failed: ${g.id}`);
  check(e.ok===true,'Evidence says FAIL');
  if(v.commit){
    try {
      git(v.repo,'merge-base','--is-ancestor',e.sha,v.commit);
      check(git(v.repo,'diff','--name-only',e.sha,v.commit).split('\n').every(p=>!p||p.startsWith('docs/releases/')),'Code changed after gates');
      let notes;
      try {notes=git(v.repo,'show',`${v.commit}:docs/releases/${v.notes}`)} catch(err){if(!v.version.endsWith('.0'))throw err;notes=git(v.repo,'show',`${v.commit}:docs/releases/HANDOFF-${v.version.split('.').slice(0,2).join('')}.md`)}
      check(notes.includes(`<!-- gate-evidence:begin sha=${e.sha} release=${v.release} json-sha256=${hash(v.file)} result=PASS -->`),'Missing or mismatched notes evidence marker');
    } catch(err){errors.push(err.message)}
  }
  return errors;
}
