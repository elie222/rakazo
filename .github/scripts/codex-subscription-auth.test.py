"""Offline tests using fake credentials only."""

import copy
import json
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("codex-subscription-auth.py")
AUTH = {
    "auth_mode": "chatgpt",
    "OPENAI_API_KEY": None,
    "tokens": {
        "access_token": "fake-access",
        "id_token": "fake-id",
        "refresh_token": "fake-refresh",
        "account_id": "fake-account",
    },
    "last_refresh": "2026-01-01T00:00:00Z",
}


class SubscriptionAuthTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.destination = pathlib.Path(self.directory.name) / "auth.json"

    def run_helper(self, raw):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.destination)],
            input=raw,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_preserves_refreshed_cache_and_restricts_file_mode(self):
        self.destination.write_text("old cache")
        self.destination.chmod(0o644)
        result = self.run_helper(json.dumps(AUTH))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.destination.read_text()), AUTH)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o600)
        for token in AUTH["tokens"].values():
            self.assertIn(f"::add-mask::{token}\n", result.stdout)

    def test_rejects_non_subscription_or_non_refreshable_auth(self):
        invalid = [None, [], "not an object", {"auth_mode": "chatgptAuthTokens"}]
        for name in ("access_token", "id_token", "refresh_token"):
            for value in (None, "", " ", 123):
                auth = copy.deepcopy(AUTH)
                auth["tokens"][name] = value
                invalid.append(auth)
        for mode in ("apikey", "chatgptAuthTokens", None):
            invalid.append({**AUTH, "auth_mode": mode})
        invalid.append({**AUTH, "OPENAI_API_KEY": "fake-api-key"})
        for auth in invalid:
            with self.subTest(auth=auth):
                result = self.run_helper(json.dumps(auth))
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.destination.exists())
                self.assertNotIn("fake-access", result.stdout + result.stderr)

    def test_rejects_malformed_or_oversized_input_without_echoing_it(self):
        for raw in ("fake-invalid-json", json.dumps({**AUTH, "padding": "x" * 65536})):
            result = self.run_helper(raw)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(self.destination.exists())
            self.assertNotIn("fake-invalid-json", result.stdout + result.stderr)

    def test_escapes_mask_commands(self):
        auth = copy.deepcopy(AUTH)
        auth["tokens"]["access_token"] = "fake%\r\n::error::injected"
        result = self.run_helper(json.dumps(auth))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("::add-mask::fake%25%0D%0A::error::injected\n", result.stdout)
        self.assertEqual(len(result.stdout.splitlines()), 4)

    def test_refuses_symlink_destination(self):
        target = self.destination.with_name("unchanged.txt")
        target.write_text("unchanged")
        self.destination.symlink_to(target)
        result = self.run_helper(json.dumps(AUTH))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(), "unchanged")


if __name__ == "__main__":
    unittest.main()
