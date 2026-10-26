#!/usr/bin/env python3
"""Pinned, isolated agent-browser runner. Never invokes a shell for commands."""
import argparse, fcntl, hashlib, json, os, pathlib, re, shlex, shutil, subprocess, sys, tempfile, time
BASE = pathlib.Path(__file__).resolve().parent
EXE = pathlib.Path('/home/harout/Claude/AI/dev-team/tools/agent-browser-runtime/node_modules/agent-browser/bin/agent-browser-linux-x64')
PIN = '6906d3a2a67b05809932a93d99e53d1132373f0a52a617b2d6032dbb954df6fc'
CONFIG = {'executablePath':'/usr/bin/brave','headed':False,'hideScrollbars':True,'autoConnect':False,'noWebmcp':True,'colorScheme':'dark','contentBoundaries':True,'idleTimeout':'300000'}
ROOT = pathlib.Path('/home/harout/.cache/hbots-agent-browser')
BANNED = set('connect profiles plugin dashboard chat install upgrade doctor mcp auth record stream state devices uninstall session'.split())
FLAGS = set('auto-connect cdp profile restore restore-save restore-check-url restore-check-text restore-check-fn state session session-name args provider p executable-path extension init-script user-agent proxy proxy-bypass ignore-https-errors ca-cert no-ca-cert use-system-ca allow-file-access download-path headers config namespace device enable headed webgpu confirm-interactive action-policy idle-timeout model no-pin-tab autosave-interval-ms all'.split())
class Refused(Exception): pass
class Failed(Exception): pass

