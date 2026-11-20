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
const skillShape = BotTemplateSchema.shape.skills.element;
const routineShape = BotTemplateSchema.shape.routines.element;

/** Skills the bot's routines mention that its owner can use in the bot's Space. */
function usableSkills(prisma: Prisma, userId: string, spaceId: string) {
  return prisma.agentSkill.findMany({
    where: {
      userId,
      source: "user",
      OR: [{ spaceId }, { allSpaces: true }, { availableIn: { some: { spaceId } } }],
    },
    select: { name: true, content: true },
  });
}

function mentionedSkills<T extends { name: string }>(prompts: string[], skills: T[]): T[] {
  const names = new Set<string>();
  for (const prompt of prompts) {
    for (const name of extractRoutineSkillMentions(
      prompt,
      skills.map((skill) => skill.name),
    )) {
      names.add(name.toLowerCase());
    }
  }
  return skills.filter((skill) => names.has(skill.name.toLowerCase()));
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
      skills: mentionedSkills(
        routines.map((routine) => routine.prompt),
        skills,
      ).length,
      routines: routines.length,
    };
  });
}

/**
 * The template part of one of the admin's bots. Only what a listing can hold is kept: routines
 * that run on a schedule, and the skills they mention; anything that does not fit is left out.
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
  const skills: BotTemplate["skills"] = [];
  for (const row of mentionedSkills(
    limited.map((routine) => routine.prompt),
    await usableSkills(prisma, actor.userId, actor.spaceId),
  )) {
    const file = parseSkillMd(row.content);
    if ("error" in file) continue;
    const parsed = skillShape.safeParse({
      name: file.name,
      description: file.description,
      body: file.body,
    });
    if (parsed.success) skills.push(parsed.data);
  }
  return {
    name: bot.name.slice(0, BOT_NAME_MAX_LENGTH),
    description: bot.description.slice(0, BOT_DESCRIPTION_MAX_LENGTH),
    instructions: bot.instructions,
    skills: skills.slice(0, 5),
    routines: limited,
  };
}
