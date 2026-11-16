// Code kept only so the previous release keeps working during a deploy carries
// `compat-shim(after vX.Y.Z)`, naming the latest release when it was added. It ships in the next
// release, so once a second release follows that one nothing running still needs it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SELF = "scripts/checks/compat-shims.test.mjs";
const SCANNED = /\.(?:[cm]?[jt]sx?|sql|prisma|sh|ya?ml|py|kt|swift)$/;
const MARKER = /compat-shim\(after v(\d+\.\d+\.\d+)\)/g;
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\]/gm;
const RELEASES_UNTIL_DUE = 2;

const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** Tracked files containing `text`; `git grep` exits 1 when there are none. */
function gitGrep(text) {
  try {
    return execFileSync("git", ["grep", "-lzF", text], { cwd: root, encoding: "utf8" });
  } catch (error) {
    if (error.status === 1) return "";
    throw error;
  }
}

function releasedVersions(changelog) {
  return [...changelog.matchAll(RELEASE_HEADING)].map((match) => match[1]);
}

function shimProblems(file, text, released) {
  return text.split("\n").flatMap((line, index) =>
    [...line.matchAll(MARKER)].flatMap(([, version]) => {
      const where = `${file}:${index + 1}`;
      if (!released.includes(version))
        return [`${where} names v${version}, which is not a release in CHANGELOG.md`];
      const newer = released.filter((other) => compareVersions(other, version) > 0);
      if (newer.length < RELEASES_UNTIL_DUE) return [];
      return [
        `${where} keeps upgrades from v${version} working, but v${newer[0]} has shipped since: remove the shim`,
      ];
    }),
  );
}

test("compatibility shims are removed once nothing running needs them", () => {
  const released = releasedVersions(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
  assert.ok(released.length > 0, "CHANGELOG.md lists no releases");
  const files = gitGrep("compat-shim(after")
    .split("\0")
    .filter((file) => SCANNED.test(file) && file !== SELF);
  const problems = files.flatMap((file) =>
    shimProblems(file, readFileSync(path.join(root, file), "utf8"), released),
  );
  assert.deepEqual(problems, []);
});

test("a shim is due once two releases follow the one it names", () => {
  const released = releasedVersions(
    "## [Unreleased]\n## [0.12.0] - x\n## [0.11.1] - x\n## [0.11.0] - x\n",
  );
  assert.deepEqual(released, ["0.12.0", "0.11.1", "0.11.0"]);
  const text = [
    "// compat-shim(after v0.12.0): fine",
    "// compat-shim(after v0.11.1): fine",
    "// compat-shim(after v0.11.0): due",
    "// compat-shim(after v0.9.9): unknown",
  ].join("\n");
  assert.deepEqual(shimProblems("a.ts", text, released), [
    "a.ts:3 keeps upgrades from v0.11.0 working, but v0.12.0 has shipped since: remove the shim",
    "a.ts:4 names v0.9.9, which is not a release in CHANGELOG.md",
  ]);
});
