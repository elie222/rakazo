import { Prisma, type PrismaClient } from "./client.js";

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

/**
 * `resolveNextArtifactVersion` reads then the caller writes — two concurrent
 * attachments (e.g. two overlapping `attach_file` calls, or a client retry)
 * can both resolve the same next version number. Rather than a lock held for
 * the whole read-modify-write (this spans storage I/O too, done inside
 * `create`), this relies on the DB's own uniqueness constraint on
 * (family, version) — see the artifact_version_uniqueness migration — as the
 * actual correctness guarantee, and retries on conflict: re-resolve (the
 * loser now sees the winner's row) and try again.
 */
export async function withResolvedArtifactVersion<T>(
  prisma: Pick<PrismaClient, "artifact">,
  params: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string | null;
    name: string;
  },
  attempt: (version: { rootArtifactId: string | null; version: number }) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < MAX_VERSION_ALLOCATION_ATTEMPTS; i++) {
    const version = await resolveNextArtifactVersion(prisma, params);
    try {
      return await attempt(version);
    } catch (error) {
      if (!isArtifactVersionConflict(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function isArtifactVersionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
