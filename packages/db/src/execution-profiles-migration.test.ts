import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../prisma/migrations/20261015030000_execution_profiles/migration.sql", import.meta.url),
  "utf8",
);

describe("execution profile migration safeguards", () => {
  it("adds explicit model modalities without rewriting immutable revisions or old snapshots", () => {
    const mediaSql = readFileSync(
      new URL(
        "../prisma/migrations/20261015040500_execution_profile_input_modalities/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(mediaSql).toContain(
      'ADD COLUMN "inputModalities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]',
    );
    expect(mediaSql).toContain("'inputModalities', to_jsonb(profile.\"inputModalities\")");
    expect(mediaSql).toContain(
      'NEW."executionProfileSnapshot" IS DISTINCT FROM OLD."executionProfileSnapshot"',
    );
    expect(mediaSql).not.toMatch(/UPDATE "(?:runs|execution_profiles)"/);
  });
  it("is additive and keeps existing bots and runs unbound", () => {
    expect(sql).toContain('ALTER TABLE "bots" ADD COLUMN "executionProfileId" TEXT;');
    expect(sql).toContain('ALTER TABLE "runs" ADD COLUMN "executionProfileSnapshot" JSONB;');
    expect(sql).not.toMatch(/UPDATE "(?:runs|bots)"/);
    expect(sql).not.toMatch(/DROP (?:TABLE|COLUMN)/);
  });

  it("pins every enqueue route at insertion and forbids later rewriting", () => {
    expect(sql).toContain(
      'BEFORE INSERT OR UPDATE OF "executionProfileSnapshot", "spaceId", "userId", "botId", "threadId" ON "runs"',
    );
    expect(sql).toContain(
      'NEW."executionProfileSnapshot" IS DISTINCT FROM OLD."executionProfileSnapshot"',
    );
    expect(sql).toContain('FROM "bots" WHERE "id" = NEW."botId" FOR SHARE');
    expect(sql).toContain("'credentialSecretId', credential.\"secretId\"");
  });

  it("retains disconnected profile references and fences scope at binding", () => {
    expect(sql).toContain('FOREIGN KEY ("executionProfileId", "spaceId", "userId")');
    expect(sql).toContain("ON DELETE RESTRICT");
    expect(sql).not.toMatch(/FOREIGN KEY \("credentialId"\)/);
    expect(sql).toContain('"execution_profiles_immutable" BEFORE UPDATE');
  });

  it("isolates native sessions by bot, thread and profile revision", () => {
    expect(sql).toContain('ON "native_harness_sessions"("botId", "threadId", "profileId")');
    expect(sql).toContain('"interrupted" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('"credentialSecretId" TEXT NOT NULL');
  });
});
