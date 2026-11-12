"""Check that only the agent's own PNGs and plain-text captions reach the PR description."""

import importlib.util
import json
import contextlib
import io
import re
import pathlib
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name("pr-screenshots.py").resolve()
spec = importlib.util.spec_from_file_location("pr_screenshots", SCRIPT)
assert spec and spec.loader
shots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shots)

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 16
BASE = "https://example.com/pr-agent/1/abc"


class SelectTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)
        (self.dir / "01-chat.png").write_bytes(PNG)
        (self.dir / "02-menu.png").write_bytes(PNG)
        (self.dir / "page-2026-01-01T00-00-00.000Z.png").write_bytes(PNG)
        (self.dir / "fake.png").write_bytes(b"<svg/>")

    def tearDown(self):
        self.tmp.cleanup()

    def select(self, screenshots):
        return shots.select({"screenshots": screenshots}, self.dir)

    def test_keeps_saved_pngs_in_order(self):
        self.assertEqual(
            self.select([{"file": "02-menu.png", "caption": "Menu"}, {"file": "01-chat.png", "caption": "Chat"}]),
            [("02-menu.png", "Menu"), ("01-chat.png", "Chat")],
        )

    def test_accepts_automatic_names(self):
        name = "page-2026-01-01T00-00-00.000Z.png"
        self.assertEqual(self.select([{"file": name, "caption": ""}]), [(name, "")])

    def test_drops_missing_traversal_and_non_png_files(self):
        self.assertEqual(
            self.select(
                [
                    {"file": "../01-chat.png"},
                    {"file": "a..png"},
                    {"file": "/etc/passwd"},
                    {"file": "missing.png"},
                    {"file": "fake.png"},
                    {"file": "01-chat.PNG"},
                    {"file": 7},
                    "01-chat.png",
                ]
            ),
            [],
        )

    def test_drops_symlinks_and_duplicates(self):
        (self.dir / "link.png").symlink_to(self.dir / "01-chat.png")
        self.assertEqual(
            self.select([{"file": "link.png"}, {"file": "01-chat.png"}, {"file": "01-chat.png"}]),
            [("01-chat.png", "")],
        )

    def test_size_limit_is_in_bytes(self):
        (self.dir / "big.png").write_bytes(PNG + b"\0" * (shots.MAX_BYTES - len(PNG)))
        (self.dir / "huge.png").write_bytes(PNG + b"\0" * (shots.MAX_BYTES - len(PNG) + 1))
        self.assertEqual(self.select([{"file": "big.png"}, {"file": "huge.png"}]), [("big.png", "")])

    def test_caps_count(self):
        for index in range(6):
            (self.dir / f"s{index}.png").write_bytes(PNG)
        self.assertEqual(len(self.select([{"file": f"s{index}.png"} for index in range(6)])), shots.MAX_SHOTS)

    def test_rejects_malformed_result(self):
        self.assertEqual(shots.select(None, self.dir), [])
        self.assertEqual(shots.select({"screenshots": "01-chat.png"}, self.dir), [])

    def test_captions_with_addresses_are_dropped(self):
        for text in ("see https://evil.test", "go to www.evil.test", "visit evil.example/login", "mail a@evil.io"):
            self.assertEqual(self.select([{"file": "01-chat.png", "caption": text}]), [("01-chat.png", "")])

    def test_captions_are_plain_text(self):
        [(_, caption)] = self.select(
            [{"file": "01-chat.png", "caption": "![x](y) <img src=x> @someone\n<!-- rakazo-pr-screenshots:end -->"}]
        )
        self.assertIsNone(re.search(r"(?<!\\)[<>\[\]()!@]", caption))
        self.assertNotIn(shots.END, caption)
        self.assertLessEqual(len(self.select([{"file": "01-chat.png", "caption": "a" * 999}])[0][1]), shots.MAX_CAPTION)


