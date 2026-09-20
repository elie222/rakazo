import type { PrismaClient } from "./client.js";

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
