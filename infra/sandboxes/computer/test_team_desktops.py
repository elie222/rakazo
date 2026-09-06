"""Offline Docker lifecycle smoke, invoked by team-desktops.docker.test.ts."""

import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time


def run(commands, key):
    result = subprocess.run(
        ["bash", "-c", commands[key]], text=True, capture_output=True, timeout=90
    )
    if result.returncode:
        raise RuntimeError(f"{key} failed: {result.stderr} {result.stdout}")


def websocket(port, token):
    connection = socket.create_connection(("127.0.0.1", port), 3)
    connection.settimeout(4)
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET /websockify?token={token} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    connection.sendall(request.encode())
    return connection, connection.recv(8192)


def main():
    with open(sys.argv[1]) as source:
        commands = json.load(source)
    for step in ["reset", "ensurea", "ensureb", "controla"]:
        run(commands, step)
    viewer, response = websocket(6080, "view-a")
    assert b"101 Switching Protocols" in response, response
    controller, response = websocket(6081, "control-a")
    assert b"101 Switching Protocols" in response, response

    profile = Path(commands["profilea"])
    login = profile / "fake-login"
    login.write_text("preserved-after-browser-restart")
    # Reopen the same bot after Chromium stops, before any checkpoint/release.
    key = profile.name.removeprefix("chromium-bot-")
    pid = int(Path(f"/tmp/rakazo/browser-pid-{key}").read_text())
    os.kill(pid, 15)
    for _ in range(100):
        if not Path(f"/proc/{pid}/cmdline").exists():
            break
        if not Path(f"/proc/{pid}/cmdline").read_bytes():
            break
        time.sleep(0.1)
    run(commands, "ensurea")
    assert login.read_text() == "preserved-after-browser-restart"
    run(commands, "stopa")

    # Old clients must disconnect before the primary slot is reused.
    for connection in [viewer, controller]:
        try:
            while connection.recv(8192):
                pass
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            connection.close()
    run(commands, "ensurec")
    run(commands, "controlc")
    for port, old, current in [(6080, "view-a", "view-c"), (6081, "control-a", "control-c")]:
        connection, response = websocket(port, old)
        connection.close()
        assert b"101 Switching Protocols" not in response, response
        connection, response = websocket(port, current)
        connection.close()
        assert b"101 Switching Protocols" in response, response
    assert Path(commands["profileb"]).is_dir()
    run(commands, "stopb")
    run(commands, "stopc")
    print("PASS: parallel desktops, profile recovery, primary cleanup, and stale view/control token rejection")


if __name__ == "__main__":
    main()
