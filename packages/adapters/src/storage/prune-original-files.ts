import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { HIDDEN_ARTIFACT_MIME_TYPES, Prisma, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { bestEffortWithoutPaths } from "../computers/attachment-copies/copy-attachment.js";
import type { FilesCleanupSettings } from "../computers/attachment-copies/files-cleanup-settings.js";
import { deleteArtifactFamilyRows } from "./delete-artifact-family.js";

/** Families one pass deletes, oldest first; the rest wait for the next pass. */
const ORIGINAL_FILES_PER_PASS = 200;

type DueFamily = { id: string; spaceId: string; userId: string; botId: string | null };

/**
 * The oldest families whose newest version is older than `cutoff` and whose kind is switched on:
 * created when the newest version came from a run, received otherwise. A family with any hidden
 * file (an MCP app's HTML, a step screenshot) is never one.
 */
function dueFamilies(
  prisma: PrismaClient,
  cutoff: Date,
  switches: { received: boolean; created: boolean },
): Promise<DueFamily[]> {
  const kind =
    switches.received && switches.created
      ? Prisma.empty
      : switches.received
        ? Prisma.sql`WHERE newest."runId" IS NULL`
        : Prisma.sql`WHERE newest."runId" IS NOT NULL`;
  return prisma.$queryRaw<DueFamily[]>(Prisma.sql`
    WITH families AS (
      SELECT COALESCE("rootArtifactId", id) AS "rootId", max("createdAt") AS "newestAt"
      FROM "artifacts"
      GROUP BY COALESCE("rootArtifactId", id)
      HAVING max("createdAt") < ${cutoff}::timestamp(3)
        AND NOT bool_or("mimeType" IN (${Prisma.join(HIDDEN_ARTIFACT_MIME_TYPES)}))
    )
    SELECT root.id, root."spaceId", root."userId", root."botId"
    FROM families
    JOIN "artifacts" root ON root.id = families."rootId"
    CROSS JOIN LATERAL (
      SELECT member."runId" FROM "artifacts" member
      WHERE member.id = families."rootId" OR member."rootArtifactId" = families."rootId"
      ORDER BY member.version DESC, member."createdAt" DESC, member.id DESC
      LIMIT 1
    ) newest
    ${kind}
    ORDER BY families."newestAt" ASC, families."rootId" ASC
    LIMIT ${ORIGINAL_FILES_PER_PASS}
  `);
}

/**
 * The worker's pass that deletes the original files people sent in (`received`) or bots made
 * (`created`) once the newest version of the file is older than the settings say: the whole
 * family, versions first, each blob before its row. Hidden files are kept, and so is a family
 * that gets a new version while it is being deleted, from that point on. At most
 * `ORIGINAL_FILES_PER_PASS` families go per pass, and it looks at most once per interval in this
 * process. Off, and querying nothing, unless a switch turns it on.
 */
export function createOriginalFilesPruner(deps: {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  settings: Pick<FilesCleanupSettings, "received" | "created" | "maxAgeMs" | "intervalMs">;
  now?: () => Date;
}): (() => Promise<void>) | undefined {
  const { received, created, maxAgeMs, intervalMs } = deps.settings;
  if (!received && !created) return undefined;
  const now = deps.now ?? (() => new Date());
  let lastRun: number | undefined;
  return async () => {
    const started = now().getTime();
    if (lastRun !== undefined && started - lastRun < intervalMs) return;
    lastRun = started;
    const cutoff = new Date(started - maxAgeMs);
    const { removed, kept } = await runAsSystem("prune original files", async () => {
      const count = { removed: 0, kept: 0 };
      for (const family of await dueFamilies(deps.prisma, cutoff, { received, created })) {
        const context: AdapterContext = {
          operationId: `original-files-prune:${family.id}`,
          traceId: `original-files-prune:${family.id}`,
          spaceId: family.spaceId,
          userId: family.userId,
          botId: family.botId ?? family.id,
          signal: new AbortController().signal,
        };
        // One family that cannot be deleted (logged by its code) never stops the ones after it.
        const outcome = await bestEffortWithoutPaths(
          "delete an old original file",
          deleteArtifactFamilyRows(deps, {
            spaceId: family.spaceId,
            rootId: family.id,
            context,
            // A version published since the family was picked keeps it.
            onlyOlderThan: cutoff,
          }),
        );
        if (outcome === "deleted") count.removed += 1;
        if (outcome === "kept") count.kept += 1;
      }
      return count;
    });
    if (removed) {
      getLogger().info("files-cleanup.originals.removed", { "files.originals.removed": removed });
    }
    if (kept) {
      getLogger().info("files-cleanup.originals.kept", { "files.originals.kept": kept });
    }
  };
}
