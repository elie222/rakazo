"""Check that only the agent's own PNGs and plain-text captions reach the PR description."""

import importlib.util
import json
import re
import pathlib
import tempfile
import unittest

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


class CliTest(unittest.TestCase):
    def test_prepare_writes_uploads_and_section(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "shots").mkdir()
            (root / "shots" / "01-chat.png").write_bytes(PNG)
            result = json.dumps({"screenshots": [{"file": "01-chat.png", "caption": "Chat"}]})
            self.assertEqual(shots.main(["x", "prepare", result, str(root / "shots"), BASE, str(root / "out")]), 0)
            self.assertEqual((root / "out" / "uploads.txt").read_text(), "01-chat.png\n")
            self.assertIn("01-chat.png", (root / "out" / "section.md").read_text())
            self.assertEqual(shots.main(["x", "prepare", "not json", str(root / "shots"), BASE, str(root / "o2")]), 0)
            self.assertEqual((root / "o2" / "uploads.txt").read_text(), "")


if __name__ == "__main__":
    unittest.main()
