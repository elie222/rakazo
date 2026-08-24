#!/usr/bin/env python3
"""Localhost MCP OAuth catcher for providers that only allow loopback HTTP redirects."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(__import__("os").environ.get("MCP_OAUTH_CALLBACK_PORT", "8765"))
CANDIDATES = [
    origin.strip()
    for origin in __import__("os").environ.get(
        "MCP_OAUTH_COMPLETE_ORIGINS",
        "http://127.0.0.1:5173,http://127.0.0.1:5175",
    ).split(",")
    if origin.strip()
]


def rpc_bases() -> list[str]:
    return list(CANDIDATES)


def complete(code: str, state: str) -> tuple[bool, str]:
    payload = json.dumps({"json": {"sessionId": state, "code": code, "state": state}}).encode()
    last = "no endpoint"
    for base in rpc_bases():
        req = urllib.request.Request(
            f"{base}/rpc/mcp/oauth/complete",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Origin": f"http://127.0.0.1:{PORT}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode()
            return True, body
        except urllib.error.HTTPError as err:
            last = err.read().decode()[:800] if err.fp else str(err)
        except Exception as err:
            last = str(err)
    return False, last


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        code = (query.get("code") or [None])[0]
        state = (query.get("state") or [None])[0]
        oauth_error = (query.get("error_description") or query.get("error") or [None])[0]
        if oauth_error:
            self._html(400, f"Authorization failed: {oauth_error}")
            return
        if not code or not state:
            self._html(400, "Missing OAuth code.")
            return
        ok, detail = complete(code, state)
        if ok:
            self._html(200, "Connected. You can close this window.")
            return
        self._html(500, f"Could not finish OAuth.<pre>{detail}</pre>")

    def log_message(self, fmt: str, *args) -> None:
        print(f"mcp-oauth-callback: {fmt % args}")

    def _html(self, status: int, body: str) -> None:
        page = f"""<!doctype html><html><body style="font-family:system-ui;padding:48px;background:#111;color:#eee">
        <h1 style="font-weight:500">{body}</h1></body></html>"""
        data = page.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"mcp oauth callback on http://127.0.0.1:{PORT}/mcp/oauth/callback")
    httpd.serve_forever()
