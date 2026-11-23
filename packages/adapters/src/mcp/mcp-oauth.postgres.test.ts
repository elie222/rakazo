import { randomUUID } from "node:crypto";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretNotFoundError } from "@rakazo/adapter-kit";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresRealtimeFanout } from "../notifications/realtime.js";
import { fakeCleanupJobs } from "../secrets/secret-cleanup.test-support.js";
import { withSecretPersistence } from "../secrets/secret-persistence.js";
import { ComposedSecretStore } from "../secrets/secret-store-factory.js";
import { EncryptedSecretStore } from "../secrets/secrets.js";
import type { OAuthMaterial } from "./mcp-oauth.js";
import { McpOAuthBroker } from "./mcp-oauth.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const ISSUER = "https://auth.example.test";

describePostgres("MCP OAuth refresh (PostgreSQL contract)", () => {
  const databases: Array<ReturnType<typeof createDb>> = [];
  const users: string[] = [];
  const secrets = new EncryptedSecretStore("test-only-encryption-key");

  function openDb(poolMax?: number) {
    const db = createDb(databaseUrl!, poolMax ? { poolMax } : {});
    databases.push(db);
    return db;
  }

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

  async function seed(material: OAuthMaterial, store: Pick<SecretStore, "put"> = secrets) {
    const prisma = asSystem(openDb().prisma);
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "OAuth test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "OAuth test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "OAuth test", isDefault: true },
    });
    const stored = await store.put(JSON.stringify(material), {
      operationId: "test",
      traceId: "test",
      spaceId: id,
      userId: id,
      signal: new AbortController().signal,
    });
    await prisma.secret.create({
      data: { id: stored.id, userId: id, spaceId: id, kind: "mcp", ciphertext: stored.ciphertext },
    });
    const server = await prisma.mcpServer.create({
      data: {
        spaceId: id,
        userId: id,
        slug: "oauth",
        name: "OAuth",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        secretId: stored.id,
      },
    });
    return { server, context: { spaceId: id, userId: id } };
  }

  function expiredMaterial(): OAuthMaterial {
    return {
      oauth: {
        tokens: {
          access_token: "access-0",
          refresh_token: "refresh-0",
          token_type: "Bearer",
          expires_in: 3600,
        },
        obtainedAt: Date.now() - 2 * 60 * 60 * 1000,
        clientInformation: { client_id: "client-1" },
        discoveryState: {
          authorizationServerUrl: ISSUER,
          authorizationServerMetadata: {
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            response_types_supported: ["code"],
          },
        },
      },
    };
  }

  /** A remote store kept in memory: an entry is gone once deleted. */
  function remoteStore() {
    const entries = new Map<string, string>();
    const remote = {
      entries,
      /** Every reference written, oldest first. */
      refs: [] as string[],
      unavailable: (_ref: string) => false,
      store: {
        put: async (plaintext: string) => {
          const id = randomUUID();
          const ciphertext = `remote:${id}`;
          entries.set(ciphertext, plaintext);
          remote.refs.push(ciphertext);
          return { id, ciphertext };
        },
        load: async (ref: string) => {
          const value = entries.get(ref);
          if (value === undefined) throw new SecretNotFoundError();
          return value;
        },
        delete: async (ref: string) => {
          if (remote.unavailable(ref)) throw new Error("secret store unavailable");
          entries.delete(ref);
        },
        isRemote: () => true,
      } as unknown as SecretStore,
    };
    return remote;
  }

  /**
   * Fails, for its caller, the next commit of a transaction that inserted a secret row. With
   * `lost-reply` the commit lands and only its acknowledgement is lost; with `rolled-back`
   * the write is undone.
   */
  function failNextSecretCommit(pool: Pool, outcome: "lost-reply" | "rolled-back") {
    type Query = (...args: unknown[]) => Promise<unknown>;
    let armed = true;
    const wrapped = new WeakSet<object>();
    const connect = pool.connect.bind(pool) as (callback?: unknown) => Promise<{ query: Query }>;
    pool.connect = (async (callback?: unknown) => {
      // The pool checks a connection out this way for its own one-off queries.
      if (callback) return connect(callback);
      const client = await connect();
      if (wrapped.has(client)) return client;
      wrapped.add(client);
      const query = client.query.bind(client);
      let wroteSecret = false;
      client.query = async (...args) => {
        const [first] = args;
        const text = typeof first === "string" ? first : (first as { text: string }).text;
        if (text === "BEGIN") wroteSecret = false;
        if (/^INSERT INTO "public"\."secrets"/.test(text)) wroteSecret = true;
        if (text !== "COMMIT" || !wroteSecret || !armed) return query(...args);
        armed = false;
        await query(outcome === "lost-reply" ? "COMMIT" : "ROLLBACK");
        throw new Error("Connection terminated unexpectedly");
      };
      return client;
    }) as unknown as Pool["connect"];
    return { failed: () => !armed };
  }

  function rotatedOnce() {
    return {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      fetch: async () =>
        Response.json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
        }),
    };
  }

  async function heldSecret(db: ReturnType<typeof createDb>, serverId: string) {
    return asSystem(db.prisma).secret.findFirstOrThrow({
      where: { mcpServers: { some: { id: serverId } } },
    });
  }

  it("keeps the refreshed sign-in when its save commits but the reply is lost", async () => {
    const db = openDb();
    const { store, entries } = remoteStore();
    const cleanup = fakeCleanupJobs();
    const broker = new McpOAuthBroker(
      withSecretPersistence(db.prisma, store),
      store,
      rotatedOnce(),
      false,
      cleanup.jobs,
    );
    const { server, context } = await seed(expiredMaterial(), store);
    const provider = await runAsTenant(context, () => broker.providerFor(server, context));
    const commit = failNextSecretCommit(db.pool, "lost-reply");

    const tokens = await runAsTenant(context, () => provider?.tokens());

    expect(commit.failed()).toBe(true);
    const row = await heldSecret(db, server.id);
    expect(entries.has(row.ciphertext)).toBe(true);
    expect(JSON.parse(await store.load(row.ciphertext, row.id)).oauth.tokens.refresh_token).toBe(
      "refresh-1",
    );
    expect(tokens).toMatchObject({ access_token: "access-1" });
    expect(cleanup.cleanups()).toEqual([]);
  }, 30_000);

  it("removes the entry a rolled-back refresh wrote, through the queue while the store is down", async () => {
    const db = openDb();
    const remote = remoteStore();
    const { store, entries, refs } = remote;
    const cleanup = fakeCleanupJobs();
    const broker = new McpOAuthBroker(
      withSecretPersistence(db.prisma, store),
      store,
      rotatedOnce(),
      false,
      cleanup.jobs,
    );
    const { server, context } = await seed(expiredMaterial(), store);
    const provider = await runAsTenant(context, () => broker.providerFor(server, context));
    const commit = failNextSecretCommit(db.pool, "rolled-back");
    // The seeded grant is the first entry; the save that rolls back writes the second.
    remote.unavailable = (ref) => ref === refs[1];

    const tokens = await runAsTenant(context, () => provider?.tokens());

    expect(commit.failed()).toBe(true);
    expect(tokens).toMatchObject({ access_token: "access-1" });
    const orphan = refs[1]!;
    expect(entries.has(orphan)).toBe(true);
    expect(cleanup.cleanups()).toMatchObject([{ kind: "secret_row", ref: orphan, due: true }]);

    remote.unavailable = () => false;
    await cleanup.runQueued({ prisma: db.prisma, secrets: store });

    expect(entries.has(orphan)).toBe(false);
    const row = await heldSecret(db, server.id);
    expect(row.ciphertext).not.toBe(orphan);
    expect(JSON.parse(await store.load(row.ciphertext, row.id)).oauth.tokens.refresh_token).toBe(
      "refresh-1",
    );
  }, 30_000);

  it("refreshes more servers at once than the API pool has connections", async () => {
    // Production-shaped API process: secret change notifications go out on the Prisma pool.
    const db = openDb(2);
    const notified: string[] = [];
    const publisher = {
      query: async (sql: string, values: unknown[]) => {
        const result = await db.pool.query(sql, values);
        notified.push(JSON.parse(JSON.parse(String(values[1])).payload).ref);
        return result;
      },
    };
    const store = new ComposedSecretStore(
      new EncryptedSecretStore("test-only-encryption-key"),
      undefined,
      new PostgresRealtimeFanout({ connectionString: databaseUrl!, publisher }),
    );
    const broker = new McpOAuthBroker(withSecretPersistence(db.prisma, store), store, {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      fetch: async () =>
        Response.json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
        }),
    });
    const seeded = await Promise.all([1, 2, 3].map(() => seed(expiredMaterial())));
    const providers = await Promise.all(
      seeded.map(({ server, context }) =>
        runAsTenant(context, () => broker.providerFor(server, context)),
      ),
    );

    const started = Date.now();
    const tokens = await Promise.all(
      providers.map((provider, index) =>
        runAsTenant(seeded[index]!.context, () => provider?.tokens()),
      ),
    );

    expect(tokens.map((token) => token?.access_token)).toEqual([
      "access-1",
      "access-1",
      "access-1",
    ]);
    expect(Date.now() - started).toBeLessThan(5_000);
    for (const { server } of seeded) {
      const row = await asSystem(db.prisma).secret.findFirstOrThrow({
        where: { mcpServers: { some: { id: server.id } } },
      });
      expect(
        JSON.parse(await secrets.load(row.ciphertext, row.id)).oauth.tokens.refresh_token,
      ).toBe("refresh-1");
      expect(notified).toContain(row.ciphertext);
    }
  }, 30_000);
});
