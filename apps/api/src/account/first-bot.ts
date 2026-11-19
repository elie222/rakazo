import type { Actor, Bot } from "@rakazo/contracts";
import { BOT_COLOR_LIST } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

const FIRST_BOT_NAME = "Chief";
/** Also the key earlier web clients created it with, so their Chief is found, never duplicated. */
export const FIRST_BOT_SPAWN_KEY = "onboarding:first";

type BotCreate = {
  name: string;
  description: string;
  instructions: string;
  notifyOnFinish: boolean;
  color?: string;
  spawnKey?: string;
};

export type FirstBotDeps = {
  prisma: PrismaClient;
  /** Idempotent on spawnKey: a concurrent create of the same key returns the bot that won. */
  createBot: (actor: Actor, input: BotCreate) => Promise<Bot>;
  /** Starts a new bot's intro run, which asks what it is for when a model is set up. */
  introduce: (actor: Actor, bot: Bot) => Promise<void>;
  /** Posts the focus choice while the thread is still idle and no intro run asks instead. */
  promptFocus: (actor: Actor, botId: string) => Promise<void>;
};

/**
 * The actor's Space's first-run bot. Reuses the Chief already there; otherwise creates one only in
 * a Space that has never held a chat. Bots, groups and deleted bots all count, so a person who
 * archived or deleted their bots gets an empty Space with a New bot button instead of a new Chief.
 */
export async function ensureFirstBot(
  deps: FirstBotDeps,
  actor: Actor,
): Promise<{ botId: string | null }> {
  const botId =
    (await existingFirstBot(deps.prisma, actor)) ??
    (await createFirstBot(deps, actor)) ??
    // Another tab or device may have made Chief between the two reads, so its history is Chief.
    (await existingFirstBot(deps.prisma, actor));
  return { botId };
}

async function existingFirstBot(prisma: PrismaClient, actor: Actor): Promise<string | null> {
  const candidates = await prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      archivedAt: null,
      OR: [{ spawnKey: FIRST_BOT_SPAWN_KEY }, { name: FIRST_BOT_NAME }],
    },
    select: { id: true, spawnKey: true },
    orderBy: { createdAt: "asc" },
  });
  // A Chief made before the spawn key existed is matched by name.
  const found =
    candidates.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY) ?? candidates.at(0) ?? null;
  return found?.id ?? null;
}

async function createFirstBot(deps: FirstBotDeps, actor: Actor): Promise<string | null> {
  const where = { spaceId: actor.spaceId };
  const select = { id: true } as const;
  const history = await Promise.all([
    deps.prisma.bot.findFirst({ where, select }),
    deps.prisma.chatGroup.findFirst({ where, select }),
    deps.prisma.botDeletion.findFirst({ where, select }),
  ]);
  if (history.some(Boolean)) return null;
  const bot = await deps.createBot(actor, {
    name: FIRST_BOT_NAME,
    description: "",
    instructions: "",
    notifyOnFinish: true,
    color: BOT_COLOR_LIST.find((color) => color.id === "orange")?.hex,
    spawnKey: FIRST_BOT_SPAWN_KEY,
  });
  // Each runs at most once per thread, and in this order: the focus card waits for an intro run
  // that is already committed, so a concurrent call cannot leave both openers. A Chief that is
  // only found is left as it is, since whoever created it greets it.
  await bestEffort("first bot intro run", deps.introduce(actor, bot));
  // A failed card leaves Chief usable; the person can type to it.
  await bestEffort("first bot focus prompt", deps.promptFocus(actor, bot.id));
  return bot.id;
}
