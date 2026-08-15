import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const composeFile = path.resolve("infra/compose/docker-compose.yml");
const backupScript = path.resolve("scripts/backup.sh");
const restoreScript = path.resolve("scripts/restore.sh");

function postgresUp() {
  try {
    execSync(`docker compose -f ${composeFile} exec -T postgres pg_isready -U rakazo`, {
      stdio: "ignore",
      timeout: 8_000,
    });
    return true;
  } catch {
    return false;
  }
}

const describeBackup = postgresUp() ? describe : describe.skip;

describeBackup("compose backup and restore", () => {
  it("dumps postgres and restores into a side database", () => {
    expect(existsSync(backupScript)).toBe(true);
    expect(existsSync(restoreScript)).toBe(true);
    const stamp = `verify-${Date.now()}`;
    execSync(`${backupScript} ${stamp}`, {
      stdio: "pipe",
      timeout: 60_000,
      env: { ...process.env, RAKAZO_BACKUP_SKIP_HOMES: "1" },
    });
    const dump = path.resolve("backups", stamp, "rakazo.sql");
    expect(existsSync(dump)).toBe(true);
    const sql = readFileSync(dump, "utf8");
    expect(sql).toMatch(/CREATE TABLE|CREATE TABLE IF NOT EXISTS/i);
    expect(sql.toLowerCase()).toContain("bots");
    expect(sql).not.toMatch(/OPENROUTER_API_KEY|sk-or-v1-/);

    execSync(
      `docker compose -f ${composeFile} exec -T postgres psql -U rakazo -d postgres -c "DROP DATABASE IF EXISTS rakazo_restore_test"`,
      { stdio: "pipe", timeout: 20_000 },
    );
    execSync(
      `docker compose -f ${composeFile} exec -T postgres psql -U rakazo -d postgres -c "CREATE DATABASE rakazo_restore_test"`,
      { stdio: "pipe", timeout: 20_000 },
    );
    execSync(
      `docker compose -f ${composeFile} exec -T postgres psql -U rakazo -d rakazo_restore_test`,
      {
        input: sql,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
    const tables = execSync(
      `docker compose -f ${composeFile} exec -T postgres psql -U rakazo -d rakazo_restore_test -c "\\dt"`,
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(tables).toMatch(/bots/);
    execSync(
      `docker compose -f ${composeFile} exec -T postgres psql -U rakazo -d postgres -c "DROP DATABASE rakazo_restore_test"`,
      { stdio: "pipe", timeout: 20_000 },
    );
    rmSync(path.resolve("backups", stamp), { recursive: true, force: true });
  }, 90_000);
});
