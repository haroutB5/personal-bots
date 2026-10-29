import {args,only,required,fs,path,run,cleanEnv,main} from './ops-common.mjs';
import {start,stop} from './throwaway-server.mjs';
import {randomBytes} from 'node:crypto';
main(async()=>{
 const a=args();only(a,['backup','release','repo-root','expect-migration','expect-column','timeout-sec','out']);required(a,'backup','release','repo-root');
 const backup=fs.realpathSync(a.backup);
 if(!fs.existsSync(path.join(backup,'backup.json'))||path.basename(backup)==='userdata'||/^\/home\/harout\/\.personal-bots\/(dev|prod)(\/|$)/.test(backup))throw Error('require an explicit backup directory with backup.json; live roots forbidden');
 const source=path.join(backup,'state.sqlite');if(!fs.lstatSync(source).isFile())throw Error('backup DB must be a regular file (no symlink)');
 for(const suffix of ['-wal','-shm'])if(fs.existsSync(source+suffix))throw Error('require a completed SQLite snapshot, not a live WAL database');
 let r;
 try{
  r=await start({...a,name:'restore-'+randomBytes(5).toString('hex')},{prepare(root){const dest=path.join(root,'userdata');fs.mkdirSync(dest);fs.copyFileSync(source,path.join(dest,'state.sqlite'));}});
  await stop(r,{remove:false});
  const db=path.join(r.root,'userdata/state.sqlite');
  run(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(process.argv[1],{readOnly:true}); const r=d.prepare('PRAGMA integrity_check').all(); d.close(); if(r.length!==1||r[0].integrity_check!=='ok')process.exit(1);",db]);
  if(a['expect-migration']||a['expect-column']){
   const result=JSON.parse(run(process.execPath,['--disable-warning=ExperimentalWarning',path.join(a['repo-root'],'scripts/personal/migration-check.cjs')],{env:{...cleanEnv(r.root),PB_CHECK_DB:db,PB_CHECK_COLUMNS:a['expect-column']||''}}));
   if(a['expect-migration']&&result.maxMigration!==Number(a['expect-migration']))throw Error('migration mismatch');if(Object.values(result.columns).some(v=>!v))throw Error('expected column missing');
  }
  console.log('PASS: backup booted on loopback with schedulers off; integrity and requested migrations passed.');
 }finally{if(r){if(a.out)fs.copyFileSync(path.join(r.root,'server.log'),path.resolve(a.out));await stop(r);}}
});
