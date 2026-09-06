import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-backup-"));
  temporaryDirectories.push(root);
  const checkout = path.join(root, "checkout with spaces");
  const snapshots = path.join(root, "snapshots");
  const bin = path.join(root, "bin");
  for (const script of [
    "scripts/backup.sh",
    "scripts/restore.sh",
    "infra/compose/backup-prod.sh",
  ]) {
    let source = readFileSync(path.join(repoRoot, script), "utf8");
    if (script.endsWith("backup-prod.sh")) {
      // Relocate only the fixed output directory: never write to real host backups.
      expect(source).toContain('BACKUP_ROOT="/var/backups/rakazo"');
      source = source.replace('BACKUP_ROOT="/var/backups/rakazo"', `BACKUP_ROOT="${snapshots}"`);
    }
    write(path.join(checkout, script), source);
  }
  write(path.join(checkout, ".env"), "EXAMPLE_SETTING=fake-value\n");
  write(path.join(root, "appdata/home.txt"), "example bot home");
  const docker = path.join(bin, "docker");
  write(
    docker,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "inspect") {
  console.log(process.env.FAKE_APPDATA);
} else if (args[0] !== "compose") {
  process.exit(90);
} else if (args.includes("pg_dump")) {
  if (process.env.FAIL_DUMP === "1") process.exit(2);
  console.log("CREATE TABLE example (id integer);");
} else if (args.includes("sh")) {
  if (!args.at(-1).startsWith("pg_dump ")) process.exit(91);
  if (process.env.FAIL_DUMP === "1") process.exit(2);
  console.log("fake custom-format dump");
} else if (args.includes("psql")) {
  fs.writeFileSync(process.env.SQL_INPUT, fs.readFileSync(0));
  if (process.env.FAIL_SQL === "1") {
    console.error("ERROR: relation example already exists");
    // psql normally exits successfully after SQL errors unless explicitly told to stop.
    process.exit(args.includes("--set=ON_ERROR_STOP=on") ? 3 : 0);
  }
} else if (args.includes("pg_restore")) {
  fs.readFileSync(0);
  if (process.env.FAIL_VERIFY === "1") process.exit(1);
} else if (args.includes("ps")) {
  console.log("example-api-container");
} else if (!args.includes("up") && !args.includes("pg_isready")) {
  process.exit(92);
}
`,
  );
  chmodSync(docker, 0o755);
  const tar = path.join(bin, "tar");
  write(
    tar,
    `#!/bin/bash
set -eu
if [[ "$1" == "-czf" && "$*" == *" -C "* && -n "\${FAIL_TAR:-}" ]]; then
  echo "simulated archive read failure" >&2
  exit "$FAIL_TAR"
fi
/usr/bin/tar "$@"
if [[ "$1" == "-czf" && "\${CHANGED_TAR:-0}" == "1" ]]; then
  echo "file changed as we read it" >&2
  exit 1
