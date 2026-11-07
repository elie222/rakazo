"""Choose the commit the mobile OTA diff starts from, without network access."""

import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "ci.yml"
OTA_BASE = pathlib.Path(__file__).with_name("ota-base.sh").resolve()
OTA_CLASSIFY = pathlib.Path(__file__).with_name("ota-classify.sh").resolve()
DEPENDENCY_TREE = pathlib.Path(__file__).with_name("mobile-dependency-tree.mjs").resolve()

OLD_RUNTIME = "1.0.11"
RUNTIME = "1.0.12"
SWIFT_FILE = "apps/mobile/modules/rakazo-foo/ios/FooModule.swift"


def app_json(version, icon_key=None):
    """The mobile manifest, with only the keys the OTA decision reads.

    The pretty layout keeps a clean merge possible: two sides that adopt the same
    version and touch disjoint keys merge without a conflict.
    """
    extra = {"eas": {"projectId": "test"}}
    if icon_key is not None:
        extra["iconKey"] = icon_key
    return json.dumps({"expo": {"version": version, "extra": extra}}, indent=2) + "\n"


def update(commit, runtime, rollback=False):
    return {"gitCommitHash": commit, "runtimeVersion": runtime, "isRollBackToEmbedded": rollback}


def updates_response(*updates):
    """A GraphQL body whose production branch carries the given updates."""
    return json.dumps(
        {"data": {"app": {"byId": {"updateBranchByName": {"updates": list(updates)}}}}}
    )


NO_UPDATES = json.dumps({"data": {"app": {"byId": {"updateBranchByName": None}}}})


