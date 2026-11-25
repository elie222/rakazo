import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, isRecordNotFound, lockArtifactVersionName, Prisma } from "@rakazo/db";

type ArtifactMember = {
  id: string;
  storageKey: string;
  createdAt: Date;
  botId: string | null;
  groupId: string | null;
  name: string;
};
type Deps = { prisma: PrismaClient; artifacts: ArtifactStore };

/**
 * Deletes the family whose root is `rootId` in `spaceId`: the versions first, then the root,
 * removing each blob before its row and the root only while it has no versions. A row or blob
 * that is already gone counts as done. Says `"gone"` when the root was not there to delete.
 *
 * With `onlyOlderThan`, it stops as soon as a member was created at or after that time and says
 * `"kept"`: a version published while the family was being deleted stays, with the members not
 * yet deleted. The root goes under the same-name publish lock, so a publish that has not joined
 * the family by then waits for the deletion and starts a new family.
 */
export async function deleteArtifactFamilyRows(
  deps: Deps,
  input: { spaceId: string; rootId: string; context: AdapterContext; onlyOlderThan?: Date },
): Promise<"deleted" | "gone" | "kept"> {
  const { spaceId, rootId, context, onlyOlderThan } = input;
  for (;;) {
    const members = await deps.prisma.artifact.findMany({
      where: { spaceId, OR: [{ id: rootId }, { rootArtifactId: rootId }] },
      select: {
        id: true,
        storageKey: true,
        createdAt: true,
        botId: true,
        groupId: true,
        name: true,
      },
    });
    if (members.length === 0) return "gone";
    if (onlyOlderThan && members.some((row) => row.createdAt >= onlyOlderThan)) return "kept";
    const child = members.find((row) => row.id !== rootId);
    if (child) {
      await removeArtifactBlob(deps.artifacts, context, child);
      await deleteArtifactRowIfPresent(deps.prisma, child.id);
      continue;
    }
    const root = members.find((row) => row.id === rootId);
    if (!root) throw new IsolationError();
    const outcome = await deleteArtifactRootIfChildless(deps, context, { ...root, spaceId });
    if (outcome === "has-child") continue;
    return outcome;
  }
}

async function deleteArtifactRootIfChildless(
  deps: Deps,
  context: AdapterContext,
  root: ArtifactMember & { spaceId: string },
): Promise<"deleted" | "gone" | "has-child"> {
  let outcome: "deleted" | "gone" | "has-child" = "gone";
  await deps.prisma.$transaction(async (tx) => {
    // Only a file with a bot can be joined by a same-name publish, which holds this lock.
    if (root.botId) {
      await lockArtifactVersionName(tx, {
        spaceId: root.spaceId,
        botId: root.botId,
        groupId: root.groupId,
        name: root.name,
      });
    }
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "artifacts" WHERE id = ${root.id} FOR UPDATE
    `);
    if (locked.length === 0) {
      outcome = "gone";
      return;
    }
    const child = await tx.artifact.findFirst({
      where: { rootArtifactId: root.id },
      select: { id: true },
    });
    if (child) {
      outcome = "has-child";
      return;
    }
    await removeArtifactBlob(deps.artifacts, context, root);
    try {
      await tx.artifact.delete({ where: { id: root.id } });
    } catch (error) {
      if (isRecordNotFound(error)) {
        outcome = "gone";
        return;
      }
      throw error;
    }
    outcome = "deleted";
  });
  return outcome;
}

async function removeArtifactBlob(
  artifacts: ArtifactStore,
  context: AdapterContext,
  member: ArtifactMember,
): Promise<void> {
  try {
    await artifacts.remove(member.storageKey, context);
  } catch (error) {
    if (isAlreadyRemoved(error)) return;
    throw error;
  }
}

function isAlreadyRemoved(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  const name = "name" in error ? error.name : undefined;
  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "NoSuchKey" ||
    name === "NotFound" ||
    name === "NoSuchKey"
  );
}

async function deleteArtifactRowIfPresent(
  prisma: Pick<PrismaClient, "artifact">,
  id: string,
): Promise<void> {
  try {
    await prisma.artifact.delete({ where: { id } });
  } catch (error) {
    if (isRecordNotFound(error)) return;
    throw error;
  }
}
