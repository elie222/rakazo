import type { MediaGenerationProvider, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { JsonColumnMismatchError, readJsonColumn, reportJsonColumnOnce } from "@rakazo/db";
import { z } from "zod";
import { includedUsage } from "../computers/sandbox/sandbox-allowance.js";
import { MEDIA_JOB_KIND } from "./media-generation-tools.js";

/** What a submitted generation charges once it completes. */
export type MediaCharge = { organizationId: string; micros: number };
const savedCharge = z.object({
  charge: z.object({ organizationId: z.string(), micros: z.number() }).optional(),
});

/**
 * What the organization's submitted generations will charge once they complete, so generations
 * running at once cannot each spend the same balance. A failed one charges nothing.
 */
async function pendingMediaMicros(prisma: PrismaClient, organizationId: string, since: Date) {
  const jobs = await prisma.externalEffect.findMany({
    where: {
      kind: MEDIA_JOB_KIND,
      status: { in: ["media_submitting", "media_pending", "media_polling"] },
      createdAt: { gte: since },
      space: { organizationId },
    },
    select: { id: true, request: true },
  });
  return jobs.reduce((sum, job) => {
    const row = { table: "external_effects", column: "request", id: job.id };
    try {
      const { charge } = readJsonColumn(savedCharge, job.request, row, "reject");
      return sum + (charge?.organizationId === organizationId ? charge.micros : 0);
    } catch (error) {
      if (!(error instanceof JsonColumnMismatchError)) throw error;
      reportJsonColumnOnce("Stored media job request is invalid", error.row);
      return sum;
    }
  }, 0);
}

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
  const pending = await pendingMediaMicros(deps.prisma, space.organizationId, usage.since);
  if (usage.limitMicros - usage.usedMicros - pending < micros)
    return {
      error: `Not enough included usage left for this ${kind}.${
        usage.resetsAt ? ` It renews on ${usage.resetsAt.toISOString().slice(0, 10)}.` : ""
      } The organization owner can upgrade the plan in Billing.`,
    };
  return { charge: { organizationId: space.organizationId, micros } };
}
