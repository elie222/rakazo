"""Offline tests for the AT-SPI perception helper's pure protocol and mapping."""
from __future__ import annotations

import importlib.util
import pathlib
import subprocess
import sys
import types
import unittest
from unittest import mock


class FakeStateType:
    SHOWING = "showing"
    FOCUSED = "focused"
    EDITABLE = "editable"
    ENABLED = "enabled"
    CHECKED = "checked"
    INDETERMINATE = "indeterminate"
    EXPANDED = "expanded"


class FakeCoordType:
    SCREEN = 0


class FakeAtspi:
    StateType = FakeStateType
    CoordType = FakeCoordType

    @staticmethod
    def set_timeout(_timeout: int, _reserved: int) -> None:
        return None

    @staticmethod
    def get_desktop(_index: int):
        return None


class FakeGLib:
    class Error(Exception):
        pass


def load_helper():
    gi = types.ModuleType("gi")
    gi.require_version = lambda *_args: None
    repository = types.ModuleType("gi.repository")
    repository.Atspi = FakeAtspi
    repository.GLib = FakeGLib
    gi.repository = repository
    sys.modules["gi"] = gi
    sys.modules["gi.repository"] = repository
    path = pathlib.Path(__file__).with_name("atspi.py")
    spec = importlib.util.spec_from_file_location("rakazo_atspi", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load_helper()


class FakeStateSet:
    def __init__(self, states):
        self.states = set(states)

    def contains(self, state):
        return state in self.states


class FakeComponent:
    def __init__(self, x, y, width, height):
        self.x = x
        self.y = y
        self.width = width
        self.height = height

    def get_extents(self, _coord):
        return types.SimpleNamespace(
            x=self.x,
            y=self.y,
            width=self.width,
            height=self.height,
        )


class FakeNode:
    def __init__(self, role, name, states=(), rect=(10, 20, 100, 30), children=()):
        self.role = role
        self.name = name
        self.states = states
        self.rect = rect
        self.children = list(children)

    def get_role_name(self):
        return self.role

    def get_name(self):
        return self.name

    def get_state_set(self):
        return FakeStateSet(self.states)

    def get_component_iface(self):
        return FakeComponent(*self.rect)

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, index):
        return self.children[index]


WINDOW = {
    "id": 7,
    "pid": 100,
    "cls": "Thunar.Thunar",
    "app": "thunar",
    "title": "Files",
    "frame": {"x": 0, "y": 0, "w": 800, "h": 600},
    "active": True,
}


class ParseTests(unittest.TestCase):
    def test_parses_wmctrl_geometry_and_class(self):
        windows = helper.parse_windows(
            "0x01800003  0 99999991 0 0 1280 800 chromium.Chromium host Example\n"
            "0x04000003  1 99999992 10 20 300 200 thunar.Thunar host Files\n"
            "not a window\n"
        )

        self.assertEqual(
            windows,
            [
                {
                    "id": 0x01800003,
                    "pid": 99999991,
                    "cls": "chromium.Chromium",
                    "app": "chromium",
                    "title": "Example",
                    "frame": {"x": 0, "y": 0, "w": 1280, "h": 800},
                    "active": False,
                },
                {
                    "id": 0x04000003,
                    "pid": 99999992,
                    "cls": "thunar.Thunar",
                    "app": "thunar",
                    "title": "Files",
                    "frame": {"x": 10, "y": 20, "w": 300, "h": 200},
                    "active": False,
                },
            ],
        )

    def test_rank_prefers_exact_then_prefix_then_word_start(self):
        self.assertEqual(helper.rank("Save", "save"), 0)
        self.assertEqual(helper.rank("Save", "sa"), 1)
        self.assertEqual(helper.rank("Save", "av"), 3)
        self.assertEqual(helper.rank("Home", "om"), 3)
        self.assertIsNone(helper.rank("Save", "xyz"))
        self.assertEqual(helper.rank("Save", ""), 0)

    def test_clips_names_and_contains_points(self):
        self.assertEqual(helper.clip_text("a" * 300, 256), "a" * 256)
        self.assertTrue(helper.contains({"x": 10, "y": 20, "w": 30, "h": 40}, 10, 20))
        self.assertTrue(helper.contains({"x": 10, "y": 20, "w": 30, "h": 40}, 39, 59))
        self.assertFalse(helper.contains({"x": 10, "y": 20, "w": 30, "h": 40}, 40, 60))

    def test_active_window_reads_the_root_property(self):
        result = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1800003\n",
            stderr="",
        )
        with mock.patch.object(helper, "run", return_value=result):
            self.assertEqual(helper.active_window(":1"), 0x1800003)

    def test_list_windows_filters_the_panel_and_marks_active(self):
        result = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=(
                "0x01800003  0 99999991 0 0 1280 800 Xfce4-panel host panel\n"
                "0x04000003  1 99999992 10 20 300 200 thunar.Thunar host Files\n"
            ),
            stderr="",
        )
        with (
            mock.patch.object(helper, "run", side_effect=[result, result]),
            mock.patch.object(helper, "active_window", return_value=0x04000003),
        ):
            windows = helper.list_windows(":1")
        self.assertEqual([window["title"] for window in windows], ["Files"])
        self.assertTrue(windows[0]["active"])


