"""Offline regressions for the focus-or-launch wrapper and its control argv."""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


def load_module(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(Path(__file__).with_name(filename)))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


helper = load_module("focus_or_launch", "rakazo-focus-or-launch")
control = load_module("control", "control.py")


def wait_for_cmdline(pid):
    """/proc cmdline can be empty for a moment after exec, even once Popen returns."""
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as handle:
                if handle.read().strip(b"\0"):
                    return
        except OSError:
            pass
        time.sleep(0.01)
    raise AssertionError(f"cmdline for {pid} stayed empty")

LISTING = """\
0x01800003  0 99999991 chromium.Chromium   box  Example page - Chromium
0x04000003  0 99999992 xterm.XTerm         box  Terminal
0x0400000f -1 99999993 N/A.N/A             box  dock
0x04400010  0
"""


class WmClassTest(unittest.TestCase):
    def test_known_launchers_have_fixed_classes(self):
        self.assertEqual(helper.wm_class("rakazo-browser"), "chromium")
        self.assertEqual(helper.wm_class("xterm"), "xterm")

    def test_other_launchers_match_their_binary_basename(self):
        self.assertEqual(helper.wm_class("/usr/bin/xterm"), "xterm")
        self.assertEqual(helper.wm_class("XTerm"), "xterm")


class MatchingWindowTest(unittest.TestCase):
    def test_matches_the_wm_class_field_not_id_host_or_title(self):
        self.assertEqual(helper.matching_window(LISTING, "xterm"), "0x04000003")
        self.assertEqual(helper.matching_window(LISTING, "chromium"), "0x01800003")
        self.assertEqual(helper.matching_window(LISTING, "Terminal"), "")

    def test_matching_is_case_insensitive(self):
        listing = LISTING.replace("xterm.XTerm", "XTerm.XTerm")
        self.assertEqual(helper.matching_window(listing, "xterm"), "0x04000003")

    def test_first_match_wins_and_malformed_rows_are_skipped(self):
        listing = LISTING + "0x05000000  0 99999994 xterm.XTerm         box  second\n"
        self.assertEqual(helper.matching_window(listing, "xterm"), "0x04000003")
        self.assertEqual(helper.matching_window("garbage\n\n", "xterm"), "")
        self.assertEqual(helper.matching_window("", "xterm"), "")

    def test_components_do_not_match_a_longer_class_name(self):
        listing = "0x04000001  0 99999995 uxterm.UXTerm host uxterm\n" + LISTING
        self.assertEqual(helper.matching_window(listing, "xterm"), "0x04000003")
        self.assertEqual(helper.matching_window(listing, "uxterm"), "0x04000001")

    def test_browser_windows_are_limited_to_the_requested_profile(self):
        listing = (
            "0x01800003  0 100 chromium.Chromium box Other\n"
            "0x01800004  0 200 chromium.Chromium box Mine\n"
        )
        profiles = {"100": "/profiles/other", "200": "/profiles/mine"}
        with patch.object(helper, "window_profile", side_effect=lambda pid: profiles.get(pid)):
            self.assertEqual(
                helper.matching_window(listing, "chromium", "/profiles/mine"), "0x01800004"
            )
            self.assertEqual(helper.matching_window(listing, "chromium", "/profiles/missing"), "")
        # No profile request keeps the first class match, including when profiles are unreadable.
        self.assertEqual(helper.matching_window(listing, "chromium"), "0x01800003")