class FixtureRepository:
    """A git history that reproduces the risky sequence: a version bump, then a native
    change, then a JavaScript-only change, plus a commit that never reached main."""

    def __init__(self, path, lockfile=False, native_change=True, merged_native=False, entry_change=False):
        self.path = path
        self.git("init", "--quiet", "-b", "main")
        self.git("config", "user.email", "ota-base-test@example.com")
        self.git("config", "user.name", "OTA base test")
        root_files = {"apps/mobile/app.json": app_json(OLD_RUNTIME)}
        if lockfile:
            root_files["pnpm-lock.yaml"] = (REPO / "pnpm-lock.yaml").read_text()
        self.root = self.commit("start at an older runtime", root_files)
        if merged_native:
            self.build_merged_native_history()
            return
        self.bump = self.commit("introduce the runtime version", {"apps/mobile/app.json": app_json(RUNTIME)})
        if native_change:
            self.native = self.commit(
                "add a native module the JavaScript calls",
                {SWIFT_FILE: "import Foundation\n", "apps/mobile/lib/use-foo.ts": "export const useFoo = 1;\n"},
            )
        else:
            self.native = self.bump
        head_files = (
            {"apps/mobile/index.ts": "require(\"expo-router/entry\");\n"}
            if entry_change
            else {"apps/mobile/lib/other.ts": "export const other = 2;\n"}
        )
        self.head = self.commit("change JavaScript only", head_files)
        self.git("checkout", "--quiet", "-b", "side", self.bump)
        self.off_history = self.commit(
            "change JavaScript off main", {"apps/mobile/lib/side.ts": "export const side = 3;\n"}
        )
        self.git("checkout", "--quiet", "main")

    def build_merged_native_history(self):
        """Main adopts the runtime and ships binaries, then merges a branch that had
        adopted the same version on its own and added a native module. A path-filtered
        log simplifies the merge into the branch, hiding main's adoption."""
        self.bump = self.commit(
            "introduce the runtime version on main", {"apps/mobile/app.json": app_json(RUNTIME)}
        )
        self.git("checkout", "--quiet", "-b", "feature", self.root)
        self.native = self.commit(
            "adopt the runtime off main and add a native module",
            {
                "apps/mobile/app.json": app_json(RUNTIME, icon_key="feature"),
                SWIFT_FILE: "import Foundation\n",
                "apps/mobile/lib/use-foo.ts": "export const useFoo = 1;\n",
            },
        )
        self.git("checkout", "--quiet", "main")
        subprocess.run(
            ["git", "-C", str(self.path), "merge", "--quiet", "--no-edit", "feature"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.head = self.commit(
            "change JavaScript only", {"apps/mobile/lib/other.ts": "export const other = 2;\n"}
        )
        self.off_history = None

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.path), *args], text=True).strip()

    def commit(self, message, files):
        for rel_path, content in files.items():
            target = self.path / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        self.git("add", "-A")
        self.git("commit", "--quiet", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")


class OtaBaseTestCase(unittest.TestCase):
    def build_repository(self, **kwargs):
        directory = pathlib.Path(tempfile.mkdtemp(prefix="ota-base-test-"))
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        scripts = directory / ".github" / "scripts"
        scripts.mkdir(parents=True)
        for script in (OTA_BASE, OTA_CLASSIFY, DEPENDENCY_TREE):
            # A checkout whose step classifies inline carries no classifier script.
            if script.exists():
                shutil.copy(script, scripts / script.name)
        self.repo = FixtureRepository(directory, **kwargs)
        self.scripts = scripts
        return directory

    def decide(self, response, env=None):
        return subprocess.check_output(
            ["bash", str(self.scripts / "ota-base.sh"), response],
            cwd=self.repo.path,
            env=dict(os.environ, **env) if env else None,
            stdin=subprocess.DEVNULL,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()

    def diff_files(self, base, head):
        return subprocess.check_output(
            ["git", "-C", str(self.repo.path), "diff", "--name-only", "--no-renames", base, head],
            text=True,
        ).splitlines()


class OtaBaseDecisionTests(OtaBaseTestCase):
    def setUp(self):
        self.build_repository()

    def test_no_published_update_diffs_from_the_version_bump(self):
        # A native change from an earlier push must not escape the diff (fork #234):
        # no update for the runtime, only older-runtime updates, or none at all.
        for response in (
            NO_UPDATES,
            updates_response(),
            updates_response(update(self.repo.off_history, OLD_RUNTIME)),
        ):
            with self.subTest(response=response):
                self.assertEqual(self.decide(response), self.repo.bump)
        self.assertIn(SWIFT_FILE, self.diff_files(self.repo.bump, self.repo.head))
        self.assertNotIn(SWIFT_FILE, self.diff_files(self.repo.native, self.repo.head))

    def test_published_update_on_history_anchors_the_diff(self):
        self.assertEqual(
            self.decide(updates_response(update(self.repo.native, RUNTIME))), self.repo.native
        )
        self.assertEqual(
            self.decide(updates_response(update(self.repo.bump, RUNTIME))), self.repo.bump
        )
        self.assertEqual(self.diff_files(self.repo.native, self.repo.head), ["apps/mobile/lib/other.ts"])

    def test_published_commit_off_history_diffs_from_the_version_bump(self):
        self.assertEqual(
            self.decide(updates_response(update(self.repo.off_history, RUNTIME))), self.repo.bump
        )
        self.assertIn(SWIFT_FILE, self.diff_files(self.repo.bump, self.repo.head))

    def test_merged_native_change_diffs_from_mains_adoption(self):
        # A path-filtered log simplifies the merge into the branch and hides main's
        # adoption; the base must still be the commit main shipped binaries from.
        self.build_repository(merged_native=True)
        self.assertEqual(self.decide(NO_UPDATES), self.repo.bump)
        self.assertIn(SWIFT_FILE, self.diff_files(self.repo.bump, self.repo.head))
        self.assertNotIn(SWIFT_FILE, self.diff_files(self.repo.native, self.repo.head))

    def test_unusable_lookup_reports_unknown(self):
        for response in (
            "",
            "not json",
            "null",
            json.dumps({}),
            json.dumps({"status": "ok"}),
            json.dumps({"errors": [{"message": "Expo is down"}]}),
            updates_response(update("0" * 40, RUNTIME)),
        ):
            with self.subTest(response=response):
                self.assertEqual(self.decide(response), "unknown")

    def test_an_empty_body_stays_unknown_even_where_jq_exits_zero(self):
        # Some CI images run a jq that reads an empty body as no input and exits 0,
        # which must not turn an unreachable Expo into "no published update".
        shim = pathlib.Path(tempfile.mkdtemp(prefix="ota-base-jq-"))
        self.addCleanup(shutil.rmtree, shim, ignore_errors=True)
        jq = shutil.which("jq")
        (shim / "jq").write_text(
            "#!/usr/bin/env bash\n"
            "for arg in \"$@\"; do\n"
            f'  if [[ "$arg" != -* && -f "$arg" ]]; then exec "{jq}" "$@"; fi\n'
            "done\n"
            'input="$(cat)"\n'
            'if [[ -z "$input" ]]; then exit 0; fi\n'
            f'printf \'%s\' "$input" | "{jq}" "$@"\n'
        )
        (shim / "jq").chmod(0o755)
        self.assertEqual(
            self.decide("", env={"PATH": f"{shim}:{os.environ['PATH']}"}), "unknown"
        )

    def test_rollback_update_is_not_a_published_update(self):
        self.assertEqual(
            self.decide(updates_response(update(self.repo.native, RUNTIME, rollback=True))),
            self.repo.bump,
        )

    def test_version_that_returned_keeps_the_older_anchor(self):
        # Builds from before an intermediate bump still lack the native change.
        self.repo.commit("bump past the runtime", {"apps/mobile/app.json": app_json("1.0.13")})
        self.repo.commit("return to the runtime", {"apps/mobile/app.json": app_json(RUNTIME)})
        head = self.repo.commit(
            "change JavaScript only again", {"apps/mobile/lib/more.ts": "export const more = 4;\n"}
        )
        self.assertEqual(self.decide(NO_UPDATES), self.repo.bump)
        self.assertIn(SWIFT_FILE, self.diff_files(self.repo.bump, head))

    def test_first_update_publishes_when_only_javascript_followed_the_bump(self):
        self.build_repository(lockfile=False, native_change=False)
        self.assertEqual(self.decide(NO_UPDATES), self.repo.bump)
        self.assertNotIn(SWIFT_FILE, self.diff_files(self.repo.bump, self.repo.head))

    def test_shallow_history_has_no_safe_base(self):
        shallow = pathlib.Path(tempfile.mkdtemp(prefix="ota-base-shallow-"))
        self.addCleanup(shutil.rmtree, shallow, ignore_errors=True)
        subprocess.check_call(
            ["git", "clone", "--quiet", "--depth", "2", f"file://{self.repo.path}", str(shallow)]
        )
        decision = subprocess.check_output(
            ["bash", str(shallow / ".github" / "scripts" / "ota-base.sh"), NO_UPDATES],
            cwd=shallow,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        self.assertEqual(decision, "no-base")


class OtaBaseStepTests(OtaBaseTestCase):
    """Run the workflow's own OTA step against the fixture, with a stubbed Expo API."""

    def setUp(self):
        self.build_repository(lockfile=True)

    def ota_step_script(self):
        lines = WORKFLOW.read_text().splitlines()
        step = "      - name: Check whether the change is safe for OTA"
        try:
            start = lines.index(step)
            run = lines.index("        run: |", start)
        except ValueError:
            raise AssertionError("ci.yml no longer carries the OTA step as expected") from None
        body = []
        for line in lines[run + 1 :]:
            if line.strip() == "":
                body.append("")
            elif line.startswith("          "):
                body.append(line[10:])
            else:
                break
        script = "\n".join(body)
        if not script.lstrip().startswith("set -euo pipefail"):
            raise AssertionError("the OTA step run block did not extract cleanly")
        return script

    def run_step(self, response, transport_failure=False):
        """Run the extracted step and return its publish line and step summary."""
        stub = pathlib.Path(tempfile.mkdtemp(prefix="ota-base-curl-"))
        self.addCleanup(shutil.rmtree, stub, ignore_errors=True)
        response_file = stub / "response"
        response_file.write_text(response)
        (stub / "curl").write_text(
            "#!/usr/bin/env bash\n"
            '[[ -n "${OTA_CURL_FAIL:-}" ]] && exit 1\n'
            'cat "${OTA_CURL_RESPONSE_FILE:?}"\n'
        )
        (stub / "curl").chmod(0o755)
        env = dict(
            os.environ,
            PATH=f"{stub}:{os.environ['PATH']}",
            OTA_CURL_RESPONSE_FILE=str(response_file),
            EXPO_TOKEN="test-token",
            GITHUB_SHA=self.repo.head,
            GITHUB_STEP_SUMMARY=str(stub / "summary"),
            GITHUB_OUTPUT=str(stub / "output"),
        )
        if transport_failure:
            env["OTA_CURL_FAIL"] = "1"
        subprocess.run(
            ["bash", "-c", self.ota_step_script()],
            cwd=self.repo.path,
            env=env,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        publish = (stub / "output").read_text().strip()
        self.assertIn(publish, ("publish=true", "publish=false"))
        return publish, (stub / "summary").read_text()

    def test_blocks_when_no_update_was_published_for_the_runtime(self):
        publish, summary = self.run_step(NO_UPDATES)
        self.assertEqual(publish, "publish=false")
        self.assertIn(SWIFT_FILE, summary)

    def test_blocks_when_updates_exist_only_for_older_runtimes(self):
        publish, summary = self.run_step(
            updates_response(update(self.repo.off_history, OLD_RUNTIME))
        )
        self.assertEqual(publish, "publish=false")
        self.assertIn(SWIFT_FILE, summary)

    def test_blocks_when_the_published_commit_is_off_history(self):
        publish, summary = self.run_step(updates_response(update(self.repo.off_history, RUNTIME)))
        self.assertEqual(publish, "publish=false")
        self.assertIn(SWIFT_FILE, summary)

    def test_blocks_when_the_published_object_is_missing(self):
        publish, summary = self.run_step(updates_response(update("0" * 40, RUNTIME)))
        self.assertEqual(publish, "publish=false")
        self.assertIn("Could not determine the last published update", summary)

    def test_blocks_when_the_native_change_arrived_through_a_merge(self):
        self.build_repository(lockfile=True, merged_native=True)
        publish, summary = self.run_step(NO_UPDATES)
        self.assertEqual(publish, "publish=false")
        self.assertIn(SWIFT_FILE, summary)

    def test_blocks_when_expo_is_unreachable(self):
        publish, summary = self.run_step("", transport_failure=True)
        self.assertEqual(publish, "publish=false")
        self.assertIn("Could not determine the last published update", summary)

    def test_publishes_a_javascript_only_change_after_a_published_update(self):
        publish, _ = self.run_step(updates_response(update(self.repo.native, RUNTIME)))
        self.assertEqual(publish, "publish=true")

    def test_publishes_a_change_to_the_bundle_entry(self):
        # apps/mobile/index.ts is the entry the manifest's "main" names; a change
        # to it alone must not block every later update for the runtime.
        self.build_repository(lockfile=True, entry_change=True)
        publish, _ = self.run_step(updates_response(update(self.repo.native, RUNTIME)))
        self.assertEqual(publish, "publish=true")

    def test_publishes_the_first_update_when_only_javascript_followed_the_bump(self):
        self.build_repository(lockfile=True, native_change=False)
        publish, _ = self.run_step(NO_UPDATES)
        self.assertEqual(publish, "publish=true")


if __name__ == "__main__":
    unittest.main()