class DescribeTests(unittest.TestCase):
    def test_describes_a_button_with_its_state(self):
        node = FakeNode(
            "button",
            "Save",
            states=(FakeStateType.ENABLED, FakeStateType.EDITABLE, FakeStateType.EXPANDED),
        )

        self.assertEqual(
            helper.describe(node, WINDOW, "button", "Save"),
            {
                "point": {"x": 60, "y": 35},
                "bbox": {"x": 10, "y": 20, "w": 100, "h": 30},
                "windowFrame": WINDOW["frame"],
                "source": "ax",
                "app": "thunar",
                "window": "Files",
                "role": "button",
                "name": "Save",
                "secret": False,
                "editable": True,
                "state": {"expanded": True},
            },
        )

    def test_masks_a_password_field_and_reports_disabled(self):
        node = FakeNode("password text", "Password", states=(FakeStateType.EDITABLE,))
        element = helper.describe(node, WINDOW, "password text", "Password")
        self.assertIsNotNone(element)
        self.assertTrue(element["secret"])
        self.assertEqual(element["state"], {"disabled": True})

    def test_a_password_field_name_never_reaches_the_model(self):
        # Some toolkits put what the person typed in the accessible name.
        node = FakeNode("password text", "hunter2", states=(FakeStateType.EDITABLE,))
        element = helper.describe(node, WINDOW, "password text", "hunter2")
        self.assertIsNotNone(element)
        self.assertEqual(element["name"], "[secret]")
        self.assertTrue(element["secret"])

    def test_returns_none_without_extents(self):
        node = FakeNode("button", "Save")
        node.get_component_iface = lambda: None
        self.assertIsNone(helper.describe(node, WINDOW, "button", "Save"))


class CapabilityTests(unittest.TestCase):
    def test_capabilities_reports_programs_and_screen(self):
        result = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="  dimensions:    1440x900 pixels\n",
            stderr="",
        )
        with (
            mock.patch.object(helper, "run", return_value=result),
            mock.patch.object(
                helper.shutil,
                "which",
                side_effect=lambda name: f"/usr/bin/{name}"
                if name in ("git", "libreoffice")
                else None,
            ),
        ):
            capabilities = helper.capabilities(":1")

        self.assertEqual(capabilities["display"], {"width": 1440, "height": 900, "scale": 1})
        self.assertEqual(capabilities["programs"]["git"], "available")
        self.assertEqual(capabilities["programs"]["node"], "not_on_path")
        self.assertTrue(capabilities["desktopApps"])
        self.assertTrue(capabilities["perception"]["atspi"])

    def test_health_and_unknown_command(self):
        self.assertEqual(
            helper.handle({"cmd": "health", "display": ":1"}),
            {"ok": True, "atspi": True, "display": ":1"},
        )
        self.assertEqual(
            helper.handle({"cmd": "bogus", "display": ":1"}),
            {"ok": False, "error": "unknown command 'bogus'"},
        )
        self.assertEqual(
            helper.handle({"cmd": "health", "display": "not-a-display"}),
            {"ok": False, "error": "invalid display"},
        )


class FindTests(unittest.TestCase):
    def test_finds_by_name_role_app_and_window(self):
        windows = [
            {**WINDOW, "pid": 1, "app": "thunar", "title": "Files"},
            {
                **WINDOW,
                "pid": 2,
                "app": "chromium",
                "title": "Example",
                "frame": {"x": 0, "y": 0, "w": 1280, "h": 800},
            },
        ]
        elements = {
            1: [
                {"role": "button", "name": "Save"},
                {"role": "link", "name": "Home"},
            ],
            2: [{"role": "button", "name": "Submit"}],
        }

        def walked(_root, window, _deadline):
            return elements[window["pid"]], False

        with (
            mock.patch.object(helper, "list_windows", return_value=windows),
            mock.patch.object(helper, "window_root", return_value=object()),
            mock.patch.object(helper, "walk_elements", side_effect=walked),
        ):
            save = helper.find(":1", {"text": "Save", "limit": 10}, helper.mono() + 1000)
            buttons = helper.find(
                ":1", {"role": "button", "limit": 10}, helper.mono() + 1000
            )
            thunar = helper.find(
                ":1", {"app": "thunar", "limit": 10}, helper.mono() + 1000
            )
            example = helper.find(
                ":1", {"window": "Example", "limit": 10}, helper.mono() + 1000
            )
            limited = helper.find(":1", {"limit": 1}, helper.mono() + 1000)

        self.assertEqual([element["name"] for element in save["elements"]], ["Save"])
        self.assertEqual(
            [element["name"] for element in buttons["elements"]], ["Save", "Submit"]
        )
        self.assertEqual([element["name"] for element in thunar["elements"]], ["Save", "Home"])
        self.assertEqual([element["name"] for element in example["elements"]], ["Submit"])
        self.assertEqual(len(limited["elements"]), 1)
        self.assertTrue(limited["truncated"])

    def test_expired_find_answers_unknown(self):
        with (
            # The scale lookup shells out to xdpyinfo, which a test host need not have.
            mock.patch.object(helper, "scale_factors", return_value=(1.0, 1.0)),
            mock.patch.object(helper, "find", side_effect=helper.Expired()),
        ):
            self.assertEqual(
                helper.handle({"cmd": "find", "display": ":1", "text": "Save"}),
                {"ok": True, "unknown": True},
            )

    def test_an_application_that_stopped_answering_is_unknown_not_no_match(self):
        stopped = mock.Mock()
        stopped.get_process_id.side_effect = helper.GLib.Error("Timeout was reached")
        desktop = mock.Mock()
        desktop.get_child_count.return_value = 1
        desktop.get_child_at_index.return_value = stopped
        with (
            mock.patch.object(helper, "scale_factors", return_value=(1.0, 1.0)),
            mock.patch.object(helper, "list_windows", return_value=[WINDOW]),
            mock.patch.object(helper.Atspi, "get_desktop", return_value=desktop),
        ):
            self.assertEqual(
                helper.handle({"cmd": "find", "display": ":1", "text": "Save"}),
                {"ok": True, "unknown": True},
            )


if __name__ == "__main__":
    unittest.main()
