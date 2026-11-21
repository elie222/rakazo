import { canonicalEmail } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";

/**
 * The one account an operator means by an address: the spelling typed, else its canonical
 * form, each exactly or as the only account differing by case. A mailbox kept under two
 * spellings from before addresses were canonical stays reachable by each.
 */
export async function accountByEmail(
  db: Pick<Prisma.TransactionClient, "user">,
  address: string,
): Promise<{ id: string } | null> {
  for (const email of new Set([address.trim().toLowerCase(), canonicalEmail(address)])) {
    const exact = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (exact) return exact;
    const matches = await db.user.findMany({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
      take: 2,
    });
    if (matches.length > 1) return null;
    if (matches[0]) return matches[0];
  }
  return null;
}
