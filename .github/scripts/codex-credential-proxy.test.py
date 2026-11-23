import base64
import importlib.util
import io
import json
import pathlib
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest import mock

spec = importlib.util.spec_from_file_location("proxy", pathlib.Path(__file__).with_name("codex-credential-proxy.py"))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


def jwt(exp: float, **extra) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp, **extra}).encode()).decode().rstrip("=")
    return f"h.{payload}.s"


class RefreshTest(unittest.TestCase):
    def write(self, directory: str, access: str) -> str:
        path = f"{directory}/auth.json"
        tokens = {"access_token": access, "id_token": "id", "refresh_token": "old", "account_id": "acct"}
        pathlib.Path(path).write_text(json.dumps({"auth_mode": "chatgpt", "tokens": tokens}))
        return path

    def test_keeps_a_login_that_is_not_expiring(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write(directory, jwt(time.time() + 86400))
            with mock.patch.object(proxy.urllib.request, "urlopen") as urlopen:
                proxy.refresh(path)
            urlopen.assert_not_called()

    def test_refreshes_and_saves_a_login_about_to_expire(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write(directory, jwt(time.time() + 60))
            fresh = {"access_token": "new-access", "id_token": "new-id", "refresh_token": "new-refresh"}
            response = mock.MagicMock()
            response.__enter__.return_value = io.BytesIO(json.dumps(fresh).encode())
            with mock.patch.object(proxy.urllib.request, "urlopen", return_value=response) as urlopen, \
                    mock.patch("builtins.print"):
                proxy.refresh(path)
            sent = urllib.parse.parse_qs(urlopen.call_args.args[0].data.decode())
            self.assertEqual(sent["refresh_token"], ["old"])
            tokens = json.loads(pathlib.Path(path).read_text())["tokens"]
            self.assertEqual(tokens["refresh_token"], "new-refresh")
            self.assertEqual(tokens["account_id"], "acct")


    def test_keeps_the_login_when_the_reply_has_no_access_token(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.write(directory, jwt(time.time() + 60))
            before = pathlib.Path(path).read_text()
            response = mock.MagicMock()
            response.__enter__.return_value = io.BytesIO(b"{}")
            with mock.patch.object(proxy.urllib.request, "urlopen", return_value=response), \
                    self.assertRaises(SystemExit):
                proxy.refresh(path)
            self.assertEqual(pathlib.Path(path).read_text(), before)


class AccountTest(unittest.TestCase):
    def test_reads_the_account_from_the_id_token_when_not_stored(self):
        id_token = jwt(0, **{"https://api.openai.com/auth": {"chatgpt_account_id": "from-id"}})
        self.assertEqual(proxy.account_id({"id_token": id_token}), "from-id")
        self.assertEqual(proxy.account_id({"id_token": id_token, "account_id": "stored"}), "stored")


class ServeTest(unittest.TestCase):
    def test_refuses_paths_outside_the_codex_api(self):
        server = proxy.Server(("127.0.0.1", 0), proxy.handler("/nonexistent"))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            for path in ("/v1/other", "/backend-api/codex/../me", "/backend-api/codex/%2e%2e/me"):
                with self.assertRaises(urllib.error.HTTPError) as refused:
                    urllib.request.urlopen(f"http://127.0.0.1:{server.server_address[1]}{path}", timeout=5)
                self.assertEqual(refused.exception.code, 403)
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()
