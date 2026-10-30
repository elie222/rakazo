import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { run } from "./bot-profile.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url).pathname;
const dirs = [];
async function fixture(value) {
  const dir = await mkdtemp(join(tmpdir(), "bot-profile-"));
  dirs.push(dir);
  const path = join(dir, "profile.json");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

after(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function capture(fn) {
  let output = "";
  const original = { log: console.log, error: console.error };
  const sink = new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
  console.log = (...parts) => sink.write(`${parts.join(" ")}\n`);
  console.error = (...parts) => sink.write(`${parts.join(" ")}\n`);
  try {
    return { result: await fn(), output };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

describe("bot profile CLI", () => {
  it("validates a profile from a temporary JSON fixture", async () => {
    const path = await fixture({});
    assert.equal(await run(["validate", path]), 0);
  });

  it("rejects invalid JSON profile data", async () => {
    const path = await fixture({ unexpected: true });
    assert.equal(await run(["validate", path]), 1);
  });

  it("rejects a diff when either profile fails schema validation", async () => {
    const before = await fixture({});
    const after = await fixture({ unexpected: "do-not-print-this" });
    const { result, output } = await capture(() => run(["diff", before, after]));
    assert.equal(result, 1);
    assert.equal(output.includes("do-not-print-this"), false);
  });

  it("redacts sensitive-looking field values in diff output", async () => {
    const profile = (auth) => ({
      extensions: [{
        extensionId: "demo.extension",
        version: "1",
        digest: `sha256:${"a".repeat(64)}`,
        settings: { auth },
      }],
    });
    const before = await fixture(profile("old-private-value"));
    const after = await fixture(profile("new-private-value"));
    const { result, output } = await capture(() => run(["diff", before, after]));
    assert.equal(result, 0);
    assert.match(output, /settings\.auth: \[REDACTED\] -> \[REDACTED\]/);
    assert.equal(output.includes("private-value"), false);
  });

  it("runs the documented pnpm CLI examples against temporary files", async () => {
    const before = await fixture({});
    const after = await fixture({ schemaVersion: 1 });
    const { stdout: validate } = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/bot-profile.mjs", "validate", before], { cwd: root });
    const { stdout: diffOutput } = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/bot-profile.mjs", "diff", before, after], { cwd: root });
    assert.match(validate, /Profile is valid/);
    assert.match(diffOutput, /No changes/);
  });

  it("reports local field changes", async () => {
    const before = await fixture({ persona: { persona: "" } });
    const after = await fixture({ persona: { persona: "helper" } });
    const { result, output } = await capture(() => run(["diff", before, after]));
    assert.equal(result, 0);
    assert.match(output, /persona\.persona/);
  });

  for (const command of ["get", "update"]) {
    it(`fails closed for remote ${command} without standalone auth`, async () => {
      const marker = "do-not-echo-this-token";
      const { result, output } = await capture(() => run([command, marker]));
      assert.equal(result, 2);
      assert.equal(output.includes(marker), false);
    });
  }
});
