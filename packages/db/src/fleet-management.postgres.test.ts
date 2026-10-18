import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("bot fleetManagement (PostgreSQL)", () => {
  const provider = "sendblue";
  const address = "+15550004444";
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string; botId: string };

  const actor = () => ({
    userId: owner.userId,
    spaceId: owner.spaceId,
    email: "fleet@example.com",
    isDeploymentOwner: false,
  });
  const botInput = (name: string, parentBotId?: string) => ({
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    parentBotId,
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    owner = await provisionMessagingIdentity(
      prisma,
      { provider, address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
  });

  afterAll(async () => {
    if (owner) {
      await prisma.messagingIdentity.deleteMany({ where: { provider, address } });
      await prisma.organization.deleteMany({ where: { id: owner.spaceId } });
      await prisma.user.deleteMany({ where: { id: owner.userId } });
    }
    await close?.();
  });

  it("createBot returns fleetManagement false", async () => {
    const bot = await createRepos(prisma).createBot(actor(), botInput("Plain"));
    expect(bot.fleetManagement).toBe(false);
  });
});
