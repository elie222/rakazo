"""The only tunneled sandbox port. Static viewer assets are public; RFB requires a capability."""
import hmac
import json
import os
from pathlib import Path
import select
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import time

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass  # Never log screen capability URLs.
    def do_GET(self):
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        upgrade = self.headers.get('Upgrade', '').lower() == 'websocket'
        port = 6080
        if upgrade:
            token = query.get('cadre_token', [''])[0]
            if query.get('view_only', ['true'])[0] == 'false':
                try: state = json.loads(Path('/tmp/cadre-screen.json').read_text())
                except (FileNotFoundError, json.JSONDecodeError): state = {}
                expected = state.get('token', '') if state.get('expiresAt', 0) > time.time() else ''
                port = 6081
            else: expected = os.environ.get('CADRE_SCREEN_VIEW_TOKEN', '')
            if not expected or not hmac.compare_digest(token, expected):
                self.send_error(403); return
        elif parsed.path == '/websockify':
            self.send_error(403); return
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=10) as upstream:
                lines = [f'GET {parsed.path or "/"} HTTP/1.1', f'Host: 127.0.0.1:{port}']
                for key, value in self.headers.items():
                    if key.lower() not in ('host', 'authorization', 'cookie'):
                        lines.append(f'{key}: {value}')
                upstream.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode())
                upstream.settimeout(None)
                self.connection.settimeout(None)
                deadline = time.monotonic() + 3600
                while time.monotonic() < deadline:
                    ready, _, _ = select.select([self.connection, upstream], [], [], 5)
                    for source in ready:
                        data = source.recv(65536)
                        if not data: return
                        (upstream if source is self.connection else self.connection).sendall(data)
                    if upgrade and port == 6081:
                        try: current = json.loads(Path('/tmp/cadre-screen.json').read_text())
                        except (FileNotFoundError, json.JSONDecodeError): return
                        if current.get('token') != token or current.get('expiresAt', 0) <= time.time(): return
        except (OSError, TimeoutError): return

if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
