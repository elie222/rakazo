import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Offline checks for the point-in-time recovery scripts. The real-Docker round trip is
 * infra/compose/pitr.docker-test.sh; these cover the decisions and refusals around it.
 */

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const agent = path.join(repoRoot, "infra/compose/pitr-agent.sh");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runAgent(args: string[], input = "", env: Record<string, string> = {}) {
  const result = spawnSync("/bin/bash", [agent, ...args], {
    input,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const DAY = 86_400;
const NOW = 1_800_000_000;

describe("WAL file names", () => {
  it.each([
    ["1", "0/B000028", "16777216", "00000001000000000000000B"],
    ["2", "1/FF000000", "16777216", "0000000200000001000000FF"],
    ["3", "A/1", "16777216", "000000030000000A00000000"],
    ["1", "0/8000000", "67108864", "000000010000000000000002"],
  ])("timeline %s at %s with %s-byte segments is %s", (timeline, lsn, size, name) => {
    expect(runAgent(["wal-name", timeline, lsn, size]).stdout.trim()).toBe(name);
  });
});

describe("retention", () => {
  const base = (stamp: string, startSegment: string, endsDaysAgo: number) =>
    `base ${stamp} 00000001000000000000${startSegment} ${NOW - endsDaysAgo * DAY} 1`;
  const listing = [
    base("20260101T000000Z", "0010", 10),
    base("20260102T000000Z", "0020", 9),
    base("20260103T000000Z", "0030", 8),
    base("20260105T000000Z", "0050", 6),
    base("20260110T000000Z", "0090", 1),
    "partial 20260104T000000Z",
    "partial 20260111T000000Z",
    "wal 00000001000000000000001F.gz.age",
    "wal 00000001000000000000002F.gz.age",
    "wal 000000010000000000000030.gz.age",
    "wal 000000020000000000000031.gz.age",
    "wal 00000002.history.gz.age",
    "wal 000000010000000000000060.gz.age",
  ].join("\n");

  it("keeps every base inside the window plus the one that covers its start", () => {
    const plan = runAgent(["plan-prune", String(NOW), "7"], listing)
      .stdout.trim()
      .split("\n");
    expect(plan).toEqual([
      "purge base/20260101T000000Z",
      "purge base/20260102T000000Z",
      "purge base/20260104T000000Z",
      "delete wal/00000001000000000000001F.gz.age",
      "delete wal/00000001000000000000002F.gz.age",
    ]);
  });

  it("keeps the newest base even when it is older than the window", () => {
    const later = String(NOW + 30 * DAY);
    const plan = runAgent(["plan-prune", later, "7"], listing).stdout.trim().split("\n");
    expect(plan).toContain("purge base/20260105T000000Z");
    expect(plan).not.toContain("purge base/20260110T000000Z");
    expect(plan).toContain("delete wal/000000010000000000000060.gz.age");
    expect(plan).not.toContain("delete wal/00000002.history.gz.age");
    // The base still being uploaded is newer than every finished one.
    expect(plan).not.toContain("purge base/20260111T000000Z");
  });

  it("keeps WAL a newer timeline's lower-starting base needs", () => {
    // After a restore rewinds the database, a newer base can start below an older one.
    const rewound = [
      base("20260108T000000Z", "0100", 2),
      `base 20260109T000000Z 000000020000000000000020 ${NOW - DAY} 2`,
      "wal 000000010000000000000010.gz.age",
      "wal 000000020000000000000030.gz.age",
      "wal 000000010000000000000100.gz.age",
    ].join("\n");
    expect(runAgent(["plan-prune", String(NOW), "7"], rewound).stdout.trim()).toBe(
      "delete wal/000000010000000000000010.gz.age",
    );
  });

  it("deletes nothing before a base backup has finished", () => {
    const unfinished = "partial 20260111T000000Z\nwal 000000010000000000000001.gz.age";
    expect(runAgent(["plan-prune", String(NOW), "7"], unfinished)).toMatchObject({
      status: 0,
      stdout: "",
    });
  });
});

describe("choosing a base backup to restore", () => {
  const bases = [
    `base 20260101T000000Z 000000010000000000000010 ${NOW - 2 * DAY} 1`,
    `base 20260102T000000Z 000000010000000000000020 ${NOW - DAY} 1`,
    "partial 20260103T000000Z",
  ].join("\n");

  it("uses the newest base that finished before the target", () => {
    expect(runAgent(["plan-restore", String(NOW - DAY - 1)], bases).stdout.trim()).toBe(
      "20260101T000000Z 000000010000000000000010 1",
    );
    expect(runAgent(["plan-restore", String(NOW)], bases).stdout.trim()).toBe(
      "20260102T000000Z 000000010000000000000020 1",
    );
    expect(runAgent(["plan-restore", "latest"], bases).stdout.trim()).toBe(
      "20260102T000000Z 000000010000000000000020 1",
    );
  });

  it("finds none for a target before the first base finished", () => {
    expect(runAgent(["plan-restore", String(NOW - 3 * DAY)], bases)).toMatchObject({
      status: 1,
      stdout: "",
    });
  });
});

describe("base backup markers from the bucket", () => {
  it("ignores a marker whose fields could reach shell arithmetic", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-pitr-markers-"));
    temporaryDirectories.push(root);
    const witness = path.join(root, "evaluated");
    write(
      path.join(root, "bin/rclone"),
      `#!/bin/bash
case "$1 $2" in
  "lsf -R") printf '%s\\n' 20260101T000000Z/COMPLETE 20260102T000000Z/COMPLETE ;;
  cat*) if [[ "$2" == *20260101T000000Z* ]]; then
      printf 'start_wal=000000010000000000000010\\nend_time=a[$(touch ${witness})]\\ntimeline=1\\n'
    else
      printf 'start_wal=000000010000000000000020\\nend_time=1800000000\\ntimeline=1\\n'
    fi ;;
esac
`,
    );
    chmodSync(path.join(root, "bin/rclone"), 0o755);
    const result = runAgent(["list-bases", "123"], "", {
      PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
      PITR_BUCKET: "rakazo-pitr",
      PITR_ACCESS_KEY_ID: "fake-access-key",
      PITR_SECRET_ACCESS_KEY: "fake-secret-key",
    });
    expect(result.stdout.trim()).toBe(
      "base 20260102T000000Z 000000010000000000000020 1800000000 1",
    );
    expect(result.stderr).toContain("Ignoring base backup 20260101T000000Z");
    const restore = runAgent(["plan-restore", "1900000000"], result.stdout);
    expect(restore.stdout.trim()).toBe("20260102T000000Z 000000010000000000000020 1");
    expect(existsSync(witness)).toBe(false);
  });
});

describe("sidecar configuration", () => {
  const storage = {
    PITR_BUCKET: "rakazo-pitr",
    PITR_ACCESS_KEY_ID: "fake-access-key",
    PITR_SECRET_ACCESS_KEY: "fake-secret-key",
  };

  it.each([
    [{ PITR_BUCKET: "" }, "Set PITR_BUCKET"],
    [{ PITR_BUCKET: "Not_A_Bucket" }, "PITR_BUCKET is not a valid bucket name"],
    [{ PITR_PREFIX: "backups/../other" }, "PITR_PREFIX may only hold"],
    [{ PITR_PATH_STYLE: "yes" }, "PITR_PATH_STYLE must be true or false"],
    [{ PITR_ENDPOINT: "s3.example.com" }, "PITR_ENDPOINT must be an http(s) URL"],
    [{ PITR_SECRET_ACCESS_KEY: "" }, "Set PITR_SECRET_ACCESS_KEY"],
    [{ PITR_RETAIN_DAYS: "a week" }, "PITR_RETAIN_DAYS must be a whole number"],
    [{ PITR_MAX_WAL_GB: "0" }, "PITR_MAX_WAL_GB must be a positive whole number"],
    [{}, "Set PITR_AGE_RECIPIENTS"],
  ])("refuses to start with %o", (override, message) => {
    const result = runAgent(["run"], "", { ...storage, ...override });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A checkout with pitr.sh, a .env, and a docker stand-in that records what it was asked. */
function checkout(env: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-pitr-"));
  temporaryDirectories.push(root);
  const dir = path.join(root, "checkout");
  for (const file of ["pitr.sh", "Dockerfile.pitr", "pitr-agent.sh"]) {
    write(
      path.join(dir, "infra/compose", file),
      readFileSync(path.join(repoRoot, "infra/compose", file), "utf8"),
    );
  }
  write(path.join(dir, ".env"), env);
  const log = path.join(root, "docker.jsonl");
  const docker = path.join(root, "bin/docker");
  write(
    docker,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = args.includes("-T") || args.includes("-i") ? fs.readFileSync(0, "utf8") : "";
const secret = process.env.PITR_SECRET_ACCESS_KEY ?? null;
fs.appendFileSync(process.env.DOCKER_LOG, JSON.stringify({ args, stdin, secret }) + "\\n");
if (args[0] === "ps") console.log(process.env.VOLUME_IN_USE ?? "");
if (args[0] === "build") console.log("sha256:fake-image");
`,
  );
  chmodSync(docker, 0o755);
  const run = (args: string[], input = "", extra: Record<string, string> = {}) => {
    const result = spawnSync("/bin/bash", [path.join(dir, "infra/compose/pitr.sh"), ...args], {
      input,
      encoding: "utf8",
      env: {
        PATH: [path.dirname(docker), path.dirname(process.execPath), "/usr/bin", "/bin"].join(
          path.delimiter,
        ),
        DOCKER_LOG: log,
        ...extra,
      },
    });
    let calls: { args: string[]; stdin: string; secret: string | null }[] = [];
    try {
      calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {}
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, calls };
  };
  return { run, dir };
}

const PASSWORD = "0123456789abcdef0123456789abcdef";
const SETTINGS = [
  `PITR_DATABASE_PASSWORD=${PASSWORD}`,
  "PITR_BUCKET=rakazo-pitr",
  "PITR_ACCESS_KEY_ID=fake-access-key",
  "PITR_SECRET_ACCESS_KEY=fake-secret-key",
  "PITR_AGE_RECIPIENTS=age1examplerecipient",
].join("\n");

describe("pitr.sh enable", () => {
  it.each([
    ["", "Set PITR_DATABASE_PASSWORD"],
    [SETTINGS.replace(PASSWORD, "short"), "Set PITR_DATABASE_PASSWORD"],
    [SETTINGS.replace("PITR_BUCKET=rakazo-pitr", ""), "Set PITR_BUCKET in .env"],
    [`${SETTINGS}\nPITR_MAX_WAL_GB=lots\nCOMPOSE_PROFILES=pitr`, "PITR_MAX_WAL_GB must be"],
    [SETTINGS, "Add pitr to COMPOSE_PROFILES"],
    [`${SETTINGS}\nCOMPOSE_PROFILES=updater`, "Add pitr to COMPOSE_PROFILES"],
  ])("refuses before touching Postgres (%#)", (env, message) => {
    const result = checkout(env).run(["enable"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.calls).toEqual([]);
  });

  it("configures Postgres by reload and starts the sidecar", () => {
    const env = `${SETTINGS.replace(PASSWORD, `"${PASSWORD}"`)}\nPITR_MAX_WAL_GB=10\nCOMPOSE_PROFILES=updater,pitr\n`;
    const result = checkout(env).run(["enable"]);
    expect(result.status).toBe(0);
    const commands = result.calls.map((call) => call.args.slice(5).join(" "));
    expect(commands[0]).toBe("up -d --wait postgres");
    expect(commands[1]).toContain("exec -T -u postgres postgres sh -c");
    expect(result.calls[1]?.args.at(-1)).toBe("host replication rakazo_pitr all scram-sha-256");
    expect(result.calls[1]?.args.at(-2)).toBe("add");
    const sql = result.calls[2]?.stdin ?? "";
    expect(sql).toContain(
      `ALTER ROLE rakazo_pitr WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${PASSWORD}'`,
    );
    expect(sql).toContain("ALTER SYSTEM SET archive_timeout = '60s'");
    expect(sql).toContain("ALTER SYSTEM SET max_slot_wal_keep_size = '10GB'");
    expect(sql).toContain("SELECT pg_reload_conf()");
    expect(commands[3]).toBe("up -d --wait pitr");
    // The password reaches psql on stdin only.
    for (const call of result.calls) expect(call.args.join(" ")).not.toContain(PASSWORD);
  });
});

describe("pitr.sh disable", () => {
  it("refuses while deploys would still start the sidecar", () => {
    const result = checkout(`${SETTINGS}\nCOMPOSE_PROFILES=pitr`).run(["disable"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Remove pitr from COMPOSE_PROFILES");
    expect(result.calls).toEqual([]);
  });

  it("stops the sidecar before dropping its slot", () => {
    const result = checkout(SETTINGS).run(["disable"]);
    expect(result.status).toBe(0);
    expect(result.calls[0]?.args.slice(5)).toEqual([
      "--profile",
      "pitr",
      "rm",
      "--stop",
      "--force",
      "pitr",
    ]);
    const sql = result.calls[1]?.stdin ?? "";
    expect(sql).toContain("pg_drop_replication_slot");
    expect(sql).toContain("DROP ROLE IF EXISTS rakazo_pitr");
    expect(sql).toContain("ALTER SYSTEM RESET archive_timeout");
    expect(result.calls[2]?.args.at(-2)).toBe("remove");
  });
});

describe("pitr.sh restore", () => {
  it("refuses a volume a running container still uses", () => {
    const result = checkout(SETTINGS).run(["restore", "latest", "rakazo-prod_postgres"], "", {
      VOLUME_IN_USE: "fake-container",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A running container uses rakazo-prod_postgres");
    expect(result.calls.map((call) => call.args[0])).toEqual(["ps"]);
  });

  it("passes the identity on stdin and secrets by name only", () => {
    const identity = "AGE-SECRET-KEY-1FAKEIDENTITY";
    const result = checkout(SETTINGS).run(
      ["restore", "2026-10-28 09:00:00+00", "restored"],
      identity,
    );
    expect(result.status).toBe(0);
    const run = result.calls.find((call) => call.args[0] === "run");
    expect(run?.stdin).toBe(identity);
    expect(run?.secret).toBe("fake-secret-key");
    expect(run?.args).toContain("PITR_SECRET_ACCESS_KEY");
    expect(run?.args.join(" ")).not.toContain("fake-secret-key");
    expect(run?.args).toContain("restored:/var/lib/postgresql");
    expect(run?.args.slice(-2)).toEqual(["restore", "2026-10-28 09:00:00+00"]);
  });
});
