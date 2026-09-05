"""Sandbox-local operations. Reachable only through authenticated Modal exec."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path('/home/rakazo').resolve()
LIMIT = 64 * 1024 * 1024
SCREEN = Path('/tmp/cadre-screen.json')

def target(value):
    raw = str(value)
    relative = raw[len(str(ROOT)):].lstrip('/') if raw == str(ROOT) or raw.startswith(str(ROOT) + '/') else raw.lstrip('/')
    if '\\' in relative or any(p in ('.', '..') for p in relative.split('/')):
        raise ValueError('Invalid workspace path')
    p = (ROOT / relative).resolve()
    if not p.is_relative_to(ROOT):
        raise ValueError('Path escapes workspace')
    return p

def marker(key):
    return Path('/tmp/cadre-process-' + hashlib.sha256(key.encode()).hexdigest())

def ensure_directory(directory):
    missing = []
    cursor = directory
    while not cursor.exists():
        missing.append(cursor)
        cursor = cursor.parent
    for entry in reversed(missing):
        entry.mkdir(exist_ok=True)
        os.chown(entry, 1000, 1000)

def demote():
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)

def execute(req):
    key = req['operationId']
    cwd = target(req.get('cwd') or '')
    ensure_directory(cwd)
    env = {**os.environ, **req.get('env', {})}
    # Platform credentials never enter ordinary shell commands.
    for name in list(env):
        if name.startswith(('MODAL_', 'CADRE_SCREEN_', 'RAKAZO_COMPUTER_CONTROL_')):
            env.pop(name)
    if marker(key + ':cancel').exists():
        return {'stdout': '', 'stderr': 'Cancelled', 'code': 130}
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p = subprocess.Popen(req['argv'], cwd=cwd, env=env, stdout=out, stderr=err, start_new_session=True, preexec_fn=demote)
        marker(key).write_text(str(p.pid))
        if marker(key + ':cancel').exists():
            os.killpg(p.pid, signal.SIGKILL)
        code = None
        try:
            try:
                code = p.wait(timeout=min(max(req.get('timeoutMs', 300000), 1), 3600000) / 1000)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGTERM)
                try: p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(p.pid, signal.SIGKILL)
                    p.wait()
                code = 124
            out.seek(0); err.seek(0)
            return {'stdout': out.read(4 * 1024 * 1024).decode(errors='replace'), 'stderr': err.read(1024 * 1024).decode(errors='replace'), 'code': code}
        finally:
            marker(key).unlink(missing_ok=True)
            marker(key + ':cancel').unlink(missing_ok=True)

def screenshot():
    image = subprocess.check_output(['import', '-display', ':1', '-window', 'root', 'png:-'], timeout=20)
    dims = subprocess.check_output(['xdotool', 'getdisplaygeometry'], env={**os.environ, 'DISPLAY': ':1'}, timeout=5).decode().split()
    return {'image': base64.b64encode(image).decode(), 'mimeType': 'image/png', 'width': int(dims[0]), 'height': int(dims[1])}

def actions(req):
    values = req.get('actions', [])
    if len(values) > 24: raise ValueError('Too many actions')
    env = {**os.environ, 'DISPLAY': ':1'}
    for a in values:
        kind = a['kind']
        argv = None
        if kind == 'wait': time.sleep(min(max(a['ms'], 0), 5000) / 1000)
        elif kind == 'key': argv = ['xdotool', 'key', '--clearmodifiers', '+'.join(a.get('modifiers', []) + [a['key']])]
        elif kind == 'clipboard': argv = ['xdotool', 'type', '--clearmodifiers', '--', a['text']]
        elif kind == 'pointer':
            button = '3' if a.get('button') == 'right' else '1'
            move = ['xdotool', 'mousemove', '--', str(round(a['x'])), str(round(a['y']))]
            if a['type'] == 'move': argv = move
            elif a['type'] == 'up': argv = ['xdotool', 'mouseup', button]
            elif a['type'] == 'down': argv = move + ['mousedown', button]
            else: argv = move + ['click', button]
        elif kind == 'scroll': argv = ['xdotool', 'click', '--repeat', str(min(max(round(a.get('amount', 3)), 1), 20)), '4' if a['direction'] == 'up' else '5']
        elif kind == 'open':
            location = a['path'] if a['path'].startswith(('http://', 'https://')) else str(target(a['path']))
            subprocess.Popen(['xdg-open', location], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, preexec_fn=demote)
        elif kind == 'launch':
            application = 'rakazo-browser' if a['application'].lower() in ('browser', 'chromium', 'chrome') else a['application']
            subprocess.Popen([application] + ([a['uri']] if a.get('uri') else []), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, preexec_fn=demote)
        else: raise ValueError('Unsupported action')
        if argv: subprocess.run(argv, env=env, check=True, timeout=20)
    time.sleep(min(max(req.get('settleMs', 0), 0), 5000) / 1000)
    return {'completed': len(values), **({'observation': screenshot()} if req.get('observe') else {})}

def run(req):
    op = req['op']
    if op == 'exec': return execute(req)
    if op == 'cancel':
        marker(req['operationId'] + ':cancel').touch()
        p = marker(req['operationId'])
        if p.exists():
            try: os.killpg(int(p.read_text()), signal.SIGKILL)
            except ProcessLookupError: pass
        return {'ok': True}
    if op == 'observe': return screenshot()
    if op == 'input':
        current = json.loads(SCREEN.read_text()) if SCREEN.exists() else {}
        if not req.get('leaseId') or current.get('leaseId') != req['leaseId'] or current.get('expiresAt', 0) <= time.time():
            raise ValueError('Control lease expired')
        return actions(req)
    if op == 'actions': return actions(req)
    if op == 'list':
        directory = target(req['path'])
        if not directory.exists(): return []
        rows = []
        for p in directory.iterdir():
            if p.is_symlink() or not (p.is_file() or p.is_dir()): continue
            info = p.stat()
            rows.append({'path': str(p.relative_to(ROOT)), 'kind': 'dir' if p.is_dir() else 'file', 'size': info.st_size, 'executable': bool(info.st_mode & 0o100)})
        return rows
    if op == 'read':
        p = target(req['path'])
        if p.stat().st_size > min(req.get('maxBytes', LIMIT), LIMIT): raise ValueError('File exceeds size limit')
        return {'content': base64.b64encode(p.read_bytes()).decode()}
    if op == 'write':
        p = target(req['path']); data = base64.b64decode(req['content'], validate=True)
        if len(data) > LIMIT: raise ValueError('File exceeds size limit')
        ensure_directory(p.parent)
        with tempfile.NamedTemporaryFile(dir=p.parent, delete=False) as f:
            f.write(data); tmp = Path(f.name)
        tmp.chmod(0o700 if req.get('executable') else 0o600); os.chown(tmp, 1000, 1000); tmp.replace(p)
        return {'ok': True}
    if op == 'screen':
        with open('/tmp/cadre-screen.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            current = json.loads(SCREEN.read_text()) if SCREEN.exists() else {}
            if req.get('interactive'):
                if not req.get('controlToken') or not req.get('leaseId'): raise ValueError('Control lease required')
                next_value = {'token': req['controlToken'], 'leaseId': req['leaseId'], 'expiresAt': time.time() + 3600}
            elif current.get('leaseId') != req.get('leaseId'):
                return {'ok': True}
            else: next_value = {}
            tmp = SCREEN.with_suffix('.tmp'); tmp.write_text(json.dumps(next_value)); tmp.chmod(0o600); tmp.replace(SCREEN)
        return {'ok': True}
    raise ValueError('Unsupported operation')

if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.read(96 * 1024 * 1024))
        print(json.dumps(run(request), separators=(',', ':')))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
