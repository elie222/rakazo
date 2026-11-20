import type { Actor, Bot } from "@rakazo/contracts";
import { BOT_COLOR_LIST } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
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
 * The actor's Space's first-run bot. Reuses the Chief already there; otherwise creates one only
 * for a person none of whose own Spaces has ever held a chat. Bots, groups and deleted bots all count,
 * so a person who archived or deleted their bots, or who adds a Space later, gets an empty Space
 * with a New bot button instead of a new Chief.
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
  if (await hasChatHistory(deps.prisma, actor)) return null;
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

/**
 * Whether the person has chatted before. Chief welcomes a new account, not a new Space: a chat in
 * any Space the person made means they have been here before, so a Space or organization they add
 * later starts empty. Spaces they were invited to do not count, so a new invitee still gets their
 * own Chief. A request sees only its own Space, so this one read looks past it, and only at
 * whether the person's own Spaces hold anything: ids, never content.
 */
export function hasChatHistory(prisma: PrismaClient, actor: Actor): Promise<boolean> {
  return runAsSystem("first bot checks the person's own Spaces for chats", async () => {
    const created = await prisma.space.findMany({
      // Still a member: a Space handed over when they left an organization is no longer theirs to
      // look into, even as a yes or no.
      where: { createdByUserId: actor.userId, memberships: { some: { userId: actor.userId } } },
      select: { id: true },
    });
    const where = { spaceId: { in: [actor.spaceId, ...created.map((space) => space.id)] } };
    const select = { id: true } as const;
    const found = await Promise.all([
      prisma.bot.findFirst({ where, select }),
      prisma.chatGroup.findFirst({ where, select }),
      prisma.botDeletion.findFirst({ where, select }),
    ]);
    return found.some(Boolean);
  });
}
