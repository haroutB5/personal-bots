import {args,required,only,base,atomic,fs,path,main} from './ops-common.mjs';
main(()=>{const a=args(undefined,['owner-approved','cancel']);only(a,['owner-approved','cancel','root','base-dir','home']);if(!a['base-dir'])required(a,'root');const dir=path.join(base(a),'personal'), file=path.join(dir,'browser-profile-reset.request');
 if(a.cancel){fs.rmSync(file,{force:true});console.log('Reset request cancelled.');return;}
 if(!a['owner-approved'])throw Error('Owner approval required: this signs the shared browser out of every site.');
 if(!fs.statSync(dir).isDirectory())throw Error('personal directory missing');atomic(file,{requestedAt:new Date().toISOString(),requestedBy:process.env.USER||'unknown'});console.log('Reset requested for next start; no restart performed.');
});
