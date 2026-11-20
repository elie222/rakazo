import type {
  Actor,
  BotTemplate,
  MarketplaceBotFromBot,
  MarketplaceBotSource,
} from "@rakazo/contracts";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BotTemplateSchema,
} from "@rakazo/contracts";
import { ClientError, extractRoutineSkillMentions, parseSkillMd } from "@rakazo/core";
import type { RouterDeps } from "../router.js";

type Prisma = RouterDeps["prisma"];

const SOURCE_LIMIT = 100;
const TEMPLATE_SKILL_LIMIT = 5;
const skillShape = BotTemplateSchema.shape.skills.element;
const routineShape = BotTemplateSchema.shape.routines.element;

/** Skills the owner can use in the bot's Space. A bot has no skill list of its own: it can use all of them. */
function usableSkills(prisma: Prisma, userId: string, spaceId: string) {
  return prisma.agentSkill.findMany({
    where: {
      userId,
      source: "user",
      OR: [{ spaceId }, { allSpaces: true }, { availableIn: { some: { spaceId } } }],
    },
    orderBy: { name: "asc" },
    select: { name: true, content: true },
  });
}

function mentionedNames(prompts: string[], names: string[]): Set<string> {
  const mentioned = new Set<string>();
  for (const prompt of prompts) {
    for (const name of extractRoutineSkillMentions(prompt, names))
      mentioned.add(name.toLowerCase());
  }
  return mentioned;
}

/** The skills a template can hold, the ones the routines mention first. */
function templateSkills(
  rows: { name: string; content: string }[],
  prompts: string[],
): BotTemplate["skills"] {
  const mentioned = mentionedNames(
    prompts,
    rows.map((row) => row.name),
  );
  const ordered = [
    ...rows.filter((row) => mentioned.has(row.name.toLowerCase())),
    ...rows.filter((row) => !mentioned.has(row.name.toLowerCase())),
  ];
  const skills: BotTemplate["skills"] = [];
  for (const row of ordered) {
    const file = parseSkillMd(row.content);
    if ("error" in file) continue;
    const parsed = skillShape.safeParse({
      name: file.name,
      description: file.description,
      body: file.body,
    });
    if (parsed.success) skills.push(parsed.data);
  }
  return skills.slice(0, TEMPLATE_SKILL_LIMIT);
}

/** The bots a listing can be built from: the admin's own, in the Space they are working in. */
export async function marketplaceSources(
  prisma: Prisma,
  actor: Actor,
): Promise<MarketplaceBotSource[]> {
  const [bots, skills] = await Promise.all([
    prisma.bot.findMany({
      where: { userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: SOURCE_LIMIT,
      select: {
        id: true,
        name: true,
        space: { select: { name: true } },
        routines: { select: { prompt: true, crons: true }, orderBy: { createdAt: "asc" } },
      },
    }),
    usableSkills(prisma, actor.userId, actor.spaceId),
  ]);
  return bots.map((bot) => {
    const routines = bot.routines.filter((routine) => routine.crons.length > 0);
    return {
      botId: bot.id,
      name: bot.name,
      spaceName: bot.space.name,
      skills: templateSkills(
        skills,
        routines.map((routine) => routine.prompt),
      ).length,
      routines: routines.length,
    };
  });
}

/**
 * The template part of one of the admin's bots. Only what a listing can hold is kept: routines
 * that run on a schedule, and the owner's skills; anything that does not fit is left out.
 */
export async function marketplaceDraftFromBot(
  prisma: Prisma,
  actor: Actor,
  botId: string,
): Promise<MarketplaceBotFromBot> {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
    select: {
      name: true,
      description: true,
      instructions: true,
      routines: {
        select: { name: true, prompt: true, crons: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!bot) throw new ClientError("NOT_FOUND", "No bot has that id.");
  const routines: BotTemplate["routines"] = [];
  for (const routine of bot.routines) {
    const parsed = routineShape.safeParse({
      name: routine.name,
      prompt: routine.prompt,
      crons: routine.crons.slice(0, 5),
    });
    if (routine.crons.length > 0 && parsed.success) routines.push(parsed.data);
  }
  const limited = routines.slice(0, 5);
  const skills = templateSkills(
    await usableSkills(prisma, actor.userId, actor.spaceId),
    limited.map((routine) => routine.prompt),
  );
  return {
    name: bot.name.slice(0, BOT_NAME_MAX_LENGTH),
    description: bot.description.slice(0, BOT_DESCRIPTION_MAX_LENGTH),
    instructions: bot.instructions,
    skills,
    routines: limited,
  };
}