class SectionTest(unittest.TestCase):
    def test_empty_selection_has_no_section(self):
        self.assertEqual(shots.section([], BASE), "")

    def test_links_images_under_base(self):
        text = shots.section([("01-chat.png", "Chat")], BASE + "/")
        self.assertIn(f"![01-chat.png]({BASE}/01-chat.png)", text)
        self.assertTrue(text.startswith(shots.START) and text.endswith(shots.END))


class SpliceTest(unittest.TestCase):
    new = f"{shots.START}\nnew\n{shots.END}"

    def test_appends_when_missing(self):
        self.assertEqual(shots.splice("## What\nx\n", self.new), f"## What\nx\n\n{self.new}\n")

    def test_replaces_in_place(self):
        body = f"## What\nx\n\n{shots.START}\nold\n{shots.END}\n\n🤖 footer\n"
        self.assertEqual(shots.splice(body, self.new), f"## What\nx\n\n{self.new}\n\n🤖 footer\n")

    def test_removes_when_empty(self):
        body = f"## What\nx\n\n{shots.START}\nold\n{shots.END}\n\nfooter"
        self.assertEqual(shots.splice(body, ""), "## What\nx\n\nfooter\n")

    def test_orphan_start_marker_keeps_author_text_across_updates(self):
        body = f"x\n{shots.START}\nauthor text\n"
        once = shots.splice(body, self.new)
        self.assertEqual(once.count(shots.START), 1)
        twice = shots.splice(once, f"{shots.START}\nnewer\n{shots.END}")
        self.assertIn("author text", twice)
        self.assertNotIn("\nnew\n", twice)


class PromptTest(unittest.TestCase):
    PR = {"title": "Fix", "body": "", "changed_files": ["apps/web/src/a.tsx"], "preview_url": "https://x"}

    def test_keeps_a_small_diff_whole(self):
        text = shots.prompt("Do it.", self.PR, "+line\n")
        self.assertTrue(text.startswith("Do it.\n\n<pull_request>\n"))
        self.assertTrue(text.endswith("<diff>\n+line\n\n</diff>\n"))

    def test_fits_huge_inputs_in_one_environment_variable(self):
        pr = {**self.PR, "body": "\u00e9\"" * 70_000, "changed_files": [f"f{i}" for i in range(5000)]}
        text = shots.prompt("Do it.", pr, '"\\\n' * 200_000)
        self.assertLessEqual(len(json.dumps(text)), shots.MAX_PROMPT_JSON)
        self.assertLess(len(json.dumps(text, ensure_ascii=False).encode()), 128 * 1024)
        self.assertTrue(text.endswith("\n</diff>\n"))
        self.assertIn('"f299"', text)
        self.assertNotIn('"f300"', text)


    def test_an_emoji_body_alone_cannot_overflow(self):
        text = shots.prompt("Do it.", {**self.PR, "body": "\U0001f600" * 8_000}, "")
        self.assertLessEqual(len(json.dumps(text)), shots.MAX_PROMPT_JSON)

class EfficiencyTest(unittest.TestCase):
    sha = "a" * 40

    def pr(self, body):
        return {"state": "open", "head": {"sha": self.sha}, "body": body}

    def test_author_markers_and_images_cannot_skip_assessment(self):
        body = f"{shots.START}\n<!-- screenshot-commit:{self.sha} -->\n![Chat](https://example.com/a.png)\n{shots.END}\n<!-- rakazo-screenshot-reviewed:{self.sha} -->"
        self.assertFalse(shots.obsolete(self.pr(body), self.sha))
        with mock.patch.object(shots, "api", return_value=[{"artifacts": []}]):
            self.assertFalse(shots.assessed("example/repo", "1", self.sha))

    def test_obsolete_runs_skip(self):
        self.assertTrue(shots.obsolete({**self.pr(""), "state": "closed"}, self.sha))
        self.assertTrue(shots.obsolete(self.pr(""), "b" * 40))

    def test_evidence_requires_publisher_and_current_commit(self):
        body = f"<!-- rakazo-playwright-screenshots -->\n<!-- screenshot-commit:{self.sha} -->\nGallery"
        comment = {"user": {"login": "github-actions[bot]"}, "body": body}
        pages = [[{**comment, "user": {"login": "someone"}}], [comment]]
        self.assertEqual(shots.evidence(pages, self.sha), body)
        self.assertEqual(shots.evidence(pages, "b" * 40), "")

    def test_evidence_cannot_overflow_prompt(self):
        pr = {**PromptTest.PR, "existing_e2e_screenshots": '"' * 100_000}
        self.assertLessEqual(shots.json_size(shots.prompt("Do it.", pr, "x" * 200_000)), shots.MAX_PROMPT_JSON)


