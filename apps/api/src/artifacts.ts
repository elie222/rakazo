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
import { IsolationError, type PrismaClient, resolveNextArtifactVersion } from "@rakazo/db";

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
  const { rootArtifactId, version } = await resolveNextArtifactVersion(deps.prisma, {
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: input.botId,
    groupId: input.groupId,
    name: input.name,
  });
  const stored = await deps.artifacts.put(
    { name: input.name, mimeType: input.mimeType, bytes },
    context,
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  const row = await deps.prisma.artifact
    .create({
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
    })
    .catch(async (error) => {
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

const FAMILY_RAW_FETCH_CAP = 500;

export async function listSpaceArtifacts(
  deps: { prisma: Pick<PrismaClient, "artifact"> },
  actor: Actor,
  input: { botId?: string; cursor?: string; limit?: number },
) {
  const take = Math.min(Math.max(input.limit ?? 30, 1), 60);
  const where = {
    spaceId: actor.spaceId,
    userId: actor.userId,
    groupId: null,
    ...(input.botId ? { botId: input.botId } : {}),
  };
  // A family (an artifact and its versions) collapses to one row, showing
  // the latest version's info — its `id` is the family's stable root id, not
  // this specific row's id, so opening it always means "open the family."
  // Every version shares its family's scoping fields, so collapsing happens
  // in JS after one bounded fetch rather than needing a window-function
  // query. FAMILY_RAW_FETCH_CAP bounds worst-case cost: a space with more
  // artifact rows (versions included) than this paginates through in more
  // pages rather than collapsing perfectly on the first one.
  const rows = await deps.prisma.artifact.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: FAMILY_RAW_FETCH_CAP,
  });
  const latestByFamily = new Map<string, (typeof rows)[number]>();
  const versionCountByFamily = new Map<string, number>();
  for (const row of rows) {
    const familyId = row.rootArtifactId ?? row.id;
    versionCountByFamily.set(familyId, (versionCountByFamily.get(familyId) ?? 0) + 1);
    const current = latestByFamily.get(familyId);
    if (!current || row.version > current.version) latestByFamily.set(familyId, row);
  }
  const families = [...latestByFamily.entries()]
    .map(([familyId, row]) => ({ familyId, row }))
    .sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime());

  const startIndex = input.cursor
    ? Math.max(families.findIndex((family) => family.familyId === input.cursor) + 1, 0)
    : 0;
  const page = families.slice(startIndex, startIndex + take);
  const hasMore = startIndex + take < families.length;

  return {
    items: page.map(({ familyId, row }) => ({
      id: familyId,
      botId: row.botId,
      groupId: row.groupId,
      runId: row.runId,
      name: row.name,
      description: row.description,
      mimeType: row.mimeType,
      size: row.size,
      version: row.version,
      versionCount: versionCountByFamily.get(familyId) ?? 1,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? (page.at(-1)?.familyId ?? null) : null,
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
  await Promise.all(
    members.map((member) =>
      deps.artifacts
        .remove(
          member.storageKey,
          adapterContext(actor, member.botId ?? member.id, `artifact-delete:${member.id}`),
        )
        .catch(() => undefined),
    ),
  );
  // Deleting the root row cascades (onDelete: Cascade) to every version.
  await deps.prisma.artifact.delete({ where: { id: rootId } });
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
