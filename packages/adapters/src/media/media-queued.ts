import type { PrismaClient } from "@rakazo/db";
import { MEDIA_JOB_KIND, savedMediaCharge } from "./media-generation-tools.js";

/**
 * What the organization's videos still running at the provider will charge once they complete,
 * so they hold their price from submission. The poll deadline closes every one of them.
 */
export async function queuedMediaMicros(
  prisma: Pick<PrismaClient, "externalEffect">,
  organizationId: string,
): Promise<number> {
  const jobs = await prisma.externalEffect.findMany({
    where: {
      kind: MEDIA_JOB_KIND,
      // Images finish within their turn and are charged there; only videos keep running.
      request: { path: ["tool"], equals: "generate_video" },
      status: { in: ["media_pending", "media_polling"] },
      space: { organizationId },
    },
    select: { id: true, request: true },
  });
  return jobs.reduce((sum, job) => {
    const charge = savedMediaCharge(job);
    return sum + (charge?.organizationId === organizationId ? charge.micros : 0);
  }, 0);
}