fi
`,
  );
  chmodSync(tar, 0o755);
  const checksum = path.join(bin, "sha256sum");
  write(
    checksum,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const crypto = require("node:crypto");
for (const file of process.argv.slice(2)) {
  console.log(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") + "  " + file);
}
`,
  );
  chmodSync(checksum, 0o755);
  // No inherited deployment settings, credentials, or executable search paths.
  const env = {
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    COMMAND_LOG: path.join(root, "commands.jsonl"),
    SQL_INPUT: path.join(root, "input.sql"),
    FAKE_APPDATA: path.join(root, "appdata"),
  };
  return {
    root,
    checkout,
    snapshots,
    env,
    run(script: string, args: string[] = [], overrides: Record<string, string> = {}) {
      const result = spawnSync("/bin/bash", [path.join(checkout, script), ...args], {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      return result;
    },
    commands(): string[][] {
      if (!existsSync(env.COMMAND_LOG)) return [];
      return readFileSync(env.COMMAND_LOG, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

function contents(archive: string) {
  return execFileSync("/usr/bin/tar", ["-tzf", archive], { encoding: "utf8" });
}

describe("development backup failures", () => {
  it.each([false, true])("archives data with a root env file present: %s", (hasEnv) => {
    const f = fixture();
    if (!hasEnv) rmSync(path.join(f.checkout, ".env"));
    write(path.join(f.checkout, "data/home.txt"), "example home");
    expect(f.run("scripts/backup.sh", ["example"]).status).toBe(0);
    const output = path.join(f.checkout, "backups/example");
    expect(readFileSync(path.join(output, "rakazo.sql"), "utf8")).toContain("CREATE TABLE");
    expect(contents(path.join(output, "homes.tgz"))).toContain("data/home.txt");
    expect(f.commands()[0].includes("--env-file")).toBe(hasEnv);
    if (hasEnv) expect(f.commands()[0]).toContain(path.join(f.checkout, ".env"));
  });

  it.each(["absent", "skipped"])("allows an empty archive when data is %s", (scenario) => {
    const f = fixture();
    if (scenario === "skipped") write(path.join(f.checkout, "data/home.txt"), "example home");
    const result = f.run("scripts/backup.sh", ["example"], {
      RAKAZO_BACKUP_SKIP_HOMES: scenario === "skipped" ? "1" : "0",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(contents(path.join(f.checkout, "backups/example/homes.tgz"))).toBe("");
  });

  it.each(["file", "broken link"])("rejects a data path that is a %s", (kind) => {
    const f = fixture();
    const data = path.join(f.checkout, "data");
    if (kind === "file") write(data, "not a directory");
    else symlinkSync(path.join(f.root, "missing"), data);
    const result = f.run("scripts/backup.sh", ["example"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Backup written");
  });

  it.each([1, 2])("propagates tar exit %s without replacing the failed archive", (code) => {
    const f = fixture();
    write(path.join(f.checkout, "data/home.txt"), "example home");
    const result = f.run("scripts/backup.sh", ["example"], { FAIL_TAR: String(code) });
    expect(result.status).toBe(code);
    expect(result.stderr).toContain("simulated archive read failure");
    expect(result.stdout).not.toContain("Backup written");
    expect(existsSync(path.join(f.checkout, "backups/example/homes.tgz"))).toBe(false);
  });

  it("does not archive files or report success after pg_dump fails", () => {
    const f = fixture();
    const result = f.run("scripts/backup.sh", ["example"], { FAIL_DUMP: "1" });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("Backup written");
    expect(existsSync(path.join(f.checkout, "backups/example/homes.tgz"))).toBe(false);
  });
});

describe("development restore failures", () => {
  function restoreFixture() {
    const f = fixture();
    write(path.join(f.checkout, "data/home.txt"), "backed-up home");
    expect(f.run("scripts/backup.sh", ["example"]).status).toBe(0);
    write(path.join(f.checkout, "data/home.txt"), "current home");
    return f;
  }

  it.each([false, true])(
    "restores files and starts services only after SQL succeeds: %s",
    (fail) => {
      const f = restoreFixture();
      const result = f.run("scripts/restore.sh", [path.join(f.checkout, "backups/example")], {
        FAIL_SQL: fail ? "1" : "0",
      });
      expect(result.status).toBe(fail ? 3 : 0);
      const command = f.commands().find((args) => args.includes("psql"));
      expect(command).toEqual(
        expect.arrayContaining([
          "-X",
          "--set=ON_ERROR_STOP=on",
          "--single-transaction",
          "--file=-",
        ]),
      );
      expect(readFileSync(f.env.SQL_INPUT, "utf8")).toContain("CREATE TABLE example");
      expect(readFileSync(path.join(f.checkout, "data/home.txt"), "utf8")).toBe(
        fail ? "current home" : "backed-up home",
      );
      expect(f.commands().some((args) => args.slice(-2).join(" ") === "up -d")).toBe(!fail);
      expect(result.stdout.includes("Restore complete")).toBe(!fail);
      if (fail) expect(result.stderr).toContain("already exists");
    },
  );

  it("fails rather than starting services after an invalid homes archive", () => {
    const f = restoreFixture();
    write(path.join(f.checkout, "backups/example/homes.tgz"), "invalid archive");
    const result = f.run("scripts/restore.sh", [path.join(f.checkout, "backups/example")]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Restore complete");
    expect(f.commands().some((args) => args.slice(-2).join(" ") === "up -d")).toBe(false);
  });
});

describe("production backup deployment and archive behavior", () => {
  it.each([false, true])("uses the configured deployment directory: %s", (custom) => {
    const f = fixture();
    const deployment = custom ? f.checkout : "/srv/rakazo";
    const result = f.run(
      "infra/compose/backup-prod.sh",
      [],
      custom ? { RAKAZO_DEPLOY_DIR: deployment } : {},
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Verified Rakazo backup");
    for (const command of f.commands().filter((args) => args[0] === "compose")) {
      expect(command.slice(0, 5)).toEqual([
        "compose",
        "--env-file",
        path.join(deployment, ".env"),
        "-f",
        path.join(deployment, "infra/compose/docker-compose.prod.yml"),
      ]);
    }
  });

  it("provides optional systemd configuration for installed copies", () => {
    const service = readFileSync(
      path.join(repoRoot, "infra/systemd/rakazo-backup.service"),
      "utf8",
    );
    expect(service).toContain("EnvironmentFile=-/etc/rakazo/backup.env");
  });

  it("rejects relative deployment paths before any backup commands", () => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], { RAKAZO_DEPLOY_DIR: "relative" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("absolute path");
    expect(f.commands()).toEqual([]);
    expect(existsSync(f.snapshots)).toBe(false);
  });

  it("preserves host archiving and the live-file warning allowance from PR #618", () => {
    const f = fixture();
    const result = f.run("infra/compose/backup-prod.sh", [], { CHANGED_TAR: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("file changed as we read it");
    expect(result.stdout).toContain("Verified Rakazo backup");
    const snapshot = result.stdout.trim().split("written to ")[1];
    expect(contents(path.join(snapshot, "appdata.tgz"))).toContain("home.txt");
    expect(existsSync(path.join(snapshot, "SHA256SUMS"))).toBe(true);
    expect(f.commands().some((args) => args[0] === "inspect")).toBe(true);
    expect(f.commands().some((args) => args.includes("tar"))).toBe(false);
  });

  it.each([{ FAIL_TAR: "2" }, { FAIL_DUMP: "1" }, { FAIL_VERIFY: "1" }])(
    "does not report a verified snapshot after failure: %j",
    (failure) => {
      const f = fixture();
      const result = f.run("infra/compose/backup-prod.sh", [], failure);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("Verified Rakazo backup");
    },
  );
});
