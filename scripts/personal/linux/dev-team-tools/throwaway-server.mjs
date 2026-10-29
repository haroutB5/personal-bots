import {fs,path,os,args,only,required,atomic,cleanEnv,resolveBin,run,main} from './ops-common.mjs';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
const prefix='hbots-tw-', marker='throwaway.json';
function valid(name){if(!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name||''))throw Error('name must be 1-31 lower-case letters/digits/dashes');}
function ticks(pid){try{return fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19];}catch{return null;}}
function identity(r){try{const cmd=fs.readFileSync(`/proc/${r.pid}/cmdline`,'utf8').split('\0');return ticks(r.pid)===r.ticks&&cmd.includes(r.bin)&&cmd.includes(r.root);}catch{return false;}}
function records(){return fs.readdirSync('/tmp').filter(n=>n.startsWith(prefix)).flatMap(n=>{const root=path.join('/tmp',n);try{const st=fs.lstatSync(root);if(!st.isDirectory()||st.uid!==process.getuid())return [];const r=JSON.parse(fs.readFileSync(path.join(root,marker),'utf8'));return r.tool==='linux-throwaway-v1'&&r.root===root?[r]:[];}catch{return [];}});}
export function find(name){valid(name);const found=records().filter(r=>r.name===name);if(found.length!==1)throw Error('expected exactly one owned root for '+name);return found[0];}
export async function stop(r,{remove=true}={}){
 if(identity(r)){process.kill(r.pid,'SIGTERM');for(let i=0;i<100&&identity(r);i++)await delay(100);if(identity(r)){process.kill(r.pid,'SIGKILL');for(let i=0;i<30&&identity(r);i++)await delay(100);}if(identity(r))throw Error('server did not stop');}
 else if(r.pid&&ticks(r.pid)===r.ticks)throw Error('recorded PID command changed; refusing cleanup');
 if(remove){const st=fs.lstatSync(r.root);if(st.isSymbolicLink()||st.uid!==process.getuid()||!r.root.startsWith('/tmp/'+prefix))throw Error('unsafe root');const stored=JSON.parse(fs.readFileSync(path.join(r.root,marker),'utf8'));if(stored.root!==r.root||stored.tool!=='linux-throwaway-v1')throw Error('unowned root');fs.rmSync(r.root,{recursive:true});}
}
async function freePort(){const s=net.createServer();await new Promise((yes,no)=>s.listen(0,'127.0.0.1',yes).once('error',no));const p=s.address().port;await new Promise(yes=>s.close(yes));return p;}
function settings(root,repo){const source=path.join(repo,'scripts/personal/testing/fake-claude');for(const persona of ['fakeok','fakelimit']){
 const dir=path.join(root,'fake',persona),pkg=path.join(dir,'node_modules/@anthropic-ai/claude-code');fs.mkdirSync(pkg,{recursive:true});for(const f of ['cli.js','package.json'])fs.copyFileSync(path.join(source,f),path.join(pkg,f));
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";fs.writeFileSync(path.join(dir,'claude'),`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(pkg,'cli.js'))} "$@"\n`,{mode:0o700});}
 const providers={};for(const key of ['claudeAgent','codex','deepseek','opencode','cursor','grok'])providers[key]={enabled:key==='claudeAgent',homePath:path.join(root,'homes',key)};
 providers.claudeAgent.binaryPath=path.join(root,'fake/fakeok/claude');atomic(path.join(root,'userdata/settings.json'),{providers,providerInstances:{claudeLimited:{driver:'claudeAgent',displayName:'Fake limited',config:{binaryPath:path.join(root,'fake/fakelimit/claude'),homePath:path.join(root,'homes/claudeAgent')}}}});
}
async function boot(r,timeoutSec){
 const log=fs.openSync(path.join(r.root,'server.log'),'a',0o600);
 const child=spawn(process.execPath,[r.bin,'serve','--base-dir',r.root,'--host','127.0.0.1','--port',String(r.port),'--no-browser'],{cwd:r.root,env:cleanEnv(r.root,r.schedulersOff),detached:true,stdio:['ignore',log,log]});fs.closeSync(log);
 await new Promise((yes,no)=>{child.once('spawn',yes);child.once('error',no);});r.pid=child.pid;r.ticks=ticks(child.pid);atomic(path.join(r.root,marker),r);child.unref();
 const deadline=Date.now()+Number(timeoutSec||60)*1000;
 while(Date.now()<deadline&&identity(r)){
  try{const response=await fetch(`http://127.0.0.1:${r.port}/.well-known/t3/environment`,{signal:AbortSignal.timeout(1000)});if(response.ok){r.url=`http://127.0.0.1:${r.port}`;atomic(path.join(r.root,marker),r);return true;}}catch{}await delay(250);
 }
 return false;
}
export async function start(a,{prepare}={}){
 required(a,'name','release','repo-root');valid(a.name);if(records().some(r=>r.name===a.name))throw Error('name already exists');
 const bin=resolveBin(a.release),root=fs.mkdtempSync('/tmp/'+prefix+a.name+'-');fs.chmodSync(root,0o700);
 const r={tool:'linux-throwaway-v1',name:a.name,root,bin,pid:null,ticks:null,schedulersOff:Boolean(a['schedulers-off']),port:Number(a.port||await freePort())};
 if(!Number.isInteger(r.port)||r.port<1024||r.port>65535){fs.rmdirSync(root);throw Error('invalid port');}
 atomic(path.join(root,marker),r);
 try{
  if(prepare)await prepare(root);settings(root,path.resolve(a['repo-root']));
  if(await boot(r,a['timeout-sec']))return r;
  throw Error('throwaway failed to start (inspect release compatibility)');
 }catch(e){await stop(r);throw e;}
}
export function pair(r){if(!identity(r))throw Error('server not running');const out=run(process.execPath,[r.bin,'pair','--base-dir',r.root,'--ttl','15m'],{env:cleanEnv(r.root,r.schedulersOff),cwd:r.root});const token=out.match(/^\s*Token:\s*(\S+)/m);if(!token)throw Error('pair command did not return token');return `${r.url}/pair#token=${token[1]}`;}
if(process.argv[1]===new URL(import.meta.url).pathname)main(async()=>{const a=args(undefined,['json','no-pair','schedulers-off']);only(a,['name','release','repo-root','port','timeout-sec','json','no-pair','schedulers-off']);const cmd=a._[0]||'start';
 if(cmd==='list'){console.log(JSON.stringify(records().map(r=>({...r,running:identity(r)}))));return;}
 if(cmd==='up'){const r=find(a.name||a._[1]);if(identity(r))throw Error(r.name+' is already running');if(r.pid&&ticks(r.pid)===r.ticks)throw Error("recorded PID command changed; refusing");if(!await boot(r,a['timeout-sec'])){await stop(r,{remove:false});throw Error('server did not come back up on port '+r.port);}console.log(JSON.stringify(r));return;}
 if(['stop','pair','down'].includes(cmd)){const r=find(a.name||a._[1]);if(cmd==='pair')console.log(pair(r));else {await stop(r,{remove:cmd==='stop'});console.log(cmd+' '+r.name);}return;}
 if(cmd!=='start')throw Error('commands: start, stop, down, up, pair, list');const r=await start(a);try{console.log(JSON.stringify({...r,...(a['no-pair']?{}:{pairing:pair(r)})}));}catch(e){await stop(r);throw e;}
});
