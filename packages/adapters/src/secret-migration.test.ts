import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import type { SecretMigrationRepository, SecretMigrationRow } from "./secret-migration.js";
import { migrateSecrets } from "./secret-migration.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

const context: AdapterContext = {
  operationId: "migration",
  traceId: "migration",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};
async function fixture() {
  const fake = infisicalFake();
  const encrypted = new EncryptedSecretStore("key");
  const remote = new InfisicalSecretStore(fake.options);
  await remote.start();
  const record = await encrypted.put("fake value", context, { recordId: "row" });
  const rows: SecretMigrationRow[] = [
    { id: "row", recordId: "row", label: "secret", ref: record.ref },
  ];
  const replace = vi.fn(async (row: SecretMigrationRow, ref: string) => {
    const current = rows.find((current) => current.id === row.id && current.ref === row.ref);
    if (!current) return false;
    current.ref = ref;
    return true;
  });
  const repository: SecretMigrationRepository = {
    async *rows() {
      for (const row of rows) yield { ...row };
    },
    replace,
    referenced: async (ref) => rows.some((row) => row.ref === ref),
  };
  const report = vi.fn();
  return {
    fake,
    encrypted,
    remote,
    rows,
    repository,
    replace,
    report,
    async run(direction: "forward" | "reverse", dryRun = false) {
      return migrateSecrets(repository, encrypted, remote, context, { direction, dryRun, report });
    },
    async close() {
      await encrypted.close();
      await remote.close();
    },
  };
}
describe("secret migration", () => {
  it("migrates both ways and resumes without writing another value", async () => {
    const f = await fixture();
    try {
      expect(await f.run("forward")).toMatchObject({ migrated: 1 });
      expect(f.fake.values.size).toBe(1);
      expect(await f.run("forward")).toMatchObject({ verified: 1 });
      expect(f.replace).toHaveBeenCalledTimes(1);
      expect(await f.run("reverse")).toMatchObject({ migrated: 1 });
      expect(f.fake.values.size).toBe(0);
      await expect(f.encrypted.load(f.rows[0]!.ref, "row")).resolves.toBe("fake value");
      expect(await f.run("reverse")).toMatchObject({ verified: 1 });
      expect(JSON.stringify(f.report.mock.calls)).not.toContain("fake value");
    } finally {
      await f.close();
    }
  });
  it("dry-run verifies reads and leaves both persistence and remote storage unchanged", async () => {
    const f = await fixture();
    try {
      const original = f.rows[0]!.ref;
      expect(await f.run("forward", true)).toMatchObject({ planned: 1 });
      expect(f.rows[0]!.ref).toBe(original);
      expect(f.fake.values.size).toBe(0);
      expect(f.replace).not.toHaveBeenCalled();
      await f.run("forward");
      const remoteRef = f.rows[0]!.ref;
      expect(await f.run("reverse", true)).toMatchObject({ planned: 1 });
      expect(f.rows[0]!.ref).toBe(remoteRef);
      expect(f.fake.values.size).toBe(1);
    } finally {
      await f.close();
    }
  });
  it("cleans orphan writes on DB failure and records no successful progress", async () => {
    const f = await fixture();
    try {
      f.replace.mockRejectedValueOnce(new Error("fake DB failure"));
      expect(await f.run("forward")).toMatchObject({ failed: 1, migrated: 0 });
      expect(f.fake.values.size).toBe(0);
      expect(f.report).not.toHaveBeenCalledWith(expect.anything(), "migrated");
      expect(await f.run("forward")).toMatchObject({ migrated: 1 });
    } finally {
      await f.close();
    }
  });
  it("lets concurrent edits win through CAS and deletes the losing new write", async () => {
    const f = await fixture();
    try {
      const replacement = await f.encrypted.put("concurrent", context, { recordId: "row" });
      f.replace.mockImplementationOnce(async () => {
        f.rows[0]!.ref = replacement.ref;
        return false;
      });
      expect(await f.run("forward")).toMatchObject({ concurrent: 1 });
      expect(f.fake.values.size).toBe(0);
      expect(f.rows[0]!.ref).toBe(replacement.ref);
    } finally {
      await f.close();
    }
  });
  it("verifies existing refs instead of silently skipping dangling targets and keeps OTPs local", async () => {
    const f = await fixture();
    try {
      f.rows[0]!.ephemeral = true;
      expect(await f.run("forward")).toMatchObject({ verified: 1 });
      expect(f.fake.values.size).toBe(0);
      f.rows[0]!.ephemeral = false;
      await f.run("forward");
      f.fake.values.clear();
      f.remote.invalidate(f.rows[0]!.ref);
      expect(await f.run("forward")).toMatchObject({ failed: 1, verified: 0 });
    } finally {
      await f.close();
    }
  });
  it("preserves a committed write when the DB acknowledgement is lost", async () => {
    const f = await fixture();
    try {
      f.replace.mockImplementationOnce(async (_row, ref) => {
        f.rows[0]!.ref = ref;
        throw new Error("unknown commit result");
      });
      expect(await f.run("forward")).toMatchObject({ failed: 1 });
      expect(f.fake.values.size).toBe(1);
      await expect(f.remote.load(f.rows[0]!.ref, "row")).resolves.toBe("fake value");
      expect(await f.run("forward")).toMatchObject({ verified: 1 });
    } finally {
      await f.close();
    }
  });
});
