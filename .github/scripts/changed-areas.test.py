"""Classify pull-request merge commits in disposable repositories, without network access."""

import json
import pathlib
import re
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("changed-areas.sh").resolve()
BASE_FILES = ("apps/web/src/logo.svg", "apps/mobile/app/index.tsx", "README.md")


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.DEVNULL, text=True)


def areas(change):
    """Commit `change(root)` on a branch, merge it into the base, and classify the merge commit."""
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        git(root, "init", "-q", "-b", "main")
        git(root, "config", "user.name", "Test")
        git(root, "config", "user.email", "test@example.invalid")
        git(root, "config", "commit.gpgsign", "false")
        git(root, "config", "core.hooksPath", "/dev/null")
        for name in BASE_FILES:
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(f"{name}\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "base")
        git(root, "switch", "-qc", "pr")
        change(root)
        git(root, "add", "-A")
        git(root, "commit", "-qm", "change")
        git(root, "switch", "-q", "main")
        (root / "base-moved.txt").write_text("main moved on\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "unrelated main commit")
        git(root, "merge", "-q", "--no-ff", "-m", "merge", "pr")
        output = subprocess.check_output(["bash", str(SCRIPT)], cwd=root, text=True)
        return dict(line.split("=", 1) for line in output.split())


def write(path, text="changed\n"):
    def change(root):
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(text)

    return change


def vitest_config_files(config):
    """Workspace files a Vitest config names, with or without `./`; test globs and installed
    packages are not files it loads."""
    paths = set()
    # Each quote kind closes only itself, on its own line, so an apostrophe in a comment
    # cannot pair with the next string's quote.
    for match in re.finditer(r""""([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`""", config):
        path = next(text for text in match.groups() if text is not None).removeprefix("./")
        if re.match(r"(apps|packages)/", path) and not re.search(r"[*?{}\[\]]|/node_modules/", path):
            paths.add(path)
    return sorted(paths)


AREAS = ("web", "e2e", "server", "www", "native", "compose", "all_packages")
EVERY_SHARD = "[1,2,3,4]"


def expect(*on, unit=EVERY_SHARD):
    return {**{area: str(area in on).lower() for area in AREAS}, "unit_shards": unit}


PRODUCT = ("web", "e2e", "server")
EVERY_BROWSER_AREA = (*PRODUCT, "www")


class ChangedAreasTests(unittest.TestCase):
    def test_classifies_what_the_pull_request_changed(self):
        cases = [
            ("apps/mobile/app/screen.tsx", expect()),
            (".agents/skills/x/SKILL.md", expect(unit="[]")),
            (".claude/settings.json", expect(unit="[]")),
            ("CHANGELOG.md", expect(unit="[]")),
            ("docs/getting-started.md", expect("www", unit="[1]")),
            ("apps/www/src/page.astro", expect("www", unit="[1]")),
            ("apps/www/package.json", expect(*EVERY_BROWSER_AREA, "all_packages")),
            ("apps/worker/src/index.ts", expect("web", "server")),
            ("packages/adapters/src/slack.ts", expect("web", "e2e", "server")),
            ("packages/adapters/src/scripted-runtime.ts", expect("web", "e2e", "server")),
            ("packages/adapters/src/host-computer-runner.ts", expect("web", "e2e", "server", "native")),
            ("packages/adapters/src/computer-workspace.ts", expect("web", "e2e", "server", "native")),
            ("packages/adapters/src/file-handle-path.ts", expect("web", "e2e", "server", "native")),
            ("packages/adapters/src/workspace-save-policy.ts", expect("web", "e2e", "server", "native")),
            ("packages/core/src/node/desktop-runtime.ts", expect(*EVERY_BROWSER_AREA, "native")),
            (
                "infra/compose/docker-compose.prod.yml",
                expect(*PRODUCT, "compose", "all_packages"),
            ),
            ("infra/sandboxes/computer/start.sh", expect(*PRODUCT, "all_packages")),
            ("infra/sandboxes/computer/Dockerfile", expect(*PRODUCT, "all_packages")),
            ("infra/sandboxes/supervisor/Dockerfile", expect(*PRODUCT, "all_packages")),
            ("infra/updater/Dockerfile", expect(*PRODUCT, "all_packages")),
            ("infra/updater/src/compose-env.ts", expect(*PRODUCT)),
            ("apps/mobile/package.json", expect(*PRODUCT, "all_packages")),
            ("tsconfig.base.json", expect(*EVERY_BROWSER_AREA, "all_packages")),
            ("scripts/build-server.mjs", expect(*PRODUCT, "all_packages")),
            (
                "scripts/setup-worktree.mjs",
                expect(*PRODUCT, "native", "all_packages"),
            ),
            (
                "scripts/setup-worktree.test.mjs",
                expect(*PRODUCT, "native", "all_packages"),
            ),
            (".agents/skills/pr-watch/pr-digest", expect("all_packages")),
            (".agents/skills/translate/catalog-gaps.ts", expect("all_packages")),
            ("packages/core/README.md", expect(*EVERY_BROWSER_AREA)),
            ("packages/core/src/run-error.ts", expect(*EVERY_BROWSER_AREA)),
            ("pnpm-lock.yaml", expect(*AREAS)),
            (".github/workflows/ci.yml", expect(*AREAS)),
            (".github/workflows/playwright.yml", expect(*AREAS)),
            (".github/actions/setup-workspace/action.yml", expect(*AREAS)),
            (".github/scripts/restore-postgres-image.sh", expect(*AREAS)),
            (".github/actions/start-postgres/action.yml", expect(*AREAS)),
        ]
        for path, expected in cases:
            with self.subTest(path=path):
                self.assertEqual(areas(write(path)), expected)

    def test_files_the_root_vitest_config_loads_count_for_every_package(self):
        # Every package's tests load these, but no package depends on the one that holds them.
        paths = vitest_config_files((SCRIPT.parents[2] / "vitest.config.ts").read_text())
        self.assertTrue(paths)
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(areas(write(path))["all_packages"], "true")

    def test_vitest_config_files_are_found_with_or_without_a_leading_dot(self):
        config = """
          include: ["packages/*/src/**/*.test.{ts,tsx}"],
          setupFiles: ["./packages/a/src/setup.ts", 'packages/b/src/extra-setup.ts'],
          replacement: new URL(`./apps/c/src/stub.ts`, import.meta.url),
          replacement: "./packages/d/node_modules/e/index.tsx",
        """
        self.assertEqual(
            vitest_config_files(config),
            ["apps/c/src/stub.ts", "packages/a/src/setup.ts", "packages/b/src/extra-setup.ts"],
        )

    def test_marketing_site_and_docs_together_stay_out_of_the_product_suites(self):
        def change(root):
            write("apps/www/src/page.astro")(root)
            write("docs/getting-started.md")(root)
            write("CHANGELOG.md")(root)

        self.assertEqual(areas(change), expect("www", unit="[1]"))

    def test_a_rename_out_of_the_web_app_counts_its_old_path(self):
        def move(root):
            (root / "apps/mobile/assets").mkdir()
            git(root, "mv", "apps/web/src/logo.svg", "apps/mobile/assets/logo.svg")

        self.assertEqual(areas(move), expect("web", "e2e"))

    def test_browser_clients_skip_the_postgres_journeys(self):
        cases = [
            ("apps/web/src/app.ts", expect("web", "e2e")),
            ("packages/ui-web/src/button.tsx", expect("web", "e2e", "www")),
            ("packages/chat-ui/src/thread.tsx", expect("web", "e2e")),
            ("apps/desktop/src/main/main.ts", expect("web", "e2e", "native")),
            ("apps/web/package.json", expect(*PRODUCT, "all_packages")),
            ("packages/ui-tokens/src/tokens.ts", expect(*EVERY_BROWSER_AREA)),
        ]
        for path, expected in cases:
            with self.subTest(path=path):
                self.assertEqual(areas(write(path)), expected)

    def test_repo_checks_and_unrelated_workflows_skip_the_product_suites(self):
        # Lint and typecheck runs the repo checks' own tests on every pull request.
        cases = [
            ("scripts/checks/import-boundaries.test.mjs", expect(unit="[]")),
            ("scripts/checks/bundle-size.budgets.json", expect("web", unit="[]")),
            # Unit and script tests read the release workflows, but no product suite builds them.
            (".github/workflows/release-mobile.yml", expect("all_packages")),
        ]
        for path, expected in cases:
            with self.subTest(path=path):
                self.assertEqual(areas(write(path)), expected)

    def test_www_packages_are_the_marketing_sites_workspace_dependencies(self):
        repo = SCRIPT.parents[2]
        manifests = {}
        for manifest in [*repo.glob("apps/*/package.json"), *repo.glob("packages/*/package.json")]:
            data = json.loads(manifest.read_text())
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {}), **data.get("peerDependencies", {})}
            manifests[data["name"]] = (manifest.parent, [name for name, spec in deps.items() if str(spec).startswith("workspace:")])
        closure, pending = set(), list(manifests["@rakazo/www"][1])
        while pending:
            name = pending.pop()
            if name not in closure:
                closure.add(name)
                pending.extend(manifests[name][1])
        expected = sorted(manifests[name][0].name for name in closure)
        declared = re.search(r'^WWW_PACKAGES="([^"]*)"$', SCRIPT.read_text(), re.M).group(1).split()
        self.assertEqual(sorted(declared), expected)

    def test_marketing_screenshots_follow_the_packages_the_site_imports(self):
        cases = [
            ("packages/contracts/src/client-build.ts", expect(*EVERY_BROWSER_AREA)),
            ("packages/db/src/client.ts", expect(*PRODUCT)),
            ("apps/api/src/server.ts", expect(*PRODUCT)),
        ]
        for path, expected in cases:
            with self.subTest(path=path):
                self.assertEqual(areas(write(path)), expected)


if __name__ == "__main__":
    unittest.main()
