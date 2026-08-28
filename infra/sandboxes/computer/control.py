#!/usr/bin/env python3
"""Token-auth desktop control for the Rakazo supervisor."""

import base64
import ctypes
import hmac
import json
import os
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("RAKAZO_COMPUTER_CONTROL_TOKEN", "")
MAX_BODY_BYTES = 256 * 1024
MAX_ARGV = 32
MAX_ARG_LEN = 16_384
KNOWN_LAUNCH = frozenset(
    {
        "chromium",
        "chromium-browser",
        "firefox",
        "google-chrome",
        "google-chrome-stable",
        "rakazo-browser",
        "xterm",
    }
)
NATIVE_CAPTURES = {}
NATIVE_LOCK = threading.Lock()
DISPLAY_LOCKS = {}
DISPLAY_LOCKS_GUARD = threading.Lock()


def display_lock(display):
    with DISPLAY_LOCKS_GUARD:
        lock = DISPLAY_LOCKS.get(display)
        if lock is None:
            lock = threading.Lock()
            DISPLAY_LOCKS[display] = lock
        return lock


class NativeCapture:
    """Persistent MIT-SHM frame source with native lossless PNG encoding."""

    def __init__(self, display):
        library = ctypes.CDLL("/usr/local/lib/librakazo-xcapture.so")
        library.rakazo_xcapture_open.argtypes = [ctypes.c_char_p]
        library.rakazo_xcapture_open.restype = ctypes.c_void_p
        library.rakazo_xcapture_png.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
        ]
        library.rakazo_xcapture_png.restype = ctypes.c_int
        library.rakazo_xcapture_damage.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
        ]
        library.rakazo_xcapture_damage.restype = ctypes.c_int
        library.rakazo_xinput_argv.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)]
        library.rakazo_xinput_argv.restype = ctypes.c_int
        context = library.rakazo_xcapture_open(display.encode("utf-8"))
        if not context:
            raise RuntimeError("MIT-SHM capture is unavailable")
        self.library = library
        self.context = context

    def copy(self):
        png = ctypes.POINTER(ctypes.c_ubyte)()
        png_size = ctypes.c_size_t()
        width, height = ctypes.c_int(), ctypes.c_int()
        if self.library.rakazo_xcapture_png(
            self.context, ctypes.byref(png), ctypes.byref(png_size), ctypes.byref(width), ctypes.byref(height)
        ):
            raise RuntimeError("MIT-SHM screen capture failed")
        damage = (ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int())
        changed = self.library.rakazo_xcapture_damage(
            self.context, *(ctypes.byref(value) for value in damage)
        )
        return (
            ctypes.string_at(png, png_size.value),
            width.value,
            height.value,
            ({"x": damage[0].value, "y": damage[1].value, "width": damage[2].value, "height": damage[3].value}
             if changed else None),
        )

    def act(self, argv):
        encoded = (ctypes.c_char_p * len(argv))(*(value.encode("utf-8") for value in argv))
        return self.library.rakazo_xinput_argv(self.context, len(argv), encoded)


def native_capture(display):
    existing = NATIVE_CAPTURES.get(display)
    if existing is not None:
        return existing
    try:
        capture = NativeCapture(display)
    except (OSError, RuntimeError):
        return None
    NATIVE_CAPTURES[display] = capture
    return capture


def drop_native_capture(display):
    NATIVE_CAPTURES.pop(display, None)


def _is_int_string(value):
    if not value or value[0] == "-":
        return value[1:].isdigit() if len(value) > 1 else False
    return value.isdigit()


def allowed_xdotool_argv(argv):
    """Only xdotool forms emitted by containerActionStep / xdotoolCommand."""
    if len(argv) < 4 or argv[2] != "xdotool":
        return False
    op = argv[3]
    if op == "key":
        return len(argv) == 6 and argv[4] == "--clearmodifiers" and argv[5] != ""
    if op == "mousemove":
        if len(argv) == 7 and argv[4] == "--" and _is_int_string(argv[5]) and _is_int_string(argv[6]):
            return True
        return (
            len(argv) == 9
            and argv[4] == "--"
            and _is_int_string(argv[5])
            and _is_int_string(argv[6])
            and argv[7] in ("mousedown", "click")
            and argv[8] in ("1", "3")
        )
    if op == "mouseup":
        return len(argv) == 5 and argv[4] in ("1", "3")
    if op == "type":
        return len(argv) == 7 and argv[4] == "--clearmodifiers" and argv[5] == "--"
    if op == "click":
        return (
            len(argv) == 7
            and argv[4] == "--repeat"
            and argv[5].isdigit()
            and 1 <= int(argv[5]) <= 20
            and argv[6] in ("4", "5")
        )
    return False


