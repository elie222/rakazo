import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitBotUpdate } from "./bot-update.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import {
  botModelConnectionId,
  copyBotModelConnection,
  findBotModelCredential,
} from "./model-credentials.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("a bot's model connection (PostgreSQL)", () => {
  const provider = "sendblue";
  const seed = Math.floor(Math.random() * 9_000_000 + 1_000_000);
  const addresses = [`+1556${seed}`, `+1557${seed}`];
  const model = "claude-opus";
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };
  let other: { userId: string; spaceId: string };
  let opusOnSubscription: string;
  let opusOnApiKey: string;

  const actor = () => ({
    userId: owner.userId,
    spaceId: owner.spaceId,
    email: "connections@example.com",
    isDeploymentOwner: false,
  });
  const connection = (label: string, userId = owner.userId) =>
    asSystem(prisma, "test fixture").userModelCredential.create({
      data: { userId, provider: "anthropic", label, secretId: `secret-${label}` },
    });
  const newBot = async (name: string) => {
    const bot = await runAsTenant(owner, () =>
      createRepos(prisma).createBot(actor(), {
        name,
        description: "",
        instructions: "",
        notifyOnFinish: true,
      }),
    );
    await asSystem(prisma, "test fixture").bot.update({
      where: { id: bot.id },
      data: { modelProvider: "anthropic", modelId: model },
    });
    return bot.id;
  };
  const pin = (botId: string, credentialId: string) =>
    runAsTenant(owner, () =>
      prisma.userBotModelConnection.create({
        data: { userId: owner.userId, botId, provider: "anthropic", modelId: model, credentialId },
      }),
    );
  const served = (botId: string, scope = owner, modelId = model) =>
    runAsTenant(scope, () => findBotModelCredential(prisma, scope, botId, "anthropic", modelId));

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const provision = (address: string) =>
      runAsSystem("test fixture", () =>
        provisionMessagingIdentity(
          prisma,
          { provider, address },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      );
    owner = await provision(addresses[0]!);
    other = await provision(addresses[1]!);
    opusOnSubscription = (await connection("subscription")).id;
    opusOnApiKey = (await connection("api-key")).id;
  });

  afterAll(async () => {
    if (prisma && owner && other) {
      const system = asSystem(prisma, "test fixture cleanup");
      await system.messagingIdentity.deleteMany({
        where: { provider, address: { in: addresses } },
      });
      await system.organization.deleteMany({
        where: { id: { in: [owner.spaceId, other.spaceId] } },
      });
      await system.user.deleteMany({ where: { id: { in: [owner.userId, other.userId] } } });
    }
    await close?.();
  });

  it("runs the same model on a different connection for each bot", async () => {
    const [first, second] = [await newBot("First"), await newBot("Second")];
    await pin(first, opusOnSubscription);
    await pin(second, opusOnApiKey);

    await expect(served(first)).resolves.toMatchObject({ id: opusOnSubscription });
    await expect(served(second)).resolves.toMatchObject({ id: opusOnApiKey });
  });

  it("saves a chosen connection in the same write as the model", async () => {
    const botId = await newBot("Saved together");
    const thread = await runAsTenant(owner, () => createRepos(prisma).getBot(actor(), botId));

    await runAsTenant(owner, () =>
      commitBotUpdate({
        prisma,
        notify: async () => undefined,
        spaceId: owner.spaceId,
        threadId: thread.thread!.id,
        botId,
        emitBotUpdated: false,
        data: { modelProvider: "anthropic", modelId: "claude-haiku" },
        modelConnection: {
          userId: owner.userId,
          provider: "anthropic",
          modelId: "claude-haiku",
          credentialId: opusOnApiKey,
        },
      }),
    );

    await expect(served(botId, owner, "claude-haiku")).resolves.toMatchObject({ id: opusOnApiKey });
  });

  it("goes back to the usual connection when the choice is removed", async () => {
    const botId = await newBot("Removed");
    await pin(botId, opusOnApiKey);
    const thread = await runAsTenant(owner, () => createRepos(prisma).getBot(actor(), botId));

    await runAsTenant(owner, () =>
      commitBotUpdate({
        prisma,
        notify: async () => undefined,
        spaceId: owner.spaceId,
        threadId: thread.thread!.id,
        botId,
        emitBotUpdated: false,
        data: {},
        clearModelConnectionFor: owner.userId,
      }),
    );

    await expect(
      runAsTenant(owner, () => botModelConnectionId(prisma, actor(), botId, "anthropic", model)),
    ).resolves.toBeUndefined();
  });

  it("copies a member's choice to a duplicate of the bot", async () => {
    const source = await newBot("Original");
    const copy = await newBot("Original copy");
    await pin(source, opusOnApiKey);

    await runAsTenant(owner, () =>
      copyBotModelConnection(
        prisma,
        owner,
        { id: source, modelProvider: "anthropic", modelId: model },
        copy,
      ),
    );

    await expect(served(copy)).resolves.toMatchObject({ id: opusOnApiKey });
  });

  it("keeps a member's choice away from other members", async () => {
    const botId = await newBot("Shared");
    await pin(botId, opusOnSubscription);

    await expect(
      runAsTenant(other, () => botModelConnectionId(prisma, other, botId, "anthropic", model)),
    ).resolves.toBeUndefined();
  });

  it("stops applying once the bot's model changes", async () => {
    const botId = await newBot("Moved");
    await pin(botId, opusOnSubscription);

    await expect(
      runAsTenant(owner, () =>
        botModelConnectionId(prisma, owner, botId, "anthropic", "claude-haiku"),
      ),
    ).resolves.toBeUndefined();
  });

  it("removes the choice with its connection", async () => {
    const botId = await newBot("Disconnected");
    const temporary = await connection("temporary");
    await pin(botId, temporary.id);

    await asSystem(prisma, "test fixture").userModelCredential.delete({
      where: { id: temporary.id },
    });

    await expect(
      runAsTenant(owner, () =>
        prisma.userBotModelConnection.findUnique({
          where: { userId_botId: { userId: owner.userId, botId } },
        }),
      ),
    ).resolves.toBeNull();
    await expect(served(botId)).resolves.toMatchObject({ provider: "anthropic" });
  });
});
