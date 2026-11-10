import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { composeBaseArgs, postgresUp } from "./compose-stack.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// The suite dumps and restores the developer's running local stack database; run it only with
// explicit opt-in (VERIFY_COMPOSE_BACKUP=1). With the opt-in set, an unreachable stack fails the
// suite instead of skipping it: a silent skip reads as a verified backup.
const describeBackup = process.env.VERIFY_COMPOSE_BACKUP === "1" ? describe : describe.skip;

/** Runs `docker compose` against the repo's stack, with the root env file applied (see above). */
function compose(args: string[], options?: Parameters<typeof execFileSync>[2]) {
  return execFileSync("docker", [...composeBaseArgs(repoRoot), ...args], options);
}

describeBackup("compose backup and restore", () => {
  beforeAll(() => {
    if (!postgresUp(repoRoot)) {
      throw new Error(
        "VERIFY_COMPOSE_BACKUP=1 but the local compose stack is not reachable; start it with pnpm compose:up",
      );
    }
  });

  it("dumps postgres and restores into a side database", () => {
    expect(existsSync(path.join(repoRoot, "scripts/backup.sh"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "scripts/restore.sh"))).toBe(true);
    const stamp = `verify-${Date.now()}`;
    execSync(`${path.join(repoRoot, "scripts/backup.sh")} ${stamp}`, {
      stdio: "pipe",
      timeout: 60_000,
      env: { ...process.env, RAKAZO_BACKUP_SKIP_HOMES: "1" },
    });
    const dump = path.join(repoRoot, "backups", stamp, "rakazo.sql");
    expect(existsSync(dump)).toBe(true);
    const sql = readFileSync(dump, "utf8");
    expect(sql).toMatch(/CREATE TABLE|CREATE TABLE IF NOT EXISTS/i);
    expect(sql.toLowerCase()).toContain("bots");
    expect(sql).not.toMatch(/OPENROUTER_API_KEY|sk-or-v1-/);

    const psql = (sqlArgs: string[]) => [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "rakazo",
      ...sqlArgs,
    ];
    compose(psql(["-d", "postgres", "-c", "DROP DATABASE IF EXISTS rakazo_restore_test"]), {
      stdio: "pipe",
      timeout: 20_000,
    });
    compose(psql(["-d", "postgres", "-c", "CREATE DATABASE rakazo_restore_test"]), {
      stdio: "pipe",
      timeout: 20_000,
    });
    compose(psql(["-d", "rakazo_restore_test"]), {
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000,
    });
    const tables = compose(psql(["-d", "rakazo_restore_test", "-c", "\\dt"]), {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(tables).toMatch(/bots/);
    compose(psql(["-d", "postgres", "-c", "DROP DATABASE rakazo_restore_test"]), {
      stdio: "pipe",
      timeout: 20_000,
    });
    rmSync(path.join(repoRoot, "backups", stamp), { recursive: true, force: true });
  }, 90_000);
});
