import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { retryWhileDatabaseUnavailable, runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

export async function signalOrganizationCapabilities(
  prisma: PrismaClient,
  events: Pick<ThreadEvents, "publishSpaceChange"> | undefined,
  organizationId: string | null | undefined,
) {
  if (!organizationId || !events?.publishSpaceChange) return;
  const publish = events.publishSpaceChange.bind(events);
  void bestEffort(
    "publish organization capability changes",
    retryWhileDatabaseUnavailable(
      async () => {
        const spaces = await runAsSystem("notify Spaces whose shared capabilities changed", () =>
          prisma.space.findMany({
            where: { organizationId, deletingAt: null },
            select: { id: true },
          }),
        );
        await Promise.all(spaces.map(({ id }) => publish(id, "capabilities")));
      },
      { source: "organization capability signal", waitMs: 15_000 },
    ),
  );
}
