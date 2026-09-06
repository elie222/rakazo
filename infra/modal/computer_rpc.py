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
import stat
from contextlib import contextmanager
import uuid
import time
import screens

ROOT = Path('/home/rakazo').resolve()
LIMIT = 64 * 1024 * 1024

def target(value):
    raw = str(value)
    relative = raw[len(str(ROOT)):].lstrip('/') if raw == str(ROOT) or raw.startswith(str(ROOT) + '/') else raw.lstrip('/')
    if '\\' in relative or any(p in ('.', '..') for p in relative.split('/')):
        raise ValueError('Invalid workspace path')
    p = (ROOT / relative).resolve()
    if not p.is_relative_to(ROOT):
        raise ValueError('Path escapes workspace')
    return p

def workspace_parts(value):
    raw=str(value)
    relative=raw[len(str(ROOT)):].lstrip('/') if raw==str(ROOT) or raw.startswith(str(ROOT)+'/') else raw.lstrip('/')
    if '\\' in relative or any(p in ('.','..') for p in relative.split('/')):raise ValueError('Invalid workspace path')
    return [p for p in relative.split('/') if p]

@contextmanager
def workspace_dir(parts, create=False):
    fd=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts:
            if create:
                try:os.mkdir(part,0o700,dir_fd=fd)
                except FileExistsError:pass
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            if create:os.fchown(child,1000,1000)
            os.close(fd);fd=child
        yield fd
    finally:os.close(fd)


def marker(key):
    return screens.STATE / ('process-' + hashlib.sha256(key.encode()).hexdigest())

def demote():
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)

def execute(req):
    key = req['operationId']
    parts = workspace_parts(req.get('cwd') or '')
    env = {**os.environ, **req.get('env', {})}
    if req.get('screenKey'):
        try:
            screen_key, state = screens.resolve(req['screenKey'], req.get('screenLease'))
            env = {**screens.child_env(state['index'], screen_key), **req.get('env', {})}
            env['DISPLAY'] = f":{state['index']+1}"
        except screens.ScreenUnavailableError:
            # File and shell work can continue without borrowing another bot's display.
            env['DISPLAY'] = ''
    # Platform credentials never enter ordinary shell commands.
    for name in list(env):
        if name.startswith(('MODAL_', 'CADRE_SCREEN_', 'RAKAZO_COMPUTER_CONTROL_')):
            env.pop(name)
    if marker(key + ':cancel').exists():
        return {'stdout': '', 'stderr': 'Cancelled', 'code': 130}
    with workspace_dir(parts, create=True) as directory, tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p = subprocess.Popen(req['argv'], cwd=f'/proc/self/fd/{directory}', pass_fds=(directory,), env=env, stdout=out, stderr=err, start_new_session=True, preexec_fn=demote)
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

def screenshot(req):
    _, state = screens.resolve(req.get('screenKey'), req.get('screenLease'))
    display = f":{state['index']+1}"
    image = subprocess.check_output(['import', '-display', display, '-window', 'root', 'png:-'], timeout=20)
    dims = subprocess.check_output(['xdotool', 'getdisplaygeometry'], env={**os.environ, 'DISPLAY': display}, timeout=5).decode().split()
    return {'image': base64.b64encode(image).decode(), 'mimeType': 'image/png', 'width': int(dims[0]), 'height': int(dims[1])}

