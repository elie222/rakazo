"""Validate and privately snapshot Codex-managed account auth from stdin."""

import json
import os
import sys


def snapshot(destination):
    raw = sys.stdin.buffer.read(65537)
    try:
        if len(raw) > 65536:
            raise ValueError()
        auth = json.loads(raw)
        if auth.get("auth_mode") != "chatgpt" or auth.get("OPENAI_API_KEY"):
            raise ValueError()
        tokens = auth["tokens"]
        for name in ("access_token", "id_token", "refresh_token"):
            if not isinstance(tokens[name], str) or not tokens[name].strip():
                raise ValueError()
    except (ValueError, KeyError, TypeError, AttributeError):
        raise SystemExit("Expected refreshable Codex subscription auth; reseed the repository secret.") from None

    for value in tokens.values():
        if isinstance(value, str) and value:
            escaped = value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print(f"::add-mask::{escaped}")
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(auth, output)


if __name__ == "__main__":
    snapshot(sys.argv[1])
