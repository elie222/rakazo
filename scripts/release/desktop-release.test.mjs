import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkNewerThanPublished,
  checkReleaseTag,
  releaseNotes,
  releasePlatforms,
} from "./desktop-release.mjs";

const script = fileURLToPath(new URL("./desktop-release.mjs", import.meta.url));

test("a release runs from a stable tag that names the desktop version", () => {
  checkReleaseTag({ refType: "tag", tag: "v1.2.3", version: "1.2.3" });
  assert.throws(
    () => checkReleaseTag({ refType: "branch", tag: "main", version: "1.2.3" }),
    /must run from a tag/,
  );
  for (const tag of ["v1.2", "1.2.3", "v1.2.3-beta.1", "v1.2.3\nv1.2.4"]) {
    assert.throws(
      () => checkReleaseTag({ refType: "tag", tag, version: "1.2.3" }),
      /stable vMAJOR\.MINOR\.PATCH/,
    );
  }
  assert.throws(
    () => checkReleaseTag({ refType: "tag", tag: "v1.2.4", version: "1.2.3" }),
    /^Error: Tag v1\.2\.4 does not match desktop version 1\.2\.3\.$/,
  );
});

test("a release must be newer than every published stable release", () => {
  checkNewerThanPublished("v1.0.0", []);
  checkNewerThanPublished("v1.0.0", ["", "android"]);
  checkNewerThanPublished("v1.10.0", ["v1.9.0", "v1.2.0", "android", "v2.0.0-beta.1"]);
  assert.throws(
    () => checkNewerThanPublished("v1.9.9", ["v1.9.0", "v1.10.0"]),
    /^Error: v1\.9\.9 must be newer than published release v1\.10\.0\.$/,
  );
  checkNewerThanPublished("v1.0.9007199254740993", ["v1.0.9007199254740992"]);
  assert.throws(
    () => checkNewerThanPublished("v1.0.9007199254740992", ["v1.0.9007199254740993"]),
    /newer than published release v1\.0\.9007199254740993/,
  );
  assert.throws(
    () => checkNewerThanPublished("v1.2.3", ["v1.2.3"]),
    /newer than published release v1\.2\.3/,
  );
});

test("platforms build every desktop target unless the release is macOS only", () => {
  const all =
    '[{"os":"macos-26","artifact":"macos"},{"os":"ubuntu-24.04","artifact":"linux"},{"os":"windows-2022","artifact":"windows"}]';
  assert.equal(JSON.stringify(releasePlatforms("")), all);
  assert.equal(JSON.stringify(releasePlatforms("false")), all);
  assert.equal(JSON.stringify(releasePlatforms("true")), '[{"os":"macos-26","artifact":"macos"}]');
  assert.throws(() => releasePlatforms("yes"), /must be true or false/);
});

test("release notes are the version's changelog section without its heading", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [1.3.0] - 2026-11-20",
    "",
    "- Newer.",
    "## [1.2.0] - 2026-11-01",
    "",
    "### Added",
    "- A thing.",
    "",
    "## [1.1.0] - 2026-10-01",
    "- Older.",
    "",
  ].join("\n");
  assert.equal(releaseNotes(changelog, "1.2.0"), "\n### Added\n- A thing.\n\n");
  assert.equal(releaseNotes(changelog, "1.1.0"), "- Older.\n");
  assert.equal(
    releaseNotes("## [1.1.0] - today\n- No final newline.", "1.1.0"),
    "- No final newline.\n",
  );
  assert.equal(releaseNotes(changelog, "9.9.9"), "");
  assert.equal(releaseNotes("Text ## [1.2.0] - mid-line\n- Not a heading.\n", "1.2.0"), "");
});

test("the command line reports failures on stderr with a failing exit code", (t) => {
  assert.equal(
    execFileSync("node", [script, "platforms", "true"], { encoding: "utf8" }),
    '[{"os":"macos-26","artifact":"macos"}]\n',
  );
  const dir = mkdtempSync(path.join(tmpdir(), "desktop-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const published = path.join(dir, "published.txt");
  writeFileSync(published, "v1.0.0\nv2.0.0\n");
  assert.throws(
    () =>
      execFileSync("bash", ["-c", `node "${script}" check-newer v1.5.0 < "${published}"`], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error) =>
      error.status === 1 &&
      error.stderr === "v1.5.0 must be newer than published release v2.0.0.\n",
  );
});
