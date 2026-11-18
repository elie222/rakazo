import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("repository ignore rules leave tracked mobile files available for Expo uploads", () => {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "apps/mobile"], { cwd: root });
  const result = spawnSync("git", ["check-ignore", "--no-index", "--verbose", "-z", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: tracked,
  });
  if (result.error) throw result.error;
  assert.ok(result.status === 0 || result.status === 1, result.stderr);

  const fields = result.stdout.split("\0");
  const excluded = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [source, , pattern, file] = fields.slice(index, index + 4);
    if ((source === ".gitignore" || source.endsWith("/.gitignore")) && !pattern.startsWith("!")) {
      excluded.push(`${file} (${source}: ${pattern})`);
    }
  }
  assert.deepEqual(excluded, [], "Keep tracked mobile files out of repository ignore patterns.");
});
