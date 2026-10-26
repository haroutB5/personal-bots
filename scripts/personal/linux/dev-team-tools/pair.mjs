import {args,only,required,resolveBin,cleanEnv,run,main} from './ops-common.mjs';
main(()=>{const a=args(undefined,['connect']);only(a,['release','base-dir','ttl','connect']);required(a,'release','base-dir');if(a.ttl&&!/^\d+[smh]$/.test(a.ttl))throw Error('ttl must be e.g. 15m');
 const output=run(process.execPath,[resolveBin(a.release),'pair','--base-dir',a['base-dir'],'--ttl',a.ttl||'15m',...(a.connect?['--connect']:[])],{env:cleanEnv(a['base-dir'])});process.stdout.write(output);
});
