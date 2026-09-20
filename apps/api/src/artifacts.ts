import { createHash } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import {
  AttachmentValidationError,
  decodeAttachmentBase64,
  messageBlockForArtifact,
  promptTextForAttachments,
  validateAttachmentMimeType,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma, withResolvedArtifactVersion } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

function adapterContext(actor: Actor, botId: string, operationId: string) {
  return {
    operationId,
    traceId: operationId,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

export async function createOwnedArtifact(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  actor: Actor,
  input: {
    botId: string;
    groupId?: string;
    name: string;
    description?: string;
    mimeType: string;
    contentBase64: string;
  },
) {
  validateAttachmentMimeType(input.mimeType);
  const bytes = decodeAttachmentBase64(input.contentBase64);
  const context = adapterContext(actor, input.botId, `artifact-create:${input.botId}`);
  const stored = await deps.artifacts.put(
    { name: input.name, mimeType: input.mimeType, bytes },
    context,
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  const row = await withResolvedArtifactVersion(
    deps.prisma,
    {
      spaceId: actor.spaceId,
      userId: actor.userId,
      botId: input.botId,
      groupId: input.groupId,
      name: input.name,
    },
    ({ rootArtifactId, version }) =>
      deps.prisma.artifact.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: input.botId,
          groupId: input.groupId,
          name: input.name,
          description: input.description?.trim() || null,
          mimeType: input.mimeType,
          size: bytes.byteLength,
          hash,
          storageKey: stored.id,
          rootArtifactId,
          version,
        },
      }),
  ).catch(async (error) => {
    await deps.artifacts.remove(stored.id, context).catch(() => undefined);
    throw error;
  });
  return {
    id: row.id,
    botId: row.botId,
    groupId: row.groupId,
    runId: row.runId,
    name: row.name,
    description: row.description,
    mimeType: row.mimeType,
    size: row.size,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getOwnedArtifact(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  actor: Actor,
  input: { botId: string; artifactId: string },
) {
  const row = await deps.prisma.artifact.findFirst({
    where: {
      id: input.artifactId,
      botId: input.botId,
      groupId: null,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
  });
  if (!row) throw new IsolationError();
  return readArtifact(deps.artifacts, actor, row, input.botId);
}

export async function getSpaceArtifact(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  actor: Actor,
  input: { artifactId: string; groupId: string; contextBotId: string },
) {
  const row = await deps.prisma.artifact.findFirst({
    where: {
      id: input.artifactId,
      groupId: input.groupId,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
  });
  if (!row) throw new IsolationError();
  return readArtifact(deps.artifacts, actor, row, input.contextBotId);
}

/**
 * Opens an artifact from the space-wide Artifacts tab, where the caller only
 * has the artifact's id (not the bot/group thread it was created in). Scoped
 * to spaceId + userId like every other artifact read; the row's own botId is
 * only used for the adapter's tracing context, not for authorization.
 */
export async function getSpaceArtifactById(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  actor: Actor,
  input: { artifactId: string },
) {
  const row = await deps.prisma.artifact.findFirst({
    where: {
      id: input.artifactId,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
  });
  if (!row) throw new IsolationError();
  return readArtifact(deps.artifacts, actor, row, row.botId ?? row.groupId ?? row.id);
}

async function readArtifact(
  artifacts: ArtifactStore,
  actor: Actor,
  row: {
    id: string;
    botId: string | null;
    groupId: string | null;
    runId: string | null;
    storageKey: string;
    name: string;
    description: string | null;
    mimeType: string;
    size: number;
    version: number;
    createdAt: Date;
  },
  contextBotId: string,
) {
  const bytes = await artifacts.get(
    row.storageKey,
    adapterContext(actor, contextBotId, `artifact-get:${row.id}`),
  );
  return {
    id: row.id,
    botId: row.botId,
    groupId: row.groupId,
    runId: row.runId,
    name: row.name,
    description: row.description,
    mimeType: row.mimeType,
    size: row.size,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    contentBase64: Buffer.from(bytes).toString("base64"),
  };
}

type ListSpaceRow = {
  id: string;
  familyId: string;
  botId: string | null;
  groupId: string | null;
  runId: string | null;
  name: string;
  description: string | null;
  mimeType: string;
  size: number;
  version: number;
  createdAt: Date;
  versionCount: bigint | number;
};

/**
 * One row per family (the latest version's info), collapsed and paginated in
 * the database via a `DISTINCT ON` + keyset cursor — not a bounded raw fetch
 * collapsed in JS, which can never page past its own snapshot. Group-owned
 * artifacts are included: every artifact (bot- or group-owned) is scoped by
 * spaceId/userId, same as the rest of this file's reads.
 */
export async function listSpaceArtifacts(
  deps: { prisma: Pick<PrismaClient, "artifact" | "$queryRaw"> },
  actor: Actor,
  input: { botId?: string; cursor?: string; limit?: number },
) {
  const take = Math.min(Math.max(input.limit ?? 30, 1), 60);
  const botFilter = input.botId ? Prisma.sql`AND "botId" = ${input.botId}` : Prisma.empty;

  let cursorFilter = Prisma.empty;
  if (input.cursor) {
    // A cursor that isn't one of the caller's own rows (foreign/stale) is
    // ignored rather than erroring — same as returning the first page again.
    const cursorRow = await deps.prisma.artifact.findFirst({
      where: { id: input.cursor, spaceId: actor.spaceId, userId: actor.userId },
      select: { createdAt: true },
    });
    if (cursorRow) {
      cursorFilter = Prisma.sql`AND (latest."createdAt", latest.id) < (${cursorRow.createdAt}, ${input.cursor})`;
    }
  }

  const rows = await deps.prisma.$queryRaw<ListSpaceRow[]>(Prisma.sql`
    WITH scoped AS (
      SELECT * FROM "artifacts"
      WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} ${botFilter}
    ),
    latest AS (
      SELECT DISTINCT ON (COALESCE("rootArtifactId", id))
        id, "botId", "groupId", "runId", name, description, "mimeType", size, version, "createdAt", "rootArtifactId"
      FROM scoped
      ORDER BY COALESCE("rootArtifactId", id), version DESC
    ),
    counts AS (
      SELECT COALESCE("rootArtifactId", id) AS "familyId", COUNT(*)::int AS "versionCount"
      FROM scoped
      GROUP BY COALESCE("rootArtifactId", id)
    )
    SELECT latest.id, COALESCE(latest."rootArtifactId", latest.id) AS "familyId",
           latest."botId", latest."groupId", latest."runId", latest.name,
           latest.description, latest."mimeType", latest.size, latest.version, latest."createdAt",
           counts."versionCount"
    FROM latest
    JOIN counts ON counts."familyId" = COALESCE(latest."rootArtifactId", latest.id)
    WHERE true ${cursorFilter}
    ORDER BY latest."createdAt" DESC, latest.id DESC
    LIMIT ${take + 1}
  `);

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return {
    // `id` is the family's stable root id — never the version row that
    // happens to be latest right now — so a card's URL never changes just
    // because a new version was published.
    items: page.map((row) => ({
      id: row.familyId,
      botId: row.botId,
      groupId: row.groupId,
      runId: row.runId,
      name: row.name,
      description: row.description,
      mimeType: row.mimeType,
      size: row.size,
      version: row.version,
      versionCount: Number(row.versionCount),
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

/** All versions of a family, latest first — for the version-switcher dropdown. */
export async function listArtifactVersions(
  deps: { prisma: Pick<PrismaClient, "artifact"> },
  actor: Actor,
  input: { familyId: string },
) {
  const anchor = await deps.prisma.artifact.findFirst({
    where: { id: input.familyId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, rootArtifactId: true },
  });
  if (!anchor) throw new IsolationError();
  const rootId = anchor.rootArtifactId ?? anchor.id;
  const rows = await deps.prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [{ id: rootId }, { rootArtifactId: rootId }],
    },
    orderBy: { version: "desc" },
  });
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Deletes a whole family — the root row and every version — plus their storage blobs. */
export async function deleteArtifactFamily(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  actor: Actor,
  input: { familyId: string },
) {
  const anchor = await deps.prisma.artifact.findFirst({
    where: { id: input.familyId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, rootArtifactId: true, botId: true },
  });
  if (!anchor) throw new IsolationError();
  const rootId = anchor.rootArtifactId ?? anchor.id;
  const members = await deps.prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [{ id: rootId }, { rootArtifactId: rootId }],
    },
    select: { id: true, storageKey: true, botId: true },
  });
  // Delete the DB rows first: that's the state the UI and the rest of the
  // app treat as authoritative, so it must never survive a blob-removal
  // failure (which would otherwise leave rows pointing at storage the app
  // just told the user was gone). Deleting the root row cascades
  // (onDelete: Cascade) to every version. Blob removal is best-effort
  // cleanup after — a failure here is a storage leak, not a correctness
  // problem, but it's logged rather than silently swallowed so it's
  // discoverable.
  await deps.prisma.artifact.delete({ where: { id: rootId } });
  await Promise.all(
    members.map((member) =>
      deps.artifacts
        .remove(
          member.storageKey,
          adapterContext(actor, member.botId ?? member.id, `artifact-delete:${member.id}`),
        )
        .catch((error) => {
          getLogger().error("artifact blob cleanup failed after delete", error, {
            "artifact.id": member.id,
            "artifact.storageKey": member.storageKey,
          });
        }),
    ),
  );
  return { ok: true as const };
}

type SendAttachmentRow = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
};

function normalizeAttachmentIds(artifactIds: string[] | undefined) {
  const ids = [...new Set(artifactIds ?? [])];
  if (ids.length > ATTACHMENT_MAX_COUNT) {
    throw new AttachmentValidationError(`At most ${ATTACHMENT_MAX_COUNT} attachments per message`);
  }
  return ids;
}

function toAttachmentResolution<T extends SendAttachmentRow>(ids: string[], rows: T[]) {
  if (rows.length !== ids.length) throw new IsolationError();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const artifacts = ids.map((id) => byId.get(id)!);
  const blocks = artifacts.map((row) =>
    messageBlockForArtifact({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
    }),
  );
  return { blocks, artifacts };
}

export async function resolveSendAttachments(
  deps: { prisma: Pick<PrismaClient, "artifact"> },
  actor: Actor,
  botId: string,
  artifactIds: string[] | undefined,
) {
  const ids = normalizeAttachmentIds(artifactIds);
  if (!ids.length) return toAttachmentResolution(ids, [] as SendAttachmentRow[]);

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: ids },
      botId,
      groupId: null,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
  });
  return toAttachmentResolution(ids, rows);
}

export async function resolveGroupSendAttachments(
  deps: { prisma: Pick<PrismaClient, "artifact"> },
  actor: Actor,
  groupId: string,
  memberBotIds: string[],
  artifactIds: string[] | undefined,
) {
  const ids = normalizeAttachmentIds(artifactIds);
  if (!ids.length) return toAttachmentResolution(ids, [] as SendAttachmentRow[]);

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: ids },
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [
        { groupId },
        // Accept artifacts uploaded by a current member before group ownership
        // was persisted. Removing that member revokes this legacy fallback.
        { groupId: null, botId: { in: memberBotIds } },
      ],
    },
  });
  return toAttachmentResolution(ids, rows);
}

export function buildUserMessageBlocks(
  text: string | undefined,
  attachmentBlocks: ReturnType<typeof messageBlockForArtifact>[],
) {
  const blocks = [];
  const caption = text?.trim();
  if (caption) blocks.push({ kind: "text" as const, text: caption });
  blocks.push(...attachmentBlocks);
  return blocks;
}

export function buildSendPrompt(
  text: string | undefined,
  artifacts: Array<{ name: string; mimeType: string; size: number }>,
  connectorNames: string[] = [],
) {
  const prompt = promptTextForAttachments(text, artifacts);
  if (connectorNames.length === 0) return prompt;
  const marker = "Use these connectors if relevant:";
  const existing = new RegExp(`^${marker} (.*)\\.$`, "m").exec(prompt);
  const names = [
    ...new Set([
      ...(existing?.[1]
        ?.split(",")
        .map((name) => name.trim())
        .filter(Boolean) ?? []),
      ...connectorNames.map((name) => name.trim()).filter(Boolean),
    ]),
  ];
  const line = `${marker} ${names.join(", ")}.`;
  if (existing) return prompt.replace(existing[0], () => line);
  return prompt ? `${prompt}\n\n${line}` : line;
}
