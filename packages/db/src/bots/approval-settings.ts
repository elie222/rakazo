import type { EffectiveApprovalTarget, SettingsScope } from "@rakazo/contracts";
import { APPROVAL_RULES_CHANGED } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "../database/client.js";
import { Prisma } from "../database/client.js";
import { lockSpaceSettings, settingsTarget } from "../spaces/space-settings.js";

type Scope = { userId: string; spaceId: string };
/** A write runs in a transaction: it locks the member's settings before picking a copy. */
type ConfirmationsTx = ConfirmationsClient & Pick<Prisma.TransactionClient, "$queryRaw">;
type ConfirmationsClient = Pick<
  PrismaClient,
  | "spaceSettingOverride"
  | "actionApprovalRule"
  | "userActionApprovalRule"
  | "actionAutoReviewPreference"
  | "userActionAutoReviewPreference"
>;

/** A stored effect's batch actions, or undefined when the effect is not a batch. */
export function storedBatchActions(
  value: Prisma.JsonValue | null | undefined,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((action): action is string => typeof action === "string");
}

export type ApprovalRuleInput = { effect: string; matchKind: string; matchValue: string };
export type AutoReviewPreference = { enabled: boolean; skipApprovals: boolean };

/**
 * Approval rules and auto review are confirmations: the account's copy, or the Space's
 * override. Every call reads or writes the copy that applies unless it names one.
 */
function confirmationsTarget(prisma: ConfirmationsClient, scope: Scope, requested?: SettingsScope) {
  return settingsTarget(prisma, scope, "confirmations", requested);
}

class ApprovalRulesChangedError extends ClientError {
  constructor() {
    super("CONFLICT", "Approval rules changed. Try again.", APPROVAL_RULES_CHANGED);
  }
}

async function approvalRuleWriteTarget(
  tx: ConfirmationsTx,
  scope: Scope,
  requested?: SettingsScope,
  expected?: EffectiveApprovalTarget,
) {
  if (expected && requested !== undefined && requested !== expected.scope) {
    throw new ApprovalRulesChangedError();
  }
  await lockSpaceSettings(tx, scope);
  const effective = await confirmationsTarget(tx, scope, expected ? undefined : requested);
  if (expected && (expected.spaceId !== scope.spaceId || expected.scope !== effective)) {
    throw new ApprovalRulesChangedError();
  }
  return effective;
}

