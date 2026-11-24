import type { ByokTier, ComputerSize } from "@rakazo/contracts";
import {
  BYOK_TIERS,
  ByokTierSchema,
  ComputerSizeSchema,
  CREDITS_SANDBOX_ALLOWANCE_PERCENT,
  computerSizesUpTo,
  MEDIA_ALLOWANCE_CENTS,
  SPEECH_ALLOWANCE_PERCENT,
  TRIAL_SANDBOX_ALLOWANCE_CENTS,
} from "@rakazo/contracts";
import type { PrismaClient } from "../database/client.js";
import { Prisma } from "../database/client.js";
import { runAsSystem, runAsSystemInTransaction } from "../database/row-security.js";
import { hasBillingAccess } from "./billing.js";

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
  const live = hasBillingAccess(billing?.status ?? null);
  if (mode !== "byok" && !(live && billing?.byokPriceCents)) return null;
  return (live && ByokTierSchema.safeParse(billing?.byokTier).data) || "standard";
}

/**
 * The organization's computer allowance in cents and the moment its period began, or null when
 * it has no limit: a deployment without model-credit billing never limits computers. The period
 * is the subscription's billing period, or the calendar month in UTC without one. A cancelled
 * trial gets nothing more from its plan. Credit an admin granted, without a monthly plan, brings its
 * share once. Extra allowance an operator granted counts only in the period it was granted in, and
 * is not a reset: when the plan renews nothing, `resetsAt` stays null.
 */
export async function sandboxAllowancePlan(
  prisma: PrismaClient,
  organizationId: string,
  now = new Date(),
): Promise<{ limitCents: number; extraCents: number; since: Date; resetsAt: Date | null } | null> {
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
            currentPeriodEndsAt: true,
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
  const { live, periodStart, since } = allowancePeriod(billing, now);
  const tier = byokTierOf(organization?.modelCredits?.mode, billing);
  const creditShare = (cents: number) =>
    Math.floor((cents * CREDITS_SANDBOX_ALLOWANCE_PERCENT) / 100);
  if (billing?.status !== "trialing" && !tier && !billing?.creditAmountCents) {
    // Granted credit without a monthly plan: its share is one pool, spent since the first grant.
    const granted = await prisma.accessGrant.aggregate({
      where: { organizationId, appliedAt: { not: null }, creditCents: { gt: 0 } },
      _sum: { creditCents: true },
      _min: { appliedAt: true },
    });
    if (granted._sum.creditCents && granted._min.appliedAt) {
      const since = granted._min.appliedAt;
      // Grants from a paid plan's earlier periods already reset; its last period's still count. A
      // yearly plan's period is the month that began on its last anniversary before it ended.
      const periodStartsAt = billing?.currentPeriodStartsAt;
      const lastPeriod =
        periodStartsAt && billing?.byokInterval === "year"
          ? latestMonthlyAnniversary(
              periodStartsAt,
              billing.currentPeriodEndsAt && billing.currentPeriodEndsAt < now
                ? billing.currentPeriodEndsAt
                : now,
            )
          : periodStartsAt;
      const extraCents = await grantedAllowanceCents(
        prisma,
        organizationId,
        lastPeriod && lastPeriod > since ? lastPeriod : since,
      );
      return {
        limitCents: creditShare(granted._sum.creditCents) + extraCents,
        extraCents,
        since,
        resetsAt: null,
      };
    }
  }
  const baseCents =
    billing?.status === "trialing"
      ? billing.cancelAtPeriodEnd
        ? 0
        : TRIAL_SANDBOX_ALLOWANCE_CENTS
      : tier
        ? BYOK_TIERS[tier].computerAllowanceCents
        : creditShare(billing?.creditAmountCents ?? 0);
  const extraCents = await grantedAllowanceCents(prisma, organizationId, since);
  const limitCents = baseCents + extraCents;
  const periodEnd = live ? billing?.currentPeriodEndsAt : null;
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const nextAnniversary =
    periodStart && billing?.byokInterval === "year"
      ? monthlyAnniversary(periodStart, monthsBetween(periodStart, since) + 1)
      : null;
  const reset = periodStart ? (nextAnniversary ?? periodEnd ?? null) : nextMonth;
  const resetsAt =
    reset === null ||
    baseCents <= 0 ||
    (!tier && !live) ||
    billing?.status === "trialing" ||
    reset <= now ||
    (live && periodEnd != null && periodEnd <= now) ||
    // The cancellation flag can also mean a scheduled date before the billing period ends.
    (live && billing?.cancelAtPeriodEnd)
      ? null
      : reset;
  return { limitCents, extraCents, since, resetsAt };
}