def screen(tokens, depth=0):
    if not tokens or depth > 4: raise Refused('empty command or nested batch too deep')
    if tokens[0].startswith('-') or tokens[0] in BANNED: raise Refused('banned command')
    for i,t in enumerate(tokens):
        k=t.split('=')[0].lstrip('-')
        if t.startswith('-') and (k in FLAGS or k.startswith('restore')): raise Refused('banned flag: '+k)
        if k=='engine' and (t.split('=',1)[1] if '=' in t else tokens[i+1] if i+1<len(tokens) else '')!='chrome': raise Refused('only chrome engine allowed')
    if tokens[0]=='batch':
        for t in tokens[1:]:
            if t != '--bail': screen(shlex.split(t.replace('\\','')), depth+1)
    return tokens

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for n in ['session','cmd','steps','out']: p.add_argument('--'+n)
    for n in ['close','sweep','check','dry-run','json','show-log']: p.add_argument('--'+n,action='store_true')
    for n,d in [('timeout-sec',120),('idle-sec',300),('depth',6),('tries',8),('wait-ms',1500)]: p.add_argument('--'+n,type=int,default=d)
    a=p.parse_args()
    if not 1<=a.timeout_sec<=600 or not 1<=a.idle_sec<=900 or not 1<=a.tries<=30 or not 0<=a.wait_ms<=10000 or not 1<=a.depth<=100: raise Refused('numeric bound exceeded')
    if hashlib.sha256(EXE.read_bytes()).hexdigest()!=PIN: raise RuntimeError('binary pin mismatch')
    env={k:v for k,v in os.environ.items() if not re.match(r'^(AGENT_BROWSER_|BROWSER_USE_|OBSCURA_|AI_GATEWAY_)',k,re.I) and k.lower() not in ['http_proxy','https_proxy','all_proxy','no_proxy']}
    if a.check:
        version=subprocess.run([str(EXE),'--version'],env=env,capture_output=True,text=True,timeout=10,check=True).stdout.strip()
        if version!='agent-browser 0.39.1': raise RuntimeError('version mismatch: '+version)
        print(json.dumps({'version':version,'sha256':PIN,'browser':'/usr/bin/brave'})); return
    if a.sweep and not a.session:
        print('\n'.join(x.name for x in ROOT.iterdir() if x.is_dir()) if ROOT.exists() else ''); return
    if not a.session or not re.fullmatch(r'[a-z][a-z0-9]*(-[a-z0-9]+)+',a.session) or not 5<=len(a.session)<=40: raise Refused('session must be <bot>-<task8>, 5-40 lower-case characters')
    if sum(bool(x) for x in [a.cmd,a.steps,a.close,a.sweep])!=1: raise Refused('choose cmd, steps, close or sweep')
    if pathlib.Path('agent-browser.json').exists(): raise Refused('project agent-browser.json exists')
    session=ROOT/a.session
    ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    if session.is_symlink(): raise Refused('session is a symlink')
    session.mkdir(mode=0o700,exist_ok=True)
    lock=open(ROOT/(a.session+'.lock'),'a'); fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    env.pop('XDG_RUNTIME_DIR',None)
    env.update(HOME=str(session),XDG_CONFIG_HOME=str(session/'config'),XDG_CACHE_HOME=str(session/'cache'),XDG_DATA_HOME=str(session/'data'))
    config=session/'clean.json'; config.write_text(json.dumps(CONFIG))
    args=[str(EXE),'--config',str(config),'--session',a.session,'--idle-timeout',str(a.idle_sec*1000)]
    if a.json: args+=['--json']
    refs={}; previous=''; log=[]; closed=False
    def call(tokens):
        nonlocal previous, closed
        screen(tokens)
        if a.dry_run:
            print(json.dumps({'argv':args+tokens,'isolatedHome':str(session),'sanitisedEnvironment':True})); return ''
        # Regular files prevent a daemon retaining a parent's stdout pipe.
        with tempfile.TemporaryFile() as out:
            proc=subprocess.Popen(args+tokens,env=env,cwd=session,stdin=subprocess.DEVNULL,stdout=out,stderr=out,start_new_session=True)
            try: code=proc.wait(timeout=a.timeout_sec)
            except subprocess.TimeoutExpired:
                proc.kill(); proc.wait(); raise
            out.seek(0); previous=out.read().decode(errors='replace')
        log.append(previous)
        if code: raise Failed(previous[-2000:])
        if tokens == ['close']: closed=True
        return previous
    def command(line):
        tokens=shlex.split(line)
        tokens=[('@'+refs[t[1:]]) if t.startswith('@') and t[1:] in refs else t for t in tokens]
        return call(tokens)
    def dead():
        for f in (session/'.agent-browser').glob('*.pid'):
            try: os.kill(int(f.read_text().strip()),0); return False
            except ProcessLookupError: pass
        return True
    try:
        if a.sweep:
            if not dead(): raise Refused('daemon alive; use --close first')
            shutil.rmtree(session); return
        if a.close:
            if not dead(): call(['close'])
            else: closed=True
            print('closed '+a.session); return
        if a.cmd: print(command(a.cmd),end=''); return
        lines=pathlib.Path(a.steps).read_text().splitlines(); batch=None
        # Screen all direct commands before opening a browser.
        for line in lines:
            s=line.strip()
            if s.startswith('cmd:'): screen(shlex.split(s[4:].strip()))
        for line in lines:
            s=line.strip()
            if not s or s.startswith('#'): continue
            if batch is not None:
                if s=='end': call(['batch','--bail']+batch); batch=None
                else: batch.append(s)
                continue
            if s=='batch:': batch=[]; continue
            if s.startswith('cmd:'): command(s[4:].strip())
            elif s.startswith('expect:'):
                if s[7:].strip() not in previous: raise Failed('expected text absent')
            elif s.startswith('text:') or s.startswith('ref '):
                m=re.fullmatch(r'ref (\w+) = (.+)',s) if s.startswith('ref ') else None
                if s.startswith('ref ') and not m: raise Refused('invalid ref syntax')
                needle=m[2] if m else s[5:].strip()
                for attempt in range(a.tries):
                    snap=call(['snapshot','-d',str(a.depth)])
                    matches=[x for x in snap.splitlines() if needle in x]
                    hit=next((re.search(r'\[ref=(e\d+)\]',x) for x in matches if re.search(r'\[ref=(e\d+)\]',x)),None)
                    if (m and hit) or (not m and matches):
                        if m: refs[m[1]]=hit[1]
                        break
                    time.sleep(a.wait_ms/1000)
                else: raise Failed('text/ref absent: '+needle)
            else: raise Refused('unknown step: '+s)
            print('PASS '+s.split(':')[0])
        if batch is not None: raise Refused('unterminated batch')
    finally:
        if a.steps or a.close:
            if not a.dry_run:
                try:
                    if not closed and not dead(): call(['close'])
                    for _ in range(50):
                        if dead(): break
                        time.sleep(0.1)
                    if dead(): shutil.rmtree(session)
                    else: raise Failed('daemon did not exit; session retained for --close')
                finally:
                    if a.out: pathlib.Path(a.out).write_text('\n'.join(log))
        if a.out: pathlib.Path(a.out).write_text('\n'.join(log))
        if a.show_log: print('\n'.join(log))

if __name__=='__main__':
    try: main()
    except Refused as e: print('REFUSED: '+str(e),file=sys.stderr); sys.exit(2)
    except Failed as e: print(str(e),file=sys.stderr); sys.exit(3)
    except subprocess.TimeoutExpired: print('command timeout',file=sys.stderr); sys.exit(4)
    except Exception as e: print(str(e),file=sys.stderr); sys.exit(5)
