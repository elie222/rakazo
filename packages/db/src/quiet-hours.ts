import type { QuietHours } from "@rakazo/contracts";
import { inQuietHours } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

/** A person's saved quiet hours, or null while they are off. */
export function quietHoursOf(user: {
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
}): QuietHours | null {
  return user.quietHoursStart === null || user.quietHoursEnd === null
    ? null
    : { start: user.quietHoursStart, end: user.quietHoursEnd };
}

/** Which of these people are in their quiet hours at `now`, each read in their own timezone. */
export async function membersInQuietHours(
  prisma: PrismaClient,
  userIds: readonly string[],
  now = new Date(),
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const users = await runAsSystem("find which members are in their quiet hours", () =>
    prisma.user.findMany({
      where: { id: { in: [...userIds] }, quietHoursStart: { not: null } },
      select: { id: true, timezone: true, quietHoursStart: true, quietHoursEnd: true },
    }),
  );
  return new Set(
    users
      .filter((user) => inQuietHours(quietHoursOf(user), user.timezone, now))
      .map((user) => user.id),
  );
}
