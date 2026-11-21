"""Live check of the passkey step on a real site: webauthn.io creates a passkey in one fresh browser,
then a second fresh browser signs in with only the saved passkey, through page_passkey.Passkey as the
page browser runs it. Needs the network, so page-passkey.docker.test.ts runs it only when asked.

    python3 test_page_passkey_site.py [browser]
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from typing import Any

sys.path[:0] = [os.path.dirname(os.path.realpath(__file__)), "/usr/local/lib/rakazo"]
import page_passkey  # noqa: E402
import page_secrets  # noqa: E402

ORIGIN = "https://webauthn.io"
SIGNED_IN = "You're logged in!"
BROWSERS = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "brave-browser")


def find_browser() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    found = next((path for path in map(shutil.which, BROWSERS) if path), None)
    if not found:
        raise SystemExit("no browser found")
    return found


def wait_for(check: Any, what: str, seconds: float = 20.0) -> Any:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except Exception:  # noqa: BLE001
            pass  # Not ready yet.
        time.sleep(0.2)
    raise AssertionError(f"timed out waiting for {what}")


def page_eval(client: page_secrets.CdpClient, session: str, expression: str) -> Any:
    return page_secrets.page_value(client.call("Runtime.evaluate", {
        "expression": expression, "returnByValue": True, "awaitPromise": True}, session_id=session))


def click(client: page_secrets.CdpClient, session: str, element_id: str) -> None:
    x, y = page_eval(client, session, f"(() => {{ const r = document.getElementById('{element_id}')"
                                      ".getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()")
    for kind in ("mousePressed", "mouseReleased"):
        client.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1},
                    session_id=session)


def step_in_fresh_browser(browser: str, port: int, username: str, step: dict[str, Any],
                          button: str) -> tuple[dict[str, Any] | None, str]:
    """Opens the site in a new profile, runs the passkey step on `button`, and returns what the step
    returned and the page's text."""
    profile = tempfile.mkdtemp(prefix="passkey-site-")
    process = subprocess.Popen([browser, "--headless=new", "--no-sandbox", "--no-first-run",
                                f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "about:blank"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        target = wait_for(lambda: next(tab["id"] for tab in json.load(
            urllib.request.urlopen(f"http://127.0.0.1:{port}/json")) if tab["type"] == "page"), "the browser")
        client = page_secrets.connect(port)
        try:
            session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
            client.call("Page.navigate", {"url": ORIGIN}, session_id=session)
            wait_for(lambda: page_eval(client, session, "document.readyState === 'complete' && "
                                                        f"!!document.getElementById('{button}')"), "the page")
            page_eval(client, session, f"(() => {{ const input = document.getElementById('input-email'); "
                                       f"input.value = {json.dumps(username)}; "
                                       "input.dispatchEvent(new Event('input', { bubbles: true })) })()")
            with page_passkey.Passkey(port, target, step) as passkey:
                passkey.present()
                click(client, session, button)
                result = passkey.wait()
            text = wait_for(lambda: (lambda body: body if SIGNED_IN in body or "credential" not in step else "")(
                page_eval(client, session, "document.body.innerText")), "the site's answer")
            return result, text
        finally:
            client.close()
    finally:
        process.kill()
        process.wait()
        shutil.rmtree(profile, ignore_errors=True)


def main() -> None:
    browser = find_browser()
    username = f"rakazo-passkey-check-{int(time.time())}"
    created, _ = step_in_fresh_browser(browser, 9341, username, {"kind": "passkey", "ref": "e1", "origin": ORIGIN},
                                       "register-button")
    assert created and created["rpId"] == "webauthn.io", created and created.get("rpId")
    # As the server hands it over: its clock in seconds since 2025-01-01.
    credential = {**{key: created[key] for key in ("credentialId", "privateKey", "userHandle") if key in created},
                  "signCount": max(0, int(time.time()) - 1_735_689_600)}
    used, text = step_in_fresh_browser(browser, 9342, username, {
        "kind": "passkey", "ref": "e1", "origin": ORIGIN, "rpId": created["rpId"], "credential": credential},
        "login-button")
    assert used is None and SIGNED_IN in text, text[:400]
    print("PASS: passkey created, then signed in from a fresh browser on webauthn.io")


if __name__ == "__main__":
    main()
