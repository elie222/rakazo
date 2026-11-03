"""Offline protocol/error regressions for the live browser helper."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import socket
import struct
import os
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

loader = importlib.machinery.SourceFileLoader("page_browser", str(Path(__file__).with_name("rakazo-page-browser")))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


MERCHANT = "https://shop.example.test"
CARD_NUMBER = "4242424242424242"


class CardBrowser:
    """A stand-in Chromium: a merchant page with one card frame in its own CDP session."""

    def __init__(self, frame_url="https://js.stripe.com/v3/elements-inner-card.html", main_found=0, frame_found=1,
                 kept=None, owned=True, shown=True, top_origin=MERCHANT, on_focus=None, after_key=None,
                 clears=True):
        self.frame_url, self.main_found, self.frame_found = frame_url, main_found, frame_found
        self.kept, self.owned, self.shown, self.top_origin = kept, owned, shown, top_origin
        self.on_focus, self.after_key, self.clears = on_focus, after_key, clears
        self.typed, self.cleared, self.focused = "", False, False
        self.sent, self.evaluated = [], []
        self.client = helper.CdpClient("ws://127.0.0.1:9222/test")
        self.client.context_id = 1
        self.client.call = self.call

    def call(self, method, params=None, *, session_id=None, timeout_s=30.0):
        params = params or {}
        self.sent.append((method, params, session_id))
        if method == "Target.setAutoAttach":
            self.client._handle_event({"method": "Target.attachedToTarget", "sessionId": session_id, "params": {
                "sessionId": "frame-session", "targetInfo": {"type": "iframe", "url": self.frame_url}}})
        elif method == "Page.getFrameTree":
            frame = {"id": "card-frame", "url": self.frame_url} if session_id == "frame-session" else {"id": "main"}
            return {"frameTree": {"frame": frame}}
        elif method == "DOM.getFrameOwner":
            if not self.owned:
                raise RuntimeError("DOM.getFrameOwner failed: Frame with given id does not belong to target.")
            return {"backendNodeId": 7}
        elif method == "DOM.resolveNode":
            return {"object": {"objectId": "owner"}}
        elif method == "Runtime.callFunctionOn":
            return {"result": {"value": self.shown}}
        elif method == "Page.createIsolatedWorld":
            return {"executionContextId": 2}
        elif method == "Runtime.evaluate":
            return {"result": {"value": self.evaluate(params["expression"], params["contextId"] == 2)}}
        elif method == "Input.insertText":
            self.typed += params["text"]
            if self.after_key:
                self.after_key(self)
        return {}

    def evaluate(self, expression, in_frame):
        self.evaluated.append(expression)
        if expression == "location.origin":
            return urlsplit_origin(self.frame_url) if in_frame else self.top_origin
        if "snapshot()" in expression:
            return {"url": MERCHANT, "title": "", "elements": [], "tree": "Checkout", "frames": True}
        if "findCard(" in expression:
            return self.frame_found if in_frame else self.main_found
        if "hasCardField()" in expression:
            return in_frame and self.frame_found > 0
        if "focusCard()" in expression:
            self.focused = True
            if self.on_focus:
                self.on_focus(self)
            return True
        if "cardHolds()" in expression:
            return self.focused
        if "cardTyped(" in expression:
            kept = len(self.typed) if self.kept is None else self.kept
            return kept == int(expression.split("(")[-1].rstrip(")"))
        if "emptyCard()" in expression:
            self.cleared = True
            if self.clears:
                self.typed, self.kept = "", None
            return None
        return True


PAY_TOKEN = "lpt_fake_secret_token"


class PayTokenBrowser(CardBrowser):
    """A merchant page whose pay token block is in the page or in a frame it shows."""

    def __init__(self, main_account=None, frame_account="acct_fake123", accepted=True, **kwargs):
        super().__init__(**kwargs)
        self.main_account, self.frame_account, self.accepted = main_account, frame_account, accepted
        self.handed = []

    def call(self, method, params=None, *, session_id=None, timeout_s=30.0):
        if method == "Runtime.callFunctionOn" and "arguments" in params:
            self.sent.append((method, params, session_id))
            self.handed.append((params["arguments"][0]["value"], session_id, params["executionContextId"]))
            if self.on_focus:
                self.on_focus(self)
            return {"result": {"value": self.accepted}}
        return super().call(method, params, session_id=session_id, timeout_s=timeout_s)

    def evaluate(self, expression, in_frame):
        if "payTokenAccount()" in expression:
            return self.frame_account if in_frame else self.main_account
        return super().evaluate(expression, in_frame)


def urlsplit_origin(url):
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


class PageBrowserTest(unittest.TestCase):
    def setUp(self):
        # The stand-in clients have no socket to listen on: waiting for events is just waiting.
        self.real_listen = getattr(helper.CdpClient, "listen", None)
        patcher = patch.object(helper.CdpClient, "listen", lambda client, seconds: helper.time.sleep(seconds), create=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_listening_stamps_events_when_they_arrive(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client._sock = Mock()
        event = json.dumps({"method": "Network.requestWillBeSent", "sessionId": "s",
                            "params": {"requestId": "r1", "type": "Fetch"}}).encode()
        frames = iter([b"\x81" + bytes([len(event)]) + event])

        def recv(_):
            try:
                return next(frames)
            except StopIteration:
                raise socket.timeout from None

        client._sock.recv.side_effect = recv
        with patch.object(helper.time, "monotonic", side_effect=[0.0, 0.0, 5.0, 5.0, 100.0]):
            self.real_listen(client, 0.03)
        self.assertEqual(client._requests[("s", "r1")], [5.0, None])

    def test_closed_stdin_cancels_helper_without_a_browser(self):
        with subprocess.Popen([sys.executable, str(Path(__file__).with_name("rakazo-page-browser")), "snapshot", "{}"],
                              env={**os.environ, "RAKAZO_BROWSER_WATCH_STDIN": "1", "RAKAZO_CDP_PORT": "0"},
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            process.stdin.close()
            self.assertEqual(process.wait(timeout=3), 130)

    def test_act_without_a_browser_is_not_uncertain(self):
        out = []
        with patch.object(helper, "wait_for_cdp", side_effect=RuntimeError("CDP not ready on port 9222: refused")), \
                patch("builtins.print", side_effect=out.append):
            code = helper.run(["rakazo-page-browser", "act", json.dumps({"actions": [{"kind": "click", "ref": "e1"}]})])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out[0]), {"ok": False, "error": "CDP not ready on port 9222: refused",
                                              "fallback": "computer_act", "uncertain": False})

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

    HUGE = 3_000_000

    def frame_client(self, payload, then=b"", drop=True):
        """A client reading one frame of HUGE bytes that begins with `payload`, then the bytes `then`."""
        stream = bytearray(payload + b"x" * (self.HUGE - len(payload)) + then)

        def recv(size):
            chunk = bytes(stream[:size])
            del stream[:size]
            if not chunk:
                raise socket.timeout
            return chunk

        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client._sock = Mock()
        client._sock.recv.side_effect = recv
        client._buf.extend(b"\x81\x7f" + struct.pack("!Q", self.HUGE))
        client.drop_oversized = drop
        return client

    SMALL = b"\x81\x05hello"
    EVENT = b'{"method":"Network.webSocketFrameReceived","params":'

    def test_a_page_s_huge_network_event_is_dropped_once_requests_are_watched(self):
        client = self.frame_client(self.EVENT, self.SMALL)
        self.assertEqual(client._read_frame(), b"hello")
        self.assertEqual(len(client._buf), 0)

    def test_dropping_a_huge_event_survives_a_read_that_times_out_in_the_middle_of_it(self):
        client = self.frame_client(self.EVENT, self.SMALL)
        real_recv, calls = client._sock.recv.side_effect, [0]

        def recv(size):
            calls[0] += 1
            if calls[0] % 7 == 0:
                raise socket.timeout
            return real_recv(size)

        client._sock.recv.side_effect = recv
        frame = None
        for _ in range(1000):
            try:
                frame = client._read_frame()
                break
            except socket.timeout:
                continue
        self.assertEqual(frame, b"hello")

    def test_a_huge_answer_to_a_call_is_never_dropped(self):
        for payload in (b'{"id":7,"result":{"x":"', b'{"method":"Page.frameNavigated","params":'):
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(RuntimeError, "too large"):
                    self.frame_client(payload, self.SMALL)._read_frame()

    def test_a_huge_frame_is_not_dropped_before_requests_are_watched(self):
        with self.assertRaisesRegex(RuntimeError, "too large"):
            self.frame_client(self.EVENT, self.SMALL, drop=False)._read_frame()

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

    def test_contenteditable_fill_inserts_the_whole_text_once(self):
        for text in ["hello", "", "שלום 😀\nparagraph " * 1000]:
            with self.subTest(length=len(text)):
                client = Mock()
                with patch.object(helper, "ensure_helpers"), \
                        patch.object(helper, "snapshot", return_value={"ok": True}), \
                        patch.object(helper, "wait_for_action", return_value=True), \
                        patch.object(helper, "eval_json", side_effect=[True, {"insertText": True}]):
                    result = helper.act(client, "session", [{"kind": "fill", "ref": "e1", "text": text}])
                self.assertEqual(result["completed"], 1)
                client.call.assert_any_call("Input.insertText", {"text": text}, session_id="session")
                self.assertEqual(sum(call.args[0] == "Input.insertText" for call in client.call.call_args_list), 1)

    def test_plain_fill_does_not_insert_into_the_focused_element(self):
        client = Mock()
        with patch.object(helper, "ensure_helpers"), \
                patch.object(helper, "snapshot", return_value={"ok": True}), \
                patch.object(helper, "wait_for_action", return_value=True), \
                patch.object(helper, "eval_json", side_effect=[True, {}]):
            result = helper.act(client, "session", [{"kind": "fill", "ref": "e1", "text": "hello"}])
        self.assertEqual(result["completed"], 1)
        self.assertFalse(any(call.args[0] == "Input.insertText" for call in client.call.call_args_list))

    def test_contenteditable_fill_is_uncertain_if_insertion_response_is_lost(self):
        client = Mock()
        def call(method, *args, **kwargs):
            if method == "Input.insertText":
                raise TimeoutError("lost response")
            return {}
        client.call.side_effect = call
        with patch.object(helper, "ensure_helpers"), \
                patch.object(helper, "snapshot", return_value={}), \
                patch.object(helper, "eval_json", side_effect=[True, {"insertText": True}]):
            result = helper.act(client, "session", [{"kind": "fill", "ref": "e1", "text": "hello"}])
        self.assertFalse(result["ok"])
        self.assertEqual(result["completed"], 0)
        self.assertTrue(result["uncertain"])

    def test_binds_saved_login_fill_to_its_origin_in_the_same_evaluation(self):
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "snapshot", return_value={"ok": True}), \
                patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [True, {}]
            helper.act(Mock(), "session", [
                {"kind": "fill", "ref": "e1", "text": "fake-password", "origin": "https://login.example.test",
                 "field": "password"},
            ])
        self.assertEqual(
            evaluate.call_args_list[1].args[2],
            'window.__rakazoPageBrowser.fill("e1", "fake-password", "https://login.example.test", "password")',
        )

    def test_reports_a_refused_fill_as_settled_with_its_reason(self):
        client = Mock()
        client.call.side_effect = [
            {},
            {"result": {"value": True}},
            {"exceptionDetails": {"text": "Uncaught", "exception": {
                "description": "Error: Refused: The page is not on the site this login was saved for."
                               "\n    at Object.fill (<anonymous>:1:1)",
            }}},
        ]
        with patch.object(helper, "ensure_helpers"):
            result = helper.act(client, "session", [
                {"kind": "fill", "ref": "e1", "text": "fake-password", "origin": "https://login.example.test",
                 "field": "password"},
            ])
        self.assertEqual(result, {"ok": False, "completed": 0, "uncertain": False,
                                  "error": "The page is not on the site this login was saved for."})

    def test_rejects_origin_outside_fill_before_any_action(self):
        with patch.object(helper, "ensure_helpers") as ensure:
            with self.assertRaisesRegex(RuntimeError, "origin"):
                helper.act(Mock(), "session", [
                    {"kind": "type", "ref": "e1", "text": "x", "origin": "https://login.example.test"},
                ])
            ensure.assert_not_called()

    def test_binds_card_fill_to_the_merchant_origin_in_the_same_evaluation(self):
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "snapshot", return_value={"ok": True}), \
                patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [True, {}]
            helper.act(Mock(), "session", [
                {"kind": "fill", "ref": "e1", "text": "4242424242424242", "origin": "https://shop.example.test",
                 "field": "card"},
            ])
        self.assertEqual(
            evaluate.call_args_list[1].args[2],
            'window.__rakazoPageBrowser.fill("e1", "4242424242424242", "https://shop.example.test", "card")',
        )

    def test_rejects_card_fill_without_its_origin_before_any_action(self):
        with patch.object(helper, "ensure_helpers") as ensure:
            with self.assertRaisesRegex(RuntimeError, "card fill needs its origin"):
                helper.act(Mock(), "session", [
                    {"kind": "fill", "ref": "e1", "text": "4242424242424242", "field": "card"},
                ])
            ensure.assert_not_called()

    def test_card_fill_without_a_ref_needs_its_card_field_and_others_need_a_ref(self):
        for step, error in (
            ({"kind": "fill", "text": "4242424242424242", "origin": "https://shop.example.test", "field": "card"},
             "needs its card field"),
            ({"kind": "fill", "text": "x", "cardField": "number"}, "ref is required"),
            ({"kind": "type", "text": "4242", "origin": "https://shop.example.test", "field": "card",
              "cardField": "number"}, "ref is required"),
        ):
            with self.subTest(step=step), patch.object(helper, "ensure_helpers") as ensure:
                with self.assertRaisesRegex(RuntimeError, error):
                    helper.act(Mock(), "session", [step])
                ensure.assert_not_called()

    def card_fill(self, browser, field="number", text=CARD_NUMBER):
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "snapshot", return_value={"ok": True}):
            return helper.act(browser.client, "page", [
                {"kind": "fill", "text": text, "origin": MERCHANT, "field": "card", "cardField": field},
            ])

    def test_card_fill_finds_the_field_in_a_payment_frame_and_types_it_there(self):
        browser = CardBrowser()
        result = self.card_fill(browser)
        self.assertEqual(result, {"ok": True, "completed": 1})
        self.assertEqual(browser.typed, CARD_NUMBER)
        self.assertEqual({session for method, _, session in browser.sent if method.startswith("Input.")},
                         {"frame-session"})
        self.assertIn('findCard("cc-number")', "".join(browser.evaluated))
        self.assertNotIn(CARD_NUMBER, "".join(browser.evaluated))

    def test_card_fill_types_into_the_page_itself_when_the_field_is_there(self):
        browser = CardBrowser(main_found=1)
        result = self.card_fill(browser, "expiry", "1234")
        self.assertEqual(result, {"ok": True, "completed": 1})
        self.assertEqual({session for method, _, session in browser.sent if method.startswith("Input.")}, {"page"})
        self.assertNotIn("Target.setAutoAttach", [method for method, _, _ in browser.sent])

    def test_card_fill_types_nothing_into_frames_the_page_does_not_own_or_providers_not_listed(self):
        for browser in (CardBrowser(frame_url="https://pay.example.test/card"),
                        CardBrowser(frame_url="http://js.stripe.com/card"),
                        CardBrowser(frame_url="https://js.stripe.com.example.test/card"),
                        CardBrowser(owned=False), CardBrowser(shown=False)):
            with self.subTest(frame=browser.frame_url, owned=browser.owned, shown=browser.shown):
                result = self.card_fill(browser)
                self.assertEqual(result, {"ok": False, "completed": 0, "uncertain": False,
                                          "error": helper.CARD_FIELD_MISSING})
                self.assertEqual(browser.typed, "")

    def test_card_fill_refuses_more_than_one_matching_field(self):
        for browser in (CardBrowser(main_found=2), CardBrowser(frame_found=2)):
            result = self.card_fill(browser)
            self.assertEqual(result["error"], helper.CARD_FIELD_AMBIGUOUS)
            self.assertEqual(browser.typed, "")

    def test_card_fill_refuses_a_page_that_left_the_merchant_before_typing(self):
        def leave(browser):
            browser.top_origin = "https://evil.example.test"

        def navigate(browser):
            browser.client._handle_event({"method": "Page.frameNavigated", "sessionId": "page",
                                          "params": {"frame": {"id": "main"}}})

        for before_typing in (leave, navigate):
            with self.subTest(before_typing=before_typing.__name__):
                browser = CardBrowser(on_focus=before_typing)
                result = self.card_fill(browser)
                self.assertEqual(result, {"ok": False, "completed": 0, "uncertain": False,
                                          "error": helper.NOT_ON_MERCHANT})
                self.assertEqual(browser.typed, "")
        browser = CardBrowser(top_origin="https://evil.example.test")
        self.assertEqual(self.card_fill(browser)["error"], helper.NOT_ON_MERCHANT)
        self.assertNotIn("Target.setAutoAttach", [method for method, _, _ in browser.sent])

    def test_card_fill_stops_when_the_payment_frame_changes_mid_card(self):
        def frame_moves(browser):
            if len(browser.typed) == 4:
                browser.client._handle_event({"method": "Page.frameNavigated", "sessionId": "frame-session",
                                              "params": {"frame": {"id": "card-frame"}}})

        browser = CardBrowser(after_key=frame_moves)
        result = self.card_fill(browser)
        self.assertFalse(result["ok"])
        self.assertIn("payment frame changed", result["error"])
        self.assertEqual([method for method, _, _ in browser.sent].count("Input.insertText"), 4)
        self.assertTrue(browser.cleared)

    def test_card_fill_clears_a_field_that_did_not_keep_every_digit(self):
        browser = CardBrowser(kept=12)
        result = self.card_fill(browser)
        self.assertEqual(result, {"ok": False, "completed": 0, "uncertain": False,
                                  "error": "This field didn't accept the card, so it was cleared."})
        self.assertIn(("Input.dispatchKeyEvent", "Backspace", "frame-session"),
                      [(method, params.get("key"), session) for method, params, session in browser.sent])
        self.assertTrue(browser.cleared)
        self.assertNotIn(CARD_NUMBER, str(result))

    def test_card_fill_reports_a_field_it_could_not_confirm_empty_as_uncertain(self):
        browser = CardBrowser(kept=12, clears=False)
        result = self.card_fill(browser)
        self.assertEqual(result["uncertain"], True)
        self.assertFalse(result["ok"])
        self.assertIn("could not be confirmed empty", result["error"])
        self.assertNotIn(CARD_NUMBER, str(result))

    def test_card_fill_clears_a_field_whose_page_left_after_the_last_key(self):
        def leave_at_end(browser):
            if len(browser.typed) == len(CARD_NUMBER):
                browser.top_origin = "https://evil.example.test"

        browser = CardBrowser(after_key=leave_at_end)
        result = self.card_fill(browser)
        self.assertEqual(result["error"], helper.NOT_ON_MERCHANT)
        self.assertTrue(browser.cleared)

    def test_card_fill_types_only_the_digits_of_an_expiry(self):
        browser = CardBrowser()
        self.assertEqual(self.card_fill(browser, "expiry", "03/34"), {"ok": True, "completed": 1})
        self.assertEqual(browser.typed, "0334")

    def test_card_fill_counts_formatted_digits_as_kept(self):
        browser = CardBrowser()
        self.card_fill(browser)
        self.assertIn("cardTyped(16)", "".join(browser.evaluated))

    def test_snapshot_points_to_fill_card_only_for_payment_frames_with_card_fields(self):
        for browser, line in ((CardBrowser(), helper.PAYMENT_FRAME_HINT),
                              (CardBrowser(frame_found=0), "Embedded frames require desktop tools."),
                              (CardBrowser(frame_url="https://ads.example.test/"),
                               "Embedded frames require desktop tools.")):
            with self.subTest(frame=browser.frame_url), patch.object(helper, "wait_for_settle", return_value=True), \
                    patch.object(helper, "ensure_helpers"):
                result = helper.snapshot(browser.client, "page")
            self.assertEqual(result["tree"], f"Checkout\n{line}")
            self.assertNotIn("frames", result)

    def test_snapshot_names_the_merchant_account_of_a_pay_token_checkout(self):
        for browser, account in ((PayTokenBrowser(), "acct_fake123"),
                                 (PayTokenBrowser(main_account="acct_main1", frame_account=None), "acct_main1"),
                                 (PayTokenBrowser(frame_url="https://checkout.pci.shopifyinc.com/card"), None),
                                 (PayTokenBrowser(frame_account=None), None)):
            with self.subTest(frame=browser.frame_url), patch.object(helper, "wait_for_settle", return_value=True), \
                    patch.object(helper, "ensure_helpers"):
                tree = helper.snapshot(browser.client, "page")["tree"]
            if account:
                self.assertTrue(tree.endswith(helper.pay_token_hint(account)), tree)
            else:
                self.assertNotIn("pay token", tree)

    def pay_token_fill(self, browser, account="acct_fake123", origin=MERCHANT):
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "snapshot", return_value={"ok": True}):
            return helper.act(browser.client, "page", [
                {"kind": "pay_token", "text": PAY_TOKEN, "origin": origin, "merchantAccountId": account},
            ])

    def test_pay_token_goes_to_the_stripe_frame_block_as_an_argument_only(self):
        browser = PayTokenBrowser()
        self.assertEqual(self.pay_token_fill(browser), {"ok": True, "completed": 1})
        self.assertEqual(browser.handed, [(PAY_TOKEN, "frame-session", 2)])
        self.assertNotIn(PAY_TOKEN, "".join(browser.evaluated))
        self.assertNotIn(PAY_TOKEN, json.dumps([params for method, params, _ in browser.sent
                                                if method != "Runtime.callFunctionOn"]))

    def test_pay_token_goes_to_the_page_itself_when_its_block_is_there(self):
        browser = PayTokenBrowser(main_account="acct_fake123", frame_account=None)
        self.assertEqual(self.pay_token_fill(browser), {"ok": True, "completed": 1})
        self.assertEqual(browser.handed, [(PAY_TOKEN, "page", 1)])
        self.assertNotIn("Target.setAutoAttach", [method for method, _, _ in browser.sent])

    def test_pay_token_refuses_other_merchants_frames_and_sites(self):
        for browser, kwargs, error in (
            (PayTokenBrowser(frame_account="acct_other"), {}, helper.PAY_TOKEN_MISSING),
            (PayTokenBrowser(frame_url="https://checkout.pci.shopifyinc.com/card"), {}, helper.PAY_TOKEN_MISSING),
            (PayTokenBrowser(owned=False), {}, helper.PAY_TOKEN_MISSING),
            (PayTokenBrowser(top_origin="https://evil.example.test"), {}, helper.NOT_ON_MERCHANT),
            (PayTokenBrowser(), {"origin": "http://shop.example.test"}, "only be filled on HTTPS"),
        ):
            with self.subTest(frame=browser.frame_url, kwargs=kwargs):
                result = self.pay_token_fill(browser, **kwargs)
                self.assertEqual(result["ok"], False)
                self.assertEqual(result["uncertain"], False)
                self.assertIn(error, result["error"])
                self.assertEqual(browser.handed, [])

    def test_pay_token_reports_a_checkout_that_did_not_take_it_without_the_token(self):
        result = self.pay_token_fill(PayTokenBrowser(accepted=False))
        self.assertEqual(result["ok"], False)
        self.assertIn("didn't take the pay token", result["error"])
        self.assertNotIn(PAY_TOKEN, json.dumps(result))

    def test_pay_token_steps_need_their_token_origin_and_account_and_no_ref(self):
        for step in ({"kind": "pay_token", "text": PAY_TOKEN, "origin": MERCHANT},
                     {"kind": "pay_token", "text": "", "origin": MERCHANT, "merchantAccountId": "acct_1"},
                     {"kind": "pay_token", "ref": "e1", "text": PAY_TOKEN, "origin": MERCHANT,
                      "merchantAccountId": "acct_1"}):
            with self.subTest(step=step), patch.object(helper, "ensure_helpers") as ensure:
                with self.assertRaisesRegex(RuntimeError, "pay token needs"):
                    helper.act(Mock(), "session", [step])
                ensure.assert_not_called()

    def test_key_events_preserve_ascii_key_mappings_and_control_insertion(self):
        self.assertEqual(helper.key_event("6"),
                         {"key": "6", "code": "Digit6", "text": "6", "windowsVirtualKeyCode": 54})
        self.assertEqual(helper.key_event("q")["code"], "KeyQ")
        self.assertEqual(helper.key_event("Q")["windowsVirtualKeyCode"], 81)
        self.assertEqual(helper.key_event(" ")["code"], "Space")
        self.assertEqual(helper.key_event("\n"), {"key": "Enter", "code": "Enter", "text": "\r",
                                                  "windowsVirtualKeyCode": 13, "modifiers": 8})
        self.assertEqual(helper.key_event("@"), {"key": "@", "text": "@"})
        for char in ("\t", "\x00", "\x7f", "", "ab"):
            with self.subTest(char=char):
                self.assertIsNone(helper.key_event(char))

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
            if method in ("Network.enable", "Page.setInterceptFileChooserDialog"):
                return {}
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
        return result, sent, [call.args[2] for call in evaluated.call_args_list if "quietFor" not in call.args[2]]

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
            ("Input.dispatchKeyEvent", {"type": "keyDown", "key": "é", "text": "é", "unmodifiedText": "é"}),
            ("Input.dispatchKeyEvent", {"type": "keyUp", "key": "é"}),
        ])

    def test_type_dispatches_unicode_as_keys_without_ascii_physical_mappings(self):
        # Include non-ASCII letters/digits, combining marks and a ZWJ emoji, one code point at a time.
        text = "caféüñ€日本１２e\u0301👩\u200d💻"
        result, sent, _ = self.type_once({"focused": True, "multiline": False}, text)
        self.assertEqual(result, {"ok": True, "completed": 1})
        self.assertTrue(all(method == "Input.dispatchKeyEvent" for method, _ in sent))
        self.assertEqual([params["key"] for _, params in sent if params["type"] == "keyDown"], list(text))
        self.assertEqual([params["key"] for _, params in sent if params["type"] == "keyUp"], list(text))
        for char, ((_, down), (_, up)) in zip(text, zip(sent[::2], sent[1::2])):
            self.assertEqual(down["text"], char)
            self.assertEqual(down["unmodifiedText"], char)
            self.assertNotIn("text", up)
            if ord(char) > 127:
                self.assertEqual(down, {"type": "keyDown", "key": char, "text": char, "unmodifiedText": char})
                self.assertEqual(up, {"type": "keyUp", "key": char})

    def test_type_still_inserts_a_literal_tab_without_changing_focus(self):
        result, sent, _ = self.type_once({"focused": True, "multiline": False}, "a\tb")
        self.assertEqual(result, {"ok": True, "completed": 1})
        self.assertEqual(sent[2], ("Input.insertText", {"text": "\t"}))
        self.assertEqual([params["key"] for _, params in sent if params.get("type") == "keyDown"], ["a", "b"])

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

    def scripted_act(self, actions, page, on_call=None, frame_at_spot="main", node_at_spot="BUTTON"):
        """Runs act against a stand-in page: `page` answers each helper expression, CDP calls are recorded.

        The browser says the main frame owns every spot unless frame_at_spot is another frame, and that a
        node_at_spot element is there.
        """
        client = helper.CdpClient("ws://browser.example.test:9222/test")
        self.client = client
        sent = []

        def call(method, params=None, **_):
            sent.append((method, params))
            if on_call:
                on_call(client, method, params)
            if method == "DOM.getNodeForLocation":
                return {"frameId": frame_at_spot, "backendNodeId": 5}
            if method == "DOM.describeNode":
                return {"node": {"backendNodeId": 5, "nodeName": node_at_spot}}
            if method == "Page.getFrameTree":
                return {"frameTree": {"frame": {"id": "main"}}}
            return {}

        def evaluate(_, __, expression):
            answer = page(expression)
            if isinstance(answer, Exception):
                raise answer
            return answer

        client.call = call
        snap = {"ok": True, "url": "https://portal.example.test/", "title": "Portal", "tree": "Portal",
                "elements": []}
        with patch.object(helper, "ensure_helpers"), \
                patch.object(helper, "snapshot", return_value=snap) as snapshot_mock, \
                patch.object(helper, "eval_json", side_effect=evaluate):
            result = helper.act(client, "session", actions)
        self.snapshot_calls = snapshot_mock.call_args_list
        return result, sent

    def test_click_is_a_real_mouse_click_at_the_spot_the_page_reports(self):
        def page(expression):
            return {"x": 120, "y": 210} if "aim(" in expression else True
        result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], page)
        self.assertEqual(result["completed"], 1)
        mouse = [(params["type"], params["x"], params["y"]) for method, params in sent
                 if method == "Input.dispatchMouseEvent"]
        self.assertEqual(mouse, [("mouseMoved", 120, 210), ("mousePressed", 120, 210), ("mouseReleased", 120, 210)])
        pressed = [params for _, params in sent if params and params.get("type") == "mousePressed"][0]
        self.assertEqual((pressed["button"], pressed["clickCount"]), ("left", 1))

    def test_click_checks_the_spot_again_after_the_pointer_moved_and_stops_if_it_changed(self):
        def page(expression):
            if "aim(" in expression:
                return {"x": 120, "y": 210}
            if "stillAimed(" in expression:
                self.assertIn('stillAimed("e1", 120, 210)', expression)
                return helper.Settled('Element is covered by button "Confirm payment", so a click would land there.')
            return True
        result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], page)
        self.assertEqual((result["ok"], result["completed"], result["uncertain"]), (False, 0, False))
        self.assertIn("Confirm payment", result["error"])
        self.assertEqual([params["type"] for method, params in sent if method == "Input.dispatchMouseEvent"],
                         ["mouseMoved"])

    def test_click_presses_nothing_when_the_browser_says_the_spot_is_in_a_frame(self):
        # A frame the page script cannot see into, such as one in a closed shadow tree.
        def page(expression):
            return {"x": 120, "y": 210} if "aim(" in expression else True
        result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], page, frame_at_spot="other-origin-frame")
        self.assertEqual((result["ok"], result["completed"], result["uncertain"]), (False, 0, False))
        self.assertEqual(result["error"], "That spot is inside a frame, which the page tools cannot click in.")
        self.assertNotIn("fallback", result)
        self.assertEqual([params["type"] for method, params in sent if method == "Input.dispatchMouseEvent"],
                         ["mouseMoved"])
        locate = [params for method, params in sent if method == "DOM.getNodeForLocation"]
        self.assertEqual(locate, [{"x": 120, "y": 210, "includeUserAgentShadowDOM": True}])

    def test_click_presses_nothing_on_a_cross_origin_frame_the_main_frame_owns(self):
        # A cross-origin frame has its own process: the main frame's hit-test stops at the iframe element.
        result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], self.click_page, node_at_spot="IFRAME")
        self.assertEqual((result["ok"], result["completed"], result["uncertain"]), (False, 0, False))
        self.assertEqual(result["error"], helper.FRAME_CLICK)
        self.assertEqual(self.mouse_types(sent), ["mouseMoved"])

    def mouse_types(self, sent):
        return [params["type"] for method, params in sent if method == "Input.dispatchMouseEvent"]

    def test_the_browser_is_asked_about_the_spot_on_the_page_not_in_the_window(self):
        # DOM.getNodeForLocation counts from the top of the page: a scrolled page needs the offset added.
        def page(expression):
            if "stillAimed(" in expression:
                return {"x": 0, "y": 2251}
            return self.click_page(expression)
        result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], page)
        self.assertTrue(result["ok"])
        (locate,) = [params for method, params in sent if method == "DOM.getNodeForLocation"]
        self.assertEqual((locate["x"], locate["y"]), (120, 210 + 2251))
        self.assertEqual(self.mouse_types(sent), ["mouseMoved", "mousePressed", "mouseReleased"])
        # While the mouse events themselves keep using the window's spot.
        moved = [params for method, params in sent if method == "Input.dispatchMouseEvent"]
        self.assertTrue(all((params["x"], params["y"]) == (120, 210) for params in moved))

    def test_a_click_presses_nothing_when_the_browsers_answer_cannot_be_had(self):
        # Fail closed: whatever goes wrong asking which frame owns the spot, nothing is pressed.
        for method, error in (("DOM.getNodeForLocation", RuntimeError("DOM.getNodeForLocation failed: boom")),
                              ("Page.getFrameTree", RuntimeError("Page.getFrameTree failed: boom")),
                              ("Page.getFrameTree", KeyError("frameTree"))):
            with self.subTest(method=method, error=error):
                def fail(client, called, params, method=method, error=error):
                    if called == method:
                        raise error
                result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], self.click_page, on_call=fail)
                self.assertEqual((result["ok"], result["completed"], result["uncertain"]), (False, 0, False))
                self.assertEqual(result["error"], helper.CHANGED_UNDER_POINTER)
                self.assertNotIn("fallback", result)
                self.assertEqual(self.mouse_types(sent), ["mouseMoved"])

    def test_a_spot_the_browser_does_not_know_yet_after_a_far_scroll_gets_one_more_frame(self):
        seen = {"asked": 0}

        def unknown_once(client, called, params):
            if called == "DOM.getNodeForLocation":
                seen["asked"] += 1
                if seen["asked"] == 1:
                    raise RuntimeError("DOM.getNodeForLocation failed: {'code': -32000, 'message': "
                                       "'No node found at given location'}")
        evaluated = []

        def page(expression):
            evaluated.append(expression)
            return self.click_page(expression)
        result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], page, on_call=unknown_once)
        self.assertTrue(result["ok"])
        self.assertEqual(seen["asked"], 2)
        self.assertEqual(self.mouse_types(sent), ["mouseMoved", "mousePressed", "mouseReleased"])
        # The page drew before the pointer moved, and once more before the second try.
        self.assertEqual(sum("nextFrames()" in expression for expression in evaluated), 2)

    def test_a_spot_that_stays_unknown_ends_in_a_settled_error_and_no_press(self):
        def never_known(client, called, params):
            if called == "DOM.getNodeForLocation":
                raise RuntimeError("DOM.getNodeForLocation failed: 'No node found at given location'")
        result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], self.click_page, on_call=never_known)
        self.assertEqual((result["ok"], result["uncertain"], result["error"]), (False, False, helper.STILL_MOVING))
        self.assertNotIn("fallback", result)
        self.assertEqual(self.mouse_types(sent), ["mouseMoved"])
        # A click again, with the page standing still, works.
        again, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], self.click_page)
        self.assertTrue(again["ok"])

    def test_a_click_runs_its_checks_in_order_before_the_press(self):
        trace = []

        def page(expression):
            for name in ("aim(", "nextFrames(", "stillAimed("):
                if name in expression:
                    trace.append(name[:-1])
            return self.click_page(expression)

        def called(client, method, params):
            if method == "Input.dispatchMouseEvent":
                trace.append(params["type"])
            elif method == "DOM.getNodeForLocation":
                trace.append("getNodeForLocation")
        self.scripted_act([{"kind": "click", "ref": "e1"}], page, on_call=called)
        self.assertEqual(trace, ["aim", "nextFrames", "mouseMoved", "stillAimed", "getNodeForLocation",
                                 "mousePressed", "mouseReleased"])

    def test_click_asks_the_browser_who_owns_the_spot_right_before_the_press(self):
        def page(expression):
            return {"x": 120, "y": 210} if "aim(" in expression else True
        _, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], page)
        order = [params.get("type", method) for method, params in sent
                 if method in ("Input.dispatchMouseEvent", "DOM.getNodeForLocation")]
        self.assertEqual(order, ["mouseMoved", "DOM.getNodeForLocation", "mousePressed", "mouseReleased"])

    def test_requests_are_watched_with_oversize_events_dropped_only_once_network_is_on(self):
        def page(expression):
            return {"x": 120, "y": 210} if "aim(" in expression else True
        self.scripted_act([{"kind": "click", "ref": "e1"}], page)
        self.assertTrue(self.client.drop_oversized)

        def refuse_network(client, method, params):
            if method == "Network.enable":
                raise RuntimeError("Network.enable failed")
        self.scripted_act([{"kind": "click", "ref": "e1"}], page, on_call=refuse_network)
        self.assertFalse(self.client.drop_oversized)

    def click_page(self, expression):
        return {"x": 120, "y": 210} if "aim(" in expression else True

    def test_a_click_that_opens_a_file_chooser_is_held_back_and_pointed_to_upload(self):
        def open_chooser(client, method, params):
            if method == "Input.dispatchMouseEvent" and params["type"] == "mouseReleased":
                client._handle_event({"method": "Page.fileChooserOpened", "sessionId": "session",
                                      "params": {"frameId": "main", "mode": "selectSingle"}})
        result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], self.click_page, on_call=open_chooser)
        self.assertIn(("Page.setInterceptFileChooserDialog", {"enabled": True}), sent)
        self.assertEqual((result["ok"], result["completed"], result["uncertain"]), (False, 1, False))
        self.assertIn("use upload", result["error"])
        self.assertNotIn("fallback", result)
        self.assertEqual(result["tree"], "Portal")
        # Asked for before anything could be clicked.
        self.assertLess([m for m, _ in sent].index("Page.setInterceptFileChooserDialog"),
                        [m for m, _ in sent].index("Input.dispatchMouseEvent"))

    def test_a_click_without_a_file_chooser_is_unaffected(self):
        result, _ = self.scripted_act([{"kind": "click", "ref": "e1"}], self.click_page)
        self.assertTrue(result["ok"])

    def waited(self, on_call=None, busy=False):
        with patch.object(helper, "wait_for_action", return_value=not busy) as wait:
            result, _ = self.scripted_act([{"kind": "click", "ref": "e1"}], self.click_page, on_call=on_call)
        return result, wait.call_args.args[3]

    def test_the_whole_wait_after_an_action_has_one_budget(self):
        result, seconds = self.waited()
        self.assertEqual(seconds, helper.ACTION_WAIT_SECONDS)
        # The snapshot gets what is left of it, never a budget of its own on top.
        (call,) = self.snapshot_calls
        self.assertLessEqual(call.args[2], helper.ACTION_WAIT_SECONDS)
        self.assertGreater(call.args[2], helper.ACTION_WAIT_SECONDS - 0.5)
        self.assertNotIn("loading", result)

    def test_a_request_still_open_at_the_bound_skips_the_settle_and_flags_loading(self):
        result, _ = self.waited(busy=True)
        (call,) = self.snapshot_calls
        self.assertEqual(call.args[2], 0.0)
        self.assertTrue(result["loading"])

    def test_an_action_that_moves_to_another_document_waits_as_long_as_a_snapshot_does(self):
        def navigate(client, method, params):
            if method == "Input.dispatchMouseEvent" and params["type"] == "mouseReleased":
                client._handle_event({"method": "Page.frameRequestedNavigation", "sessionId": "session",
                                      "params": {"frameId": "main", "disposition": "currentTab",
                                                 "navigationType": "differentDocument"}})
        _, seconds = self.waited(on_call=navigate)
        self.assertEqual(seconds, helper.SETTLE_SECONDS)

    def test_a_snapshot_after_a_spent_budget_does_not_wait_for_the_page(self):
        client, calls, _ = self.settling_client(idle_after_calls=0)
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "eval_json") as evaluate:
            evaluate.return_value = {"title": "Example", "tree": "Loading"}
            result = helper.snapshot(client, "session", 0.0)
        self.assertEqual(result["loading"], True)
        self.assertEqual(calls, [])

    def test_click_on_a_native_select_sends_no_mouse_event(self):
        def page(expression):
            return {"x": None, "y": None} if "aim(" in expression else True
        result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], page)
        self.assertEqual(result["completed"], 1)
        self.assertNotIn("Input.dispatchMouseEvent", [method for method, _ in sent])

    def test_a_step_the_page_cannot_take_is_settled_with_the_page_and_no_desktop_fallback(self):
        for message in ("Stale element ref: the page has changed.", "Element is hidden. Open its menu first.",
                        "Element is disabled.", 'Element is covered by dialog "Cookies", so a click would land there.',
                        'This dropdown has no option "2019". Its options: "2023", "2024".'):
            with self.subTest(message=message):
                def page(expression, message=message):
                    return helper.Settled(message) if "aim(" in expression else True
                result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], page)
                self.assertEqual({key: result.get(key) for key in ("ok", "completed", "uncertain", "error")},
                                 {"ok": False, "completed": 0, "uncertain": False, "error": message})
                self.assertNotIn("fallback", result)
                self.assertEqual(result["tree"], "Portal")
                self.assertNotIn("Input.dispatchMouseEvent", [method for method, _ in sent])

    def test_a_settled_step_reports_the_steps_already_done(self):
        def page(expression):
            if "resolve(\"e2\")" in expression:
                return helper.Settled("Stale element ref: the page has changed.")
            return {} if "fill(" in expression else True
        result, _ = self.scripted_act([{"kind": "fill", "ref": "e1", "text": "x"},
                                       {"kind": "fill", "ref": "e2", "text": "y"}], page)
        self.assertEqual((result["ok"], result["completed"], result["uncertain"]), (False, 1, False))
        self.assertNotIn("fallback", result)

    def test_the_helper_raises_the_page_script_s_settled_errors_as_settled(self):
        client = Mock()
        client.call.return_value = {"exceptionDetails": {"text": "Uncaught", "exception": {
            "description": "Error: Settled: Element is hidden.\n    at Object.aim (<anonymous>:1:1)"}}}
        with self.assertRaises(helper.Settled) as raised:
            helper.eval_json(client, "session", "x", context_id=1)
        self.assertEqual(str(raised.exception), "Element is hidden.")

    def test_unsupported_input_types_still_fall_back_to_the_desktop(self):
        def page(expression):
            return RuntimeError("Input type requires desktop tools") if "fill(" in expression else True
        result, _ = self.scripted_act([{"kind": "fill", "ref": "e1", "text": "2024-01-01"}], page)
        self.assertEqual(result["fallback"], "computer_act")

    def request(self, client, request_id, started, finished=None, kind="Fetch"):
        with patch.object(helper.time, "monotonic", return_value=started):
            client._handle_event({"method": "Network.requestWillBeSent", "sessionId": "session",
                                  "params": {"requestId": request_id, "type": kind}})
        if finished is not None:
            with patch.object(helper.time, "monotonic", return_value=finished):
                client._handle_event({"method": "Network.loadingFinished", "sessionId": "session",
                                      "params": {"requestId": request_id}})

    def test_requests_the_action_started_are_told_from_background_ones(self):
        client = helper.CdpClient("ws://browser.example.test:9222/test")
        self.request(client, "click-fetch", 10.02)
        self.request(client, "follow-up", 11.03, 11.2)
        self.request(client, "chained", 11.22)
        self.request(client, "poll", 14.0)
        # A poll that starts 100 ms after the last answer is the page's own, however steadily it repeats.
        self.request(client, "steady-poll", 11.34, 11.5)
        self.request(client, "stream", 10.03, kind="EventSource")
        # While the fetch is open, requests that begin later may be the page's own.
        self.assertEqual(client.action_requests("session", 10.0, 0.12, 0.03)[0], 1)
        with patch.object(helper.time, "monotonic", return_value=11.0):
            client._handle_event({"method": "Network.loadingFinished", "sessionId": "session",
                                  "params": {"requestId": "click-fetch"}})
        # The follow-up began just after the fetch finished, the chained request just after that.
        pending, last = client.action_requests("session", 10.0, 0.12, 0.03)
        self.assertEqual(pending, 1)
        self.assertEqual(last, 11.2)
        self.assertEqual(client.action_requests("other", 10.0, 0.12, 0.03), (0, 10.0))

    def test_the_result_waits_for_the_action_s_own_request_and_the_page_drawing_it(self):
        now = [10.0]
        client = helper.CdpClient("ws://browser.example.test:9222/test")
        client.call = Mock(return_value={})
        self.request(client, "fetch", 10.02)

        def sleep(seconds):
            now[0] += seconds
            if now[0] >= 11.2 and client._requests[("session", "fetch")][1] is None:
                client._requests[("session", "fetch")][1] = now[0]

        def quiet_for(*_):
            # The page redrew the moment the answer came in.
            return max(0.0, (now[0] - 11.2) * 1000) if now[0] >= 11.2 else 0.0

        with patch.object(helper.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(helper.time, "sleep", side_effect=sleep), \
                patch.object(helper, "eval_json", side_effect=quiet_for):
            self.assertTrue(helper.wait_for_action(client, "session", 10.0, helper.ACTION_WAIT_SECONDS))
        self.assertGreaterEqual(now[0], 11.2 + helper.ACTION_QUIET_SECONDS)
        self.assertLess(now[0], 11.2 + helper.ACTION_QUIET_SECONDS + 0.2)

    def test_an_idle_page_costs_only_the_quiet_interval(self):
        now = [10.0]
        client = helper.CdpClient("ws://browser.example.test:9222/test")
        # A poll started long after the action is the page's own business.
        self.request(client, "poll", 12.5)
        with patch.object(helper.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(helper.time, "sleep", side_effect=lambda s: now.__setitem__(0, now[0] + s)), \
                patch.object(helper, "eval_json", return_value=60_000.0):
            self.assertTrue(helper.wait_for_action(client, "session", 10.0, helper.ACTION_WAIT_SECONDS))
        self.assertLess(now[0] - 10.0, helper.ACTION_QUIET_SECONDS + 0.05)

    def test_a_page_that_always_changes_does_not_hold_the_result_back(self):
        now = [10.0]
        client = helper.CdpClient("ws://browser.example.test:9222/test")
        with patch.object(helper.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(helper.time, "sleep", side_effect=lambda s: now.__setitem__(0, now[0] + s)), \
                patch.object(helper, "eval_json", return_value=0.0):
            self.assertTrue(helper.wait_for_action(client, "session", 10.0, helper.ACTION_WAIT_SECONDS))
        self.assertLess(now[0] - 10.0, helper.ACTION_CHANGE_SECONDS + helper.ACTION_QUIET_SECONDS + 0.1)

    def test_a_request_still_open_at_the_bound_marks_the_result_as_loading(self):
        now = [10.0]
        client = helper.CdpClient("ws://browser.example.test:9222/test")
        self.request(client, "slow", 10.01)
        with patch.object(helper.time, "monotonic", side_effect=lambda: now[0]), \
                patch.object(helper.time, "sleep", side_effect=lambda s: now.__setitem__(0, now[0] + s)), \
                patch.object(helper, "eval_json", return_value=0.0):
            self.assertFalse(helper.wait_for_action(client, "session", 10.0, helper.ACTION_WAIT_SECONDS))
        self.assertAlmostEqual(now[0] - 10.0, helper.ACTION_WAIT_SECONDS, delta=0.1)

    def test_act_takes_its_snapshot_only_after_waiting_and_flags_a_page_still_busy(self):
        order = []
        for busy in (False, True):
            with self.subTest(busy=busy):
                def page(expression):
                    return {"x": 1, "y": 2} if "aim(" in expression else True
                with patch.object(helper, "wait_for_action", side_effect=lambda *a: order.append("wait") or not busy):
                    result, sent = self.scripted_act([{"kind": "click", "ref": "e1"}], page)
                self.assertEqual(result.get("loading"), True if busy else None)
                self.assertIn(("Network.enable", {"maxPostDataSize": 1}), sent)


if __name__ == "__main__":
    unittest.main()
