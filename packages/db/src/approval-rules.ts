import { Prisma } from "./client.js";

type ApprovalRuleKey = {
  spaceId: string;
  createdByUserId: string;
  effect: "always_allow" | "require_approval";
  matchKind: string;
  matchValue: string;
};

/**
 * Save a rule and drop the opposite effect on the same match, so a match never has both.
 * Matching ignores case, so the replacement does too; the lock keeps concurrent opposite saves
 * from both landing.
 */
export async function saveApprovalRule(tx: Prisma.TransactionClient, rule: ApprovalRuleKey) {
  const { effect, ...match } = rule;
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`approval-rule:${match.spaceId}:${match.createdByUserId}:${match.matchKind}:${match.matchValue.toLowerCase()}`}, 0))::text AS "lock"
  `);
  // Compared here, not with Prisma's insensitive mode: that is ILIKE, where "_" is a wildcard.
  const opposite = await tx.actionApprovalRule.findMany({
    where: {
      spaceId: match.spaceId,
      createdByUserId: match.createdByUserId,
      matchKind: match.matchKind,
      effect: effect === "always_allow" ? "require_approval" : "always_allow",
    },
    select: { id: true, matchValue: true },
  });
  const value = match.matchValue.toLowerCase();
  await tx.actionApprovalRule.deleteMany({
    where: {
      id: {
        in: opposite.filter((row) => row.matchValue.toLowerCase() === value).map((row) => row.id),
      },
    },
  });
  return tx.actionApprovalRule.upsert({
    where: { spaceId_createdByUserId_effect_matchKind_matchValue: rule },
    create: rule,
    update: {},
  });
}
