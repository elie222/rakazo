"""Synchronize workspace browser sessions without sharing live Chromium profile files.

Runs as the desktop user, inside one computer. DevTools is loopback-only and never
proxied through the screen gateway. Cookies and first-party local storage are
shared; tabs, history, sessionStorage, and desktop input remain per screen.
"""
import json
import os
from pathlib import Path
import time
import signal
import re

PROFILES = Path('/home/rakazo/.browser-profiles')
STATE_FILE = PROFILES / 'shared-sessions.json'
COOKIE_FIELDS = ('name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite',
                 'expires', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey')


def cookie_map(cookies):
    result = {}
    for cookie in cookies:
        # Opaque partitions cannot be transferred to another browser context.
        if cookie.get('partitionKeyOpaque'):
            continue
        value = {k: cookie[k] for k in COOKIE_FIELDS if k in cookie}
        if cookie.get('session') or value.get('expires', -1) < 0:
            value.pop('expires', None)
        key = json.dumps([value['name'], value['domain'], value['path'],
                          value.get('partitionKey')], sort_keys=True)
        result[key] = value
    return result


def managed_profiles():
    return [profile for profile in sorted(PROFILES.iterdir())
            if (profile.name == 'chromium' or re.fullmatch(r'bot-[0-9a-f]{64}', profile.name))
            and profile.is_dir() and (profile / 'DevToolsActivePort').is_file()]


class SharedState:
    """Three-way merge: unchanged peers never overwrite another screen's update.

    None is a durable tombstone. A disconnected/stale profile may not resurrect
    a signed-out session when its screen is next opened.
    """
    def __init__(self, values=None):
        self.values = values or {}
        self.previous = {}

    def observe(self, peer, current):
        before = self.previous.get(peer)
        if before is None:
            for key, value in current.items():
                self.values.setdefault(key, value)
        else:
            for key in before.keys() | current.keys():
                if before.get(key) != current.get(key):
                    self.values[key] = current.get(key)
        self.previous[peer] = dict(current)

    def changes(self, peer):
        current = self.previous[peer]
        return {key: value for key, value in self.values.items()
                if current.get(key) != value}

    def applied(self, peer, changes):
        for key, value in changes.items():
            if value is None:
                self.previous[peer].pop(key, None)
            else:
                self.previous[peer][key] = value

    def disconnect(self, peer):
        self.previous.pop(peer, None)


class CDP:
    def __init__(self, url):
        import websocket
        self.ws = websocket.create_connection(url, timeout=2, suppress_origin=True)
        self.serial = 0

    def call(self, method, params=None, session=None):
        self.serial += 1
        request = {'id': self.serial, 'method': method, 'params': params or {}}
        if session:
            request['sessionId'] = session
        self.ws.send(json.dumps(request))
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            message = json.loads(self.ws.recv())
            if message.get('id') == self.serial:
                if 'error' in message:
                    # Never include protocol payloads: they may contain sign-ins.
                    raise RuntimeError('Browser session operation failed')
                return message.get('result', {})
        raise TimeoutError('Browser session operation timed out')

    def close(self):
        self.ws.close()


class Browser:
    def __init__(self, profile):
        lines = (profile / 'DevToolsActivePort').read_text().splitlines()
        port = int(lines[0])
        if not 1024 <= port <= 65535 or not lines[1].startswith('/devtools/browser/'):
            raise ValueError('Invalid local browser endpoint')
        self.identity = '\n'.join(lines[:2])
        self.cdp = CDP(f'ws://127.0.0.1:{port}{lines[1]}')
        self.targets = {}

    def storage(self):
        live = self.cdp.call('Target.getTargets')['targetInfos']
        pages = {p['targetId']: p for p in live if p['type'] == 'page'}
        self.targets = {key: value for key, value in self.targets.items() if key in pages}
        stores = {}
        for target, page in pages.items():
            if not page['url'].startswith(('http://', 'https://')):
                continue
            try:
                if target not in self.targets:
                    session = self.cdp.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
                    self.cdp.call('DOMStorage.enable', session=session)
                    self.targets[target] = session
                session = self.targets[target]
                frame = self.cdp.call('Page.getFrameTree', session=session)['frameTree']['frame']['id']
                key = self.cdp.call('Storage.getStorageKeyForFrame', {'frameId': frame}, session)['storageKey']
                storage_id = {'storageKey': key, 'isLocalStorage': True}
                entries = self.cdp.call('DOMStorage.getDOMStorageItems', {'storageId': storage_id}, session)['entries']
                stores.setdefault(key, (session, storage_id, dict(entries)))
            except RuntimeError:
                # Navigating/closing a tab is not a storage deletion.
                continue
        return stores

    def cookies(self):
        return cookie_map(self.cdp.call('Storage.getCookies')['cookies'])

    def apply_cookies(self, changes):
        session = None
        try:
            for key, value in changes.items():
                if value is None:
                    # Network.deleteCookies is a page-target command, unlike the
                    # browser-level Storage cookie methods. A primary new-tab
                    # page is also valid; no page navigation is necessary.
                    if session is None:
                        pages = self.cdp.call('Target.getTargets')['targetInfos']
                        target = next(p['targetId'] for p in pages if p['type'] == 'page')
                        session = self.cdp.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
                    name, domain, path, partition = json.loads(key)
                    params = {'name': name, 'domain': domain, 'path': path}
                    if partition is not None:
                        params['partitionKey'] = partition
                    self.cdp.call('Network.deleteCookies', params, session)
                else:
                    self.cdp.call('Storage.setCookies', {'cookies': [value]})
        finally:
            if session:
                self.cdp.call('Target.detachFromTarget', {'sessionId': session})

    def close(self):
        self.cdp.close()


class Broker:
    def __init__(self, state_file=STATE_FILE):
        self.state_file = state_file
        try:
            state = json.loads(state_file.read_text())
        except FileNotFoundError:
            state = {}
        self.cookies = SharedState(state.get('cookies'))
        self.storage = {key: SharedState(value) for key, value in state.get('storage', {}).items()}
        self.browsers = {}
        self.saved = None

    def save(self):
        value = json.dumps({'cookies': self.cookies.values,
                            'storage': {key: state.values for key, state in self.storage.items()}})
        if value == self.saved:
            return
        # Atomic writes make both portable and filesystem snapshots usable.
        temporary = self.state_file.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as file:
            file.write(value)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(self.state_file)
        self.saved = value

    def disconnect(self, peer):
        browser = self.browsers.pop(peer, None)
        if browser:
            browser.close()
        self.cookies.disconnect(peer)
        for state in self.storage.values():
            state.disconnect(peer)

    def tick(self):
        stores = {}
        profiles = managed_profiles()
        for peer in set(self.browsers) - {profile.name for profile in profiles}:
            self.disconnect(peer)
        for profile in profiles:
            peer = profile.name
            try:
                if peer not in self.browsers:
                    self.browsers[peer] = Browser(profile)
                browser = self.browsers[peer]
                self.cookies.observe(peer, browser.cookies())
                stores[peer] = browser.storage()
                for key, (_, _, values) in stores[peer].items():
                    self.storage.setdefault(key, SharedState()).observe(peer, values)
            except Exception:
                self.disconnect(peer)
        # Observe all peers before publishing changes; never interpret a write we
        # just replicated as a new login or sign-out from that peer.
        for peer, browser in list(self.browsers.items()):
            try:
                changes = self.cookies.changes(peer)
                browser.apply_cookies(changes)
                self.cookies.applied(peer, changes)
                for key, (session, storage_id, _) in stores.get(peer, {}).items():
                    state = self.storage[key]
                    changes = state.changes(peer)
                    for name, value in changes.items():
                        params = {'storageId': storage_id, 'key': name}
                        method = 'DOMStorage.removeDOMStorageItem'
                        if value is not None:
                            method = 'DOMStorage.setDOMStorageItem'
                            params['value'] = value
                        browser.cdp.call(method, params, session)
                    state.applied(peer, changes)
            except Exception:
                self.disconnect(peer)
        self.save()
        if self.browsers:
            fd = os.open('/tmp/cadre-browser-sessions-ready', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            os.close(fd)


def main():
    os.umask(0o077)
    PROFILES.mkdir(mode=0o700, parents=True, exist_ok=True)
    broker = Broker()
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    while not stopping:
        try:
            broker.tick()
        except Exception:
            # Keep credentials and visited origins out of process logs.
            print('Browser session synchronization will retry', flush=True)
        time.sleep(.5)
    # Capture the last sign-in before the controller stops browsers for a backup.
    broker.tick()


if __name__ == '__main__':
    main()
