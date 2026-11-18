import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { GUEST_ROLE } from "../billing/billing.js";
import type { PrismaClient } from "../database/client.js";
import { retryWhileDatabaseUnavailable } from "../database/database-outage.js";
import { runAsSystem } from "../database/row-security.js";
import { ChangeLatch } from "../threads/event-stream.js";

const IDLE_WAIT_MS = 60_000;
const PUBLISH_RETRY_MS = 15_000;

const organizationChangesTopic = (userId: string) => `organization-changes:${userId}`;

/**
 * Tells every member of the organization, and `alsoUserIds` (someone just removed), that its
 * members and their count may have changed. Each person is signalled on their own topic, so only
 * those members hear it. Like the other signals it rides out a short database outage in the
 * background; call it after the change commits.
 */
export function publishOrganizationChange(
  prisma: PrismaClient,
  realtime: RealtimeFanout | undefined,
  organizationId: string,
  alsoUserIds: readonly string[] = [],
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  if (!realtime) return Promise.resolve();
  const publish = async () => {
    const members = await runAsSystem("signal an organization's members", () =>
      prisma.member.findMany({
        where: { organizationId, role: { not: GUEST_ROLE } },
        select: { userId: true },
      }),
    );
    const userIds = new Set([...members.map((member) => member.userId), ...alsoUserIds]);
    await Promise.all(
      [...userIds].map((userId) => realtime.publish(organizationChangesTopic(userId), "")),
    );
  };
  void retryWhileDatabaseUnavailable(publish, {
    source: "organization signal",
    waitMs: PUBLISH_RETRY_MS,
    ...options,
  }).catch((error: unknown) => getLogger().warn("organization signal not published", { error }));
  return Promise.resolve();
}

/**
 * Signals once when following starts, then whenever one of the user's organizations may have
 * changed its members. Signals carry no content, and a burst that arrives before the reader asks
 * again becomes one.
 */
export async function* followOrganizationChanges(
  realtime: RealtimeFanout,
  userId: string,
  signal?: AbortSignal,
): AsyncGenerator<void> {
  const latch = new ChangeLatch();
  const unsubscribe = await realtime.subscribe(organizationChangesTopic(userId), () =>
    latch.notify(),
  );
  try {
    let seen = latch.generation;
    yield;
    while (!signal?.aborted) {
      await latch.waitForChange(seen, IDLE_WAIT_MS, signal);
      if (latch.generation === seen) continue;
      seen = latch.generation;
      yield;
    }
  } finally {
    await unsubscribe();
  }
}
