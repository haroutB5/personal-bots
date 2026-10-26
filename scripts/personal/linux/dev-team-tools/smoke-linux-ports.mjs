// Real isolated integration check. Run under heavy-job.sh. Never reads live data.
import assert from 'node:assert/strict';
import {fs,path,os,run,cleanEnv} from './ops-common.mjs';
import {start,stop,pair} from './throwaway-server.mjs';
const repo=process.argv[2],release=process.argv[3];if(!repo||!release)throw Error('usage: smoke-linux-ports.mjs REPO RELEASE');
const here=path.dirname(new URL(import.meta.url).pathname),proof=fs.mkdtempSync('/tmp/astra-ports-smoke-');let r;
try{
 r=await start({name:'astra-'+process.pid,release,'repo-root':repo});
 const link=pair(r);assert.ok(link.startsWith(r.url+'/pair#token='));
 const pairOutput=run(process.execPath,[path.join(here,'pair.mjs'),'--release',release,'--base-dir',r.root]);assert.match(pairOutput,/Token:/); // Deliberately never print or persist the token.
 assert.match(run(path.join(r.root,'fake/fakeok/claude'),['--version'],{env:cleanEnv(r.root)}),/\d/);
 const steps=path.join(proof,'steps.txt'),screen=path.join(proof,'phone.png');
 fs.writeFileSync(steps,`cmd: open ${r.url}\ncmd: set viewport 390 844\ncmd: screenshot ${screen}\ncmd: errors\ncmd: close\n`);
 run('bash',[path.join(here,'ab.sh'),'--session','astra-'+process.pid,'--steps',steps,'--out',path.join(proof,'browser.log')],{timeout:120000});assert.ok(fs.statSync(screen).size>1000);
 assert.equal(fs.existsSync('/home/harout/.cache/hbots-agent-browser/astra-'+process.pid),false);
 // Stopping a root must unlink an internal symlink, never follow it.
 const outside=path.join(proof,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep'),'keep');fs.symlink(outside,path.join(r.root,'outside-link'));
 await stop(r,{remove:false});const backup=path.join(proof,'backup');fs.mkdirSync(backup);fs.copyFileSync(path.join(r.root,'userdata/state.sqlite'),path.join(backup,'state.sqlite'));fs.writeFileSync(path.join(backup,'backup.json'),'{}');
 const migrated=JSON.parse(run(process.execPath,['--disable-warning=ExperimentalWarning',path.join(repo,'scripts/personal/migration-check.cjs')],{env:{...cleanEnv(r.root),PB_CHECK_DB:path.join(backup,'state.sqlite')}}));
 run(process.execPath,[path.join(here,'restore-test.mjs'),'--backup',backup,'--release',release,'--repo-root',repo,'--expect-migration',String(migrated.maxMigration),'--expect-column','effect_sql_migrations.migration_id'],{timeout:120000});
 // Wrong process start-time must never kill even our own recorded process.
 await stop(r);assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'keep');assert.equal(fs.existsSync(r.root),false);r=null;
 console.log('PASS: isolated Brave 390x844 screenshot, pairing (token hidden), fake CLI, server lifecycle, restore integrity/migration, symlink-safe cleanup.');
 console.log('Evidence: '+proof);
}catch(e){throw e;}finally{if(r)await stop(r);}
