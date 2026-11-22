"""Hold the Codex subscription login outside the agent and add it to the agent's model requests.

  codex-credential-proxy.py refresh AUTH_FILE   refreshes the login when it expires within two hours
  codex-credential-proxy.py serve AUTH_FILE PORT serves 127.0.0.1:PORT, forwarding to ChatGPT's Codex API

The agent runs as another user with a placeholder login, so neither it nor any command it runs can
read the real tokens. The only refresh token stays with this process.
"""

import base64
import http.client
import http.server
import json
import os
import socketserver
import ssl
import sys
import time
import urllib.parse
import urllib.request

UPSTREAM = "chatgpt.com"
PREFIX = "/backend-api/codex/"
# Codex's public OAuth client, the one its own login refreshes with.
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
REFRESH_URL = "https://auth.openai.com/oauth/token"
REFRESH_MARGIN = 2 * 60 * 60
DROPPED = {
    "authorization", "chatgpt-account-id", "connection", "content-length", "host", "keep-alive",
    "proxy-authorization", "proxy-connection", "transfer-encoding", "upgrade", "x-api-key",
}


def load(path: str) -> dict:
    with open(path) as file:
        return json.load(file)


def save(path: str, auth: dict):
    temporary = f"{path}.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(auth, file)
    os.replace(temporary, path)


def claims(token: str) -> dict:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def expires_at(token: str) -> float:
    return float(claims(token)["exp"])


def account_id(tokens: dict) -> str | None:
    # Older logins store it only inside the ID token, where Codex reads it too.
    return tokens.get("account_id") or claims(tokens["id_token"]).get("https://api.openai.com/auth", {}).get(
        "chatgpt_account_id"
    )


def refresh(path: str):
    auth = load(path)
    tokens = auth["tokens"]
    if expires_at(tokens["access_token"]) - time.time() > REFRESH_MARGIN:
        return
    request = urllib.request.Request(
        REFRESH_URL,
        data=urllib.parse.urlencode({
            "client_id": CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
            "scope": "openid profile email",
        }).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        fresh = json.load(response)
    if not isinstance(fresh, dict) or not isinstance(fresh.get("access_token"), str) or not fresh["access_token"]:
        raise SystemExit("The login refresh returned no access token; the stored login is unchanged.")
    for name in ("access_token", "id_token", "refresh_token"):
        if fresh.get(name):
            tokens[name] = fresh[name]
            print(f"::add-mask::{fresh[name]}")
    auth["last_refresh"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save(path, auth)


def handler(path: str):
    class Forward(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def forward(self):
            # Dot segments or encoded characters could step outside the Codex API upstream.
            if not self.path.startswith(PREFIX) or ".." in self.path or "%" in self.path.split("?", 1)[0]:
                self.send_response(403)
                self.send_header("content-length", "0")
                self.end_headers()
                return
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length) if length else None
            tokens = load(path)["tokens"]
            headers = {
                k: v for k, v in self.headers.items()
                if k.lower() not in DROPPED and not any(c in k + v for c in "\r\n")
            }
            headers["Authorization"] = f"Bearer {tokens['access_token']}"
            if account := account_id(tokens):
                headers["chatgpt-account-id"] = account
            upstream = http.client.HTTPSConnection(UPSTREAM, context=ssl.create_default_context(), timeout=600)
            upstream.request(self.command, self.path, body=body, headers=headers)
            response = upstream.getresponse()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in ("connection", "content-length", "transfer-encoding") and not any(
                    c in name + value for c in "\r\n"
                ):
                    self.send_header(name, value)
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            while chunk := response.read1(65536):
                self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

        do_GET = do_POST = forward

    return Forward


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "refresh":
        refresh(argv[2])
        return 0
    if len(argv) == 4 and argv[1] == "serve":
        Server(("127.0.0.1", int(argv[3])), handler(argv[2])).serve_forever()
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
