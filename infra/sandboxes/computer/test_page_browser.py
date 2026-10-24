"""Offline protocol/error regressions for the live browser helper."""
import importlib.machinery
import importlib.util
from pathlib import Path
import struct
import os
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

loader = importlib.machinery.SourceFileLoader("page_browser", str(Path(__file__).with_name("rakazo-page-browser")))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


class PageBrowserTest(unittest.TestCase):
    def test_closed_stdin_cancels_helper_without_a_browser(self):
        with subprocess.Popen([sys.executable, str(Path(__file__).with_name("rakazo-page-browser")), "snapshot", "{}"],
                              env={**os.environ, "RAKAZO_BROWSER_WATCH_STDIN": "1", "RAKAZO_CDP_PORT": "0"},
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            process.stdin.close()
            self.assertEqual(process.wait(timeout=3), 130)

    def test_closed_extended_frame_does_not_spin(self):
        for partial in (b"\x81\x7e", b"\x81\x7f", b"\x81\x80"):
            with self.subTest(partial=partial):
                client = helper.CdpClient("ws://127.0.0.1:9222/test")
                client._sock = Mock()
                client._sock.recv.return_value = b""
                client._buf.extend(partial)
                with self.assertRaisesRegex(RuntimeError, "closed"):
                    client._read_frame()

    def test_bounds_frame_before_reading_payload(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client._sock = Mock()
        client._buf.extend(b"\x81\x7f" + struct.pack("!Q", 10_000_000))
        with self.assertRaisesRegex(RuntimeError, "too large"):
            client._read_frame()
        client._sock.recv.assert_not_called()

    def settling_client(self, idle_after_calls):
        """A client whose page reaches networkIdle on the given getFrameTree call, or never."""
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        frame_tree_calls = []

        def event(name, loader="L1"):
            client._handle_event({"method": "Page.lifecycleEvent", "sessionId": "session",
                                  "params": {"frameId": "F", "loaderId": loader, "name": name}})

        def call(method, params=None, *, session_id=None, timeout_s=30.0):
            if method == "Page.setLifecycleEventsEnabled":
                # Chromium replays what the current document has reached: loaded, still fetching.
                for name in ("commit", "DOMContentLoaded", "load", "networkAlmostIdle"):
                    event(name)
            if method == "Page.getFrameTree":
                frame_tree_calls.append(method)
                if len(frame_tree_calls) == idle_after_calls:
                    event("networkIdle")
                return {"frameTree": {"frame": {"id": "F"}}}
            return {}

        client.call = call
        return client, frame_tree_calls, event

    def test_snapshot_waits_for_the_page_to_finish_its_requests(self):
        client, calls, _ = self.settling_client(idle_after_calls=3)
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "eval_json") as evaluate, \
                patch.object(helper.time, "sleep"):
            evaluate.return_value = {"title": "Example", "tree": "Signed in as test-user"}
            result = helper.snapshot(client, "session")
        self.assertEqual(len(calls), 3)
        self.assertEqual(result, {"ok": True, "title": "Example", "tree": "Signed in as test-user"})

    def test_snapshot_flags_a_page_that_is_still_loading(self):
        client, calls, _ = self.settling_client(idle_after_calls=0)
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "eval_json") as evaluate, \
                patch.object(helper, "SETTLE_SECONDS", 0.2):
            evaluate.return_value = {"title": "Example", "tree": "Sign in Loading"}
            result = helper.snapshot(client, "session")
        self.assertGreater(len(calls), 1)
        self.assertEqual(result, {"ok": True, "title": "Example", "tree": "Sign in Loading", "loading": True})

    def test_snapshot_reports_loading_when_the_browser_is_too_slow_to_answer(self):
        timeouts = []

        def call(method, params=None, *, session_id=None, timeout_s=30.0):
            # A browser that answers no call before that call's own timeout.
            timeouts.append(timeout_s)
            raise TimeoutError(f"CDP call timed out: {method}")

        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client.call = call
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "eval_json") as evaluate:
            evaluate.return_value = {"title": "Example", "tree": "Sign in Loading"}
            result = helper.snapshot(client, "session")
        self.assertEqual(result, {"ok": True, "title": "Example", "tree": "Sign in Loading", "loading": True})
        self.assertTrue(timeouts)
        self.assertTrue(all(timeout <= helper.SETTLE_SECONDS for timeout in timeouts), timeouts)

    def test_slow_lifecycle_enable_exhausts_the_settle_budget(self):
        # Advance a fake clock by the timeout an unresponsive CDP call receives.
        now = [0.0]
        calls = []

        def call(method, params=None, *, session_id=None, timeout_s=30.0):
            calls.append((method, timeout_s))
            now[0] += timeout_s
            raise TimeoutError("CDP enable timed out")

        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client.call = call
        with patch.object(helper.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(helper, "ensure_helpers"), patch.object(helper, "eval_json") as evaluate:
            evaluate.return_value = {"tree": "Loading"}
            result = helper.snapshot(client, "session")
        self.assertEqual(result, {"ok": True, "tree": "Loading", "loading": True})
        self.assertEqual(calls, [("Page.setLifecycleEventsEnabled", helper.SETTLE_SECONDS)])
        self.assertLessEqual(now[0], helper.SETTLE_SECONDS)

    def test_frame_wait_uses_only_the_budget_left_after_enabling_events(self):
        now = [0.0]
        calls = []

        def call(method, params=None, *, session_id=None, timeout_s=30.0):
            calls.append((method, timeout_s))
            if method == "Page.setLifecycleEventsEnabled":
                now[0] += helper.SETTLE_SECONDS - 0.01
                return {}
            now[0] += timeout_s
            raise TimeoutError("CDP frame timed out")

        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client.call = call
        with patch.object(helper.time, "monotonic", side_effect=lambda: now[0]):
            self.assertFalse(helper.wait_for_settle(client, "session"))
        self.assertEqual([method for method, _ in calls],
                         ["Page.setLifecycleEventsEnabled", "Page.getFrameTree"])
        self.assertAlmostEqual(calls[1][1], 0.01)
        self.assertLessEqual(now[0], helper.SETTLE_SECONDS)

    def test_a_new_document_does_not_inherit_the_old_one_being_idle(self):
        client, _, event = self.settling_client(idle_after_calls=0)
        event("networkIdle")
        event("init", loader="L2")
        event("load", loader="L2")
        self.assertEqual(client.lifecycle("session", "F"), {"init", "load"})

    def test_rejects_url_credentials_before_navigation(self):
        client = Mock()
        for url in ("http://example:fake-password@example.test", "https://example:fake-password@example.test"):
            with self.assertRaisesRegex(RuntimeError, "credentials"):
                helper.navigate(client, "session", url)
        client.call.assert_not_called()

    def test_rejects_navigation_error(self):
        client = Mock()
        client.call.return_value = {"errorText": "net::ERR_NAME_NOT_RESOLVED"}
        with self.assertRaisesRegex(RuntimeError, "ERR_NAME_NOT_RESOLVED"):
            helper.navigate(client, "session", "https://example.test")

    def test_preserves_completed_actions_when_next_response_is_lost(self):
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [True, {}, True, TimeoutError("lost response")]
            result = helper.act(Mock(), "session", [
                {"kind": "click", "ref": "first"}, {"kind": "click", "ref": "second"},
            ])
        self.assertEqual(result["completed"], 1)
        self.assertTrue(result["uncertain"])
        self.assertFalse(result["ok"])

    def test_rejects_missing_text_before_any_action(self):
        with patch.object(helper, "ensure_helpers") as ensure:
            with self.assertRaisesRegex(RuntimeError, "Text"):
                helper.act(Mock(), "session", [{"kind": "fill", "ref": "first"}])
            ensure.assert_not_called()

    def test_binds_saved_login_fill_to_its_origin_in_the_same_evaluation(self):
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "snapshot", return_value={"ok": True}), \
                patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [True, {}]
            helper.act(Mock(), "session", [
                {"kind": "fill", "ref": "e1", "text": "fake-password", "origin": "https://login.example.test"},
            ])
        self.assertEqual(
            evaluate.call_args_list[1].args[2],
            'window.__rakazoPageBrowser.fill("e1", "fake-password", "https://login.example.test")',
        )

    def test_rejects_origin_outside_fill_before_any_action(self):
        with patch.object(helper, "ensure_helpers") as ensure:
            with self.assertRaisesRegex(RuntimeError, "origin"):
                helper.act(Mock(), "session", [
                    {"kind": "type", "ref": "e1", "text": "x", "origin": "https://login.example.test"},
                ])
            ensure.assert_not_called()

    def test_key_events_press_printable_characters_and_insert_the_rest(self):
        self.assertEqual(helper.key_event("6"),
                         {"key": "6", "code": "Digit6", "text": "6", "windowsVirtualKeyCode": 54})
        self.assertEqual(helper.key_event("q")["code"], "KeyQ")
        self.assertEqual(helper.key_event("Q")["windowsVirtualKeyCode"], 81)
        self.assertEqual(helper.key_event(" ")["code"], "Space")
        self.assertEqual(helper.key_event("\n"), {"key": "Enter", "code": "Enter", "text": "\r",
                                                  "windowsVirtualKeyCode": 13, "modifiers": 8})
        self.assertEqual(helper.key_event("@"), {"key": "@", "text": "@"})
        self.assertIsNone(helper.key_event("é"))

    def type_once(self, focus, text, typed=True, after_key=None, more=(), on_clear=None, page=None):
        """Runs one type step against a stand-in browser.

        after_key(n, client, state) runs once key n has landed; on_clear(client, state) while the field is emptied.
        """
        client = helper.CdpClient("ws://browser.example.test:9222/test")
        sent = []
        state = {"focused": True, "gone": False}

        def call(method, params=None, **_):
            if method == "Page.getFrameTree":
                document = (client.navigations("session", "main"), state["gone"])
                return {"frameTree": {"frame": {"id": "main", "loaderId": str(document)}}}
            sent.append((method, params))
            if after_key and (method == "Input.insertText" or params.get("type") == "keyUp"):
                after_key(sum(m == "Input.insertText" or p.get("type") == "keyUp" for m, p in sent), client, state)
            return {}

        def evaluate(_, __, expression):
            if state["gone"]:
                raise RuntimeError("Runtime.evaluate failed: Cannot find context with specified id")
            if "resolve(" in expression:
                return True
            if "focusForKeys(" in expression:
                if on_clear:
                    on_clear(client, state)
                return focus
            if "focusHolds()" in expression:
                return state["focused"]
            if "typed(" in expression:
                return typed
            return {}

        client.call = call
        with patch.object(helper, "ensure_helpers"), \
                patch.object(helper, "snapshot", return_value=page or {"ok": True}), \
                patch.object(helper, "eval_json", side_effect=evaluate) as evaluated:
            result = helper.act(client, "session", [{"kind": "type", "ref": "e1", "text": text}, *more])
        return result, sent, [call.args[2] for call in evaluated.call_args_list]

    @staticmethod
    def navigate_on(key, event="Page.frameRequestedNavigation", **params):
        def after_key(n, client, state):
            if n == key:
                client._handle_event({"method": event, "sessionId": "session",
                                      "params": {"frameId": "main", **params}})
        return after_key

    def test_type_presses_each_key_into_the_focused_field(self):
        result, sent, evaluated = self.type_once({"focused": True, "multiline": False}, "6é")
        self.assertEqual(result, {"ok": True, "completed": 1})
        self.assertEqual(evaluated[1], 'window.__rakazoPageBrowser.focusForKeys("e1", true)')
        self.assertEqual(evaluated[-1], 'window.__rakazoPageBrowser.typed("e1", "6\\u00e9")')
        self.assertEqual(sent, [
            ("Input.dispatchKeyEvent", {"type": "keyDown", "key": "6", "code": "Digit6", "text": "6",
                                        "windowsVirtualKeyCode": 54, "unmodifiedText": "6"}),
            ("Input.dispatchKeyEvent", {"type": "keyUp", "key": "6", "code": "Digit6", "windowsVirtualKeyCode": 54}),
            ("Input.insertText", {"text": "é"}),
        ])

    def test_type_of_one_character_replaces_only_the_box_it_is_typed_into(self):
        result, sent, evaluated = self.type_once({"focused": True, "multiline": False}, "8")
        self.assertEqual(result, {"ok": True, "completed": 1})
        self.assertEqual(evaluated[1], 'window.__rakazoPageBrowser.focusForKeys("e1", false)')
        self.assertEqual([params["key"] for _, params in sent if params.get("type") == "keyDown"], ["8"])

    def test_type_checks_the_page_before_every_key_and_after_the_last(self):
        _, sent, evaluated = self.type_once({"focused": True, "multiline": False}, "482913")
        self.assertEqual(len([params for _, params in sent if params.get("type") == "keyDown"]), 6)
        self.assertEqual(evaluated.count("window.__rakazoPageBrowser.focusHolds()"), 7)

    def test_type_presses_no_key_when_emptying_the_field_made_the_page_navigate(self):
        def on_clear(client, _):
            client._handle_event({"method": "Page.frameRequestedNavigation", "sessionId": "session",
                                  "params": {"frameId": "main", "disposition": "currentTab"}})
        result, sent, _ = self.type_once({"focused": True, "multiline": False}, "482913", on_clear=on_clear)
        self.assertEqual(sent, [])
        self.assertEqual({key: result[key] for key in ("ok", "completed")}, {"ok": False, "completed": 0})
        self.assertIn("page changed while typing, after 0 of 6 characters", result["error"])

    def test_type_breaks_lines_with_shift_enter_only_where_a_line_break_belongs(self):
        _, one_line, _ = self.type_once({"focused": True, "multiline": False}, "a\r\nb\n")
        self.assertNotIn("Enter", [params.get("key") for _, params in one_line])
        _, text_area, _ = self.type_once({"focused": True, "multiline": True}, "a\r\nb\rc")
        enters = [params for _, params in text_area if params.get("key") == "Enter"]
        # One line break per newline, each a Shift+Enter in both the key press and its release.
        self.assertEqual([(params["type"], params["modifiers"]) for params in enters],
                         [("keyDown", 8), ("keyUp", 8)] * 2)
        self.assertNotIn("Input.insertText", [method for method, _ in text_area])

    def test_type_reports_characters_the_page_did_not_keep(self):
        result, _, _ = self.type_once({"focused": True, "multiline": False}, "A7K29Q", typed=False)
        self.assertEqual({key: result[key] for key in ("ok", "completed")}, {"ok": False, "completed": 1})
        self.assertIn("did not keep every character", result["error"])
        self.assertNotIn("A7K29Q", result["error"])

    def test_type_stops_at_once_when_the_page_navigates_mid_code(self):
        events = [
            ("Page.frameRequestedNavigation", {"disposition": "currentTab"}),
            ("Page.frameStartedNavigating", {"navigationType": "differentDocument"}),
            ("Page.frameNavigated", {}),
        ]
        for event, params in events:
            with self.subTest(event=event):
                if event == "Page.frameNavigated":
                    def after_key(n, client, _):
                        if n == 2:
                            client._handle_event({"method": event, "sessionId": "session",
                                                  "params": {"frame": {"id": "main"}}})
                else:
                    after_key = self.navigate_on(2, event, **params)
                result, sent, _ = self.type_once({"focused": True, "multiline": False}, "482913",
                                                 after_key=after_key)
                self.assertEqual([p["key"] for _, p in sent if p.get("type") == "keyDown"], ["4", "8"])
                self.assertEqual({key: result[key] for key in ("ok", "completed")}, {"ok": False, "completed": 0})
                self.assertIn("page changed while typing, after 2 of 6 characters", result["error"])
                self.assertNotIn("482913", result["error"])

    def test_type_stops_when_the_document_is_gone_before_any_event_arrives(self):
        def after_key(n, _, state):
            state["gone"] = n == 3
        result, sent, _ = self.type_once({"focused": True, "multiline": False}, "482913", after_key=after_key)
        self.assertEqual(len([p for _, p in sent if p.get("type") == "keyDown"]), 3)
        self.assertIn("page changed while typing", result["error"])

    def test_type_keeps_going_through_same_document_and_other_tab_navigations(self):
        elsewhere = [
            ("Page.frameStartedNavigating", {"frameId": "main", "navigationType": "sameDocument"}),
            ("Page.frameRequestedNavigation", {"frameId": "main", "disposition": "newTab"}),
            ("Page.frameRequestedNavigation", {"frameId": "ad", "disposition": "currentTab"}),
        ]

        def after_key(n, client, _):
            if n == 1:
                for event, params in elsewhere:
                    client._handle_event({"method": event, "sessionId": "session", "params": params})
        result, sent, _ = self.type_once({"focused": True, "multiline": False}, "482913", after_key=after_key)
        self.assertEqual(result, {"ok": True, "completed": 1})
        self.assertEqual(len([p for _, p in sent if p.get("type") == "keyDown"]), 6)

    def test_type_that_submits_on_the_last_key_is_done_and_later_steps_are_stale(self):
        signed_in = {"ok": True, "url": "https://code.example.test/done", "title": "Signed in", "elements": []}
        result, sent, evaluated = self.type_once(
            {"focused": True, "multiline": False}, "482913", after_key=self.navigate_on(6),
            more=[{"kind": "click", "ref": "e2"}], page=signed_in)
        self.assertEqual(len([p for _, p in sent if p.get("type") == "keyDown"]), 6)
        # The result is the page the code led to.
        self.assertEqual({key: result.get(key) for key in ("ok", "completed", "url", "title")},
                         {"ok": False, "completed": 1, "url": signed_in["url"], "title": "Signed in"})
        self.assertIn("Stale element ref", result["error"])
        self.assertFalse(any("typed(" in expression or "click(" in expression for expression in evaluated))
        alone, _, _ = self.type_once({"focused": True, "multiline": False}, "482913", after_key=self.navigate_on(6))
        self.assertEqual(alone, {"ok": True, "completed": 1})

    def test_type_stops_when_focus_leaves_the_field_or_its_code(self):
        def after_key(n, _, state):
            state["focused"] = n < 3
        result, sent, _ = self.type_once({"focused": True, "multiline": False}, "482913", after_key=after_key)
        self.assertEqual([p["key"] for _, p in sent if p.get("type") == "keyDown"], ["4", "8", "2"])
        self.assertEqual({key: result[key] for key in ("ok", "completed")}, {"ok": False, "completed": 0})
        self.assertIn("Focus left the field while typing, after 3 of 6 characters", result["error"])
        self.assertNotIn("482913", result["error"])

    def test_type_into_a_select_chooses_the_option_as_fill_does(self):
        result, sent, evaluated = self.type_once({"select": True}, "Blue")
        self.assertEqual(result, {"ok": True, "completed": 1})
        self.assertEqual(evaluated[2], 'window.__rakazoPageBrowser.fill("e1", "Blue")')
        self.assertEqual(sent, [])

    def test_type_presses_nothing_when_the_field_does_not_take_focus(self):
        result, sent, _ = self.type_once({"focused": False, "multiline": False}, "x")
        self.assertFalse(result["ok"])
        self.assertIn("keyboard focus", result["error"])
        self.assertEqual(sent, [])

    def test_reads_arguments_from_one_stdin_line_only(self):
        payload = b'{"actions": []}\nrest'
        with patch.object(helper.os, "read", side_effect=[payload[i:i + 1] for i in range(len(payload))]) as read:
            self.assertEqual(helper.read_stdin_line(), '{"actions": []}')
        self.assertEqual(read.call_count, len(b'{"actions": []}\n'))

    def test_discovery_cannot_leave_loopback_endpoint(self):
        with patch.object(helper, "http_get_json", return_value={"webSocketDebuggerUrl": "ws://example.test:9222/session"}):
            with self.assertRaisesRegex(RuntimeError, "Unexpected CDP"):
                helper.discover_ws_url(9222)

    def test_ensure_world_reuses_named_isolated_context(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        calls = []

        def fake_call(method, params=None, *, session_id=None, timeout_s=30.0):
            calls.append(method)
            if method == "Page.getFrameTree":
                return {"frameTree": {"frame": {"id": "frame-1"}}}
            if method == "Runtime.enable":
                client._handle_event({
                    "method": "Runtime.executionContextCreated",
                    "sessionId": session_id,
                    "params": {
                        "context": {
                            "id": 42,
                            "name": helper.WORLD_NAME,
                            "auxData": {"frameId": "frame-1", "isDefault": False},
                        }
                    },
                })
                return {}
            raise AssertionError(f"unexpected CDP call: {method}")

        client.call = fake_call  # type: ignore[method-assign]
        helper.ensure_world(client, "session-a")
        self.assertEqual(client.context_id, 42)
        self.assertNotIn("Page.createIsolatedWorld", calls)

    def test_context_lookup_rejects_default_foreign_and_unbound_contexts(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        for aux, session in (({"frameId": "frame-1", "isDefault": True}, "session-a"),
                             ({"frameId": "other-frame", "isDefault": False}, "session-a"),
                             ({"frameId": "frame-1", "isDefault": False}, "session-b"),
                             ({}, "session-a")):
            client._handle_event({"method": "Runtime.executionContextCreated", "sessionId": session,
                                  "params": {"context": {"id": 42, "name": helper.WORLD_NAME, "auxData": aux}}})
            self.assertIsNone(client.find_world_context(helper.WORLD_NAME, "frame-1", "session-a"))

    def test_ensure_world_creates_when_missing(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")

        def fake_call(method, params=None, *, session_id=None, timeout_s=30.0):
            if method == "Page.getFrameTree":
                return {"frameTree": {"frame": {"id": "frame-1"}}}
            if method == "Runtime.enable":
                return {}
            if method == "Page.createIsolatedWorld":
                self.assertEqual(params["worldName"], helper.WORLD_NAME)
                return {"executionContextId": 7}
            raise AssertionError(f"unexpected CDP call: {method}")

        client.call = fake_call  # type: ignore[method-assign]
        helper.ensure_world(client, "session-a")
        self.assertEqual(client.context_id, 7)

    def test_upload_paths_must_be_existing_files_inside_home(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as outside:
            receipt = Path(home, "receipts", "march.pdf")
            receipt.parent.mkdir()
            receipt.write_bytes(b"%PDF-1.4")
            secret = Path(outside, "secret.txt")
            secret.write_text("nope")
            Path(home, "escape.txt").symlink_to(secret)

            self.assertEqual(
                helper.resolve_upload_paths(["receipts/march.pdf"], home),
                [os.path.realpath(receipt)],
            )
            for paths, message in (
                (["../" + Path(outside).name + "/secret.txt"], "inside this computer's home"),
                ([str(secret)], "inside this computer's home"),
                (["escape.txt"], "inside this computer's home"),
                (["receipts/missing.pdf"], "File not found"),
                (["receipts"], "Not a regular file"),
                ([], "1 to 10"),
                (["a"] * 11, "1 to 10"),
                ([""], "non-empty"),
            ):
                with self.subTest(paths=paths), self.assertRaisesRegex(RuntimeError, message):
                    helper.resolve_upload_paths(paths, home)

    def test_upload_confinement_checks_symlinked_parents_without_leaking_targets(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as outside:
            Path(home, "parent").symlink_to(outside, target_is_directory=True)
            for exists in (False, True):
                if exists:
                    Path(outside, "secret.txt").write_text("secret")
                with self.subTest(exists=exists), self.assertRaises(RuntimeError) as error:
                    helper.resolve_upload_paths(["parent/secret.txt"], home)
                self.assertEqual(str(error.exception),
                                 "Upload files must be inside this computer's home folder: parent/secret.txt")
                self.assertNotIn(outside, str(error.exception))

    def test_team_upload_roots_confine_files_and_roots_after_symlinks(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as outside:
            for folder in ("bots/b1", "bots/b2", "shared"):
                Path(home, folder).mkdir(parents=True)
            for file in ("bots/b1/own.txt", "bots/b2/secret.txt", "shared/brief.txt", "root.txt"):
                Path(home, file).write_text("fixture")
            Path(home, "bots/b1/link").symlink_to(Path(home, "bots/b2/secret.txt"))
            Path(home, "bots/b1/parent").symlink_to(Path(home, "bots/b2"), target_is_directory=True)
            roots = ["bots/b1", "shared"]
            self.assertEqual(helper.resolve_upload_paths(
                ["bots/b1/own.txt", "shared/brief.txt"], home, roots),
                [str(Path(home, "bots/b1/own.txt").resolve()), str(Path(home, "shared/brief.txt").resolve())])
            for path in ("bots/b1/link", "bots/b1/parent/secret.txt", "root.txt"):
                with self.subTest(path=path), self.assertRaises(RuntimeError) as error:
                    helper.resolve_upload_paths([path], home, roots)
                self.assertEqual(str(error.exception),
                                 f"Upload files must be inside your folder or shared/: {path}")
                self.assertNotIn(home, str(error.exception))
            for root in ("missing", "escaped"):
                if root == "escaped":
                    Path(home, root).symlink_to(outside, target_is_directory=True)
                with self.subTest(root=root), self.assertRaisesRegex(RuntimeError, "your folder or shared/"):
                    helper.resolve_upload_paths(["root.txt"], home, [root])

    def test_team_upload_missing_root_does_not_block_the_other(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            Path(home, "bots/b1").mkdir(parents=True)
            Path(home, "bots/b1/own.txt").write_text("fixture")
            self.assertEqual(
                helper.resolve_upload_paths(["bots/b1/own.txt"], home, ["bots/b1", "shared"]),
                [str(Path(home, "bots/b1/own.txt").resolve())],
            )

    def test_team_upload_rejects_roots_redirected_to_another_bot(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            Path(home, "bots/b2").mkdir(parents=True)
            Path(home, "bots/b2/secret.txt").write_text("fixture")
            Path(home, "bots/b1").symlink_to(Path(home, "bots/b2"), target_is_directory=True)
            Path(home, "shared").symlink_to(Path(home, "bots/b2"), target_is_directory=True)
            for path in ("bots/b1/secret.txt", "shared/secret.txt"):
                with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, "your folder or shared/"):
                    helper.resolve_upload_paths([path], home, ["bots/b1", "shared"])

    def test_upload_rejects_fifo_without_opening_it(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            os.mkfifo(Path(home, "pipe"))
            with patch("builtins.open", side_effect=AssertionError("must not open FIFO")):
                with self.assertRaisesRegex(RuntimeError, "Not a regular file: pipe"):
                    helper.resolve_upload_paths(["pipe"], home)

    def test_upload_absolute_paths_and_literal_tilde(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as outside:
            file = Path(home, "x")
            file.write_text("fixture")
            self.assertEqual(helper.resolve_upload_paths([str(file)], home), [str(file.resolve())])
            with self.assertRaisesRegex(RuntimeError, "File not found: ~/x"):
                helper.resolve_upload_paths(["~/x"], home)
            for exists in (False, True):
                target = Path(outside, "x")
                if exists:
                    target.write_text("fixture")
                with self.assertRaisesRegex(RuntimeError, "must be inside"):
                    helper.resolve_upload_paths([str(target)], home)

    def test_upload_total_size_limit(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            for name in ("a", "b"):
                Path(home, name).write_bytes(b"123")
            with patch.dict(os.environ, {"RAKAZO_BROWSER_UPLOAD_MAX_BYTES": "5"}):
                self.assertEqual(helper.resolve_upload_paths(["a"], home), [str(Path(home, "a").resolve())])
                with self.assertRaisesRegex(RuntimeError, "upload files are larger than .* MB in total"):
                    helper.resolve_upload_paths(["a", "b"], home)
            for override in ("invalid", "0", "-1"):
                with patch.dict(os.environ, {"RAKAZO_BROWSER_UPLOAD_MAX_BYTES": override}):
                    self.assertEqual(len(helper.resolve_upload_paths(["a", "b"], home)), 2)
            with patch.dict(os.environ, {}, clear=True):
                with patch.object(helper.os, "stat", return_value=Mock(
                        st_mode=0o100644, st_size=helper.MAX_UPLOAD_BYTES + 1)):
                    with self.assertRaisesRegex(RuntimeError, "larger than 100 MB in total"):
                        helper.resolve_upload_paths(["a"], home)

    def test_upload_act_passes_trusted_roots_before_touching_the_page(self):
        with patch.object(helper, "resolve_upload_paths", side_effect=RuntimeError("confined")) as resolve:
            with patch.object(helper, "ensure_helpers") as ensure:
                with self.assertRaisesRegex(RuntimeError, "confined"):
                    helper.act(Mock(), "session", [{"kind": "upload", "ref": "e1",
                               "paths": ["bots/b1/file"], "roots": ["bots/b1", "shared"]}])
            resolve.assert_called_once_with(["bots/b1/file"], roots=["bots/b1", "shared"])
            ensure.assert_not_called()

    def test_upload_sets_files_on_the_input_without_a_file_chooser(self):
        client = Mock()
        client.context_id = 7
        client.call.side_effect = [{"result": {"objectId": "node-1"}}, {}, {}]
        helper.upload(client, "session", "e1", ["/home/rakazo/receipt.pdf"])
        methods = [call.args[0] for call in client.call.call_args_list]
        self.assertEqual(methods, ["Runtime.evaluate", "DOM.setFileInputFiles", "Runtime.releaseObject"])
        self.assertEqual(
            client.call.call_args_list[1].args[1],
            {"files": ["/home/rakazo/receipt.pdf"], "objectId": "node-1"},
        )

    def test_upload_rejects_a_bad_path_before_touching_the_page(self):
        with patch.object(helper, "ensure_helpers") as ensure:
            with self.assertRaisesRegex(RuntimeError, "File not found"):
                helper.act(Mock(), "session", [{"kind": "upload", "ref": "e1", "paths": ["nope.pdf"]}])
        ensure.assert_not_called()


if __name__ == "__main__":
    unittest.main()