/** The monthly allowance period an organization's billing puts it in. */
function allowancePeriod(
  billing:
    | {
        status: string | null;
        currentPeriodStartsAt: Date | null;
        byokInterval: string | null;
      }
    | null
    | undefined,
  now: Date,
) {
  const live = hasBillingAccess(billing?.status ?? null);
  const periodStart =
    live && billing?.currentPeriodStartsAt && billing.currentPeriodStartsAt <= now
      ? billing.currentPeriodStartsAt
      : null;
  const since = periodStart
    ? // A yearly plan's allowance still renews monthly, on the day its period began.
      billing?.byokInterval === "year"
      ? latestMonthlyAnniversary(periodStart, now)
      : periodStart
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { live, periodStart, since };
}

/**
 * What the organization may spend on deployment-funded speech this period, in micros, and when
 * the period began: a share of its plan's monthly price. Without a live plan or a trial it gets
 * nothing; a deployment without model-credit billing never limits speech (null).
 */
export async function speechAllowancePlan(
  prisma: Pick<PrismaClient, "deploymentSettings" | "organization">,
  organizationId: string,
  now = new Date(),
): Promise<{ limitMicros: bigint; since: Date } | null> {
  const [settings, organization] = await Promise.all([
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { modelCreditsEnabled: true },
    }),
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        billing: {
          select: {
            creditAmountCents: true,
            status: true,
            cancelAtPeriodEnd: true,
            currentPeriodStartsAt: true,
            currentPeriodEndsAt: true,
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
  const { live, since } = allowancePeriod(billing, now);
  // A paid tier counts only while its subscription is live; a lapsed one pays for nothing.
  const tier = byokTierOf(null, billing);
  const ended = billing?.currentPeriodEndsAt != null && billing.currentPeriodEndsAt <= now;
  const planCents =
    !live || ended || (billing?.status === "trialing" && billing.cancelAtPeriodEnd)
      ? 0
      : billing?.status === "trialing"
        ? (BYOK_TIERS.standard.monthlyPriceCents ?? 0)
        : tier
          ? (BYOK_TIERS[tier].monthlyPriceCents ?? 0)
          : (billing?.creditAmountCents ?? 0);
  // One cent is 10,000 micros, so a percent of it is 100.
  return { limitMicros: BigInt(planCents) * BigInt(SPEECH_ALLOWANCE_PERCENT) * 100n, since };
}

/**
 * What the organization may spend on hosted image and video generation this period, in micros,
 * and when the period began. Only a live paid plan gets any: a trial or an organization without a
 * plan gets none. A deployment without model-credit billing never meters media (null).
 */
export async function mediaAllowancePlan(
  prisma: Pick<PrismaClient, "deploymentSettings" | "organization">,
  organizationId: string,
  now = new Date(),
): Promise<{ limitMicros: number; since: Date; trial: boolean } | null> {
  const [settings, organization] = await Promise.all([
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { modelCreditsEnabled: true },
    }),
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        billing: {
          select: {
            creditAmountCents: true,
            status: true,
            currentPeriodStartsAt: true,
            currentPeriodEndsAt: true,
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
  const { live, since } = allowancePeriod(billing, now);
  const trial = billing?.status === "trialing";
  const ended = billing?.currentPeriodEndsAt != null && billing.currentPeriodEndsAt <= now;
  const paid =
    live && !ended && !trial && Boolean(byokTierOf(null, billing) || billing?.creditAmountCents);
  // One cent is 10,000 micros.
  return { limitMicros: paid ? MEDIA_ALLOWANCE_CENTS * 10_000 : 0, since, trial };
}

async function grantedAllowanceCents(
  prisma: Pick<PrismaClient, "computerAllowanceGrant">,
  organizationId: string,
  since: Date,
): Promise<number> {
  const granted = await runAsSystem("an operator's computer allowance grants", () =>
    prisma.computerAllowanceGrant.aggregate({
      where: { organizationId, createdAt: { gte: since } },
      _sum: { amountCents: true },
    }),
  );
  return granted._sum.amountCents ?? 0;
}

/** Operator-only: extra allowance for the organization's current period, kept in the journal. */
export async function grantComputerAllowance(
  prisma: PrismaClient,
  organizationId: string,
  amountCents: number,
) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 1_000_000)
    throw new Error("Extra allowance must be between 1 cent and $10,000");
  await prisma.$transaction((tx) =>
    runAsSystemInTransaction(tx, "record an operator's computer allowance grant", async () => {
      const grant = await tx.computerAllowanceGrant.create({
        data: { organizationId, amountCents },
        select: { id: true },
      });
      await tx.billingAuditEvent.create({
        data: {
          source: `computer-allowance:${grant.id}`,
          kind: "computer_allowance_granted",
          organizationId,
          details: { amountCents, by: "operator" },
        },
      });
    }),
  );
}

/** What `allowedComputerSizes` reads from an organization. */
export const COMPUTER_SIZE_PLAN_SELECT = {
  modelCredits: { select: { mode: true } },
  billing: { select: { status: true, byokTier: true, byokPriceCents: true } },
} as const;

type ComputerSizePlan =
  | {
      modelCredits: { mode: string | null } | null;
      billing: {
        status: string | null;
        byokTier: string | null;
        byokPriceCents: number | null;
      } | null;
    }
  | null
  | undefined;

/** The sizes an organization's plan lets its computers run at, smallest first. */
export function allowedComputerSizes(organization: ComputerSizePlan): ComputerSize[] {
  const tier = byokTierOf(organization?.modelCredits?.mode, organization?.billing);
  return computerSizesUpTo(tier ? BYOK_TIERS[tier].computerSize : "standard");
}

/** A stored size the plan no longer allows runs at the largest size it does allow. */
export function effectiveComputerSize(stored: string, allowed: readonly ComputerSize[]) {
  const size = ComputerSizeSchema.catch("standard").parse(stored);
  return allowed.includes(size) ? size : (allowed.at(-1) ?? "standard");
}

/** The size the computer starts at next: its own choice, within its organization's plan. */
export async function planComputerSize(
  prisma: Pick<PrismaClient, "computer">,
  computerId: string,
): Promise<ComputerSize> {
  const computer = await prisma.computer.findUnique({
    where: { id: computerId },
    select: {
      size: true,
      space: { select: { organization: { select: COMPUTER_SIZE_PLAN_SELECT } } },
    },
  });
  if (!computer) return "standard";
  return effectiveComputerSize(computer.size, allowedComputerSizes(computer.space.organization));
}

/** Months between two UTC calendar months, without rounding partial months. */
function monthsBetween(start: Date, end: Date): number {
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth()
  );
}

/** Always shift from the original anchor, so February does not move a January 31 renewal. */
function monthlyAnniversary(start: Date, months: number): Date {
  const shifted = new Date(start);
  shifted.setUTCDate(1);
  shifted.setUTCMonth(start.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate();
  shifted.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return shifted;
}

/** The latest monthly anniversary of start at or before now. */
function latestMonthlyAnniversary(start: Date, now: Date): Date {
  const months = monthsBetween(start, now);
  const anniversary = monthlyAnniversary(start, months);
  return anniversary <= now ? anniversary : monthlyAnniversary(start, months - 1);
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
): Promise<Array<{ kind: string; size: string | null; hours: number }>> {
  // The allowance is per organization, so it counts the computers of all its Spaces.
  return runAsSystem("computer allowance across an organization's Spaces", () =>
    prisma.$queryRaw<Array<{ kind: string; size: string | null; hours: number }>>(Prisma.sql`
      SELECT "kind", "size", SUM("seconds")::float8 / 3600 AS "hours"
      FROM (${sandboxRunWindow(organizationId, since, now)}) AS runs
      GROUP BY "kind", "size"`),
  );
}

export function sandboxRunHoursByComputer(
  prisma: Pick<PrismaClient, "$queryRaw">,
  organizationId: string,
  since: Date,
  now: Date,
) {
  return runAsSystem("computer usage across an organization's Spaces", () =>
    prisma.$queryRaw<
      Array<{ computerId: string; kind: string; size: string | null; hours: number }>
    >(Prisma.sql`
      SELECT "computerId", "kind", "size", SUM("seconds")::float8 / 3600 AS "hours"
      FROM (${sandboxRunWindow(organizationId, since, now)}) AS runs
      GROUP BY "computerId", "kind", "size"`),
  );
}

function sandboxRunWindow(organizationId: string, since: Date, now: Date) {
  return Prisma.sql`
    SELECT r."computerId", r."kind", r."size", EXTRACT(EPOCH FROM (
        LEAST(COALESCE(r."endedAt", ${now}::timestamp(3)), ${now}::timestamp(3))
        - GREATEST(r."startedAt", ${since}::timestamp(3))
      )) AS "seconds"
    FROM "computer_runs" AS r
    JOIN "spaces" AS s ON s."id" = r."spaceId"
    WHERE s."organizationId" = ${organizationId}
      AND r."startedAt" < ${now}::timestamp(3)
      AND (r."endedAt" IS NULL OR r."endedAt" > ${since}::timestamp(3))`;
}
