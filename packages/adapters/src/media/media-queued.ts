import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { MEDIA_JOB_KIND, savedMediaCharge } from "./media-generation-tools.js";

/**
 * What the organization's videos still running at the provider will charge once they complete,
 * so they hold their price from submission. One already charged counts only as its charge. The
 * poll deadline closes every one of them.
 */
export async function queuedMediaMicros(
  prisma: Pick<PrismaClient, "externalEffect" | "includedUsageCharge">,
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
  if (!jobs.length) return 0;
  const charged = await runAsSystem("charges of an organization's queued videos", () =>
    prisma.includedUsageCharge.findMany({
      where: { source: { in: jobs.map((job) => `media:${job.id}`) } },
      select: { source: true },
    }),
  );
  const done = new Set(charged.map((charge) => charge.source));
  return jobs.reduce((sum, job) => {
    if (done.has(`media:${job.id}`)) return sum;
    const charge = savedMediaCharge(job);
    return sum + (charge?.organizationId === organizationId ? charge.micros : 0);
  }, 0);
}
