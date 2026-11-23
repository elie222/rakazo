import { randomUUID } from "node:crypto";
import {
  EncryptedSecretStore,
  MAX_PASTED_KEYS,
  storeBotSecret,
  TooManyPastedKeysError,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  lockSpaceSettings,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

// Synthetic, built from parts so no scanner mistakes this file for a leak.
const key = ["sk", "-proj-", randomUUID().replaceAll("-", ""), "Zz9"].join("");

describe.skipIf(!enabled)("keys pasted into a chat message (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  let close: () => Promise<void>;
  let actor: Actor;
  let target: ThreadTarget;
  const secrets = new EncryptedSecretStore("test-only-encryption-key");

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    pool = db.pool;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  beforeEach(async () => {
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "test", address: `pasted-${randomUUID()}` }),
    );
    actor = { spaceId: identity.spaceId, userId: identity.userId } as Actor;
    target = {
      kind: "bot",
      botId: identity.botId,
      threadId: identity.threadId,
      bot: { computer: null },
    } as ThreadTarget;
  });
  afterEach(async () => {
    if (!actor) return;
    await system.messagingIdentity.deleteMany({ where: { userId: actor.userId } });
    await system.organization.deleteMany({ where: { id: actor.spaceId } });
    await system.user.deleteMany({ where: { id: actor.userId } });
  });
  afterAll(async () => {
    await close?.();
  });

  function send(text: string) {
    return runAsTenant(actor, () =>
      sendThreadMessage(
        {
          prisma,
          events: { notify: vi.fn().mockResolvedValue(undefined) } as never,
          jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never,
          sandbox: {} as never,
          secrets,
        },
        actor,
        target,
        { text, clientNonce: randomUUID() },
      ),
    );
  }

  async function stored() {
    const [messages, tasks, events] = await Promise.all([
      system.message.findMany({ where: { threadId: target.threadId, role: "user" } }),
      system.task.findMany({ where: { threadId: target.threadId } }),
      system.event.findMany({ where: { threadId: target.threadId } }),
    ]);
    return JSON.stringify({ messages, tasks, events });
  }

  it("keeps the key only in the vault, saved as a command variable", async () => {
    await send(`Deploy with ${key} please`);

    const written = await stored();
    expect(written).not.toContain(key);
    const variable = /Deploy with \[saved as \$(PASTED_KEY_[0-9A-F]{6})\] please/.exec(
      written,
    )?.[1];
    const item = await system.vaultCredential.findFirstOrThrow({
      where: { userId: actor.userId, name: variable?.toLowerCase().replaceAll("_", "-") },
    });
    expect(item.auth).toEqual({ type: "command" });
    expect(await secrets.load(item.ciphertext, item.id)).toBe(key);
  });

  it.each([
    ["a key already saved", {}, "allow"],
    ["a key blocked for bots", { policy: "off" as const }, "off"],
    ["a key limited to chosen bots", { bots: { allBots: false, botIds: [] } }, "off"],
  ])("saves %s again under a new name, blocked only if it was", async (_, access, policy) => {
    await runAsTenant(actor, () =>
      storeBotSecret({
        prisma,
        secretStore: secrets,
        scope: { userId: actor.userId, spaceId: actor.spaceId },
        destination: { name: "deploy-key", origin: "", auth: { type: "command" } },
        plaintext: key,
        ...access,
      }),
    );

    await send(`Use ${key}`);

    const variable = /Use \[saved as \$(PASTED_KEY_[0-9A-F]{6})\]/.exec(await stored())?.[1];
    const copy = await system.vaultCredential.findFirstOrThrow({
      where: { userId: actor.userId, name: variable?.toLowerCase().replaceAll("_", "-") },
    });
    expect(copy.policy).toBe(policy);
    expect(await system.vaultCredential.count({ where: { userId: actor.userId } })).toBe(2);
  });

  it("refuses a message with more keys than one message may save and keeps none of it", async () => {
    const keys = Array.from({ length: MAX_PASTED_KEYS + 1 }, (_, n) => `${key}${n}`);

    await expect(send(keys.join(" "))).rejects.toBeInstanceOf(TooManyPastedKeysError);

    expect(await system.message.count({ where: { threadId: target.threadId, role: "user" } })).toBe(
      0,
    );
    expect(await system.vaultCredential.count({ where: { userId: actor.userId } })).toBe(0);
  });

  // A secret card's answer locks the thread and then the vault; a send must not take them the
  // other way round, or each waits on the other until one is aborted.
  it("commits alongside a secret card answer that holds the thread", async () => {
    const probe = await runAsSystem("lock probe", () => pool.connect());
    const threadLocked = deferred<string>();
    const resumed = deferred();
    let sending: Promise<unknown> = Promise.resolve();
    const answer = system.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
      const [row] = await tx.$queryRaw<Array<{ xactId: string }>>`
        SELECT pg_current_xact_id()::text AS "xactId"`;
      threadLocked.resolve(row?.xactId ?? "");
      await resumed.promise;
      // Gives up before the send's deadlock check would abort and retry the send instead.
      await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
      await lockSpaceSettings(tx, actor);
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${actor.userId} FOR UPDATE`;
    });
    try {
      const xactId = await threadLocked.promise;
      sending = send(`Deploy with ${key}`);
      sending.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const waiting = await probe.query(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
            [xactId],
          );
          expect(waiting.rows[0].n).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );
      resumed.resolve();
      await expect(answer).resolves.toBeUndefined();
      await expect(sending).resolves.toBeDefined();
    } finally {
      resumed.resolve();
      await Promise.allSettled([answer, sending]);
      probe.release();
    }
  }, 20_000);
});
