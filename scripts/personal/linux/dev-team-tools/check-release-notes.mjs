import {args,required,only,fs,path,run,main} from './ops-common.mjs';
export function checkNotes(text){
 if(text.trim().length<200)throw Error('release notes are a stub (<200 characters)');
 let fence=null;
 for(const [i,line] of text.split(/\r?\n/).entries()){
  const m=line.match(/^\s*(`{3,}|~{3,})/);if(m){if(!fence)fence=m[1];else if(m[1][0]===fence[0]&&m[1].length>=fence.length)fence=null;continue;}if(fence)continue;
  const s=line.replace(/`[^`]*`/g,' ');
  if(/\b(?:[A-Z][A-Z0-9_]*_PLACEHOLDER|PLACEHOLDER|TODO|TBD|FIXME|XXX)\b/.test(s)||/\bto be (filled|written|added|determined|completed)\b|<\s*(fill|insert|todo|tbd|placeholder)[^>]*>|lorem ipsum/i.test(s))throw Error('unfinished release notes at line '+(i+1));
 }
}
if(process.argv[1]===new URL(import.meta.url).pathname)main(()=>{
 const a=args();only(a,['version','repo-root','commit','path']);required(a,'version');if(!/^\d+\.\d+\.\d+$/.test(a.version))throw Error('version must be x.y.z');
 if(a.commit&&!/^[a-f0-9]{7,40}$/.test(a.commit))throw Error('commit must be a SHA');
 if(a.commit&&a.path)throw Error('path and commit are mutually exclusive');
 const parts=a.version.split('.'), names=['HANDOFF-'+parts.join('')+'.md'];if(parts[2]==='0')names.push('HANDOFF-'+parts.slice(0,2).join('')+'.md');
 let text,source;if(a.path){source=path.resolve(a.path);text=fs.readFileSync(source,'utf8');}else {required(a,'repo-root');if(a.commit)run('git',['-C',a['repo-root'],'cat-file','-e',a.commit+'^{commit}']);for(const n of names){source='docs/releases/'+n;try{text=a.commit?run('git',['-C',a['repo-root'],'show',a.commit+':'+source]):fs.readFileSync(path.join(a['repo-root'],source),'utf8');break;}catch{}}}
 if(text===undefined)throw Error('release notes missing');checkNotes(text);console.log('PASS: '+source);
});