def allowed_control_argv(argv, display):
    """Only supervisor-shaped argv for the locked display."""
    if not isinstance(argv, list) or not (3 <= len(argv) <= MAX_ARGV):
        return False
    if any(not isinstance(value, str) or len(value) > MAX_ARG_LEN or "\0" in value for value in argv):
        return False
    if argv[0] != "env" or argv[1] != f"DISPLAY={display}":
        return False
    command = argv[2]
    if command == "xdotool":
        return allowed_xdotool_argv(argv)
    if command == "xdg-open":
        return len(argv) == 4
    if "/" in command or command not in KNOWN_LAUNCH:
        return False
    return len(argv) in (3, 4)


def capture(display):
    env = {**os.environ, "DISPLAY": display}

    def output(argv, fallback=""):
        return subprocess.run(argv, env=env, capture_output=True, text=True).stdout.strip() or fallback

    geometry = output(["xdotool", "getdisplaygeometry"], "1280 800").split()
    cursor = output(["xdotool", "getmouselocation", "--shell"])
    window = output(["xdotool", "getactivewindow"])
    title = output(["xdotool", "getwindowname", window]) if window else ""
    image = None
    width = height = damage = None
    with NATIVE_LOCK:
        source = native_capture(display)
        if source:
            try:
                encoded, width, height, damage = source.copy()
                image = subprocess.CompletedProcess([], 0, encoded, b"")
            except RuntimeError:
                drop_native_capture(display)
    if image is None:
        image = subprocess.run(
            ["import", "-define", "png:compression-level=3", "-window", "root", "png:-"],
            env=env,
            capture_output=True,
        )
        width, height, damage = (int(geometry[0]), int(geometry[1]), None)
    if image.returncode:
        raise RuntimeError(image.stderr.decode("utf-8", "replace") or "screen capture failed")
    fields = dict(line.split("=", 1) for line in cursor.splitlines() if "=" in line)
    return {
        "image": base64.b64encode(image.stdout).decode("ascii"),
        "mimeType": "image/png",
        "width": width,
        "height": height,
        **({"cursor": {"x": int(fields["X"]), "y": int(fields["Y"])}} if "X" in fields and "Y" in fields else {}),
        **({"activeWindow": {"id": window, **({"title": title} if title else {})}} if window else {}),
        **({"damage": damage} if damage else {}),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != "/v1/desktop" or not TOKEN or not hmac.compare_digest(
            self.headers.get("Authorization", "").removeprefix("Bearer "), TOKEN
        ):
            self.send_error(401)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_BODY_BYTES:
                raise RuntimeError("request body too large")
            body = json.loads(self.rfile.read(length))
            display = body.get("display", ":1")
            if not isinstance(display, str) or not re.fullmatch(r":[0-9]+", display):
                raise RuntimeError("invalid display")
            with display_lock(display):
                for step in body.get("steps", []):
                    if "waitMs" in step:
                        time.sleep(max(0, min(int(step["waitMs"]), 5000)) / 1000)
                        continue
                    argv = step.get("argv")
                    if not allowed_control_argv(argv, display):
                        raise RuntimeError("unsupported computer action")
                    with NATIVE_LOCK:
                        source = native_capture(display)
                        handled = source.act(argv) if source else 0
                        if handled < 0:
                            drop_native_capture(display)
                            handled = 0
                    if not handled:
                        result = subprocess.run(argv, env={**os.environ, "DISPLAY": display})
                        if result.returncode:
                            raise RuntimeError("computer action failed")
                settle_ms = max(0, min(int(body.get("settleMs", 0)), 5000))
                if settle_ms:
                    time.sleep(settle_ms / 1000)
                response = {"completed": len(body.get("steps", []))}
                if body.get("observe", True):
                    response["observation"] = capture(display)
            encoded = json.dumps(response, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except Exception as error:
            encoded = json.dumps({"error": str(error)}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 7070), Handler).serve_forever()
