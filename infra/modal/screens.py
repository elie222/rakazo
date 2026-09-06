"""Sandbox-local screen registry. Only the trusted Modal controller can mutate it."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time

STATE = Path('/run/cadre')
LIMIT = 9  # One legacy desktop plus eight independent agent screens.

class ScreenUnavailableError(RuntimeError):
    pass

def screen_key(value=None):
    return hashlib.sha256(str(value or 'default').encode()).hexdigest()

def load(key):
    try: return json.loads((STATE / (key + '.json')).read_text())
    except (FileNotFoundError, json.JSONDecodeError): return None

def save(key, state):
    tmp = STATE / (key + '.tmp')
    tmp.write_text(json.dumps(state)); tmp.chmod(0o600)
    tmp.replace(STATE / (key + '.json'))

def fence(value):
    try: return int((value or '').rsplit(':', 1)[1])
    except (ValueError, IndexError): return 0

def demote():
    os.setgroups([]); os.setgid(1000); os.setuid(1000)

def child_env(index, key):
    env = {k:v for k,v in os.environ.items() if not k.startswith(('MODAL_', 'CADRE_SCREEN_', 'RAKAZO_COMPUTER_CONTROL_'))}
    env.update(HOME='/home/rakazo', DISPLAY=f':{index+1}', RAKAZO_BROWSER_PROFILE=f'/home/rakazo/.browser-profiles/bot-{key}')
    return env

def ready(port):
    try:
        with socket.create_connection(('127.0.0.1',port),timeout=.2): return True
    except OSError: return False

def ensure(state, key):
    index = state['index']
    if not ready(6080 + index * 2):
        if index != 0:
            child = subprocess.Popen(['/usr/local/bin/rakazo-computer'], env=child_env(index,key),
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,preexec_fn=demote,start_new_session=True)
            state['pid'] = child.pid
        for _ in range(150):
            if ready(6080 + index * 2): break
            time.sleep(.1)
        else: raise RuntimeError('Cloud desktop did not become ready')
    if not ready(6081 + index * 2):
        env = child_env(index,key)
        for command in [
            ['x11vnc','-display',env['DISPLAY'],'-forever','-shared','-nopw','-listen','127.0.0.1','-rfbport',str(5901+index*2),'-xkb','-noshm','-no6'],
            ['websockify','--heartbeat=30','--web=/usr/share/novnc',f'127.0.0.1:{6081+index*2}',f'127.0.0.1:{5901+index*2}'],
        ]:
            p = subprocess.Popen(command,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
            state.setdefault('controlPids',[]).append(p.pid)
        for _ in range(50):
            if ready(6081+index*2) and ready(5901+index*2): break
            time.sleep(.1)
        else: raise RuntimeError('Cloud control stream did not become ready')
    return state

def retire(state):
    for pid in [state.get('pid'), *state.get('controlPids',[])]:
        if pid:
            try: os.killpg(pid,signal.SIGTERM)
            except ProcessLookupError: pass
    for _ in range(50):
        if not ready(6080+state['index']*2) and not ready(6081+state['index']*2): return
        time.sleep(.1)
    raise RuntimeError('Computer screen is still closing')

def resolve(value=None, lease=None, start=True):
    key = screen_key(value)
    with open(STATE / 'registry.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        state = load(key)
        if state is None:
            entries = [(p.stem,json.loads(p.read_text())) for p in STATE.glob('*.json')]
            used = {s['index'] for _,s in entries}
            if key != screen_key(): used.add(0)  # Keep the startup browser separate from agent profiles.
            free = next((i for i in range(LIMIT) if i not in used),None)
            if free is None:
                idle = [(k,s) for k,s in entries if s['index'] != 0 and not s.get('lease') and s.get('expiresAt',0) <= time.time()]
                if not idle: raise ScreenUnavailableError('Cannot allocate another screen')
                old_key, old = min(idle,key=lambda pair:pair[1].get('usedAt',0))
                retire(old); (STATE / (old_key+'.json')).unlink(); free=old['index']
            state = {'index':free}
        current = state.get('lease')
        if lease and current and current != lease and fence(lease) <= fence(current):
            raise RuntimeError('Stale computer screen lease')
        if lease: state['lease'] = lease
        state['usedAt'] = time.time()
        if start: ensure(state,key)
        save(key,state)
        return key,state

def control(value, lease, token, interactive):
    key,state = resolve(value,start=interactive)
    with open(STATE / 'registry.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        state=load(key)
        if interactive:
            if not token or not lease: raise ValueError('Control lease required')
            state.update(token=token,controlLease=lease,expiresAt=time.time()+3600)
        elif state.get('controlLease') == lease:
            state.pop('token',None); state.pop('controlLease',None);state['expiresAt']=0
        save(key,state)
    return {'ok':True}

def release(value, lease):
    key=screen_key(value)
    with open(STATE / 'registry.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        state=load(key)
        if not state: return {'ok':True}
        current=state.get('lease')
        same_owner = current and lease and current.rsplit(':',1)[0] == lease.rsplit(':',1)[0]
        if not lease or not current or current == lease or (same_owner and fence(lease)>=fence(current)):
            state.pop('lease',None);save(key,state)
    return {'ok':True}
