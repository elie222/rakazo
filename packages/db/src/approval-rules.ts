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
  await tx.actionApprovalRule.deleteMany({
    where: {
      ...match,
      effect: effect === "always_allow" ? "require_approval" : "always_allow",
      matchValue: { equals: match.matchValue, mode: "insensitive" },
    },
  });
  return tx.actionApprovalRule.upsert({
    where: { spaceId_createdByUserId_effect_matchKind_matchValue: rule },
    create: rule,
    update: {},
  });
}
