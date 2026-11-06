import { randomUUID } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PostgresRealtimeFanout } from "./realtime.js";
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
      pool: db.pool,
      oauth: await import("./pi-oauth.js"),
      credentials: await import("./pi-credentials.js"),
      secretStores: await import("./secret-store-factory.js"),
    };
  }

  // A user, space and stored ChatGPT sign-in whose token is due for a refresh.
  async function seed(owner: Awaited<ReturnType<typeof instance>>) {
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
    const fixture = asSystem(owner.prisma);
    await fixture.user.create({
      data: { id, name: "OAuth test", email: `${id}@example.test`, emailVerified: true },
    });
    await fixture.organization.create({
      data: { id, name: "OAuth test", slug: id, createdAt: new Date() },
    });
    await fixture.space.create({
      data: { id, organizationId: id, name: "OAuth test", isDefault: true },
    });
    const plaintext = owner.oauth.serializeModelSecret({ kind: "oauth", credential });
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
    return { scope, credential, plaintext, stored, connection };
  }

  it("spends a rotating refresh token once when the kick, a run start and a running run race across processes", async () => {
    const a = await instance();
    const b = await instance();
    const c = await instance();
    // Separate module graphs: no in-process lock is shared, only the database lock.
    expect(new Set([a, b, c].map((p) => p.oauth.withModelCredentialLock)).size).toBe(3);
    const { scope, credential, plaintext, stored, connection } = await seed(a);
    const fixture = asSystem(a.prisma);

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

  it("commits a reconnect marker when the provider rejects the stored token", async () => {
    const owner = await instance();
    const { scope, plaintext, stored, connection } = await seed(owner);
    const oauth = {
      refresh: vi.fn(async () => {
        throw new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}');
      }),
      toAuth: vi.fn(async (held: OAuthCredential) => ({ apiKey: held.access })),
    };

    await expect(
      runAsTenant(scope, () =>
        owner.oauth.resolveStoredModelAuth(
          owner.prisma,
          secrets,
          scope,
          { id: connection.id, secretId: stored.id },
          plaintext,
          "openai-codex",
          { oauth },
        ),
      ),
    ).rejects.toThrow(owner.oauth.OAUTH_RECONNECT_REQUIRED_ERROR);
    const row = await asSystem(owner.prisma).secret.findUniqueOrThrow({ where: { id: stored.id } });
    expect(
      owner.oauth.parseModelSecret(await secrets.load(row.ciphertext, stored.id)),
    ).toMatchObject({
      reconnectRequired: true,
    });
  });

  it("keeps a rotated token when the refreshed sign-in yields no usable key", async () => {
    const owner = await instance();
    const { scope, credential, plaintext, stored, connection } = await seed(owner);
    const oauth = {
      refresh: vi.fn(async () => ({
        ...credential,
        access: "acc-1",
        refresh: "rt-1",
        expires: Date.now() + 3_600_000,
      })),
      toAuth: vi.fn(async () => ({ apiKey: "" })),
    };

    await expect(
      runAsTenant(scope, () =>
        owner.oauth.resolveStoredModelAuth(
          owner.prisma,
          secrets,
          scope,
          { id: connection.id, secretId: stored.id },
          plaintext,
          "openai-codex",
          { oauth },
        ),
      ),
    ).rejects.toThrow("did not produce a usable token");
    // The provider already spent rt-0, so the rotated token must survive the failure.
    const row = await asSystem(owner.prisma).secret.findUniqueOrThrow({ where: { id: stored.id } });
    expect(
      owner.oauth.parseModelSecret(await secrets.load(row.ciphertext, stored.id)),
    ).toMatchObject({
      credential: { refresh: "rt-1" },
    });
  });

  it("announces a refreshed token after the lock's connection is released", async () => {
    const owner = await instance();
    const { scope, credential, plaintext, stored, connection } = await seed(owner);
    // The app's store announces each write on the same one-connection pool.
    const notified: string[] = [];
    const store = new owner.secretStores.ComposedSecretStore(
      new EncryptedSecretStore("test-only-encryption-key"),
      undefined,
      new PostgresRealtimeFanout({
        connectionString: databaseUrl!,
        publisher: {
          query: async (sql: string, values: unknown[]) => {
            const result = await owner.pool.query(sql, values);
            notified.push(JSON.parse(JSON.parse(String(values[1])).payload).ref);
            return result;
          },
        },
      }),
    );
    const oauth = {
      refresh: vi.fn(async () => ({
        ...credential,
        access: "acc-1",
        refresh: "rt-1",
        expires: Date.now() + 3_600_000,
      })),
      toAuth: vi.fn(async (held: OAuthCredential) => ({ apiKey: held.access })),
    };

    const started = Date.now();
    const resolved = await runAsTenant(scope, () =>
      owner.oauth.resolveStoredModelAuth(
        owner.prisma,
        store,
        scope,
        { id: connection.id, secretId: stored.id },
        plaintext,
        "openai-codex",
        { oauth },
      ),
    );

    expect(resolved.apiKey).toBe("acc-1");
    // Announcing inside the lock would wait out the 10 s pool checkout.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(notified).toHaveLength(1);
  });
});