class MainTest(unittest.TestCase):
    def run_wrapper(self, argv, listing=LISTING, launch_code=None):
        calls = []

        def fake_run(run_argv, **_kwargs):
            if run_argv[:2] == ["wmctrl", "-lxp"]:
                return subprocess.CompletedProcess(run_argv, 0, listing, "")
            calls.append(("run", run_argv))
            return subprocess.CompletedProcess(run_argv, 0, "", "")

        def fake_popen(popen_argv, **_kwargs):
            calls.append(("popen", popen_argv))

            class Child:
                def wait(self, timeout=None):
                    calls.append(("wait", timeout))
                    if launch_code is None:
                        raise subprocess.TimeoutExpired(popen_argv, timeout or 0)
                    return launch_code

            return Child()

        with patch.object(helper.subprocess, "run", side_effect=fake_run), patch.object(
            helper.subprocess, "Popen", side_effect=fake_popen
        ):
            try:
                helper.main(argv)
            except SystemExit as error:
                if error.code:
                    calls.append(("exit", error.code))
        return calls

    def test_activates_a_matching_window_without_spawning(self):
        calls = self.run_wrapper(["xterm"])
        self.assertEqual(calls, [("run", ["wmctrl", "-ia", "0x04000003"])])

    def test_spawns_the_launcher_when_no_window_matches(self):
        calls = self.run_wrapper(["xterm"], listing="")
        self.assertEqual(calls, [("popen", ["xterm"]), ("wait", helper.DEFAULT_LAUNCH_WAIT_SEC)])

    def test_missing_wmctrl_still_spawns(self):
        calls = []

        def fake_popen(popen_argv, **_kwargs):
            calls.append(popen_argv)

            class Child:
                def wait(self, timeout=None):
                    raise subprocess.TimeoutExpired(popen_argv, timeout or 0)

            return Child()

        with patch.object(helper.subprocess, "run", side_effect=OSError), patch.object(
            helper.subprocess, "Popen", side_effect=fake_popen
        ):
            with self.assertRaises(SystemExit) as raised:
                helper.main(["xterm"])
        self.assertEqual(raised.exception.code, 0)
        self.assertEqual(calls, [["xterm"]])

    def test_arguments_reach_the_launcher_before_the_window_is_raised(self):
        calls = self.run_wrapper(["rakazo-browser", "https://example.test"], launch_code=0)
        self.assertEqual(
            calls,
            [
                ("popen", ["rakazo-browser", "https://example.test"]),
                ("wait", helper.LAUNCH_WAIT_SEC["rakazo-browser"]),
                ("run", ["wmctrl", "-ia", "0x01800003"]),
            ],
        )

    def test_a_live_launcher_does_not_block_the_raise(self):
        calls = self.run_wrapper(["rakazo-browser", "https://example.test"])
        self.assertEqual(calls[-1], ("run", ["wmctrl", "-ia", "0x01800003"]))

    def test_a_failing_launcher_does_not_raise_or_succeed(self):
        calls = self.run_wrapper(["xterm", "bad-flag"], launch_code=1)
        self.assertEqual(
            calls,
            [
                ("popen", ["xterm", "bad-flag"]),
                ("wait", helper.DEFAULT_LAUNCH_WAIT_SEC),
                ("exit", 1),
            ],
        )

    def test_usage_error_without_a_launcher(self):
        with self.assertRaises(SystemExit):
            helper.main([])

    def test_a_different_browser_profile_is_not_raised(self):
        calls = self.run_wrapper(["rakazo-browser"])
        # The fixture PIDs expose no profile, so the only chromium window is raised.
        self.assertEqual(calls, [("run", ["wmctrl", "-ia", "0x01800003"])])
        with patch.object(helper, "window_profile", return_value="/profiles/other"), patch.dict(
            os.environ, {"RAKAZO_BROWSER_PROFILE": "/profiles/mine"}
        ):
            calls = self.run_wrapper(["rakazo-browser"])
        self.assertEqual(
            calls,
            [("popen", ["rakazo-browser"]), ("wait", helper.LAUNCH_WAIT_SEC["rakazo-browser"])],
        )


PROFILE = "/home/rakazo/.browser-profiles/chromium-bot-" + "a" * 32


class ControlArgvTest(unittest.TestCase):
    def test_accepts_wrapped_known_launchers(self):
        for argv in (
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "rakazo-browser"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "rakazo-browser", "https://example.test"],
            [
                "env",
                "DISPLAY=:1",
                f"RAKAZO_BROWSER_PROFILE={PROFILE}",
                "rakazo-focus-or-launch",
                "rakazo-browser",
                "https://example.test",
            ],
        ):
            with self.subTest(argv=argv):
                self.assertTrue(control.allowed_control_argv(argv, ":1"))
                self.assertFalse(control.is_long_lived_control(argv))

    def test_rejects_launchers_outside_the_allowlist(self):
        for inner in ("sh", "wmctrl", "rakazo-focus-or-launch", "/usr/bin/xterm"):
            argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", inner]
            with self.subTest(inner=inner):
                self.assertFalse(control.allowed_control_argv(argv, ":1"))

    def test_rejects_bad_arity_and_a_browser_profile_on_other_launchers(self):
        for argv in (
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm", "one", "two"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm", "-e", "sh"],
            [
                "env",
                "DISPLAY=:1",
                f"RAKAZO_BROWSER_PROFILE={PROFILE}",
                "rakazo-focus-or-launch",
                "xterm",
            ],
            ["env", "DISPLAY=:8", "rakazo-focus-or-launch", "xterm"],
        ):
            with self.subTest(argv=argv):
                self.assertFalse(control.allowed_control_argv(argv, ":1"))

    def test_wrapped_browser_keeps_the_browser_spawn_poll(self):
        argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "rakazo-browser"]
        self.assertEqual(control.launch_spawn_poll_sec(argv), control.BROWSER_OPEN_POLL_SEC)
        argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm"]
        self.assertEqual(control.launch_spawn_poll_sec(argv), control.LAUNCH_SPAWN_POLL_SEC)

    def test_focus_waits_for_the_wrapper_instead_of_the_spawn_poll(self):
        argv = [
            "env",
            "DISPLAY=:1",
            f"RAKAZO_BROWSER_PROFILE={PROFILE}",
            "rakazo-focus-or-launch",
            "rakazo-browser",
        ]
        with patch.object(
            control.subprocess, "run", return_value=subprocess.CompletedProcess(argv, 0)
        ) as run:
            control.run_control_argv(argv, ":1")
        self.assertEqual(run.call_args.args[0], argv)
        self.assertEqual(run.call_args.kwargs["timeout"], control.FOCUS_COMPLETION_SEC)
        self.assertGreater(control.FOCUS_COMPLETION_SEC, control.LAUNCH_SPAWN_POLL_SEC)

    def test_slow_focus_is_not_reported_before_the_wrapper_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "rakazo-focus-or-launch"
            marker = Path(tmp) / "done"
            script.write_text(f"#!/bin/sh\nsleep 0.5\ntouch {marker}\n")
            script.chmod(script.stat().st_mode | stat.S_IEXEC)
            argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm"]
            with patch.dict(os.environ, {"PATH": f"{tmp}{os.pathsep}{os.environ.get('PATH', '')}"}):
                started = time.monotonic()
                control.run_control_argv(argv, ":1")
                elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, 0.45)
            self.assertTrue(marker.exists())


