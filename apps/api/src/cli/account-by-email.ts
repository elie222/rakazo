import { canonicalEmail } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";

/**
 * The one account an operator means by an address: the spelling typed, else its canonical
 * form, else the only account differing from either by case. A mailbox kept under two
 * spellings from before addresses were canonical stays reachable by each.
 */
export async function accountByEmail(
  db: Pick<Prisma.TransactionClient, "user">,
  address: string,
): Promise<{ id: string } | null> {
  const spellings = [...new Set([address.trim().toLowerCase(), canonicalEmail(address)])];
  for (const email of spellings) {
    const exact = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (exact) return exact;
  }
  const matches = await db.user.findMany({
    where: { OR: spellings.map((email) => ({ email: { equals: email, mode: "insensitive" } })) },
    select: { id: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0]! : null;
}