/** Rules and mode come from the same effective copy in one database snapshot. */
export function readEffectiveApprovalRules(prisma: PrismaClient, actor: Scope) {
  return prisma.$transaction(
    async (tx) => {
      const scope = await confirmationsTarget(tx, actor);
      const [rules, preference] = await Promise.all([
        listApprovalRules(tx, actor, scope),
        findAutoReviewPreference(tx, actor, scope),
      ]);
      return { target: { scope, spaceId: actor.spaceId }, rules, preference };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

export async function listApprovalRules(
  prisma: ConfirmationsClient,
  scope: Scope,
  requested?: SettingsScope,
) {
  const orderBy = { createdAt: "asc" } as const;
  return (await confirmationsTarget(prisma, scope, requested)) === "account"
    ? prisma.userActionApprovalRule.findMany({ where: { userId: scope.userId }, orderBy })
    : prisma.actionApprovalRule.findMany({
        where: { spaceId: scope.spaceId, createdByUserId: scope.userId },
        orderBy,
      });
}

/**
 * Saves a rule once and drops any other effect on the same match in the same copy, so a match
 * has one rule. Matching ignores case, so the replacement does too; the lock keeps concurrent
 * saves of different effects from both landing. Runs inside the caller's transaction.
 */
export async function saveApprovalRule(
  tx: ConfirmationsTx,
  scope: Scope,
  rule: ApprovalRuleInput,
  requested?: SettingsScope,
  expected?: EffectiveApprovalTarget,
) {
  const account = (await approvalRuleWriteTarget(tx, scope, requested, expected)) === "account";
  const owner = account ? `account:${scope.userId}` : `${scope.spaceId}:${scope.userId}`;
  const value = rule.matchValue.toLowerCase();
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`approval-rule:${owner}:${rule.matchKind}:${value}`}, 0))::text AS "lock"
  `);
  // One rule per match, whatever its effect or spelling. Compared here, not with Prisma's
  // insensitive mode: that is ILIKE, where "_" is a wildcard.
  const replaced = (rows: Array<{ id: string; effect: string; matchValue: string }>) =>
    rows
      .filter((row) => row.matchValue.toLowerCase() === value)
      .filter((row) => row.effect !== rule.effect || row.matchValue !== rule.matchValue)
      .map((row) => row.id);
  const select = { id: true, effect: true, matchValue: true } as const;
  if (account) {
    const where = { userId: scope.userId, matchKind: rule.matchKind };
    const ids = replaced(await tx.userActionApprovalRule.findMany({ where, select }));
    await tx.userActionApprovalRule.deleteMany({ where: { id: { in: ids } } });
    const row = { userId: scope.userId, ...rule };
    return tx.userActionApprovalRule.upsert({
      where: { userId_effect_matchKind_matchValue: row },
      create: row,
      update: {},
    });
  }
  const where = {
    spaceId: scope.spaceId,
    createdByUserId: scope.userId,
    matchKind: rule.matchKind,
  };
  const ids = replaced(await tx.actionApprovalRule.findMany({ where, select }));
  await tx.actionApprovalRule.deleteMany({ where: { id: { in: ids } } });
  const row = { spaceId: scope.spaceId, createdByUserId: scope.userId, ...rule };
  return tx.actionApprovalRule.upsert({
    where: { spaceId_createdByUserId_effect_matchKind_matchValue: row },
    create: row,
    update: {},
  });
}

export async function removeApprovalRule(
  prisma: ConfirmationsTx,
  scope: Scope,
  id: string,
  requested?: SettingsScope,
  expected?: EffectiveApprovalTarget,
) {
  const target = await approvalRuleWriteTarget(prisma, scope, requested, expected);
  const { count } =
    target === "account"
      ? await prisma.userActionApprovalRule.deleteMany({ where: { id, userId: scope.userId } })
      : await prisma.actionApprovalRule.deleteMany({
          where: { id, spaceId: scope.spaceId, createdByUserId: scope.userId },
        });
  if (expected && count === 0) throw new ApprovalRulesChangedError();
}

export async function findAutoReviewPreference(
  prisma: ConfirmationsClient,
  scope: Scope,
  requested?: SettingsScope,
): Promise<AutoReviewPreference | null> {
  const select = { enabled: true, skipApprovals: true } as const;
  return (await confirmationsTarget(prisma, scope, requested)) === "account"
    ? prisma.userActionAutoReviewPreference.findUnique({
        where: { userId: scope.userId },
        select,
      })
    : prisma.actionAutoReviewPreference.findUnique({
        where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
        select,
      });
}

/** Updates the given fields; a first save fills the rest from `defaults`. */
export async function saveAutoReviewPreference(
  prisma: ConfirmationsTx,
  scope: Scope,
  update: Partial<AutoReviewPreference>,
  defaults: AutoReviewPreference,
  requested?: SettingsScope,
) {
  const create = {
    enabled: update.enabled ?? defaults.enabled,
    skipApprovals: update.skipApprovals ?? defaults.skipApprovals,
  };
  await lockSpaceSettings(prisma, scope);
  if ((await confirmationsTarget(prisma, scope, requested)) === "account") {
    await prisma.userActionAutoReviewPreference.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, ...create },
      update,
    });
  } else {
    await prisma.actionAutoReviewPreference.upsert({
      where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
      create: { spaceId: scope.spaceId, userId: scope.userId, ...create },
      update,
    });
  }
}