class ScriptTest(unittest.TestCase):
    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux /proc process arguments")
    def test_window_profile_reads_the_user_data_dir_flag(self):
        # The flag has to stay on this process. A shell would exec the sleep away.
        equals = subprocess.Popen(
            ["python3", "-c", "import time; time.sleep(30)", "--user-data-dir=/profiles/mine"]
        )
        separate = subprocess.Popen(
            [
                "python3",
                "-c",
                "import time; time.sleep(30)",
                "--user-data-dir",
                "/profiles/other",
            ]
        )
        try:
            wait_for_cmdline(equals.pid)
            wait_for_cmdline(separate.pid)
            self.assertEqual(helper.window_profile(str(equals.pid)), "/profiles/mine")
            self.assertEqual(helper.window_profile(str(separate.pid)), "/profiles/other")
            self.assertIsNone(helper.window_profile("99999999"))
        finally:
            for proc in (equals, separate):
                proc.kill()
                proc.wait()

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux /proc process arguments")
    def test_script_raises_the_requested_browser_profile_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            windows = Path(tmp) / "windows"
            args_log = Path(tmp) / "args"
            other = subprocess.Popen(
                ["python3", "-c", "import time; time.sleep(30)", "--user-data-dir=/profiles/other"]
            )
            mine = subprocess.Popen(
                ["python3", "-c", "import time; time.sleep(30)", "--user-data-dir=/profiles/mine"]
            )
            try:
                wait_for_cmdline(other.pid)
                wait_for_cmdline(mine.pid)
                windows.write_text(
                    f"0x111 0 {other.pid} chromium.Chromium host Other\n"
                    f"0x222 0 {mine.pid} chromium.Chromium host Mine\n"
                )
                wmctrl = bin_dir / "wmctrl"
                wmctrl.write_text(
                    "#!/bin/sh\n"
                    'if [ "$1" = "-lxp" ]; then cat "$RAKAZO_TEST_WINDOWS"; exit 0; fi\n'
                    'printf "wmctrl %s\\n" "$*" >> "$RAKAZO_TEST_ARGS"\n'
                )
                browser = bin_dir / "rakazo-browser"
                browser.write_text('#!/bin/sh\nprintf "browser %s\\n" "$*" >> "$RAKAZO_TEST_ARGS"\n')
                wmctrl.chmod(0o755)
                browser.chmod(0o755)
                env = {
                    **os.environ,
                    "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
                    "RAKAZO_BROWSER_PROFILE": "/profiles/mine",
                    "RAKAZO_TEST_WINDOWS": str(windows),
                    "RAKAZO_TEST_ARGS": str(args_log),
                }
                script = str(Path(__file__).with_name("rakazo-focus-or-launch"))
                result = subprocess.run(
                    ["python3", script, "rakazo-browser"],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(args_log.read_text().strip(), "wmctrl -ia 0x222")

                args_log.write_text("")
                windows.write_text(f"0x111 0 {other.pid} chromium.Chromium host Other\n")
                result = subprocess.run(
                    ["python3", script, "rakazo-browser"],
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(args_log.read_text().strip(), "browser")
            finally:
                for proc in (other, mine):
                    proc.kill()
                    proc.wait()


if __name__ == "__main__":
    unittest.main()
