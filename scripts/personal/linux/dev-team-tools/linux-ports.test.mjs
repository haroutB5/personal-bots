import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkNotes} from './check-release-notes.mjs';
const dir=path.dirname(new URL(import.meta.url).pathname);
function cli(file,argv,expected=0){const r=spawnSync(process.execPath,[path.join(dir,file),...argv],{encoding:'utf8',timeout:10000});assert.equal(r.status,expected,r.stderr);return r;}
test('notes reject missing, stub, unfinished text; allow code examples and pinned commit',()=>{
 const good='Tested the new implementation against an isolated server. '.repeat(6);checkNotes(good+'\n`TODO`\n```\nPROOF_PLACEHOLDER\n```');
 for(const bad of ['short',good+' TODO',good+' PROOF_PLACEHOLDER',good+' to be completed',good+' <insert evidence>'])assert.throws(()=>checkNotes(bad));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'astra-notes-'));
 try{fs.writeFileSync(path.join(root,'notes.md'),good);cli('check-release-notes.mjs',['--version','1.2.3','--path',path.join(root,'notes.md')]);cli('check-release-notes.mjs',['--version','1.2.3','--path',path.join(root,'absent')],1);
 const git=(...a)=>{const r=spawnSync('git',['-C',root,...a],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};git('init','-q');git('config','user.email','harout_b5@live.com');git('config','user.name','haroutB5');fs.mkdirSync(path.join(root,'docs/releases'),{recursive:true});fs.writeFileSync(path.join(root,'docs/releases/HANDOFF-123.md'),good);git('add','.');git('commit','-qm','test fixture');const sha=git('rev-parse','HEAD');fs.writeFileSync(path.join(root,'docs/releases/HANDOFF-123.md'),'TODO');cli('check-release-notes.mjs',['--version','1.2.3','--repo-root',root,'--commit',sha]);
 }finally{fs.rmSync(root,{recursive:true});}
});
test('notice writes complete BOM-free JSON only to explicit fixture inbox; no-thread is a no-op',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'astra-notice-'));try{
 const a=['--base-dir',root,'--version','1.2.3','--release','abcdef012345','--outcome','live','--smoke-exit','0'];cli('notify-release.mjs',a);assert.equal(fs.existsSync(path.join(root,'personal')),false);cli('notify-release.mjs',[...a,'--thread-id','test-thread']);const inbox=path.join(root,'personal/release-notices'),files=fs.readdirSync(inbox);assert.equal(files.length,1);const notice=JSON.parse(fs.readFileSync(path.join(inbox,files[0]),'utf8'));assert.equal(notice.smokeExit,0);assert.equal(notice.threadId,'test-thread');cli('notify-release.mjs',[...a,'--thread-id','test','--bogus','x'],1);
 }finally{fs.rmSync(root,{recursive:true});}
});
test('profile reset refuses without approval; writes and cancels only fixture request',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'astra-reset-'));try{fs.mkdirSync(path.join(root,'personal'));cli('reset-browser-profile.mjs',['--base-dir',root],1);cli('reset-browser-profile.mjs',['--base-dir',root,'--owner-approved']);assert.ok(JSON.parse(fs.readFileSync(path.join(root,'personal/browser-profile-reset.request'),'utf8')).requestedAt);cli('reset-browser-profile.mjs',['--base-dir',root,'--cancel']);assert.equal(fs.existsSync(path.join(root,'personal/browser-profile-reset.request')),false);}finally{fs.rmSync(root,{recursive:true});}
});
test('browser policy screens nested batch and all launch overrides',()=>{
 const source=`import importlib.util\ns=importlib.util.spec_from_file_location('ab',${JSON.stringify(path.join(dir,'ab.py'))})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nbad=[['connect','9222'],['open','about:blank','--profile=/tmp/x'],['batch','state save /tmp/x'],['batch','\\\\state save /tmp/x'],['close','--all'],['open','about:blank','--session','other'],['snapshot','--engine','firefox']]\nfor t in bad:\n try:m.screen(t)\n except m.Refused:pass\n else:raise AssertionError(t)\nm.screen(['snapshot','-i'])\n`;
 const r=spawnSync('python3',['-c',source],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
test('skill installer rejects BOM and verifies all installed files',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'astra-skills-'));try{
 const master=path.join(root,'master'),base=path.join(root,'plugins'),dest=path.join(base,'bot/.claude/skills/agent-browser');fs.mkdirSync(master);fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(master,'SKILL.md'),'---\nname: test\n---\n');const go=(expected,...args)=>{const r=spawnSync('python3',[path.join(dir,'install-skill.py'),'--master',master,'--base',base,...args],{encoding:'utf8'});assert.equal(r.status,expected,r.stderr);};go(0);go(0,'--check');fs.writeFileSync(path.join(dest,'SKILL.md'),'drift');go(1,'--check');fs.writeFileSync(path.join(master,'SKILL.md'),'\ufeff---\n');go(1);
 }finally{fs.rmSync(root,{recursive:true});}
});
