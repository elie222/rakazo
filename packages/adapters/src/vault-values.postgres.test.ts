import { randomBytes, randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { BotSecretDestination } from "@rakazo/contracts";
import {
  asSystem,
  ciphertextKeyId,
  contentEncryptionOf,
  contentEncryptionStatus,
  createDb,
  LocalKeyProvider,
  masterKeysFromEnv,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLoginFill, revealBotSecret, storeBotSecret } from "./bot-secrets.js";
import { EncryptedSecretStore } from "./secrets.js";
import { migrateVaultValues, rotateVaultKeys, vaultItemsUnderOlderKeys } from "./vault-values.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

const login = {
  origin: "https://login.example.test",
  auth: { type: "login" },
} as const;
const value = (password: string) =>
  JSON.stringify({ fields: [{ label: "Password", value: password, hidden: true }] });

/** The client, with its next transaction stopped at its credential count until `during` returns. */
function pausedAfterRead<T extends object>(prisma: T, during: () => Promise<unknown>): T {
  let pending = true;
  const bound = (target: object, key: PropertyKey) => {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  };
  return new Proxy(prisma, {
    get(target, key) {
      if (key !== "$transaction") return bound(target, key);
      return (run: (tx: object) => Promise<unknown>, options?: unknown) =>
        (
          Reflect.get(target, "$transaction") as (
            run: (tx: object) => Promise<unknown>,
            options?: unknown,
          ) => Promise<unknown>
        ).call(
          target,
          (tx: object) =>
            run(
              new Proxy(tx, {
                get(client, model) {
                  if (model !== "vaultCredential") return bound(client, model);
                  const delegate = Reflect.get(client, model) as object;
                  return new Proxy(delegate, {
                    get(methods, method) {
                      if (method !== "count" || !pending) return bound(methods, method);
                      return async (args: unknown) => {
                        pending = false;
                        await during();
                        return Reflect.get(methods, method).call(methods, args);
                      };
                    },
                  });
                },
              }),
            ),
          options,
        );
    },
  });
}

describePostgres("vault values under the content keys (PostgreSQL)", () => {
  const address = `vault-values-${randomUUID()}@rakazo.test`;
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const keyProvider = new LocalKeyProvider([
    { id: "vault-test", key: randomBytes(32) },
    ...masterKeysFromEnv(),
  ]);
  let sealing: ReturnType<typeof createDb>;
  // A deployment with content encryption off writes vault values as before.
  let plain: ReturnType<typeof createDb>;
  let system: ReturnType<typeof createDb>["prisma"];
  let scope: { userId: string; spaceId: string };
  let context: AdapterContext;

  beforeAll(async () => {
    sealing = createDb(url!, { keyProvider, encryptContent: true });
    plain = createDb(url!, { keyProvider, encryptContent: false });
    system = asSystem(sealing.prisma);
    scope = await runAsSystem("vault values fixture", () =>
      provisionMessagingIdentity(
        sealing.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    context = {
      operationId: "vault-values",
      traceId: "vault-values",
      ...scope,
      signal: new AbortController().signal,
    };
  });

  afterAll(async () => {
    if (scope) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: scope.spaceId } });
      await system.user.deleteMany({ where: { id: scope.userId } });
    }
    for (const db of [sealing, plain]) {
      if (!db) continue;
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  const save = (prisma: typeof sealing.prisma, name: string, password: string) =>
    runAsTenant(scope, () =>
      storeBotSecret({
        prisma,
        secretStore,
        scope,
        destination: { ...login, name } as BotSecretDestination,
        plaintext: value(password),
      }),
    );
  const fill = (name: string) =>
    runAsTenant(scope, () =>
      resolveLoginFill({
        prisma: sealing.prisma,
        secretStore,
        scope,
        runId: "run-1",
        name,
        field: "password",
      }),
    );
  const rows = () =>
    system.vaultCredential.findMany({ where: { userId: scope.userId }, orderBy: { name: "asc" } });

  const memberKeys = () => system.spaceKey.findMany({ where: { spaceId: `user:${scope.userId}` } });
  const waiting = async () =>
    (await contentEncryptionStatus(system)).tables.find((t) => t.table === "vault_credentials")!
      .plaintext;

  it("moves old rows beside new ones, once, and back for a rollback", async () => {
    await save(plain.prisma, "old", "fake-old-password");
    await save(plain.prisma, "broken", "fake-broken-password");
    // Until migrate creates the vault's key, saves keep the format the previous release reads.
    await save(sealing.prisma, "new", "fake-new-password");
    const [broken, newer, old] = await rows();
    expect(old!.ciphertext).toMatch(/^v2:/);
    expect(newer!.ciphertext).toMatch(/^v2:/);
    await system.vaultCredential.update({
      where: { id: broken!.id },
      data: {
        ciphertext: `v2:${Buffer.alloc(64).toString("base64")}`,
        updatedAt: broken!.updatedAt,
      },
    });
    expect(await fill("old")).toMatchObject({ text: "fake-old-password" });
    expect(await fill("new")).toMatchObject({ text: "fake-new-password" });

    const migrate = (mode: "encrypt" | "decrypt") =>
      runAsSystem("vault values migration", () =>
        migrateVaultValues(sealing.prisma, secretStore, context, { mode }),
      );
    const before = await waiting();
    await runAsSystem("vault values preview", () =>
      migrateVaultValues(sealing.prisma, secretStore, context, { mode: "encrypt", dryRun: true }),
    );
    expect(await memberKeys()).toEqual([]);
    // Other suites may share the database, so only this member's rows are checked by value.
    expect((await migrate("encrypt")).failed).toBeGreaterThanOrEqual(1);
    expect(await waiting()).toBeLessThanOrEqual(before - 2);
    const [key] = await memberKeys();
    expect((await rows()).find((row) => row.name === "new")!.ciphertext).toContain(key!.id);
    const after = await rows();
    expect(after.find((row) => row.name === "old")).toMatchObject({
      ciphertext: expect.stringMatching(/^rkz1:/),
      updatedAt: old!.updatedAt,
    });
    expect(after.find((row) => row.name === "broken")!.ciphertext).toBe(
      `v2:${Buffer.alloc(64).toString("base64")}`,
    );
    expect(await fill("old")).toMatchObject({ text: "fake-old-password" });
    await migrate("encrypt");
    expect(await rows()).toEqual(after);
    await save(sealing.prisma, "newest", "fake-newest-password");
    expect((await rows()).find((row) => row.name === "newest")!.ciphertext).toMatch(/^rkz1:/);
    expect(await fill("newest")).toMatchObject({ text: "fake-newest-password" });

    await migrate("decrypt");
    for (const row of (await rows()).filter((row) => row.name !== "broken")) {
      expect(row.ciphertext).toMatch(/^v2:/);
      expect(await secretStore.load(row.ciphertext, row.id)).toContain("fake-");
    }
    expect(
      await runAsTenant(scope, () =>
        revealBotSecret({ prisma: sealing.prisma, secretStore, scope, name: "new" }),
      ),
    ).toMatchObject({ fields: [{ value: "fake-new-password" }] });
  });

  it("keeps a save and migrate from undoing each other on the same item", async () => {
    // Its own member, so the vault has no key yet and the save prepares the older format.
    const raceAddress = `vault-race-${randomUUID()}@rakazo.test`;
    const race = await runAsSystem("vault race fixture", () =>
      provisionMessagingIdentity(
        sealing.prisma,
        { provider: "email", address: raceAddress },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const applicationName = `vault-race-${randomUUID()}`;
    const migrating = createDb(url!, { keyProvider, encryptContent: true, applicationName });
    try {
      const saveAs = (prisma: typeof sealing.prisma, password: string) =>
        runAsTenant(race, () =>
          storeBotSecret({
            prisma,
            secretStore,
            scope: race,
            destination: { ...login, name: "site" } as BotSecretDestination,
            plaintext: value(password),
          }),
        );
      await saveAs(sealing.prisma, "fake-old-password");
      const reports = new Map<string, string>();
      let migration: Promise<unknown> | undefined;
      // Holds the save inside its transaction, after it read the item and before it writes,
      // while migrate runs: until migrate is done or waiting on a lock the save holds, such as
      // the member's, which creating the member's vault key waits on from its own connection.
      const blocked = async () => {
        for (let tries = 0; tries < 500; tries++) {
          const { rows } = await sealing.pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE application_name IN ($1, $1 || '-keys') AND wait_event_type = 'Lock'`,
            [applicationName],
          );
          if (rows[0]!.n > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("migrate neither finished nor waited");
      };
      const barrier = async () => {
        migration = runAsSystem("vault race migration", () =>
          migrateVaultValues(migrating.prisma, secretStore, context, {
            mode: "encrypt",
            report: (row, status) => reports.set(row.id, status),
          }),
        );
        await Promise.race([migration, blocked()]);
      };
      await saveAs(pausedAfterRead(sealing.prisma, barrier), "fake-new-password");
      await migration;
      const [item] = await system.vaultCredential.findMany({ where: { userId: race.userId } });
      // Either migrate moved the item first and the save sealed again under the key, or the save
      // went first and migrate reported it changed concurrently; never a migrated item undone.
      if (item!.ciphertext.startsWith("v2:")) expect(reports.get(item!.id)).toBe("concurrent");
      else expect(item!.ciphertext).toMatch(/^rkz1:/);
      expect(
        await runAsTenant(race, () =>
          revealBotSecret({ prisma: sealing.prisma, secretStore, scope: race, name: "site" }),
        ),
      ).toMatchObject({ fields: [{ value: "fake-new-password" }] });
      await runAsSystem("vault race rerun", () =>
        migrateVaultValues(migrating.prisma, secretStore, context, { mode: "encrypt" }),
      );
      expect(
        (await system.vaultCredential.findUnique({ where: { id: item!.id } }))!.ciphertext,
      ).toMatch(/^rkz1:/);
    } finally {
      await system.messagingIdentity.deleteMany({ where: { address: raceAddress } });
      await system.organization.deleteMany({ where: { id: race.spaceId } });
      await system.user.deleteMany({ where: { id: race.userId } });
      await migrating.prisma.$disconnect();
      await migrating.pool.end();
    }
  });

  it("gives vault keys a new version and moves items under it", async () => {
    const rotateAddress = `vault-rotate-${randomUUID()}@rakazo.test`;
    const member = await runAsSystem("vault rotation fixture", () =>
      provisionMessagingIdentity(
        sealing.prisma,
        { provider: "email", address: rotateAddress },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    try {
      await runAsTenant(member, () =>
        storeBotSecret({
          prisma: sealing.prisma,
          secretStore,
          scope: member,
          destination: { ...login, name: "site" } as BotSecretDestination,
          plaintext: value("fake-rotated-password"),
        }),
      );
      const reports = new Map<string, string>();
      const migrate = (mode: "encrypt" | "reencrypt") =>
        runAsSystem("vault values migration", () =>
          migrateVaultValues(sealing.prisma, secretStore, context, {
            mode,
            report: (row, status) => reports.set(row.id, status),
          }),
        );
      const item = async () =>
        (await system.vaultCredential.findMany({ where: { userId: member.userId } }))[0]!;
      const versions = () =>
        system.spaceKey.findMany({
          where: { spaceId: `user:${member.userId}` },
          orderBy: { version: "asc" },
        });
      await migrate("encrypt");
      const before = await item();
      const [first] = await versions();
      expect(before.ciphertext).toContain(first!.id);

      expect(
        await runAsSystem("vault key rotation", () => rotateVaultKeys(sealing.prisma)),
      ).toMatchObject({ rotated: expect.any(Number), ownerGone: 0, failed: 0 });
      const [, second] = await versions();
      expect(second).toMatchObject({ version: 2 });
      await migrate("reencrypt");
      expect(reports.get(before.id)).toBe("migrated");
      expect(await item()).toMatchObject({
        ciphertext: expect.stringContaining(second!.id),
        updatedAt: before.updatedAt,
      });
      expect(
        await runAsTenant(member, () =>
          revealBotSecret({ prisma: sealing.prisma, secretStore, scope: member, name: "site" }),
        ),
      ).toMatchObject({ fields: [{ value: "fake-rotated-password" }] });
    } finally {
      await system.messagingIdentity.deleteMany({ where: { address: rotateAddress } });
      await system.organization.deleteMany({ where: { id: member.spaceId } });
      await system.user.deleteMany({ where: { id: member.userId } });
    }
  });

  it("moves items to a version another process rotated to while this one had the old one cached", async () => {
    const raceAddress = `vault-stale-${randomUUID()}@rakazo.test`;
    const member = await runAsSystem("vault stale key fixture", () =>
      provisionMessagingIdentity(
        sealing.prisma,
        { provider: "email", address: raceAddress },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    // A second process, with its own key cache.
    const other = createDb(url!, { keyProvider, encryptContent: true });
    try {
      for (const name of ["site", "bank"])
        await runAsTenant(member, () =>
          storeBotSecret({
            prisma: sealing.prisma,
            secretStore,
            scope: member,
            destination: { ...login, name } as BotSecretDestination,
            plaintext: value(`fake-${name}-password`),
          }),
        );
      const reports = new Map<string, string>();
      const migrate = (prisma: typeof sealing.prisma, mode: "encrypt" | "reencrypt") =>
        runAsSystem("vault values migration", () =>
          migrateVaultValues(prisma, secretStore, context, {
            mode,
            report: (row, status) => reports.set(row.id, status),
          }),
        );
      const items = () =>
        system.vaultCredential.findMany({
          where: { userId: member.userId },
          orderBy: { name: "asc" },
        });
      const versions = () =>
        system.spaceKey.findMany({
          where: { spaceId: `user:${member.userId}` },
          orderBy: { version: "asc" },
        });
      await migrate(sealing.prisma, "encrypt");
      // The other process caches version 1 as the newest.
      await migrate(other.prisma, "reencrypt");
      const [first] = await versions();
      expect((await items()).map((item) => ciphertextKeyId(item.ciphertext))).toEqual([
        first!.id,
        first!.id,
      ]);

      await runAsSystem("vault key rotation", () => rotateVaultKeys(sealing.prisma));
      const [, second] = await versions();
      reports.clear();
      await migrate(other.prisma, "reencrypt");
      const moved = await items();
      expect(moved.map((item) => ciphertextKeyId(item.ciphertext))).toEqual([
        second!.id,
        second!.id,
      ]);
      expect(moved.map((item) => reports.get(item.id))).toEqual(["migrated", "migrated"]);
    } finally {
      await other.prisma.$disconnect();
      await other.pool.end();
      await system.messagingIdentity.deleteMany({ where: { address: raceAddress } });
      await system.organization.deleteMany({ where: { id: member.spaceId } });
      await system.user.deleteMany({ where: { id: member.userId } });
    }
  });

  it("counts items a process saved under its cached key version after a rotation, until reencrypt moves them", async () => {
    const windowAddress = `vault-window-${randomUUID()}@rakazo.test`;
    const member = await runAsSystem("vault key window fixture", () =>
      provisionMessagingIdentity(
        sealing.prisma,
        { provider: "email", address: windowAddress },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    // A second process, with its own key cache.
    const other = createDb(url!, { keyProvider, encryptContent: true });
    try {
      const saveWith = (prisma: typeof sealing.prisma, name: string) =>
        runAsTenant(member, () =>
          storeBotSecret({
            prisma,
            secretStore,
            scope: member,
            destination: { ...login, name } as BotSecretDestination,
            plaintext: value(`fake-${name}-password`),
          }),
        );
      const reencrypt = () =>
        runAsSystem("vault values migration", () =>
          migrateVaultValues(sealing.prisma, secretStore, context, { mode: "reencrypt" }),
        );
      const olderKeys = () =>
        runAsSystem("vault status", () => vaultItemsUnderOlderKeys(sealing.prisma));
      await saveWith(sealing.prisma, "site");
      await runAsSystem("vault values migration", () =>
        migrateVaultValues(sealing.prisma, secretStore, context, { mode: "encrypt" }),
      );
      await saveWith(other.prisma, "warm"); // the other process caches version 1
      await runAsSystem("vault key rotation", () => rotateVaultKeys(sealing.prisma));
      await reencrypt();
      // Other tests' damaged items may stay behind; this vault's are counted on top of them.
      const settled = await olderKeys();

      await saveWith(other.prisma, "later");
      const later = await system.vaultCredential.findFirstOrThrow({
        where: { userId: member.userId, name: "later" },
      });
      const [first] = await system.spaceKey.findMany({
        where: { spaceId: `user:${member.userId}` },
        orderBy: { version: "asc" },
      });
      expect(ciphertextKeyId(later.ciphertext)).toBe(first!.id);
      expect(await olderKeys()).toBe(settled + 1);
      await reencrypt();
      expect(await olderKeys()).toBe(settled);
    } finally {
      await other.prisma.$disconnect();
      await other.pool.end();
      await system.messagingIdentity.deleteMany({ where: { address: windowAddress } });
      await system.organization.deleteMany({ where: { id: member.spaceId } });
      await system.user.deleteMany({ where: { id: member.userId } });
    }
  });

  it("leaves items in the previous format to migrate when re-encrypting, creating no vault key", async () => {
    const oldAddress = `vault-old-format-${randomUUID()}@rakazo.test`;
    const member = await runAsSystem("vault old format fixture", () =>
      provisionMessagingIdentity(
        sealing.prisma,
        { provider: "email", address: oldAddress },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    try {
      await runAsTenant(member, () =>
        storeBotSecret({
          prisma: sealing.prisma,
          secretStore,
          scope: member,
          destination: { ...login, name: "site" } as BotSecretDestination,
          plaintext: value("fake-keyed-password"),
        }),
      );
      const migrate = (mode: "encrypt" | "reencrypt") =>
        runAsSystem("vault values migration", () =>
          migrateVaultValues(sealing.prisma, secretStore, context, { mode }),
        );
      await migrate("encrypt");
      // In the previous format: one beside the keyed item, one in the Space vault, which has no key.
      for (const [name, spaceId] of [
        ["old-account", null],
        ["old-space", member.spaceId],
      ] as const) {
        const id = randomUUID();
        const { ciphertext } = await secretStore.put(value("fake-old-password"), context, {
          recordId: id,
        });
        await system.vaultCredential.create({
          data: {
            id,
            userId: member.userId,
            spaceId,
            name,
            origin: login.origin,
            auth: login.auth,
            ciphertext,
          },
        });
      }
      const oldItems = () =>
        system.vaultCredential.findMany({
          where: { userId: member.userId, name: { startsWith: "old-" } },
          orderBy: { name: "asc" },
        });
      const spaceVaultKeys = () =>
        system.spaceKey.count({ where: { spaceId: `vault:${member.spaceId}` } });
      const before = await oldItems();
      expect(before).toHaveLength(2);

      const reencrypt = async () => {
        const counts = await migrate("reencrypt");
        expect(await spaceVaultKeys()).toBe(0);
        expect(await oldItems()).toEqual(before);
        expect(counts.notMigrated).toBeGreaterThanOrEqual(2);
      };
      await reencrypt();
      // rotate --reencrypt
      await runAsSystem("vault key rotation", () => rotateVaultKeys(sealing.prisma));
      await reencrypt();
    } finally {
      await system.messagingIdentity.deleteMany({ where: { address: oldAddress } });
      await system.organization.deleteMany({ where: { id: member.spaceId } });
      await system.user.deleteMany({ where: { id: member.userId } });
    }
  });

  it.each([
    ["migrate", "encrypt", "first run"],
    ["migrate", "encrypt", "second run"],
    ["decrypt", "decrypt", "second run"],
    ["reencrypt", "reencrypt", "rotated"],
  ] as const)(
    "counts a member's items deleted with them after %s listed them as changed, not failed (%s, %s)",
    async (_command, mode, state) => {
      const goneAddress = `vault-gone-${randomUUID()}@rakazo.test`;
      const doomed = await runAsSystem("vault deletion fixture", () =>
        provisionMessagingIdentity(
          sealing.prisma,
          { provider: "email", address: goneAddress },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      );
      const remove = async () => {
        await system.messagingIdentity.deleteMany({ where: { address: goneAddress } });
        await system.organization.deleteMany({ where: { id: doomed.spaceId } });
        await system.user.deleteMany({ where: { id: doomed.userId } });
      };
      // The command's own process, which has none of the member's keys cached.
      const command = createDb(url!, { keyProvider, encryptContent: true });
      try {
        const vault = `user:${doomed.userId}`;
        for (const name of ["one", "two"])
          await runAsTenant(doomed, () =>
            storeBotSecret({
              prisma: plain.prisma,
              secretStore,
              scope: doomed,
              destination: { ...login, name } as BotSecretDestination,
              plaintext: value(`fake-${name}-password`),
            }),
          );
        const migrate = (
          prisma: typeof sealing.prisma,
          mode: "encrypt" | "decrypt" | "reencrypt",
        ) =>
          runAsSystem("vault values migration", () =>
            migrateVaultValues(prisma, secretStore, { ...context, ...doomed }, { mode }),
          );
        if (state !== "first run") await migrate(sealing.prisma, "encrypt");
        if (state === "rotated")
          await runAsSystem("vault rotation", () =>
            contentEncryptionOf(sealing.prisma)!.ring.rotate(vault),
          );
        // The member is deleted once their items are listed, before the first is rewritten.
        let deleted = false;
        const listing = new Proxy(command.prisma, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (key !== "vaultCredential")
              return typeof value === "function" ? value.bind(target) : value;
            return new Proxy(target.vaultCredential, {
              get(delegate, method) {
                const fn = Reflect.get(delegate, method);
                if (method !== "findMany") return typeof fn === "function" ? fn.bind(delegate) : fn;
                return async (args: Parameters<typeof delegate.findMany>[0]) => {
                  const batch = (await Reflect.apply(fn, delegate, [args])) as { userId: string }[];
                  if (!deleted && batch.some((row) => row.userId === doomed.userId)) {
                    deleted = true;
                    await remove();
                  }
                  return batch;
                };
              },
            });
          },
        });
        const items = (
          await system.vaultCredential.findMany({ where: { userId: doomed.userId } })
        ).map((row) => row.id);
        // Other suites may share the database, so only this member's items are checked.
        const reported: string[] = [];
        await runAsSystem("vault values migration", () =>
          migrateVaultValues(
            listing,
            secretStore,
            { ...context, ...doomed },
            {
              mode,
              report: (row, status, reason) => {
                if (items.includes(row.id)) reported.push(`${status}${reason ? ` ${reason}` : ""}`);
              },
            },
          ),
        );
        expect(reported).toEqual(["concurrent", "concurrent"]);
        expect(await system.vaultCredential.count({ where: { userId: doomed.userId } })).toBe(0);
        expect(await system.spaceKey.findMany({ where: { spaceId: vault } })).toEqual([]);
      } finally {
        await remove();
        await command.prisma.$disconnect();
        await command.pool.end();
      }
    },
  );

  it("keeps rotating vault keys past a member deleted after they were listed", async () => {
    const addresses = [0, 1].map(() => `vault-rotate-gone-${randomUUID()}@rakazo.test`);
    const [doomed, kept] = await runAsSystem("vault rotation fixture", () =>
      Promise.all(
        addresses.map((address) =>
          provisionMessagingIdentity(
            sealing.prisma,
            { provider: "email", address },
            { signupsEnabled: undefined, signupAllowlist: undefined },
          ),
        ),
      ),
    );
    const remove = async () => {
      await system.messagingIdentity.deleteMany({ where: { address: { in: addresses } } });
      await system.organization.deleteMany({
        where: { id: { in: [doomed!.spaceId, kept!.spaceId] } },
      });
      await system.user.deleteMany({ where: { id: { in: [doomed!.userId, kept!.userId] } } });
    };
    try {
      const ring = contentEncryptionOf(sealing.prisma)!.ring;
      const [gone, stays] = [`user:${doomed!.userId}`, `user:${kept!.userId}`];
      await runAsSystem("vault rotation fixture", () =>
        Promise.all([ring.current(gone), ring.current(stays)]),
      );
      // The member is deleted once the keys are listed, before theirs is rotated.
      let deleted = false;
      const listing = new Proxy(sealing.prisma, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== "spaceKey") return typeof value === "function" ? value.bind(target) : value;
          return {
            groupBy: async (args: Parameters<typeof target.spaceKey.groupBy>[0]) => {
              const scopes = await Reflect.apply(target.spaceKey.groupBy, target.spaceKey, [args]);
              if (!deleted) {
                deleted = true;
                await system.messagingIdentity.deleteMany({ where: { address: addresses[0] } });
                await system.organization.deleteMany({ where: { id: doomed!.spaceId } });
                await system.user.deleteMany({ where: { id: doomed!.userId } });
              }
              return scopes;
            },
          };
        },
      });
      const reports: string[] = [];
      const counts = await runAsSystem("vault key rotation", () =>
        rotateVaultKeys(listing, { report: (scope, status) => reports.push(`${scope} ${status}`) }),
      );
      expect(counts).toMatchObject({ ownerGone: 1, failed: 0 });
      expect(reports).toEqual([`${gone} owner gone`]);
      const versions = await system.spaceKey.findMany({
        where: { spaceId: { in: [gone, stays] } },
        orderBy: { version: "asc" },
        select: { spaceId: true, version: true },
      });
      expect(versions).toEqual([
        { spaceId: stays, version: 1 },
        { spaceId: stays, version: 2 },
      ]);
    } finally {
      await remove();
    }
  });

  it("shreds vault keys with their Space and their member", async () => {
    // Its own member, with both vault keys, so it does not depend on the tests before it.
    const shredAddress = `vault-shred-${randomUUID()}@rakazo.test`;
    const member = await runAsSystem("vault shred fixture", () =>
      provisionMessagingIdentity(
        sealing.prisma,
        { provider: "email", address: shredAddress },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    try {
      const ring = contentEncryptionOf(sealing.prisma)!.ring;
      const [space, user] = [`vault:${member.spaceId}`, `user:${member.userId}`];
      await ring.current(space);
      await ring.current(user);
      const keys = (scopes: string[]) =>
        system.spaceKey.count({ where: { spaceId: { in: scopes } } });
      expect(await keys([space, user])).toBe(2);
      await system.messagingIdentity.deleteMany({ where: { address: shredAddress } });
      await system.organization.deleteMany({ where: { id: member.spaceId } });
      expect(await keys([space])).toBe(0);
      // The member's account vault outlives the Space.
      expect(await keys([user])).toBe(1);
      await system.user.deleteMany({ where: { id: member.userId } });
      expect(await keys([space, user])).toBe(0);
    } finally {
      await system.messagingIdentity.deleteMany({ where: { address: shredAddress } });
      await system.organization.deleteMany({ where: { id: member.spaceId } });
      await system.user.deleteMany({ where: { id: member.userId } });
    }
  });
});
