#!/usr/bin/env python3
"""Synchronise existing agent-browser skill installations, without deleting files."""
import argparse,hashlib,json,pathlib,re,shutil,sys
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--master',default='/home/harout/Claude/AI/dev-team/tools/agent-browser-skill')
p.add_argument('--base',default='/home/harout/.personal-bots/dev/bot-plugins')
p.add_argument('--check',action='store_true')
LINUX_PATCH='Linux port 26 Oct 2026: runner is tools/ab.sh (ab.py), pinned linux-x64 binary SHA256, Brave only, isolated session HOME under ~/.cache/hbots-agent-browser; docs rewritten for Linux paths, BOM-free'
a=p.parse_args();master=pathlib.Path(a.master);base=pathlib.Path(a.base)
try:
 files={str(f.relative_to(master)):f.read_bytes() for f in master.rglob('*') if f.is_file()}
 if 'SKILL.md' not in files or not files['SKILL.md'].startswith(b'---\n'):raise ValueError('missing BOM-free frontmatter')
 if any(v.startswith(b'\xef\xbb\xbf') for v in files.values()):raise ValueError('master has UTF-8 BOM')
 if any(f.is_symlink() for f in master.rglob('*')):raise ValueError('symlink in master')
 targets=sorted(base.glob('*/.claude/skills/agent-browser'))
 # Some plugin layouts use skills/ rather than .claude/skills/.
 targets+=sorted(base.glob('*/skills/agent-browser'))
 if not targets:raise ValueError('no existing agent-browser installations found')
 digest=hashlib.sha256(files['SKILL.md']).hexdigest()
 for dest in targets:
  if any(f.is_symlink() for f in [dest,*dest.parents] if f!=base.parent):raise ValueError('symlink destination')
  installed={str(f.relative_to(dest)) for f in dest.rglob('*') if f.is_file()}
  extra=installed-files.keys()
  if extra:raise ValueError('stale files require explicit review; not deleted: '+str(extra))
  plugin=next(parent for parent in dest.parents if parent.parent==base)
  lockpath=plugin/'skills-lock.json';manifest=plugin/'.claude-plugin/plugin.json'
  lock=json.loads(lockpath.read_text(encoding='utf-8-sig')) if lockpath.exists() else {'version':1,'skills':{}}
  entry=lock.setdefault('skills',{}).setdefault('agent-browser',{})
  if not a.check:
   for rel,data in files.items():
    out=dest/rel;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(data)
   patches=[x for x in entry.get('localPatches',[]) if x!=LINUX_PATCH]+[LINUX_PATCH]
   entry.update(computedHash=digest,package='agent-browser@0.39.1',skillPath=entry.get('skillPath','skills/agent-browser/SKILL.md'),localPatches=patches)
   lockpath.write_text(json.dumps(lock,indent=2)+'\n')
   if manifest.exists():
    data=json.loads(manifest.read_text(encoding='utf-8-sig'))
    data['description']=data.get('description','').replace('tools/ab.cmd','tools/ab.sh').replace('tools/ab.ps1','tools/ab.sh')
    manifest.write_text(json.dumps(data,indent=2)+'\n')
  if entry.get('computedHash')!=digest:raise ValueError('lock mismatch '+str(plugin))
  for rel,data in files.items():
   if (dest/rel).read_bytes()!=data:raise ValueError('file mismatch '+str(dest/rel))
  if manifest.exists() and re.search(r'ab\.(cmd|ps1)',json.loads(manifest.read_text(encoding='utf-8-sig')).get('description','')):raise ValueError('plugin description still names the Windows runner '+str(manifest))
  for f in [lockpath,manifest]:
   if f.exists() and f.read_bytes().startswith(b'\xef\xbb\xbf'):raise ValueError('JSON BOM '+str(f))
  print('PASS '+str(dest))
 print(f'{len(targets)} installations match; SHA256 {digest}; no BOMs')
except Exception as e:print('FAIL: '+str(e),file=sys.stderr);sys.exit(1)
