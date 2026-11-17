import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AdapterContext, BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { BOT_SECRET_VALUE_MAX_LENGTH, encodeLoginSecret } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { currentDbContext, runAsTenant, withTransactionRetry } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { findRunLogin } from "./bot-secrets.js";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import { McpConnector } from "./mcp-connector.js";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { McpSession } from "./mcp-transport.js";
import { retireToReconnectMarker } from "./model-credential-refresh.js";
import { createRunSecretWriter } from "./run-secret.js";
import { retrySecretCleanup } from "./secret-cleanup.js";
import { fakeCleanupJobs } from "./secret-cleanup.test-support.js";
import { persistPreparedSecret, withSecretPersistence } from "./secret-persistence.js";
import { ComposedSecretStore } from "./secret-store-factory.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";
import { InMemoryJobQueue } from "./wakeup.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
type Row = {
  id: string;
  kind?: string;
  ciphertext?: string;
  userId?: string;
  spaceId?: string;
  botId?: string;
  endpoint?: string;
  secretId?: string | null;
  organizationId?: string;
  operationKey?: string;
  cardCiphertext?: string | null;
  requestCiphertext?: string | null;
  tokenCiphertext?: string | null;
};
type Args = { where?: Record<string, unknown>; data?: Row; create?: Row; update?: Row };
type Hook = (input: {
  model: string;
  operation: string;
  args: Args;
  query: (args: Args) => Promise<unknown>;
}) => Promise<unknown>;
function database() {
  const tables = new Map<string, Row[]>([
    ["secret", []],
    ["botSecret", []],
    ["vaultCredential", []],
    ["integrationProviderConfig", []],
    ["user", [{ id: "user" }]],
    ["space", [{ id: "space", organizationId: "organization" }]],
    ["organization", [{ id: "organization" }]],
    ["bot", []],
    ["mcpServer", []],
    ["mcpServerSpace", []],
    ["messagingInstallation", []],
    ["paymentWallet", []],
    ["purchase", []],
    ["userModelCredential", []],
  ]);
  const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR")
        return (value as Array<Record<string, unknown>>).some((branch) => matches(row, branch));
      // As the vault's bot filter reads: no item is limited to chosen bots here.
      if (key === "limits") return true;
      if (key === "bots") return false;
      const actual = row[key as keyof Row];
      if (value && typeof value === "object" && "not" in value) return actual !== value.not;
      if (value && typeof value === "object" && "in" in value)
        return (value.in as unknown[]).includes(actual);
      return actual === value;
    });
  // As the row policies read: a tenant sees only its own user's rows.
  const visible = (row: Row): boolean => {
    const context = currentDbContext();
    return context?.kind !== "tenant" || !row.userId || row.userId === context.userId;
  };
  const client: Record<string, unknown> = {};
  for (const [table, rows] of tables) {
    client[table] = {
      findFirst: async (args: Args) => {
        const row = rows.find((row) => matches(row, args.where));
        return row ? { ...row } : null;
      },
      findUnique: async (args: Args) => {
        const row = rows.find((row) => matches(row, args.where));
        return row ? { ...row } : null;
      },
      findMany: async (args: Args) =>
        rows.filter((row) => visible(row) && matches(row, args.where)).map((row) => ({ ...row })),
      count: async (args: Args) => rows.filter((row) => matches(row, args.where)).length,
      create: async (args: Args) => {
        rows.push({ ...args.data! });
        return args.data;
      },
      update: async (args: Args) => {
        const row = rows.find((row) => matches(row, args.where));
        if (!row) throw new Error("Missing row");
        Object.assign(row, args.data);
        return row;
      },
      upsert: async (args: Args) => {
        const row = rows.find((row) => matches(row, args.where));
        if (row) {
          Object.assign(row, args.update);
          return row;
        }
        rows.push({ ...args.create! });
        return args.create;
      },
      deleteMany: async (args: Args) => {
        const removed = rows.filter((row) => matches(row, args.where));
        for (const row of removed) rows.splice(rows.indexOf(row), 1);
        if (table === "user")
          for (const target of ["secret", "botSecret", "messagingInstallation", "paymentWallet"]) {
            const children = tables.get(target)!;
            for (let i = children.length - 1; i >= 0; i--)
              if (removed.some((parent) => children[i]?.userId === parent.id))
                children.splice(i, 1);
          }
        if (["organization", "space", "bot"].includes(table)) {
          const spaces = tables.get("space")!;
          const removedSpaces =
            table === "organization"
              ? spaces.filter((space) =>
                  removed.some((parent) => space.organizationId === parent.id),
                )
              : removed;
          if (table === "organization")
            for (const space of removedSpaces) spaces.splice(spaces.indexOf(space), 1);
          for (const target of table === "bot"
            ? ["botSecret", "messagingInstallation"]
            : ["secret", "botSecret", "messagingInstallation", "purchase"]) {
            const children = tables.get(target)!;
            for (let i = children.length - 1; i >= 0; i--)
              if (
                removedSpaces.some(
                  (parent) =>
                    (table === "bot" ? children[i]?.botId : children[i]?.spaceId) === parent.id,
                )
              )
                children.splice(i, 1);
          }
        }
        return { count: removed.length };
      },
    };
  }
  client.$queryRaw = async (query: { sql: string; values: unknown[] }) => {
    // Every member is in their Space, so the settings lock (a tagged template) finds the row.
    if (Array.isArray(query) && query.join("").includes('FROM "space_members"')) {
      return [{ locked: 1 }];
    }
    if (!query.sql) return [];
    const table = query.sql.match(/FROM "([^"]+)"/)?.[1];
    const names: Record<string, string> = {
      secrets: "secret",
      bot_secrets: "botSecret",
      vault_credentials: "vaultCredential",
      integration_provider_configs: "integrationProviderConfig",
      user: "user",
      spaces: "space",
      bots: "bot",
      organization: "organization",
      messaging_installations: "messagingInstallation",
      payment_wallets: "paymentWallet",
      purchases: "purchase",
    };
    return (
      tables
        .get(names[table ?? ""] ?? "")
        ?.filter((row) => visible(row) && query.values.flat().includes(row.id))
        .map((row) => ({ ...row })) ?? []
    );
  };
  client.$executeRaw = async () => 1;
  client.$extends = (extension: { query: { $allModels: { $allOperations: Hook } } }) => {
    const extended: Record<string, unknown> = {};
    for (const [table] of tables) {
      const delegate = client[table] as Record<string, (args: Args) => Promise<unknown>>;
      extended[table] = Object.fromEntries(
        Object.entries(delegate).map(([operation, query]) => [
          operation,
          (args: Args) => ({
            // biome-ignore lint/suspicious/noThenProperty: Prisma queries are lazy thenables in batch transactions.
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
              extension.query.$allModels
                .$allOperations({
                  model: table[0]!.toUpperCase() + table.slice(1),
                  operation,
                  args,
                  query,
                })
                .then(resolve, reject),
          }),
        ]),
      );
    }
    extended.$queryRaw = client.$queryRaw;
    extended.$executeRaw = client.$executeRaw;
    extended.$transaction = async (
      callback: ((tx: Record<string, unknown>) => Promise<unknown>) | Promise<unknown>[],
    ) => {
      const snapshot = new Map(
        [...tables].map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
      );
      try {
        return await (Array.isArray(callback) ? Promise.all(callback) : callback(extended));
      } catch (error) {
        for (const [name, rows] of tables) rows.splice(0, rows.length, ...snapshot.get(name)!);
        throw error;
      }
    };
    client.$transaction = extended.$transaction;
    return extended;
  };
  return { prisma: client as unknown as PrismaClient, tables };
}

