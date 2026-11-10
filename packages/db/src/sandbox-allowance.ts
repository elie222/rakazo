import type { ByokTier, ComputerSize } from "@rakazo/contracts";
import {
  BYOK_TIERS,
  ByokTierSchema,
  CREDITS_SANDBOX_ALLOWANCE_PERCENT,
  TRIAL_SANDBOX_ALLOWANCE_CENTS,
} from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

const LIVE_SUBSCRIPTION_STATUSES = new Set(["trialing", "active", "past_due"]);

/**
 * The own-key tier an organization's computers get: a live own-key subscription's tier, whatever
 * pays for its models (a top-up switches those to credits), else Standard while it uses its own
 * key. Credit organizations without an own-key subscription get none.
 */
function byokTierOf(
  mode: string | null | undefined,
  billing:
    | { status: string | null; byokTier: string | null; byokPriceCents: number | null }
    | null
    | undefined,
): ByokTier | null {
  const live = Boolean(billing?.status && LIVE_SUBSCRIPTION_STATUSES.has(billing.status));
  if (mode !== "byok" && !(live && billing?.byokPriceCents)) return null;
  return (live && ByokTierSchema.safeParse(billing?.byokTier).data) || "standard";
}

/**
 * The organization's computer allowance in cents and the moment its period began, or null when
 * it has no limit: a deployment without model-credit billing never limits computers. The period
 * is the subscription's billing period, or the calendar month in UTC without one. A cancelled
 * trial gets nothing more.
 */
export async function sandboxAllowancePlan(
  prisma: PrismaClient,
  organizationId: string,
  now = new Date(),
): Promise<{ limitCents: number; since: Date } | null> {
  const [settings, organization] = await Promise.all([
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { modelCreditsEnabled: true },
    }),
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        modelCredits: { select: { mode: true } },
        billing: {
          select: {
            creditAmountCents: true,
            status: true,
            cancelAtPeriodEnd: true,
            currentPeriodStartsAt: true,
            byokInterval: true,
            byokTier: true,
            byokPriceCents: true,
          },
        },
      },
    }),
  ]);
  if (!settings?.modelCreditsEnabled) return null;
  const billing = organization?.billing;
  const live = Boolean(billing?.status && LIVE_SUBSCRIPTION_STATUSES.has(billing.status));
  const periodStart = live ? billing?.currentPeriodStartsAt : null;
  const since =
    periodStart && periodStart <= now
      ? // A yearly plan's allowance still renews monthly, on the day its period began.
        billing?.byokInterval === "year"
        ? latestMonthlyAnniversary(periodStart, now)
        : periodStart
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const tier = byokTierOf(organization?.modelCredits?.mode, billing);
  const limitCents =
    billing?.status === "trialing"
      ? billing.cancelAtPeriodEnd
        ? 0
        : TRIAL_SANDBOX_ALLOWANCE_CENTS
      : tier
        ? BYOK_TIERS[tier].computerAllowanceCents
        : Math.floor(((billing?.creditAmountCents ?? 0) * CREDITS_SANDBOX_ALLOWANCE_PERCENT) / 100);
  return { limitCents, since };
}

/**
 * The machine size a Space's computers start at: its organization's own-key tier's size, and
 * standard on credits. A computer moves to this size when it next starts or resumes, so a plan
 * change reaches running computers on their next resume.
 */
export async function planComputerSize(
  prisma: Pick<PrismaClient, "space">,
  spaceId: string,
): Promise<ComputerSize> {
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: {
      organization: {
        select: {
          modelCredits: { select: { mode: true } },
          billing: { select: { status: true, byokTier: true, byokPriceCents: true } },
        },
      },
    },
  });
  const tier = byokTierOf(space?.organization.modelCredits?.mode, space?.organization.billing);
  return tier ? BYOK_TIERS[tier].computerSize : "standard";
}

/** The latest monthly anniversary of `start` at or before `now`, on a shorter month's last day. */
function latestMonthlyAnniversary(start: Date, now: Date): Date {
  const monthsLater = (months: number) => {
    const shifted = new Date(start);
    shifted.setUTCDate(1);
    shifted.setUTCMonth(start.getUTCMonth() + months);
    const lastDay = new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
    ).getUTCDate();
    shifted.setUTCDate(Math.min(start.getUTCDate(), lastDay));
    return shifted;
  };
  const months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth();
  const anniversary = monthsLater(months);
  return anniversary <= now ? anniversary : monthsLater(months - 1);
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
