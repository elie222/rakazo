import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

export async function signalOrganizationCapabilities(
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "publishSpaceChange"> | undefined,
  organizationId: string | null | undefined,
) {
  if (!organizationId || !events?.publishSpaceChange) return;
  const spaces = await runAsSystem("notify Spaces whose shared capabilities changed", () =>
    prisma.space.findMany({
      where: { organizationId, deletingAt: null },
      select: { id: true },
    }),
  );
  await Promise.all(spaces.map(({ id }) => events.publishSpaceChange?.(id, "capabilities")));
}