describe("secret persistence cleanup", () => {
  it("deletes a replaced ref only after commit and removes refs on row deletion", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const db = database();
    const prisma = withSecretPersistence(db.prisma, store);
    const old = await store.put("old", context, { recordId: "row" });
    const next = await store.put("next", context, { recordId: "row" });
    db.tables.get("secret")!.push({ id: "row", ciphertext: old.ref });
    const remove = vi.spyOn(store, "delete");
    try {
      await prisma.$transaction(async (tx) => {
        await tx.secret.update({ where: { id: "row" }, data: { ciphertext: next.ref } });
        expect(remove).not.toHaveBeenCalled();
        expect(fake.values.size).toBe(2);
      });
      expect(remove).toHaveBeenCalledWith(old.ref, expect.objectContaining({ recordId: "row" }));
      expect(fake.values.size).toBe(1);
      await prisma.secret.deleteMany({ where: { id: "row" } });
      expect(fake.values.size).toBe(0);
    } finally {
      await store.close();
    }
  });
  it("cleans the losing retry write while the committed fresh key remains loadable", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    const db = database();
    const prisma = withSecretPersistence(db.prisma, store);
    let attempts = 0;
    try {
      await withTransactionRetry(async () => {
        const stored = await store.put("fake", context, { recordId: "row" });
        await prisma.$transaction(async (tx) => {
          await tx.secret.create({
            data: {
              id: stored.id,
              ciphertext: stored.ref,
              userId: "user",
              spaceId: "space",
              kind: "agent-environment",
            },
          });
          if (++attempts === 1) throw { code: "P2034" };
        });
      });
      expect(attempts).toBe(2);
      expect(fake.values.size).toBe(1);
      await expect(store.load(db.tables.get("secret")![0]!.ciphertext!, "row")).resolves.toBe(
        "fake",
      );
    } finally {
      await store.close();
    }
  });
  it("rollbacks preserve committed values and clean the losing new write", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const db = database();
    const prisma = withSecretPersistence(db.prisma, store);
    const old = await store.put("old", context, { recordId: "row" });
    const next = await store.put("next", context, { recordId: "row" });
    db.tables.get("secret")!.push({ id: "row", ciphertext: old.ref });
    try {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.secret.update({ where: { id: "row" }, data: { ciphertext: next.ref } });
          throw new Error("fake DB failure");
        }),
      ).rejects.toThrow("fake DB failure");
      expect(fake.values.size).toBe(1);
      await expect(store.load(old.ref, "row")).resolves.toBe("old");
      expect(db.tables.get("secret")![0]!.ciphertext).toBe(old.ref);
    } finally {
      await store.close();
    }
  });
  it("cleans cascade deletions and uses the integration configuration AAD", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const db = database();
    const prisma = withSecretPersistence(db.prisma, store);
    const bot = await store.put("bot", context, { recordId: "bot-row" });
    const config = await store.put("config", context, {
      recordId: "integration-provider:composio",
    });
    db.tables.get("botSecret")!.push({ id: "bot-row", ciphertext: bot.ref, userId: "user" });
    try {
      await prisma.user.deleteMany({ where: { id: "user" } });
      expect(fake.values.size).toBe(1);
      await prisma.integrationProviderConfig.upsert({
        where: { id: "composio" },
        create: { id: "composio", ciphertext: config.ref },
        update: { ciphertext: config.ref },
      });
      await prisma.integrationProviderConfig.deleteMany({ where: { id: "composio" } });
      expect(fake.values.size).toBe(0);
    } finally {
      await store.close();
    }
  });
  it("captures organization cascades and cleans only after the enclosing transaction commits", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const db = database();
    const prisma = withSecretPersistence(db.prisma, store);
    const record = await store.put("fake", context, { recordId: "row" });
    db.tables.get("secret")!.push({ id: "row", ciphertext: record.ref, spaceId: "space" });
    try {
      await prisma.$transaction(async (tx) => {
        await tx.organization.deleteMany({ where: { id: "organization" } });
        expect(fake.values.size).toBe(1);
      });
      expect(fake.values.size).toBe(0);
    } finally {
      await store.close();
    }
  });
  it("preserves atomicity by rejecting secret mutations in batches that expose no transaction client", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const db = database();
    const prisma = withSecretPersistence(db.prisma, store);
    const record = await store.put("fake", context, { recordId: "row" });
    db.tables.get("secret")!.push({ id: "row", ciphertext: record.ref });
    try {
      await expect(
        prisma.$transaction([prisma.secret.deleteMany({ where: { id: "row" } })]),
      ).rejects.toThrow("interactive transaction");
      expect(fake.values.size).toBe(1);
      expect(db.tables.get("secret")).toHaveLength(1);
      await expect(
        prisma.$transaction([prisma.secret.findMany({ where: { id: "row" } })]),
      ).resolves.toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});

