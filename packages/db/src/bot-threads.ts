/**
 * Helpers for Bot↔Thread after Global bots broke the old 1:1 relation.
 * Personal bots still have one thread; Global instances have one per userId.
 */

export function primaryBotThread<T>(threads: T[] | undefined | null): T | undefined {
  return threads?.[0];
}

/** Prisma include/select shape: the caller's thread on a bot (at most one). */
export function threadsForUser(userId: string) {
  return { where: { userId }, take: 1 } as const;
}

/** Collapse Prisma `threads` onto the legacy singular `thread` field for call sites. */
export function withPrimaryThread<T extends { threads?: readonly unknown[] | null }>(
  bot: T,
): Omit<T, "threads"> & { thread: NonNullable<T["threads"]>[number] | null } {
  const { threads, ...rest } = bot;
  return { ...rest, thread: threads?.[0] ?? null };
}

export function withPrimaryThreads<T extends { threads?: readonly unknown[] | null }>(
  bots: T[],
): Array<Omit<T, "threads"> & { thread: NonNullable<T["threads"]>[number] | null }> {
  return bots.map((bot) => withPrimaryThread(bot));
}
