"""Exercise the publishing guard in disposable repositories, without network access."""

import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("apply-dependency-update.sh").resolve()


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.DEVNULL)


class PatchHandoffTests(unittest.TestCase):
    def test_patch_scope_and_unchanged_checkout_on_rejection(self):
        cases = [
            ("package.json", "modify", True),
            ("src/new file.ts", "add", True),
            (".github/workflows/check.yml", "modify", False),
            ("AGENTS.md", "delete", False),
            ("nested/CLAUDE.md", "add", False),
            ("nested/SKILL.md", "add", False),
            (".env.production", "add", False),
            ("nested/.env.local", "add", False),
            (".agents", "symlink", False),
            (".codex/config.toml", "add", False),
            (".github/workflows/check.yml", "rename", False),
        ]
        for path, operation, allowed in cases:
            with self.subTest(path=path, operation=operation), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory) / "repo"
                root.mkdir()
                git(root, "init", "-q")
                git(root, "config", "user.name", "Test")
                git(root, "config", "user.email", "test@example.invalid")
                git(root, "config", "commit.gpgsign", "false")
                git(root, "config", "core.hooksPath", "/dev/null")
                for initial in ("package.json", "AGENTS.md", ".github/workflows/check.yml"):
                    file = root / initial
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_text("before\n")
                git(root, "add", ".")
                git(root, "commit", "-qm", "fixture")
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                if operation == "delete":
                    file.unlink()
                elif operation == "rename":
                    file.rename(root / "renamed.yml")
                elif operation == "symlink":
                    file.symlink_to("package.json")
                else:
                    file.write_text("after\n")
                git(root, "add", "-N", ".")
                patch = git(root, "diff", "--binary", "HEAD")
                git(root, "reset", "--hard", "-q", "HEAD")
                git(root, "clean", "-fdq")
                temp = pathlib.Path(directory) / "temp"
                temp.mkdir()
                patch_file = temp / "update.patch"
                patch_file.write_bytes(patch)
                result = subprocess.run(
                    ["bash", str(SCRIPT), str(patch_file)],
                    cwd=root,
                    env={**os.environ, "RUNNER_TEMP": str(temp)},
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode == 0, allowed, result.stderr.decode())
                if allowed:
                    self.assertEqual(file.read_text(), "after\n")
                    self.assertEqual(git(root, "diff", "--cached", "--binary"), patch)
                else:
                    self.assertFalse(git(root, "status", "--porcelain"))


if __name__ == "__main__":
    unittest.main()
