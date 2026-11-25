#!/usr/bin/python3 -I
"""AT-SPI perception helper for Rakazo computers.

The adapter runs `rakazo-perception` in the computer; that client forwards one JSON line to the
Unix socket this server owns and prints the reply. The helper is persistent so AT-SPI state and
focus events survive between tool calls, and it handles one request at a time: a slow application
must not make every other display wait.

The helper reads only role, name, bounds and state. It never reads a control's value, so a saved
password or a card number cannot reach the model through a tree or a hit test.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import socketserver
import subprocess
import time
from collections.abc import Iterator
from typing import Any

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib  # noqa: E402

SOCKET_PATH = os.environ.get("RAKAZO_PERCEPTION_SOCKET", "/tmp/rakazo/perception.sock")
CALL_TIMEOUT_MS = 150
SCAN_LIMIT = 256
WALK_CHILD_LIMIT = 1000
DEPTH_LIMIT = 40
TREE_LIMIT = 300
NAME_LIMIT = 256
ROLE_LIMIT = 64
MODEL_WIDTH = 1280
MODEL_HEIGHT = 800
MATCH_SLACK = 4
TITLED_SLACK = 64
MAX_BODY_BYTES = 64 * 1024
DEFAULT_DEADLINE_MS = 1000
COMMAND_TIMEOUT_MS = 2_000
PROGRAMS = ("git", "gh", "node", "python3", "curl", "unzip", "ffmpeg", "libreoffice")
SECRET_ROLES = frozenset(("password text", "password"))
DECOR_CLASSES = frozenset(("xfce4-panel", "plank", "xfdesktop"))

SHOWING = Atspi.StateType.SHOWING
FOCUSED = Atspi.StateType.FOCUSED
EDITABLE = Atspi.StateType.EDITABLE
ENABLED = Atspi.StateType.ENABLED
CHECKED = Atspi.StateType.CHECKED
INDETERMINATE = Atspi.StateType.INDETERMINATE
EXPANDED = Atspi.StateType.EXPANDED


class Expired(Exception):
    """The request's deadline passed."""


def mono() -> float:
    return time.monotonic_ns() / 1e6


def clip_text(value: str, limit: int) -> str:
    return value[:limit]


def contains(rect: dict[str, int], x: float, y: float) -> bool:
    return (
        rect["x"] <= x < rect["x"] + rect["w"] and rect["y"] <= y < rect["y"] + rect["h"]
    )


def rank(name: str, wanted: str) -> int | None:
    """How well a name answers a search: whole, from its start, from a word's start, or inside."""
    if not wanted:
        return 0
    lower = name.lower()
    if lower == wanted:
        return 0
    if lower.startswith(wanted):
        return 1
    at = lower.find(wanted)
    if at < 0:
        return None
    return 3 if at > 0 and lower[at - 1].isalnum() else 2


def run(display: str, argv: list[str]) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "DISPLAY": display, "LC_ALL": "C"}
    try:
        return subprocess.run(
            argv,
            env=env,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT_MS / 1000,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"{argv[0]} failed: {error}") from error


def parse_windows(output: str) -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []
    for line in output.splitlines():
        fields = line.split(None, 9)
        if len(fields) != 10:
            continue
        window_id, _desktop, pid, x, y, w, h, cls, _host, title = fields
        try:
            frame = {
                "x": int(x),
                "y": int(y),
                "w": int(w),
                "h": int(h),
            }
            windows.append(
                {
                    "id": int(window_id, 16),
                    "pid": int(pid),
                    "cls": clip_text(cls, 128),
                    "app": clip_text(cls.split(".", 1)[0].lower(), 64),
                    "title": clip_text(title, 256),
                    "frame": frame,
                    "active": False,
                }
            )
        except ValueError:
            continue
    return windows


def active_window(display: str) -> int | None:
    result = run(display, ["xprop", "-root", "_NET_ACTIVE_WINDOW"])
    if result.returncode != 0:
        return None
    match = re.search(r"0x[0-9a-fA-F]+", result.stdout)
    return int(match.group(0), 16) if match else None


