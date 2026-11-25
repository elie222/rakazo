import type { MediaGenerationProvider } from "@rakazo/adapter-kit";
import { MEDIA_ALLOWANCE_CENTS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { mediaAllowancePlan, mediaChargedMicros } from "@rakazo/db";
import { queuedMediaMicros } from "./media-queued.js";
import type { ResolvedMediaSource } from "./media-sources.js";
import { MEDIA_REFUSALS } from "./media-usage.prompt.js";

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
  if (!space) return { error: MEDIA_REFUSALS.unavailable };
  const balance = await mediaBalance(prisma, space.organizationId);
  if (!balance) return { charge: null };
  if (balance.trial) return { error: MEDIA_REFUSALS.trial };
  if (!balance.limitMicros) return { error: MEDIA_REFUSALS.noPlan };
  if (balance.limitMicros - balance.usedMicros < micros)
    return { error: MEDIA_REFUSALS.balance(kind) };
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

/** Which media the provider offers at a price one monthly balance can pay at least once. */
export function mediaWithinAllowance(provider: MediaGenerationProvider) {
  const limit = MEDIA_ALLOWANCE_CENTS * 10_000;
  return {
    images: provider.capabilities.images && provider.prices.imageMicros <= limit,
    video: provider.capabilities.video && provider.prices.videoMicros <= limit,
  };
}

/**
 * The deployment's provider without any media whose one generation costs more than a whole
 * monthly balance where billing meters it, so a bot is never offered a tool that is refused
 * on every call.
 */
export async function hostedMediaWithinAllowance(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  provider: MediaGenerationProvider | undefined,
): Promise<MediaGenerationProvider | undefined> {
  const fits = provider && mediaWithinAllowance(provider);
  const images = provider?.capabilities.images && !fits?.images;
  const video = provider?.capabilities.video && !fits?.video;
  if (!provider || !(images || video)) return provider;
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { modelCreditsEnabled: true },
  });
  if (!settings?.modelCreditsEnabled) return provider;
  // The same provider, read through its prototype chain, with only these capabilities changed.
  return Object.create(provider, {
    capabilities: {
      value: {
        ...provider.capabilities,
        images: provider.capabilities.images && !images,
        video: provider.capabilities.video && !video,
      },
    },
  }) as MediaGenerationProvider;
}
