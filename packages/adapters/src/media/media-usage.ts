import type { MediaGenerationProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { mediaAllowancePlan, mediaChargedMicros } from "@rakazo/db";
import { queuedMediaMicros } from "./media-queued.js";
import type { ResolvedMediaSource } from "./media-sources.js";

/** What a submitted hosted generation charges once it completes. */
export type MediaCharge = { organizationId: string; micros: number };

type MediaPrisma = Pick<
  PrismaClient,
  "deploymentSettings" | "organization" | "mediaCharge" | "externalEffect"
>;

/**
 * The organization's media balance this period in micros, with videos still running counted at
 * their price, or null where billing is off and nothing is metered.
 */
export async function mediaBalance(prisma: MediaPrisma, organizationId: string) {
  const plan = await mediaAllowancePlan(prisma, organizationId);
  if (!plan) return null;
  const [charged, queued] = await Promise.all([
    mediaChargedMicros(prisma, organizationId, plan.since),
    queuedMediaMicros(prisma, organizationId),
  ]);
  return { limitMicros: plan.limitMicros, usedMicros: charged + queued, trial: plan.trial };
}

/**
 * What a new hosted generation will charge the Space's organization, or why it cannot be
 * submitted. Nothing is charged where billing is off or the provider costs nothing.
 */
export async function priceMediaGeneration(
  prisma: MediaPrisma & Pick<PrismaClient, "space">,
  provider: MediaGenerationProvider,
  spaceId: string,
  kind: "image" | "video",
): Promise<{ charge: MediaCharge | null } | { error: string }> {
  const micros = kind === "video" ? provider.prices.videoMicros : provider.prices.imageMicros;
  if (micros <= 0) return { charge: null };
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: { organizationId: true },
  });
  if (!space) return { error: "Media generation is unavailable." };
  const balance = await mediaBalance(prisma, space.organizationId);
  if (!balance) return { charge: null };
  if (balance.trial)
    return {
      error:
        "Image and video generation is unavailable during a trial. It starts with the paid plan.",
    };
  if (!balance.limitMicros)
    return {
      error: "Image and video generation needs a paid plan. The owner can subscribe in Billing.",
    };
  if (balance.limitMicros - balance.usedMicros < micros)
    return { error: `Not enough media balance left this month for this ${kind}.` };
  return { charge: { organizationId: space.organizationId, micros } };
}

/**
 * Prices a run's generations only when the deployment's hosted provider makes them; media made
 * with the owner's own connection is billed to them by its provider, so it is never priced,
 * refused or charged here.
 */
export function hostedMediaPrice(
  prisma: MediaPrisma & Pick<PrismaClient, "space">,
  source: ResolvedMediaSource,
  spaceId: string,
) {
  if (source.record.kind !== "hosted") return undefined;
  return (kind: "image" | "video") => priceMediaGeneration(prisma, source.provider, spaceId, kind);
}
