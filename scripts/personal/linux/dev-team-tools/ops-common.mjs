import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
export {fs,path,os};
export function args(argv=process.argv.slice(2), booleans=[]) {
  const out={_:[]};
  for(let i=0;i<argv.length;i++) {const a=argv[i]; if(!a.startsWith('--')) {out._.push(a);continue;} const k=a.slice(2); if(booleans.includes(k)){out[k]=true;continue;} if(!argv[i+1]||argv[i+1].startsWith('--')) throw Error('Missing value for '+a); if(Object.hasOwn(out,k))throw Error('Duplicate '+a); out[k]=argv[++i];} return out;
}
export function required(a,...keys){for(const k of keys)if(!a[k])throw Error('Required --'+k);}
export function only(a,keys){for(const k of Object.keys(a))if(k!=='_'&&!keys.includes(k))throw Error('Unknown --'+k);}
export function run(cmd,argv,options={}){const r=spawnSync(cmd,argv,{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe'],...options});if(r.error||r.status!==0)throw Error(`${cmd} failed (${r.status}): ${[r.stderr,r.stdout].map(t=>(t||'').split('\n').filter(l=>/\w/.test(l)&&!/^\s+at /.test(l)).slice(-3).join(' | ')).find(Boolean)||r.error?.message||''}`);return r.stdout;}
export const home='/home/harout/.personal-bots';
export function base(a){if(a['base-dir'])return path.resolve(a['base-dir']);if(a.root&&!['dev','prod'].includes(a.root))throw Error('root must be dev or prod');return path.join(a.home||home,a.root||'dev');}
export function atomic(file,data){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data)+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}
export function cleanEnv(root,schedulersOff=true){return {PATH:'/usr/bin:/bin:'+path.dirname(process.execPath),HOME:root,LANG:'C.UTF-8',XDG_CONFIG_HOME:path.join(root,'homes/config'),XDG_DATA_HOME:path.join(root,'homes/data'),XDG_CACHE_HOME:path.join(root,'homes/cache'),...(process.env.OMARCHY_PATH?{OMARCHY_PATH:process.env.OMARCHY_PATH}:{}),...(process.env.DBUS_SESSION_BUS_ADDRESS?{DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}:{}),PERSONAL_SEED_MODEL:'claude-sonnet-5-5',...(schedulersOff?{T3CODE_PERSONAL_SCHEDULERS:'off'}:{}),T3CODE_PERSONAL_BROWSER_HEADLESS:'1',T3CODE_AUTO_CONNECT:'false',T3CODE_ENVIRONMENT_LABEL:'Throwaway test',GROK_HOME:path.join(root,'homes/grok'),OPENCODE_DATA_DIR:path.join(root,'homes/opencode'),ANTIGRAVITY_DATA_DIR:path.join(root,'homes/antigravity'),FAKE_CLAUDE_PID_DIR:path.join(root,'fake-pids')};}
export function resolveBin(release){const dir=/^[a-f0-9]{7,40}$/.test(release)?path.join(home,'releases',release):path.resolve(release);for(const rel of ['dist/bin.mjs','apps/server/dist/bin.mjs']){const p=path.join(dir,rel);if(fs.existsSync(p))return fs.realpathSync(p);}throw Error('No built server under '+dir);}
export function main(fn){Promise.resolve().then(fn).catch(e=>{console.error('FAIL: '+e.message);process.exitCode=1;});}
