import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";

/**
 * Shared by both artifact-authoring paths (the human-facing `create` RPC and
 * the bot's `attach_file` tool): attaching something with the same name as
 * an existing artifact, for the same bot/group, becomes a new version of
 * that artifact instead of an unrelated duplicate. Matching is by the
 * *current* display name (case-insensitive) of the most recent version in
 * scope — a rename on a later version naturally becomes what the next
 * update matches against.
 */
export async function resolveNextArtifactVersion(
  prisma: Pick<PrismaClient, "artifact">,
  params: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string | null;
    name: string;
  },
): Promise<{ rootArtifactId: string | null; version: number }> {
  const previous = await prisma.artifact.findFirst({
    where: {
      spaceId: params.spaceId,
      userId: params.userId,
      botId: params.botId,
      groupId: params.groupId ?? null,
      name: { equals: params.name, mode: "insensitive" },
    },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    select: { id: true, rootArtifactId: true, version: true },
  });
  if (!previous) return { rootArtifactId: null, version: 1 };
  return {
    rootArtifactId: previous.rootArtifactId ?? previous.id,
    version: previous.version + 1,
  };
}

const MAX_VERSION_ALLOCATION_ATTEMPTS = 5;

type ArtifactVersionWrite = {
  rootArtifactId: string | null;
  version: number;
};

/**
 * `resolveNextArtifactVersion` reads then the caller writes. Two concurrent
 * attachments can both observe "no previous row" and insert two version-1
 * roots — the family/version unique index does not stop that, because each
 * new root's family key is its own id. They can also both pick the same next
 * version of an existing family. Storage I/O stays outside this function;
 * the transaction only serializes the read and the insert, with a
 * transaction-scoped advisory lock on the scope and name. The unique index
 * remains the backstop for a same-family version clash, which is retried.
 */
export async function withResolvedArtifactVersion<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  params: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string | null;
    name: string;
  },
  attempt: (
    db: Pick<Prisma.TransactionClient, "artifact">,
    version: ArtifactVersionWrite,
  ) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < MAX_VERSION_ALLOCATION_ATTEMPTS; i++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${artifactVersionLockKey(params)}, 0))::text AS "lock"
        `);
        const version = await resolveNextArtifactVersion(tx, params);
        return await attempt(tx, version);
      });
    } catch (error) {
      if (!isArtifactVersionConflict(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** Same identity `resolveNextArtifactVersion` matches on, so concurrent publishes queue. */
function artifactVersionLockKey(params: {
  spaceId: string;
  userId: string;
  botId: string;
  groupId?: string | null;
  name: string;
}): string {
  return [
    params.spaceId,
    params.userId,
    params.botId,
    params.groupId ?? "",
    params.name.toLowerCase(),
  ].join("\u001f");
}

function isArtifactVersionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
