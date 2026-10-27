#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {options,git,hash,gatePass,validate} from './gate-common.mjs';
let v;
try {v=options()} catch(e){console.error(e.message);process.exit(2)}
const here=path.dirname(fileURLToPath(import.meta.url));
const MAIN_LOCK=`${process.env.HEAVY_JOB_BASE||'/home/harout/.personal-bots/run/omarchy-heavy'}.lock`;
const linkOf=(fd)=>{try{return fs.readlinkSync(`/proc/self/fd/${fd}`)}catch{return null}};
const holdsGate=()=>linkOf(8)===MAIN_LOCK||linkOf(9)===MAIN_LOCK;
if(process.env.HBOTS_HEAVY_JOB_HELD!=='1' || !holdsGate()) {
  const r=spawnSync('bash',[path.join(here,'heavy-job.sh'),'--label',`gate evidence ${v.release}`,'--',process.execPath,fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit'});
  process.exit(r.status??1);
}
try {
  const sha=git(v.repo,'rev-parse','HEAD'), dirty=()=>git(v.repo,'status','--porcelain','--untracked-files=no');
  const startDirty=dirty();
  const staged=Object.fromEntries(fs.readFileSync(path.join(v.dir,'VERSION'),'utf8').trim().split(/\r?\n/).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));
  if(!sha.startsWith(v.release)||staged.version!==v.version||!sha.startsWith(staged.sha)||staged.dirty!=='false')throw new Error('Stage a clean matching commit/version first');
  const binHash=hash(path.join(v.dir,'dist/bin.mjs'));
  // The phone harness must be supplied until its PowerShell server control is ported.
  // No evidence can pass by silently omitting this gate.
  if(!v['gates-json'])throw new Error('--gates-json FILE required: supply Linux gate commands including phone e2e; the legacy default harness requires PowerShell');
  const defs=JSON.parse(fs.readFileSync(v['gates-json'],'utf8'));
  if(!Array.isArray(defs)||defs.some(d=>!/^[-a-z0-9]+$/.test(d.id)||!Array.isArray(d.commands)||!d.commands.length||d.commands.some(c=>typeof c!=='string'||!c.trim()))||new Set(defs.map(d=>d.id)).size!==defs.length)throw new Error('Invalid gate definitions');
  const wanted=v.gates?v.gates.split(','):defs.map(d=>d.id);
  if(wanted.some(id=>!defs.some(d=>d.id===id)))throw new Error('Unknown gate selection');
  let kept=[];
  if(v.merge){const old=JSON.parse(fs.readFileSync(v.file,'utf8'));if(old.sha!==sha||old.treeClean!==true||old.binSha256!==binHash)throw new Error('Cannot merge evidence from different/dirty tree or artifact');kept=old.gates.filter(g=>!wanted.includes(g.id))}
  const logDir=path.join(v.dir,'gate-evidence-logs');fs.mkdirSync(logDir,{recursive:true});
  const startedAt=new Date().toISOString(), gates=[...kept];
  for(const d of defs.filter(d=>wanted.includes(d.id))){
    const log=path.join(logDir,`${d.id}.log`), fd=fs.openSync(log,'w'), commands=[], started=Date.now();
    const stdio=['ignore',fd,fd,'ignore','ignore','ignore','ignore','ignore','ignore','ignore'];
    if(linkOf(8)!==null) stdio[8]=8;
    if(linkOf(9)!==null) stdio[9]=9;
    try {for(const command of d.commands){const r=spawnSync('bash',['-o','pipefail','-c',command],{cwd:path.resolve(v.repo,(d.cwd??'.').replaceAll('\\','/')),env:{...process.env,PATH:`${v.repo}/node_modules/.bin:${process.env.PATH}`,NO_COLOR:'1'},stdio});commands.push({command,exit:r.status??1})}} finally{fs.closeSync(fd)}
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
    gates.push(g);console.log(`${g.id}: ${gatePass(g)?'PASS':'FAIL'} (exit ${g.exit})`);
  }
  const endDirty=dirty();
  const e={schema:1,version:v.version,release:v.release,sha,branch:git(v.repo,'branch','--show-current'),headAtStart:sha,headAtEnd:git(v.repo,'rev-parse','HEAD'),treeClean:!startDirty&&!endDirty,dirtyPaths:[...new Set((startDirty+'\n'+endDirty).split('\n').filter(Boolean))],stagedRelease:{...staged,dirty:staged.dirty==='true'},binSha256:binHash,startedAt,finishedAt:new Date().toISOString(),ok:true,gates};
  e.ok=validate(e,{...v,commit:undefined}).length===0;
  fs.writeFileSync(v.file,JSON.stringify(e,null,2)+'\n');
  if(!v['skip-notes']){
    const notesFile=path.join(v.repo,'docs/releases',v.notes);fs.mkdirSync(path.dirname(notesFile),{recursive:true});
    const section=`<!-- gate-evidence:begin sha=${sha} release=${v.release} json-sha256=${hash(v.file)} result=${e.ok?'PASS':'FAIL'} -->\n${gates.map(g=>`- ${g.id}: ${gatePass(g)?'PASS':'FAIL'}, exit ${g.exit}`).join('\n')}\n<!-- gate-evidence:end -->`;
    const old=fs.existsSync(notesFile)?fs.readFileSync(notesFile,'utf8'):`# HANDOFF ${v.version}\n`;
    fs.writeFileSync(notesFile,old.includes('<!-- gate-evidence:begin')?old.replace(/<!-- gate-evidence:begin[^]*?<!-- gate-evidence:end -->/,section):old.trimEnd()+'\n\n## Gate evidence\n\n'+section+'\n');
  }
  console.log(`${e.ok?'PASS':'FAIL'}: ${v.file}`);process.exitCode=e.ok?0:1;
} catch(e){console.error(`FAIL: ${e.message}`);process.exitCode=2}
