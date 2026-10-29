import {args,required,only,base,atomic,path,main} from './ops-common.mjs';
import {randomUUID} from 'node:crypto';
main(()=>{const a=args();only(a,['thread-id','version','release','outcome','smoke-exit','rollback-release','rollback-exit','rollback-smoke-exit','log-path','detail','root','base-dir','home']);required(a,'version','release','outcome');
 if(!['live','rolled_back','rollback_failed','failed'].includes(a.outcome))throw Error('invalid outcome');
 if(!/^\d+\.\d+\.\d+$/.test(a.version)||!/^[a-f0-9]{7,40}$/.test(a.release))throw Error('invalid version/release');
 if(!a['thread-id']?.trim()){console.log('No thread-id: no release notice posted.');return;}
 const n={};for(const [key,field] of Object.entries({'thread-id':'threadId',version:'version',release:'release',outcome:'outcome','smoke-exit':'smokeExit','rollback-release':'rollbackRelease','rollback-exit':'rollbackExit','rollback-smoke-exit':'rollbackSmokeExit','log-path':'logPath',detail:'detail'})){
 n[field]=a[key]?.trim()||null;if(key.endsWith('-exit')&&n[field]!==null){if(!/^-?\d+$/.test(n[field]))throw Error('invalid '+key);n[field]=Number(n[field]);}}
 n.writtenAt=new Date().toISOString();const file=path.join(base(a),'personal/release-notices',`${Date.now()}-${a.version}-${a.outcome}-${randomUUID()}.json`);atomic(file,n);console.log('Release notice queued: '+file);
});