describe("secret persistence cleanup with a queue", () => {
  async function setup() {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const db = database();
    const queue = fakeCleanupJobs();
    const prisma = withSecretPersistence(db.prisma, store, () => queue.jobs);
    const worker = { prisma: db.prisma, secrets: store };
    return { fake, store, db, queue, prisma, worker };
  }
  const dropped = (recordId: string, ref: string) => ({ kind: "secret_tables", recordId, ref });
  const secretFields = { id: "row", userId: "user", kind: "agent-environment" };

  it("records the backup in the transaction that drops a ref and retries a refused delete", async () => {
    const { fake, store, db, queue, prisma, worker } = await setup();
    const old = await store.put("old", context, { recordId: "row" });
    const next = await store.put("next", context, { recordId: "row" });
    db.tables.get("secret")!.push({ id: "row", ciphertext: old.ref });
    try {
      await prisma.$transaction(async (tx) => {
        await tx.secret.update({ where: { id: "row" }, data: { ciphertext: next.ref } });
        expect(queue.jobs.enqueueManyIn).toHaveBeenCalledWith(tx, [expect.anything()]);
        expect(queue.cleanups()).toEqual([{ ...dropped("row", old.ref), due: false }]);
        fake.offline = true;
      });
      expect(fake.values.size).toBe(2);
      expect(queue.cleanups()).toEqual([{ ...dropped("row", old.ref), due: true }]);

      fake.offline = false;
      await queue.runQueued(worker);
      expect(fake.values.size).toBe(1);
      await expect(store.load(next.ref, "row")).resolves.toBe("next");
    } finally {
      await store.close();
    }
  });

  it("removes the backup with the entry, and records none for a write a row holds", async () => {
    const { fake, store, db, queue, prisma } = await setup();
    const record = await store.put("fake", context, { recordId: "row" });
    try {
      await prisma.secret.create({ data: { ...secretFields, ciphertext: record.ref } });
      expect(queue.jobs.enqueue).not.toHaveBeenCalled();
      expect(queue.jobs.enqueueManyIn).not.toHaveBeenCalled();
      await prisma.secret.deleteMany({ where: { id: "row" } });
      expect(fake.values.size).toBe(0);
      expect(queue.queued.size).toBe(0);
      expect(db.tables.get("secret")).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("records one backup for a reference that several dropped rows share", async () => {
    const { fake, store, db, queue, prisma } = await setup();
    const shared = await store.put("shared", context, { recordId: "row" });
    db.tables
      .get("secret")!
      .push(
        { id: "row", ciphertext: shared.ref, userId: "user" },
        { id: "row-2", ciphertext: shared.ref, userId: "user" },
      );
    try {
      await prisma.user.deleteMany({ where: { id: "user" } });
      expect(queue.jobs.enqueueManyIn).toHaveBeenCalledOnce();
      expect(queue.jobs.enqueueManyIn.mock.calls[0]![1]).toHaveLength(1);
      expect(fake.values.size).toBe(0);
      expect(queue.queued.size).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("records nothing for a change that leaves the reference in place", async () => {
    const { fake, store, db, queue, prisma } = await setup();
    const kept = await store.put("kept", context, { recordId: "row" });
    db.tables.get("secret")!.push({ id: "row", ciphertext: kept.ref });
    try {
      await prisma.secret.update({ where: { id: "row" }, data: { kind: "one-time-code" } });
      expect(queue.jobs.enqueueManyIn).not.toHaveBeenCalled();
      expect(queue.jobs.enqueue).not.toHaveBeenCalled();
      expect(fake.values.size).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("hands a write to the job when its rows cannot be read, cancelling no backup", async () => {
    const { fake, store, db, queue, prisma, worker } = await setup();
    const written = await store.put("written", context, { recordId: "row" });
    const count = vi.spyOn(db.prisma.secret, "count");
    try {
      count.mockRejectedValueOnce(new Error("database unavailable"));
      await prisma.secret.create({ data: { ...secretFields, ciphertext: written.ref } });
      expect(queue.jobs.cancel).not.toHaveBeenCalled();
      expect(queue.cleanups()).toEqual([{ ...dropped("row", written.ref), due: true }]);

      await queue.runQueued(worker);
      expect(fake.values.size).toBe(1);
      await expect(store.load(written.ref, "row")).resolves.toBe("written");
    } finally {
      await store.close();
    }
  });

  it("retries removing a write its transaction rolled back", async () => {
    const { fake, store, queue, prisma, worker } = await setup();
    const unsaved = await store.put("unsaved", context, { recordId: "row" });
    try {
      fake.offline = true;
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.secret.create({ data: { ...secretFields, ciphertext: unsaved.ref } });
          throw new Error("fake DB failure");
        }),
      ).rejects.toThrow("fake DB failure");
      expect(fake.values.size).toBe(1);
      expect(queue.cleanups()).toEqual([{ ...dropped("row", unsaved.ref), due: true }]);

      fake.offline = false;
      await queue.runQueued(worker);
      expect(fake.values.size).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("retries removing a prepared write that was never saved", async () => {
    const { fake, store, db, queue, prisma, worker } = await setup();
    const fail = () =>
      prisma.$transaction(async () => {
        throw new Error("pre-create failure");
      });
    try {
      const unqueued = await store.put("unused", context, { recordId: "row" });
      fake.offline = true;
      // The plain client knows no queue: the same check, without the retry.
      await expect(persistPreparedSecret(db.prisma, store, unqueued, fail)).rejects.toThrow();
      expect(queue.queued.size).toBe(0);

      await expect(persistPreparedSecret(prisma, store, unqueued, fail)).rejects.toThrow();
      expect(queue.cleanups()).toEqual([{ ...dropped("row", unqueued.ref), due: true }]);
      fake.offline = false;
      await queue.runQueued(worker);
      expect(fake.values.size).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("leaves a ref another row holds to its backup, which spares it too", async () => {
    const { fake, store, db, queue, prisma, worker } = await setup();
    const shared = await store.put("shared", context, { recordId: "row" });
    db.tables.get("secret")!.push({ id: "row", ciphertext: shared.ref });
    db.tables.get("vaultCredential")!.push({ id: "copy", ciphertext: shared.ref });
    const remove = vi.spyOn(store, "delete");
    try {
      await prisma.vaultCredential.deleteMany({ where: { id: "copy" } });
      expect(queue.cleanups()).toEqual([{ ...dropped("copy", shared.ref), due: false }]);
      await queue.runQueued(worker);
      expect(remove).not.toHaveBeenCalled();
      expect(fake.values.size).toBe(1);

      await prisma.secret.deleteMany({ where: { id: "row" } });
      expect(fake.values.size).toBe(0);
      expect(queue.queued.size).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("removes the entries of installs, wallets and purchases that go with a deleted parent", async () => {
    const { fake, store, db, queue, prisma, worker } = await setup();
    const put = (value: string, recordId: string) =>
      store.put(value, context, { recordId }).then((record) => record.ref);
    const install = await put("install", "install");
    const wallet = await put("wallet", "payment-wallet:user");
    const card = await put("card", "purchase-card:purchase");
    const request = await put("request", "purchase-request:operation");
    const otherInstall = await put("other", "other-install");
    db.tables.get("messagingInstallation")!.push(
      { id: "install", userId: "user", spaceId: "space", botId: "bot", ciphertext: install },
      {
        id: "other-install",
        userId: "other",
        spaceId: "other",
        botId: "other",
        ciphertext: otherInstall,
      },
    );
    db.tables.get("paymentWallet")!.push({ id: "wallet", userId: "user", ciphertext: wallet });
    db.tables.get("purchase")!.push({
      id: "purchase",
      operationKey: "operation",
      spaceId: "space",
      userId: "user",
      cardCiphertext: card,
      requestCiphertext: request,
      tokenCiphertext: null,
    });
    const remove = vi.spyOn(store, "delete");
    try {
      remove.mockRejectedValueOnce(new Error("store unavailable"));
      await prisma.user.deleteMany({ where: { id: "user" } });
      expect(queue.cleanups()).toEqual([
        expect.objectContaining({ kind: "messaging_installation", ref: install, due: true }),
      ]);
      expect(fake.values.size).toBe(4);
      await queue.runQueued(worker);
      expect(fake.values.size).toBe(3);

      await prisma.space.deleteMany({ where: { id: "space" } });
      expect(queue.queued.size).toBe(0);
      expect([...fake.values.keys()]).toEqual([otherInstall.slice("infisical:v1:".length)]);
      expect(remove).toHaveBeenCalledWith(
        request,
        expect.objectContaining({ recordId: "purchase-request:operation" }),
      );
    } finally {
      await store.close();
    }
  });

  it("leaves a Space's many purchase entries to the queue, recorded and locked in one statement each", async () => {
    const { fake, store, db, queue, prisma, worker } = await setup();
    const purchases = 30;
    for (let i = 0; i < purchases; i++) {
      const card = await store.put("card", context, { recordId: `purchase-card:p${i}` });
      const request = await store.put("request", context, {
        recordId: `purchase-request:op${i}`,
      });
      db.tables.get("purchase")!.push({
        id: `p${i}`,
        operationKey: `op${i}`,
        spaceId: "space",
        userId: "user",
        cardCiphertext: card.ref,
        requestCiphertext: request.ref,
        tokenCiphertext: null,
      });
    }
    const locks = vi.spyOn(db.prisma, "$queryRaw");
    const remove = vi.spyOn(store, "delete");
    try {
      await prisma.space.deleteMany({ where: { id: "space" } });
      for (const [query] of locks.mock.calls)
        expect((query as unknown as { values: unknown[] }).values.length).toBeLessThanOrEqual(1);
      // Recorded as backups in the transaction, then brought forward in one call once it commits.
      const [recorded, brought] = queue.jobs.enqueueManyIn.mock.calls;
      expect(queue.jobs.enqueueManyIn).toHaveBeenCalledTimes(2);
      expect(recorded![1].every((job) => job.availableAt)).toBe(true);
      expect(brought![0]).toBe(db.prisma);
      expect(queue.jobs.enqueueIn).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      const cleanups = queue.cleanups();
      expect(cleanups).toHaveLength(purchases * 2);
      expect(cleanups.every((cleanup) => cleanup.due)).toBe(true);

      await queue.runQueued(worker);
      expect(fake.values.size).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("runs a large delete's cleanups on the in-memory queue only after the delete commits", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    const db = database();
    const queue = new InMemoryJobQueue();
    await queue.start({
      "secret.cleanup": (payload) =>
        retrySecretCleanup({ prisma: db.prisma, secrets: store }, payload),
    } as BackgroundJobHandlers);
    const prisma = withSecretPersistence(db.prisma, store, () => queue);
    for (let i = 0; i < 30; i++) {
      const card = await store.put("card", context, { recordId: `purchase-card:p${i}` });
      db.tables.get("purchase")!.push({
        id: `p${i}`,
        operationKey: `op${i}`,
        spaceId: "space",
        userId: "user",
        cardCiphertext: card.ref,
        requestCiphertext: null,
        tokenCiphertext: null,
      });
    }
    const remove = vi.spyOn(store, "delete");
    try {
      await prisma.$transaction(async (tx) => {
        await tx.space.deleteMany({ where: { id: "space" } });
        await queue.awaitIdle();
        expect(remove).not.toHaveBeenCalled();
      });
      await queue.awaitIdle();
      expect(fake.values.size).toBe(0);
    } finally {
      await queue.close();
      await store.close();
    }
  });

  it("records the backup of another member's install that goes with a deleted bot", async () => {
    const { store, db, queue, prisma } = await setup();
    const theirs = await store
      .put("theirs", context, { recordId: "their-install" })
      .then((record) => record.ref);
    db.tables.get("bot")!.push({ id: "bot", spaceId: "space" });
    db.tables.get("messagingInstallation")!.push({
      id: "their-install",
      userId: "other",
      spaceId: "space",
      botId: "bot",
      ciphertext: theirs,
    });
    vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("store unavailable"));
    try {
      await runAsTenant({ spaceId: "space", userId: "user" }, () =>
        prisma.bot.deleteMany({ where: { id: "bot" } }),
      );
      expect(queue.cleanups()).toEqual([
        expect.objectContaining({ kind: "messaging_installation", ref: theirs, due: true }),
      ]);
    } finally {
      await store.close();
    }
  });

  it("removes the copy a retired model sign-in replaced, and the marker one that lost never saved", async () => {
    const { fake, store, db, queue, prisma, worker } = await setup();
    const signedIn = await store.put('{"kind":"api_key","key":"fake-key"}', context, {
      recordId: "row",
    });
    db.tables.get("secret")!.push({ id: "row", userId: "user", ciphertext: signedIn.ref });
    db.tables
      .get("userModelCredential")!
      .push({ id: "credential", userId: "user", secretId: "row" });
    const retire = () =>
      retireToReconnectMarker(
        prisma,
        store,
        { userId: "user", spaceId: "space" },
        { id: "credential", secretId: "row" },
      )("refresh_rejected" as never, undefined);
    try {
      await expect(retire()).resolves.toBe(true);
      const marker = db.tables.get("secret")![0]!.ciphertext!;
      expect([...fake.values.keys()]).toEqual([marker.slice("infisical:v1:".length)]);
      expect(queue.queued.size).toBe(0);

      // The sign-in is gone before this retirement commits, so its marker is never saved.
      db.tables.get("userModelCredential")!.length = 0;
      vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("store unavailable"));
      await expect(retire()).resolves.toBe(false);
      expect(fake.values.size).toBe(2);
      expect(queue.cleanups()).toEqual([expect.objectContaining({ recordId: "row", due: true })]);
      await queue.runQueued(worker);
      expect([...fake.values.keys()]).toEqual([marker.slice("infisical:v1:".length)]);
    } finally {
      await store.close();
    }
  });

  it("never copies an inline reference, which is the sealed value, into a job", async () => {
    const store = new EncryptedSecretStore("fake-encryption-key");
    const db = database();
    const queue = fakeCleanupJobs();
    const prisma = withSecretPersistence(db.prisma, store, () => queue.jobs);
    const old = await store.put("old", context, { recordId: "row" });
    const next = await store.put("next", context, { recordId: "row" });
    db.tables.get("secret")!.push({ id: "row", ciphertext: old.ref });
    const remove = vi.spyOn(store, "delete");
    await prisma.secret.update({ where: { id: "row" }, data: { ciphertext: next.ref } });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(old.ref, expect.objectContaining({ recordId: "row" }));
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.secret.deleteMany({ where: { id: "row" } });
        throw new Error("fake DB failure");
      }),
    ).rejects.toThrow("fake DB failure");
    await prisma.secret.deleteMany({ where: { id: "row" } });
    expect(remove).toHaveBeenLastCalledWith(next.ref, expect.objectContaining({ recordId: "row" }));
    expect(queue.jobs.enqueue).not.toHaveBeenCalled();
    expect(queue.jobs.enqueueManyIn).not.toHaveBeenCalled();
    expect(queue.jobs.cancel).not.toHaveBeenCalled();
  });
});

describe("MCP OAuth prepared persistence", () => {
  it.each(["encrypted", "infisical"] as const)(
    "keeps %s sessions alive through their own connect and tool refresh",
    async (provider) => {
      const fake = infisicalFake();
      const store =
        provider === "encrypted"
          ? new EncryptedSecretStore("fake-encryption-key")
          : new InfisicalSecretStore(fake.options);
      const db = database();
      const prisma = withSecretPersistence(db.prisma, store);
      const initial = await store.put(
        JSON.stringify({ oauth: { tokens: { access_token: "old", token_type: "bearer" } } }),
        context,
      );
      db.tables
        .get("secret")!
        .push({ id: initial.id, ciphertext: initial.ciphertext, spaceId: "space", userId: "user" });
      db.tables.get("mcpServer")!.push({
        id: "server",
        endpoint: "https://mcp.example.test/mcp",
        secretId: initial.id,
        spaceId: "space",
        userId: "user",
      });
      const assignment = () => ({
        serverId: "server",
        allowAllTools: true,
        server: {
          ...db.tables.get("mcpServer")![0],
          slug: "demo",
          transport: "streamable_http",
          revision: 1,
          args: [],
        },
      });
      Object.assign(prisma, {
        botMcpServer: { findMany: async () => [assignment()], findFirst: async () => assignment() },
      });
      const broker = new McpOAuthBroker(prisma, store);
      const held = new Map<McpSession, OAuthClientProvider>();
      let refreshOnConnect = false;
      const closed = new Set<McpSession>();
      const connect = vi
        .spyOn(McpSession.prototype, "connectRemote")
        .mockImplementation(async function (this: McpSession, options) {
          held.set(this, options.authProvider!);
          if (refreshOnConnect)
            await options.authProvider!.saveTokens({
              access_token: "connect-refreshed",
              token_type: "bearer",
            });
          return { transport: "streamable-http", usedFallback: false };
        });
      const close = vi.spyOn(McpSession.prototype, "close").mockImplementation(async function (
        this: McpSession,
      ) {
        closed.add(this);
      });
      const list = vi
        .spyOn(McpSession.prototype, "listTools")
        .mockResolvedValue({ tools: [{ name: "echo", inputSchema: { type: "object" } }] });
      const call = vi.spyOn(McpSession.prototype, "callTool").mockImplementation(async function (
        this: McpSession,
      ) {
        await held.get(this)!.saveTokens({ access_token: "tool-refreshed", token_type: "bearer" });
        expect(closed.has(this)).toBe(false);
        return { content: [{ type: "text", text: "ok" }] };
      });
      const actor = { ...context, botId: "bot" };
      const other = new McpConnector(prisma, store, {}, broker);
      const owner = new McpConnector(prisma, store, {}, broker);
      try {
        expect(await other.discoverTools(actor)).toHaveLength(1);
        const otherSession = [...held.keys()][0]!;
        refreshOnConnect = true;
        const tools = await owner.discoverTools(actor);
        expect(tools).toHaveLength(1);
        expect(closed.has(otherSession)).toBe(true);
        const ownerSession = [...held.keys()][1]!;
        expect(closed.has(ownerSession)).toBe(false);
        refreshOnConnect = false;
        expect(await owner.discoverTools(actor)).toHaveLength(1);
        expect(connect).toHaveBeenCalledTimes(2);
        expect(await other.discoverTools(actor)).toHaveLength(1);
        const secondOther = [...held.keys()][2]!;
        const events = [];
        for await (const event of owner.execute(
          { tool: tools[0]!.name, args: {}, executionId: "call", route: tools[0]!.route },
          actor,
        ))
          events.push(event);
        expect(events.find((event) => event.type === "error")).toBeUndefined();
        expect(events).toMatchObject([{ type: "result" }]);
        expect(closed.has(secondOther)).toBe(true);
        expect(closed.has(ownerSession)).toBe(false);
        expect(await owner.discoverTools(actor)).toHaveLength(1);
        expect(connect).toHaveBeenCalledTimes(3);
      } finally {
        await owner.close();
        await other.close();
        await store.close();
        connect.mockRestore();
        close.mockRestore();
        list.mockRestore();
        call.mockRestore();
      }
    },
  );

  it("keeps slow provider I/O outside the five-second transaction and cleans CAS losers and pre-create failures", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    const db = database();
    let clock = 0;
    let active = false;
    const nativeExtend = db.prisma.$extends.bind(db.prisma);
    // Virtual time makes a healthy 15-second provider request deterministic.
    db.prisma.$extends = ((extension: never) => {
      const client = nativeExtend(extension) as unknown as PrismaClient;
      const transaction = client.$transaction.bind(client);
      client.$transaction = (async (callback: never) => {
        const start = clock;
        active = true;
        try {
          return await transaction(async (tx) => {
            const result = await (callback as (tx: Prisma.TransactionClient) => Promise<unknown>)(
              tx,
            );
            if (clock - start > 5000) throw new Error("Transaction expired");
            return result;
          });
        } finally {
          active = false;
        }
      }) as typeof client.$transaction;
      return client;
    }) as unknown as typeof db.prisma.$extends;
    const prisma = withSecretPersistence(db.prisma, store);
    db.tables.get("mcpServer")!.push({
      id: "server",
      endpoint: "https://mcp.example.test/mcp",
      secretId: null,
      spaceId: "space",
      userId: "user",
    });
    const put = store.put.bind(store);
    let race = true;
    const slowPut = vi.spyOn(store, "put").mockImplementation(async (...args) => {
      expect(active).toBe(false);
      clock += 15000;
      const record = await put(...args);
      if (race) {
        race = false;
        const staticRecord = await put(JSON.stringify({ secret: "concurrent-static" }), context);
        db.tables.get("secret")!.push({
          id: staticRecord.id,
          ciphertext: staticRecord.ciphertext,
          spaceId: "space",
          userId: "user",
        });
        db.tables.get("mcpServer")![0]!.secretId = staticRecord.id;
      }
      return record;
    });
    const load = store.load.bind(store);
    const slowLoad = vi.spyOn(store, "load").mockImplementation(async (...args) => {
      expect(active).toBe(false);
      clock += 15000;
      return load(...args);
    });
    const broker = new McpOAuthBroker(prisma, store);
    const oauth = await broker.providerFor(
      { id: "server", endpoint: "https://mcp.example.test/mcp", secretId: null },
      context,
      { material: { oauth: {} } },
    );
    try {
      await oauth!.saveTokens({ access_token: "fresh", token_type: "bearer" });
      expect(slowPut).toHaveBeenCalledTimes(2);
      expect(fake.values.size).toBe(1);
      const row = db.tables.get("secret")![0]!;
      expect(JSON.parse(await load(row.ciphertext!, row.id))).toMatchObject({
        secret: "concurrent-static",
        oauth: { tokens: { access_token: "fresh" } },
      });
      const write = await store.put("unused", context);
      await expect(
        persistPreparedSecret(prisma, store, write, () =>
          prisma.$transaction(async () => {
            throw new Error("pre-create failure");
          }),
        ),
      ).rejects.toThrow("pre-create failure");
      expect(fake.values.size).toBe(1);
      expect(clock).toBeGreaterThan(5000);
    } finally {
      slowPut.mockRestore();
      slowLoad.mockRestore();
      await store.close();
    }
  });
});

describe("prepared run-secret writes", () => {
  it.each([false, true])(
    "prepares slow secret input outside the transaction (bot credential: %s)",
    async (credentialAsk) => {
      const fake = infisicalFake();
      const store = new ComposedSecretStore(
        new EncryptedSecretStore("fake-key"),
        new InfisicalSecretStore(fake.options),
      );
      const db = database();
      const prisma = withSecretPersistence(db.prisma, store);
      const credential = credentialAsk
        ? {
            name: "example_api",
            origin: "https://api.example.test",
            auth: { type: "bearer" as const },
          }
        : undefined;
      Object.assign(prisma, {
        run: { findFirst: async () => ({ botId: "bot", userId: "user" }) },
        spaceSettingOverride: { findUnique: async () => null },
        message: {
          findFirst: async () => ({
            blocks: [
              { kind: "ask", text: "API key", input: "secret", status: "pending", credential },
            ],
          }),
        },
      });
      let active = false;
      let clock = 0;
      const put = store.put.bind(store);
      const slow = vi.spyOn(store, "put").mockImplementation(async (...args) => {
        expect(active).toBe(false);
        clock += 15000;
        return put(...args);
      });
      const writer = createRunSecretWriter(store);
      const input = {
        spaceId: "space",
        runId: "run",
        threadId: "thread",
        messageId: "message",
        answeredByUserId: "user",
        answer: "fake-value",
      };
      try {
        await writer.withPrepared!(prisma, input, async (prepared) => {
          active = true;
          const start = clock;
          try {
            await prisma.$transaction(async (tx) => {
              await prepared.store({
                botId: "bot",
                runId: "run",
                userId: "user",
                spaceId: "space",
                plaintext: input.answer,
                credential,
                remember: true,
                tx,
              });
              if (clock - start > 5000) throw new Error("Transaction expired");
            });
          } finally {
            active = false;
          }
        });
        expect(fake.values.size).toBe(credentialAsk ? 1 : 0);
        await writer.withPrepared!(prisma, input, async () => false);
        expect(fake.values.size).toBe(credentialAsk ? 1 : 0);
        expect(slow).toHaveBeenCalledTimes(2);
      } finally {
        slow.mockRestore();
        await store.close();
      }
    },
  );

  it("keeps a login sent with Save to Vault off for this run only, encrypted locally", async () => {
    const fake = infisicalFake();
    const store = new ComposedSecretStore(
      new EncryptedSecretStore("fake-key"),
      new InfisicalSecretStore(fake.options),
    );
    const db = database();
    const prisma = withSecretPersistence(db.prisma, store);
    const credential = {
      name: "example_login",
      origin: "https://login.example.test",
      auth: { type: "login" as const },
    };
    Object.assign(prisma, {
      run: { findFirst: async () => ({ botId: "bot", userId: "user" }) },
      spaceSettingOverride: { findUnique: async () => null },
      message: {
        findFirst: async () => ({
          blocks: [
            { kind: "ask", text: "Sign in", input: "secret", status: "pending", credential },
          ],
        }),
      },
    });
    const fields = [
      { label: "Username", value: "ada@example.test", hidden: false },
      { label: "Password", value: "fake-password-1", hidden: true },
    ];
    const writer = createRunSecretWriter(store);
    const answer = (remember?: false) =>
      writer.withPrepared!(
        prisma,
        {
          spaceId: "space",
          runId: "run",
          threadId: "thread",
          messageId: "message",
          answeredByUserId: "user",
          answer: "",
          fields,
          ...(remember === false ? { remember } : {}),
        },
        (prepared) =>
          prisma.$transaction((tx) =>
            prepared.store({
              botId: "bot",
              runId: "run",
              userId: "user",
              spaceId: "space",
              plaintext: encodeLoginSecret({ fields }),
              credential,
              remember: remember !== false,
              tx,
            }),
          ),
      );
    const runLogins = () =>
      db.tables.get("secret")!.filter((row) => row.kind?.startsWith("run-login:"));
    try {
      // Answering again replaces the earlier answer.
      await answer(false);
      await answer(false);
      expect(fake.values.size).toBe(0);
      expect(db.tables.get("vaultCredential")).toEqual([]);
      expect(runLogins().map((row) => row.kind)).toEqual(["run-login:run:example_login"]);
      const scope = { userId: "user", spaceId: "space" };
      expect(await findRunLogin(prisma, store, scope, "run", "example_login")).toEqual({
        origin: credential.origin,
        fields,
      });
      expect(await findRunLogin(prisma, store, scope, "other-run", "example_login")).toBe(
        undefined,
      );
      // Saving it afterwards ends the run's copy.
      await answer();
      expect(runLogins()).toEqual([]);
      expect(db.tables.get("vaultCredential")).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("keeps a code for the run's user only, as its site and digits, until a newer one replaces it", async () => {
    const store = new EncryptedSecretStore("fake-key");
    const db = database();
    const prisma = withSecretPersistence(db.prisma, store);
    const origin = "https://login.example.test";
    Object.assign(prisma, {
      run: { findFirst: async () => ({ botId: "bot", userId: "user" }) },
      spaceSettingOverride: { findUnique: async () => null },
      message: {
        findFirst: async () => ({
          blocks: [
            {
              kind: "ask",
              text: "Code",
              input: "secret",
              status: "pending",
              purpose: "otp",
              oneTimeCode: { origin },
            },
          ],
        }),
      },
    });
    const writer = createRunSecretWriter(store);
    const answer = (code: string, answeredByUserId = "user", site = origin) =>
      writer.withPrepared!(
        prisma,
        {
          spaceId: "space",
          runId: "run",
          threadId: "thread",
          messageId: "message",
          answeredByUserId,
          answer: code,
        },
        (prepared) =>
          prisma
            .$transaction((tx) =>
              prepared.store({
                botId: "bot",
                runId: "run",
                userId: "user",
                spaceId: "space",
                // The answer route hands the writer the code as the page will take it.
                plaintext: code.replace(/\s+/g, ""),
                oneTimeCode: { origin: site },
                remember: true,
                tx,
              }),
            )
            .then(() => true)
            .catch(() => false),
      );
    const codes = () => db.tables.get("secret")!.filter((row) => row.kind === "run-code:run");
    try {
      // Another member of the Space cannot answer, and a non-code is not kept.
      expect(await answer("123456", "someone-else")).toBe(false);
      expect(await answer("x".repeat(13))).toBe(false);
      expect(await answer("12")).toBe(false);
      expect(await answer("   ")).toBe(false);
      expect(codes()).toEqual([]);

      // A store for another site than the card's is refused too.
      expect(await answer("123456", "user", "https://other.example.test")).toBe(false);
      expect(codes()).toEqual([]);

      expect(await answer("123 456")).toBe(true);
      expect(codes()).toHaveLength(1);
      const [row] = codes();
      expect(row?.ciphertext).not.toContain("123456");
      expect(JSON.parse(await store.load(row!.ciphertext!, row!.id))).toEqual({
        origin,
        code: "123456",
      });

      expect(await answer("654321")).toBe(true);
      expect(codes()).toHaveLength(1);
      expect(JSON.parse(await store.load(codes()[0]!.ciphertext!, codes()[0]!.id)).code).toBe(
        "654321",
      );
      // Never kept as a saved credential or login.
      expect(db.tables.get("vaultCredential")).toEqual([]);
      expect(db.tables.get("secret")!.filter((r) => r.kind !== "run-code:run")).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("does not encrypt a secret answer over the value limit", async () => {
    const store = new EncryptedSecretStore("fake-key");
    const put = vi.spyOn(store, "put");
    const prisma = {
      run: { findFirst: async () => ({ botId: "bot", userId: "user" }) },
      message: {
        findFirst: async () => ({
          blocks: [{ kind: "ask", text: "Code", input: "secret", status: "pending" }],
        }),
      },
    } as unknown as PrismaClient;
    const writer = createRunSecretWriter(store);
    const stored = await writer.withPrepared!(
      prisma,
      {
        spaceId: "space",
        runId: "run",
        threadId: "thread",
        messageId: "message",
        answeredByUserId: "user",
        answer: "x".repeat(BOT_SECRET_VALUE_MAX_LENGTH + 1),
      },
      async (prepared) =>
        prepared
          .store({} as Parameters<typeof prepared.store>[0])
          .then(() => true)
          .catch(() => false),
    );
    expect(stored).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});
