import { randomUUID } from "node:crypto";
import { EncryptedSecretStore, storeBotSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
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
  let close: () => Promise<void>;
  let actor: Actor;
  let target: ThreadTarget;
  const secrets = new EncryptedSecretStore("test-only-encryption-key");

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
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
    expect(written).toContain("Deploy with [saved as $PASTED_KEY] please");
    const item = await system.vaultCredential.findFirstOrThrow({
      where: { userId: actor.userId, name: "pasted-key" },
    });
    expect(item.auth).toEqual({ type: "command" });
    expect(await secrets.load(item.ciphertext, item.id)).toBe(key);
  });

  it("names a key already saved as a command variable by its saved name", async () => {
    await runAsTenant(actor, () =>
      storeBotSecret({
        prisma,
        secretStore: secrets,
        scope: { userId: actor.userId, spaceId: actor.spaceId },
        destination: { name: "deploy-key", origin: "", auth: { type: "command" } },
        plaintext: key,
      }),
    );

    await send(`Use ${key}`);

    expect(await stored()).toContain("Use [saved as $DEPLOY_KEY]");
    expect(await system.vaultCredential.count({ where: { userId: actor.userId } })).toBe(1);
  });
});
