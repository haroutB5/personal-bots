import {args,only,required,resolveBin,run,main} from './ops-common.mjs';
main(()=>{const a=args(undefined,['connect']);only(a,['release','base-dir','ttl','connect']);required(a,'release','base-dir');if(a.ttl&&!/^\d+[smh]$/.test(a.ttl))throw Error('ttl must be e.g. 15m');
 const output=run(process.execPath,[resolveBin(a.release),'pair','--base-dir',a['base-dir'],'--ttl',a.ttl||'15m',...(a.connect?['--connect']:[])],{env:originEnv()});process.stdout.write(output);
});
function originEnv(){const env={...process.env};for(const k of ['VITE_DEV_SERVER_URL','VITE_HTTP_URL','VITE_WS_URL','T3CODE_HOME','T3CODE_PORT','T3CODE_MODE','T3CODE_PERSONAL_STALL_DIR','T3CODE_PERSONAL_SCHEDULERS'])delete env[k];return env;}
