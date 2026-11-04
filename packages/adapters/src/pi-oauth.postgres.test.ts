import { randomUUID } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "./secrets.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("model OAuth refresh (PostgreSQL contract)", () => {
  const databases: Array<ReturnType<typeof createDb>> = [];
  const users: string[] = [];
  const secrets = new EncryptedSecretStore("test-only-encryption-key");

  afterAll(async () => {
    const [first] = databases;
    if (first) {
      const prisma = asSystem(first.prisma);
      await prisma.organization.deleteMany({ where: { id: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    for (const db of databases) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  // One API or worker process: its own module state and a one-connection pool, so a
  // refresh that needs a second connection while it holds the lock cannot finish.
  async function instance() {
    const db = createDb(databaseUrl!, { poolMax: 1 });
    databases.push(db);
    vi.resetModules();
    return {
      prisma: db.prisma,
      oauth: await import("./pi-oauth.js"),
      credentials: await import("./pi-credentials.js"),
    };
  }

  it("spends a rotating refresh token once when the kick, a run start and a running run race across processes", async () => {
    const a = await instance();
    const b = await instance();
    const c = await instance();
    // Separate module graphs: no in-process lock is shared, only the database lock.
    expect(new Set([a, b, c].map((p) => p.oauth.withModelCredentialLock)).size).toBe(3);
    const id = randomUUID();
    users.push(id);
    const scope = { userId: id, spaceId: id };
    const credential: OAuthCredential = {
      type: "oauth",
      access: "acc-0",
      refresh: "rt-0",
      expires: Date.now() - 1,
      accountId: "acct",
    };
    const fixture = asSystem(a.prisma);
    await fixture.user.create({
      data: { id, name: "OAuth test", email: `${id}@example.test`, emailVerified: true },
    });
    await fixture.organization.create({
      data: { id, name: "OAuth test", slug: id, createdAt: new Date() },
    });
    await fixture.space.create({
      data: { id, organizationId: id, name: "OAuth test", isDefault: true },
    });
    const plaintext = a.oauth.serializeModelSecret({ kind: "oauth", credential });
    const stored = await secrets.put(plaintext, {
      operationId: "test",
      traceId: "test",
      spaceId: id,
      userId: id,
      signal: new AbortController().signal,
    });
    await fixture.secret.create({
      data: { id: stored.id, userId: id, kind: "model", ciphertext: stored.ciphertext },
    });
    const connection = await fixture.userModelCredential.create({
      data: { userId: id, provider: "openai-codex", label: "Codex", secretId: stored.id },
    });

    // The provider rotates refresh tokens and rejects a spent one.
    const sent: string[] = [];
    const oauth = {
      refresh: vi.fn(async (held: OAuthCredential) => {
        sent.push(held.refresh);
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (held.refresh !== "rt-0") throw new Error("invalid_grant: refresh token reused");
        return { ...credential, access: "acc-1", refresh: "rt-1", expires: Date.now() + 3_600_000 };
      }),
      toAuth: vi.fn(async (held: OAuthCredential) => ({ apiKey: held.access })),
    };
    const model = { id: connection.id, secretId: stored.id };
    const runner = new c.credentials.PiRuntimeCredentialStore(
      "openai-codex",
      credential,
      undefined,
      undefined,
      c.oauth.refreshStoredModelCredential(c.prisma, secrets, scope, model, "openai-codex", {
        oauth,
      }),
    );

    const [, started, running] = await Promise.all([
      runAsTenant(scope, () =>
        a.oauth.refreshExpiredModelCredential(a.prisma, secrets, scope, stored.id, "openai-codex", {
          oauth,
        }),
      ),
      runAsTenant(scope, () =>
        b.oauth.resolveStoredModelAuth(b.prisma, secrets, scope, model, plaintext, "openai-codex", {
          oauth,
        }),
      ),
      runAsTenant(scope, () =>
        runner.modify("openai-codex", async (current) =>
          current?.type === "oauth" && current.expires - Date.now() < 300_000
            ? oauth.refresh(current)
            : undefined,
        ),
      ),
    ]);

    expect(sent).toEqual(["rt-0"]);
    expect(started.apiKey).toBe("acc-1");
    expect(running).toMatchObject({ access: "acc-1", refresh: "rt-1" });
    const row = await fixture.secret.findUniqueOrThrow({ where: { id: stored.id } });
    expect(a.oauth.parseModelSecret(await secrets.load(row.ciphertext, stored.id))).toMatchObject({
      credential: { refresh: "rt-1" },
    });
  });
});
