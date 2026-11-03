import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

/** What an own-key organization may spend on computers each month. */
export const BYOK_SANDBOX_ALLOWANCE_CENTS = 500;
/** The share of a monthly credit plan an organization may also spend on computers. */
export const CREDITS_SANDBOX_ALLOWANCE_PERCENT = 20;

/**
 * The organization's monthly computer allowance in cents, or null when it has no limit: a
 * deployment without model-credit billing never limits computers.
 */
export async function sandboxAllowanceCents(
  prisma: PrismaClient,
  organizationId: string,
): Promise<number | null> {
  const [settings, organization] = await Promise.all([
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { modelCreditsEnabled: true },
    }),
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        modelCredits: { select: { mode: true } },
        billing: { select: { creditAmountCents: true } },
      },
    }),
  ]);
  if (!settings?.modelCreditsEnabled) return null;
  if (organization?.modelCredits?.mode === "byok") return BYOK_SANDBOX_ALLOWANCE_CENTS;
  return Math.floor(
    ((organization?.billing?.creditAmountCents ?? 0) * CREDITS_SANDBOX_ALLOWANCE_PERCENT) / 100,
  );
}

/** The allowance resets at the start of each calendar month, in UTC. */
export function sandboxAllowancePeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Hours the organization's computers ran between `since` and `now`, by provider kind. A run
 * still open counts up to `now`. Host computers are never recorded.
 */
export async function sandboxRunHours(
  prisma: Pick<PrismaClient, "$queryRaw">,
  organizationId: string,
  since: Date,
  now = new Date(),
): Promise<Array<{ kind: string; hours: number }>> {
  // The allowance is per organization, so it counts the computers of all its Spaces.
  return runAsSystem(
    "computer allowance across an organization's Spaces",
    () => prisma.$queryRaw<Array<{ kind: string; hours: number }>>`
    SELECT r."kind",
      SUM(EXTRACT(EPOCH FROM (
        LEAST(COALESCE(r."endedAt", ${now}::timestamp(3)), ${now}::timestamp(3))
        - GREATEST(r."startedAt", ${since}::timestamp(3))
      )))::float8 / 3600 AS "hours"
    FROM "computer_runs" AS r
    JOIN "spaces" AS s ON s."id" = r."spaceId"
    WHERE s."organizationId" = ${organizationId}
      AND r."startedAt" < ${now}::timestamp(3)
      AND (r."endedAt" IS NULL OR r."endedAt" > ${since}::timestamp(3))
    GROUP BY r."kind"`,
  );
}