def list_windows(display: str) -> list[dict[str, Any]]:
    result = run(display, ["wmctrl", "-lGxp"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "wmctrl failed")
    windows = [
        window
        for window in parse_windows(result.stdout)
        if window["cls"].split(".", 1)[0].lower() not in DECOR_CLASSES
    ]
    active = active_window(display)
    for window in windows:
        window["active"] = window["id"] == active
    return windows


def screen_size(display: str) -> tuple[int, int]:
    result = run(display, ["xdpyinfo"])
    match = re.search(r"dimensions:\s+(\d+)x(\d+)\s+pixels", result.stdout)
    if match:
        return int(match.group(1)), int(match.group(2))
    return 1280, 800


def scale_factors(display: str) -> tuple[float, float]:
    width, height = screen_size(display)
    return (
        MODEL_WIDTH / width if width > 0 else 1,
        MODEL_HEIGHT / height if height > 0 else 1,
    )


def scale_rect(rect: dict[str, int], sx: float, sy: float) -> dict[str, int]:
    return {
        "x": round(rect["x"] * sx),
        "y": round(rect["y"] * sy),
        "w": round(rect["w"] * sx),
        "h": round(rect["h"] * sy),
    }


def scale_element(element: dict[str, Any], sx: float, sy: float) -> dict[str, Any]:
    scaled = {
        **element,
        "point": {
            "x": round(element["point"]["x"] * sx),
            "y": round(element["point"]["y"] * sy),
        },
    }
    if element.get("bbox"):
        scaled["bbox"] = scale_rect(element["bbox"], sx, sy)
    if element.get("windowFrame"):
        scaled["windowFrame"] = scale_rect(element["windowFrame"], sx, sy)
    return scaled


def scale_window(window: dict[str, Any], sx: float, sy: float) -> dict[str, Any]:
    return {**window, "frame": scale_rect(window["frame"], sx, sy)}


def capabilities(display: str) -> dict[str, Any]:
    programs = {
        name: "available" if shutil.which(name) is not None else "not_on_path"
        for name in PROGRAMS
    }
    width, height = screen_size(display)
    return {
        "version": 1,
        "search": "service_path",
        "programs": programs,
        "display": {"width": width, "height": height, "scale": 1},
        "perception": {
            "atspi": True,
            "cdp": True,
            "hitTest": True,
            "settle": True,
            "zoom": True,
        },
        "stream": {"protocol": "vnc", "quality": False},
        "recording": False,
        "desktopApps": programs.get("libreoffice") == "available",
    }


def extents(node: Any) -> tuple[int, int, int, int] | None:
    try:
        component = node.get_component_iface()
    except Exception:  # noqa: BLE001 - an application that vanished mid-walk
        return None
    if component is None:
        return None
    try:
        rect = component.get_extents(Atspi.CoordType.SCREEN)
    except Exception:  # noqa: BLE001
        return None
    if rect.width <= 0 or rect.height <= 0 or rect.x <= -10000 or rect.y <= -10000:
        return None
    return (int(rect.x), int(rect.y), int(rect.width), int(rect.height))


def showing(node: Any) -> bool:
    try:
        return bool(node.get_state_set().contains(SHOWING))
    except Exception:  # noqa: BLE001
        return False


def state_of(node: Any) -> dict[str, Any] | None:
    try:
        states = node.get_state_set()
    except Exception:  # noqa: BLE001
        return None
    state: dict[str, Any] = {}
    try:
        if states.contains(CHECKED):
            state["checked"] = "true"
        elif states.contains(INDETERMINATE):
            state["checked"] = "mixed"
        if not states.contains(ENABLED):
            state["disabled"] = True
        if states.contains(EXPANDED):
            state["expanded"] = True
    except Exception:  # noqa: BLE001
        return None
    return state or None


def editable(node: Any) -> bool:
    try:
        return bool(node.get_state_set().contains(EDITABLE))
    except Exception:  # noqa: BLE001
        return False


def window_app(window: dict[str, Any]) -> str:
    cls = str(window.get("cls") or "")
    return clip_text(cls.split(".", 1)[0].lower(), 64)


def describe(node: Any, window: dict[str, Any], role: str, name: str) -> dict[str, Any] | None:
    rect = extents(node)
    if rect is None:
        return None
    x, y, w, h = rect
    element: dict[str, Any] = {
        "point": {"x": round(x + w / 2), "y": round(y + h / 2)},
        "bbox": {"x": x, "y": y, "w": w, "h": h},
        "windowFrame": window["frame"],
        "source": "ax",
        "app": window_app(window),
        "window": window["title"],
        "role": clip_text(role, ROLE_LIMIT),
        "name": clip_text(name, NAME_LIMIT),
        "secret": role in SECRET_ROLES,
        "editable": editable(node),
    }
    state = state_of(node)
    if state is not None:
        element["state"] = state
    return element


def app_for_pid(pid: int) -> Any | None:
    if pid <= 0:
        return None
    try:
        desktop = Atspi.get_desktop(0)
    except Exception:  # noqa: BLE001
        return None
    if desktop is None:
        return None
    for index in range(min(desktop.get_child_count(), SCAN_LIMIT)):
        try:
            app = desktop.get_child_at_index(index)
            if app is not None and app.get_process_id() == pid:
                return app
        except GLib.Error as error:
            # An application that stopped answering is not "no application": nothing below it
            # is known, so a caller must read the answer as unknown rather than as no match.
            if "timeout" in str(error).lower():
                raise Expired() from error
            continue
        except Exception:  # noqa: BLE001
            continue
    return None


def top_level(app: Any, title: str, frame: dict[str, int]) -> Any | None:
    """The app's top-level accessible for an X window, by title and place."""
    want = {key: int(frame.get(key, 0)) for key in ("x", "y", "w", "h")}
    best: tuple[tuple[bool, int], Any] | None = None
    for index in range(min(app.get_child_count(), 100)):
        try:
            node = app.get_child_at_index(index)
            if node is None or not showing(node):
                continue
            rect = extents(node)
            if rect is None:
                continue
            named = bool(title) and (node.get_name() or "") == title
            offset = max(
                abs(rect[0] - want["x"]),
                abs(rect[1] - want["y"]),
                abs(rect[2] - want["w"]),
                abs(rect[3] - want["h"]),
            )
            if offset > (TITLED_SLACK if named else MATCH_SLACK):
                continue
            key = (not named, offset)
            if best is None or key < best[0]:
                best = (key, node)
        except GLib.Error as error:
            # A window that stopped answering is not a window without controls.
            if "timeout" in str(error).lower():
                raise Expired() from error
            continue
        except Exception:  # noqa: BLE001
            continue
    return best[1] if best is not None else None


def walk_nodes(root: Any, deadline: float) -> Iterator[tuple[Any, int]]:
    stack = [(root, 0)]
    visited = 0
    while stack and visited < TREE_LIMIT:
        if mono() >= deadline:
            raise Expired()
        node, depth = stack.pop()
        visited += 1
        try:
            if depth > 0 and not showing(node):
                continue
            yield node, depth
            if depth >= DEPTH_LIMIT:
                continue
            count = node.get_child_count()
            if count > WALK_CHILD_LIMIT:
                continue
            for index in range(count - 1, -1, -1):
                child = node.get_child_at_index(index)
                if child is not None:
                    stack.append((child, depth + 1))
        except Expired:
            raise
        except Exception:  # noqa: BLE001 - an accessible that vanished mid-walk
            continue


def walk_elements(
    root: Any, window: dict[str, Any], deadline: float
) -> tuple[list[dict[str, Any]], bool]:
    elements: list[dict[str, Any]] = []
    truncated = False
    for node, _depth in walk_nodes(root, deadline):
        try:
            role = node.get_role_name() or ""
            if role == "document web":
                continue
            name = node.get_name() or ""
            if not name:
                continue
            element = describe(node, window, role, name)
            if element is not None:
                elements.append(element)
            if len(elements) >= TREE_LIMIT:
                truncated = True
                break
        except Expired:
            raise
        except Exception:  # noqa: BLE001
            continue
    return elements, truncated


def window_root(window: dict[str, Any]) -> Any | None:
    app = app_for_pid(int(window.get("pid") or 0))
    if app is None:
        return None
    return top_level(app, str(window.get("title") or ""), window.get("frame") or {})


def tree(
    display: str, window: dict[str, Any], deadline: float
) -> tuple[list[dict[str, Any]], bool]:
    if not window:
        return [], False
    root = window_root(window)
    if root is None:
        return [], False
    return walk_elements(root, window, deadline)


def find(
    display: str,
    request: dict[str, Any],
    deadline: float,
) -> dict[str, Any]:
    wanted = str(request.get("text") or "").lower()[:NAME_LIMIT]
    role = str(request.get("role") or "").lower()[:ROLE_LIMIT] or None
    app = str(request.get("app") or "").lower()[:64] or None
    window_title = str(request.get("window") or "").lower()[:NAME_LIMIT] or None
    limit = int(request.get("limit") or 30)
    limit = max(1, min(TREE_LIMIT, limit))
    found: list[tuple[int, dict[str, Any]]] = []
    for window in list_windows(display):
        if app is not None and window["app"] != app:
            continue
        if window_title is not None and window["title"].lower() != window_title:
            continue
        root = window_root(window)
        if root is None:
            continue
        elements, _ = walk_elements(root, window, deadline)
        for element in elements:
            if role is not None and role not in element["role"].lower():
                continue
            position = rank(element["name"], wanted)
            if position is not None:
                found.append((position, element))
    found.sort(key=lambda item: item[0])
    return {
        "elements": [element for _, element in found[:limit]],
        "truncated": len(found) > limit,
    }


def at(display: str, point: dict[str, Any], deadline: float) -> dict[str, Any]:
    x = float(point.get("x", -1))
    y = float(point.get("y", -1))
    if not math.isfinite(x) or not math.isfinite(y):
        raise ValueError("point must be finite")
    for window in list_windows(display):
        if not contains(window["frame"], x, y):
            continue
        root = window_root(window)
        if root is None:
            continue
        elements, _ = walk_elements(root, window, deadline)
        candidates = [
            element
            for element in elements
            if contains(element["bbox"], x, y)
        ]
        if candidates:
            return {
                "element": min(
                    candidates,
                    key=lambda element: element["bbox"]["w"] * element["bbox"]["h"],
                )
            }
    return {"element": None}


def focused(display: str, window: dict[str, Any], deadline: float) -> dict[str, Any]:
    if window:
        windows = [window]
    else:
        windows = list_windows(display)
    for candidate in windows:
        root = window_root(candidate)
        if root is None:
            continue
        best: tuple[Any, int] | None = None
        for node, depth in walk_nodes(root, deadline):
            try:
                if node.get_state_set().contains(FOCUSED):
                    if best is None or depth > best[1]:
                        best = (node, depth)
            except Exception:  # noqa: BLE001
                continue
        if best is not None:
            node = best[0]
            try:
                element = describe(
                    node,
                    candidate,
                    node.get_role_name() or "",
                    node.get_name() or "",
                )
            except Exception:  # noqa: BLE001
                element = None
            if element is not None:
                return {"element": element}
    return {"element": None}


def handle(request: dict[str, Any]) -> dict[str, Any]:
    command = request.get("cmd")
    display = str(request.get("display") or os.environ.get("DISPLAY") or ":1")
    if re.fullmatch(r":\d+", display) is None:
        return {"ok": False, "error": "invalid display"}
    deadline = float(request.get("deadline") or (mono() + DEFAULT_DEADLINE_MS))
    try:
        if command == "health":
            return {"ok": True, "atspi": True, "display": display}
        if command == "capabilities":
            return {"ok": True, **capabilities(display)}
        if command == "windows":
            sx, sy = scale_factors(display)
            return {
                "ok": True,
                "windows": [scale_window(window, sx, sy) for window in list_windows(display)],
            }
        if command == "tree":
            sx, sy = scale_factors(display)
            elements, truncated = tree(display, request.get("window") or {}, deadline)
            return {
                "ok": True,
                "elements": [scale_element(element, sx, sy) for element in elements],
                "truncated": truncated,
            }
        if command == "find":
            sx, sy = scale_factors(display)
            result = find(display, request, deadline)
            return {
                "ok": True,
                **result,
                "elements": [scale_element(element, sx, sy) for element in result["elements"]],
            }
        if command == "at":
            sx, sy = scale_factors(display)
            point = request.get("point") or {}
            device = {
                "x": float(point.get("x", 0)) / sx if sx else 0,
                "y": float(point.get("y", 0)) / sy if sy else 0,
            }
            result = at(display, device, deadline)
            return {
                "ok": True,
                "element": scale_element(result["element"], sx, sy)
                if result.get("element")
                else None,
            }
        if command == "focused":
            sx, sy = scale_factors(display)
            result = focused(display, request.get("window") or {}, deadline)
            return {
                "ok": True,
                "element": scale_element(result["element"], sx, sy)
                if result.get("element")
                else None,
            }
        return {"ok": False, "error": f"unknown command {command!r}"}
    except Expired:
        return {"ok": True, "unknown": True}
    except GLib.Error:
        return {"ok": True, "unknown": True}
    except Exception as error:  # noqa: BLE001 - every failure is reported on the reply line
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}


class PerceptionServer(socketserver.UnixStreamServer):
    allow_reuse_address = True

    def process(self, request: dict[str, Any]) -> dict[str, Any]:
        return handle(request)


class PerceptionHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        line = self.rfile.readline(MAX_BODY_BYTES + 1)
        if not line:
            return
        request: dict[str, Any] = {}
        try:
            parsed = json.loads(line.decode("utf-8"))
            if not isinstance(parsed, dict):
                raise ValueError("request must be an object")
            request = parsed
            response = self.server.process(request)
        except Exception as error:  # noqa: BLE001
            response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        self.wfile.write(json.dumps(response, separators=(",", ":")).encode("utf-8") + b"\n")
        self.wfile.flush()
        if request.get("cmd") == "shutdown":
            os._exit(0)


def main() -> None:
    Atspi.set_timeout(CALL_TIMEOUT_MS, -1)
    directory = os.path.dirname(SOCKET_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    try:
        os.unlink(SOCKET_PATH)
    except FileNotFoundError:
        pass
    server = PerceptionServer(SOCKET_PATH, PerceptionHandler)
    os.chmod(SOCKET_PATH, 0o600)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