class SourcesReadyTest(unittest.TestCase):
    sha = "a" * 40
    repo = "example/repo"

    def artifacts(self, source, **overrides):
        return [{"artifacts": [{"name": f"pr-screenshot-{source}-{self.sha}", "expired": False, "workflow_run": {"id": 1}, **overrides}]}]

    def source_run(self, workflow, **overrides):
        return {"event": "workflow_run", "path": f".github/workflows/{workflow}.yml", "head_repository": {"full_name": self.repo}, **overrides}

    def test_both_signals_allow_capture(self):
        responses = [self.artifacts("preview"), self.source_run("preview-deploy"), self.artifacts("e2e"), self.source_run("publish-playwright-report")]
        with mock.patch.object(shots, "api", side_effect=responses):
            self.assertTrue(shots.sources_ready(self.repo, self.sha))

    def test_e2e_finishes_first(self):
        with mock.patch.object(shots, "api", return_value=[{"artifacts": []}]):
            self.assertFalse(shots.sources_ready(self.repo, self.sha))

    def test_preview_finishes_first(self):
        with mock.patch.object(shots, "api", side_effect=[self.artifacts("preview"), self.source_run("preview-deploy"), [{"artifacts": []}]]):
            self.assertFalse(shots.sources_ready(self.repo, self.sha))

    def test_expired_or_other_commit_signal_does_not_allow_capture(self):
        for overrides in ({"expired": True}, {"name": "pr-screenshot-preview-" + "b" * 40}):
            with self.subTest(overrides=overrides), mock.patch.object(shots, "api", return_value=self.artifacts("preview", **overrides)) as api:
                self.assertFalse(shots.sources_ready(self.repo, self.sha))
                self.assertEqual(api.call_count, 1)

    def test_pr_cannot_forge_trusted_readiness_with_an_artifact_name(self):
        for overrides in ({"event": "pull_request"}, {"path": ".github/workflows/ci.yml"}, {"head_repository": {"full_name": "other/repo"}}):
            with self.subTest(overrides=overrides), mock.patch.object(shots, "api", side_effect=[self.artifacts("preview"), self.source_run("preview-deploy", **overrides)]):
                self.assertFalse(shots.sources_ready(self.repo, self.sha))

    def test_forged_artifact_does_not_hide_a_trusted_one_on_another_page(self):
        pages = self.artifacts("preview") + self.artifacts("preview")
        responses = [pages, self.source_run("preview-deploy", event="pull_request"), self.source_run("preview-deploy"), self.artifacts("e2e"), self.source_run("publish-playwright-report")]
        with mock.patch.object(shots, "api", side_effect=responses):
            self.assertTrue(shots.sources_ready(self.repo, self.sha))

    def test_assessment_requires_trusted_exact_pr_and_commit_artifact(self):
        name = f"pr-screenshot-reviewed-1-{self.sha}"
        artifact = self.artifacts("preview", name=name)
        with mock.patch.object(shots, "api", side_effect=[artifact, self.source_run("preview-deploy")]):
            self.assertTrue(shots.assessed(self.repo, "1", self.sha))
        with mock.patch.object(shots, "api", side_effect=[artifact, self.source_run("preview-deploy", event="pull_request")]):
            self.assertFalse(shots.assessed(self.repo, "1", self.sha))
        with mock.patch.object(shots, "api", return_value=artifact):
            self.assertFalse(shots.assessed(self.repo, "2", self.sha))

    def test_invalid_sha_is_rejected_before_api_access(self):
        with mock.patch.object(shots, "api") as api, self.assertRaises(ValueError):
            shots.sources_ready(self.repo, "../other")
        api.assert_not_called()


