import type { Prisma, PrismaClient } from "@rakazo/db";

/**
 * Why a group run cannot find a routine. One the bot has outside the group (`where`, without the
 * group's thread) can be changed from the bot's own chat, which reaches all of its routines.
 */
export async function groupNotFoundError(prisma: PrismaClient, where: Prisma.RoutineWhereInput) {
  const elsewhere = await prisma.routine.findFirst({ where, select: { id: true } });
  return {
    error: elsewhere
      ? "That routine is not this group chat's. Change it from the bot's own chat."
      : "Schedule not found.",
  };
}

/** Resolve a schedule_cancel target by id or exact unique name within scope. */
export async function resolveScheduleToCancel(
  prisma: PrismaClient,
  input: {
    spaceId: string;
    botId: string;
    /** In a group, only that thread's routines. */
    threadId?: string;
    routineId?: string;
    name?: string;
  },
) {
  const routineId = input.routineId?.trim();
  const name = input.name?.trim();
  if (!routineId && !name) {
    return { error: "Provide routineId or the exact schedule name to cancel." };
  }

  const scope = {
    spaceId: input.spaceId,
    botId: input.botId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
  let existing: Awaited<ReturnType<typeof prisma.routine.findFirst>>;
  if (routineId) {
    existing = await prisma.routine.findFirst({ where: { ...scope, id: routineId } });
  } else {
    const matches = await prisma.routine.findMany({
      where: { ...scope, name: name! },
      take: 2,
    });
    if (matches.length > 1) {
      return { error: `More than one schedule is named "${name}". Pass routineId instead.` };
    }
    existing = matches[0] ?? null;
  }
  if (!existing) {
    return input.threadId
      ? groupNotFoundError(prisma, {
          spaceId: input.spaceId,
          botId: input.botId,
          ...(routineId ? { id: routineId } : { name: name! }),
        })
      : { error: "Schedule not found." };
  }
  return { existing, scope };
}
