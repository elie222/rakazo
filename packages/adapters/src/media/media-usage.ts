import type { MediaGenerationProvider, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { includedUsage } from "../computers/sandbox/sandbox-allowance.js";

/** What a submitted generation charges once it completes. */
export type MediaCharge = { organizationId: string; micros: number };

/**
 * What a new generation will charge the Space's organization, or why it cannot be submitted.
 * Nothing is charged where included usage is not metered or the provider costs nothing.
 */
export async function priceMediaGeneration(
  deps: { prisma: PrismaClient; sandbox?: SandboxProvider },
  provider: MediaGenerationProvider,
  spaceId: string,
  kind: "image" | "video",
): Promise<{ charge: MediaCharge | null } | { error: string }> {
  const micros = kind === "video" ? provider.prices.videoMicros : provider.prices.imageMicros;
  if (micros <= 0) return { charge: null };
  const space = await deps.prisma.space.findUnique({
    where: { id: spaceId },
    select: { organizationId: true },
  });
  if (!space) return { error: "Media generation is unavailable." };
  const usage = await includedUsage(deps, space.organizationId);
  if (!usage) return { charge: null };
  if (usage.trial)
    return {
      error:
        "Image and video generation is unavailable during a trial. It starts with the paid plan.",
    };
  if (usage.limitMicros - usage.usedMicros < micros)
    return {
      error: `Not enough included usage left for this ${kind}.${
        usage.resetsAt ? ` It renews on ${usage.resetsAt.toISOString().slice(0, 10)}.` : ""
      } The organization owner can upgrade the plan in Billing.`,
    };
  return { charge: { organizationId: space.organizationId, micros } };
}