class CodexConfigTest(unittest.TestCase):
    def test_browser_only_configuration(self):
        import tomllib
        adapter_spec = importlib.util.spec_from_file_location("adapter", SCRIPT.with_name("pr-screenshot-codex.py"))
        adapter = importlib.util.module_from_spec(adapter_spec)
        adapter_spec.loader.exec_module(adapter)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            mcp = root / "mcp.json"
            mcp.write_text(json.dumps({"mcpServers": {"playwright": {"command": "sudo", "args": ["--isolated"]}}}))
            adapter.configure(mcp, root)
            config = tomllib.loads((root / "config.toml").read_text())
            self.assertEqual(config["permissions"]["screenshots"]["filesystem"][str(root)], "deny")
            self.assertEqual(config["web_search"], "disabled")
            self.assertTrue(all(value is False for value in config["features"].values()))
            allowed = config["mcp_servers"]["playwright"]["enabled_tools"]
            self.assertIn("browser_take_screenshot", allowed)
            self.assertNotIn("browser_evaluate", allowed)
            self.assertNotIn("browser_file_upload", allowed)
            self.assertEqual(json.loads((root / "schema.json").read_text())["required"], ["screenshots", "complete"])
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(shots.main(["x", "contract"]), 0)
            generated = dict(line.split("=", 1) for line in output.getvalue().splitlines())
            self.assertEqual(generated["tools"].split(","), [f"mcp__playwright__{tool}" for tool in allowed])
            self.assertEqual(json.loads(generated["schema"]), adapter.SCHEMA)


class CliTest(unittest.TestCase):
    def test_prepare_writes_uploads_and_section(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "shots").mkdir()
            (root / "shots" / "01-chat.png").write_bytes(PNG)
            result = json.dumps({"complete": True, "screenshots": [{"file": "01-chat.png", "caption": "Chat"}]})
            self.assertEqual(shots.main(["x", "prepare", result, str(root / "shots"), BASE, str(root / "out")]), 0)
            self.assertEqual((root / "out" / "uploads.txt").read_text(), "01-chat.png\n")
            self.assertIn("01-chat.png", (root / "out" / "section.md").read_text())
            self.assertEqual(shots.main(["x", "prepare", "not json", str(root / "shots"), BASE, str(root / "o2")]), 2)
            self.assertFalse((root / "o2").exists())

    def test_partially_rejected_capture_cannot_be_published_as_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "good.png").write_bytes(PNG)
            result = {"complete": True, "screenshots": [{"file": "good.png"}, {"file": "missing.png"}]}
            self.assertEqual(shots.main(["x", "prepare", json.dumps(result), str(root), BASE, str(root / "out")]), 2)
            self.assertFalse((root / "out").exists())

    def test_incomplete_capture_is_publishable_but_not_marked_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "good.png").write_bytes(PNG)
            result = {"complete": False, "screenshots": [{"file": "good.png"}]}
            self.assertEqual(shots.main(["x", "prepare", json.dumps(result), str(root), BASE, str(root / "out")]), 0)
            self.assertIn("good.png", (root / "out" / "section.md").read_text())
            self.assertFalse((root / "out" / "complete.txt").exists())

    def test_prepare_requires_explicit_boolean_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for result in ({"screenshots": []}, {"screenshots": [], "complete": "true"}):
                self.assertEqual(shots.main(["x", "prepare", json.dumps(result), str(root), BASE, str(root / "out")]), 2)
                self.assertFalse((root / "out").exists())


if __name__ == "__main__":
    unittest.main()