def actions(req):
    values = req.get('actions', [])
    if len(values) > 24: raise ValueError('Too many actions')
    key, state = screens.resolve(req.get('screenKey'), req.get('screenLease'))
    env = screens.child_env(state['index'], key)
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
    return {'completed': len(values), **({'observation': screenshot(req)} if req.get('observe') else {})}

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
    if op == 'observe': return screenshot(req)
    if op == 'input':
        current = screens.load(screens.screen_key(req.get('screenKey'))) or {}
        if not req.get('leaseId') or current.get('controlLease') != req['leaseId'] or current.get('expiresAt', 0) <= time.time():
            raise ValueError('Control lease expired')
        return actions(req)
    if op == 'actions': return actions(req)
    if op == 'list':
        parts=workspace_parts(req['path']);rows=[]
        try:
            with workspace_dir(parts) as fd:
                for name in os.listdir(fd):
                    try:info=os.stat(name,dir_fd=fd,follow_symlinks=False)
                    except FileNotFoundError:continue
                    if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):continue
                    rows.append({'path':'/'.join([*parts,name]),'kind':'dir' if stat.S_ISDIR(info.st_mode) else 'file','size':info.st_size,'executable':bool(info.st_mode&0o100)})
        except FileNotFoundError:return []
        return rows
    if op == 'read':
        parts=workspace_parts(req['path'])
        if not parts:raise ValueError('File path required')
        with workspace_dir(parts[:-1]) as parent:
            fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
            with os.fdopen(fd,'rb') as f:
                info=os.fstat(f.fileno());limit=min(req.get('maxBytes',LIMIT),LIMIT)
                if not stat.S_ISREG(info.st_mode) or info.st_size>limit:raise ValueError('File exceeds size limit or is not regular')
                data=f.read(limit+1)
                if len(data)>limit:raise ValueError('File exceeds size limit')
                return {'content':base64.b64encode(data).decode()}
    if op == 'write':
        parts=workspace_parts(req['path']);data=base64.b64decode(req['content'],validate=True)
        if not parts or len(data)>LIMIT:raise ValueError('Invalid file or size')
        with workspace_dir(parts[:-1],create=True) as parent:
            name='.cadre-write-'+uuid.uuid4().hex
            fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
            try:
                with os.fdopen(fd,'wb') as f:
                    f.write(data);os.fchmod(f.fileno(),0o700 if req.get('executable') else 0o600);os.fchown(f.fileno(),1000,1000)
                os.replace(name,parts[-1],src_dir_fd=parent,dst_dir_fd=parent)
            finally:
                try:os.unlink(name,dir_fd=parent)
                except FileNotFoundError:pass
        return {'ok':True}
    if op == 'screen':
        return screens.control(req.get('screenKey'), req.get('leaseId'), req.get('controlToken'), req.get('interactive'))
    if op == 'releaseScreen': return screens.release(req.get('screenKey'), req.get('screenLease'))
    if op == 'resolveScreen':
        key, state = screens.resolve(req.get('screenKey'), req.get('screenLease'))
        return {'key': key, 'index': state['index']}
    if op == 'restoreBegin': return screens.pause_browsers()
    if op == 'restoreEnd': return screens.resume_browsers()
    if op == 'readBatch':
        paths = req.get('paths', [])
        if len(paths) > 8: raise ValueError('Too many files')
        return [run({'op':'read', 'path':p}) for p in paths]
    if op == 'writeBatch':
        files = req.get('files', [])
        if len(files) > 8: raise ValueError('Too many files')
        for file in files: run({**file, 'op':'write'})
        return {'ok':True}
    if op == 'manifest':
        rows=[];pending=[''];total=0
        while pending:
            for entry in run({'op':'list','path':pending.pop()}):
                if entry['path'].startswith('.browser-profiles/') and any(part in ('Cache','Code Cache','GPUCache','GrShaderCache','ShaderCache','DawnGraphiteCache','DawnWebGPUCache','Crashpad','SingletonCookie','SingletonLock','SingletonSocket','BrowserMetrics','DevToolsActivePort','lock','.parentlock') for part in entry['path'].split('/')): continue
                if entry['kind']=='dir': pending.append(entry['path'])
                else:
                    rows.append(entry);total+=entry['size']
                if len(rows)+len(pending)>10000 or total>512*1024*1024: raise ValueError('Workspace exceeds checkpoint limit')
        return rows
    raise ValueError('Unsupported operation')

if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.read(96 * 1024 * 1024))
        print(json.dumps(run(request), separators=(',', ':')))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
