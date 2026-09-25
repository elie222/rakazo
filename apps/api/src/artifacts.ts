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
    (tx, { rootArtifactId, version }) =>
      tx.artifact.create({
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

// Trace with the row's own bot; space and user authorize the read.
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

export class ArtifactListCursorError extends Error {
  constructor() {
    super("Invalid artifact cursor");
    this.name = "ArtifactListCursorError";
  }
}

type ArtifactListCursor = {
  createdAt: string;
  id: string;
  botId: string | null;
  // Freezes the version set for this page sequence.
  asOf: string;
};

const ARTIFACT_LIST_CURSOR_PREFIX = "v1.";

function encodeArtifactListCursor(cursor: ArtifactListCursor): string {
  return (
    ARTIFACT_LIST_CURSOR_PREFIX + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
  );
}

function decodeArtifactListCursor(value: string): ArtifactListCursor {
  if (!value.startsWith(ARTIFACT_LIST_CURSOR_PREFIX)) throw new ArtifactListCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(ARTIFACT_LIST_CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new ArtifactListCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new ArtifactListCursorError();
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.createdAt !== "string" ||
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.asOf !== "string"
  ) {
    throw new ArtifactListCursorError();
  }
  const botId = cursorBotId(record.botId);
  const createdAt = new Date(record.createdAt);
  const asOf = new Date(record.asOf);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(asOf.getTime())) {
    throw new ArtifactListCursorError();
  }
  return { createdAt: createdAt.toISOString(), id: record.id, botId, asOf: asOf.toISOString() };
}

function cursorBotId(value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new ArtifactListCursorError();
}

export async function listSpaceArtifacts(
  deps: { prisma: Pick<PrismaClient, "artifact" | "$queryRaw"> },
  actor: Actor,
  input: { botId?: string; cursor?: string; limit?: number },
) {
  const take = Math.min(Math.max(input.limit ?? 30, 1), 60);
  const scopeBotId = input.botId ?? null;
  const botFilter = scopeBotId ? Prisma.sql`AND "botId" = ${scopeBotId}` : Prisma.empty;

  let asOf = new Date();
  let cursorFilter = Prisma.empty;
  if (input.cursor) {
    // Position is stored on the cursor so a deleted row cannot replay the first page.
    const cursor = decodeArtifactListCursor(input.cursor);
    if (cursor.botId !== scopeBotId) throw new ArtifactListCursorError();
    asOf = new Date(cursor.asOf);
    cursorFilter = Prisma.sql`AND (latest."createdAt", latest.id) < (${new Date(cursor.createdAt)}, ${cursor.id})`;
  }

  const rows = await deps.prisma.$queryRaw<ListSpaceRow[]>(Prisma.sql`
    WITH scoped AS (
      SELECT * FROM "artifacts"
      WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} ${botFilter}
        AND "createdAt" <= ${asOf}
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
  const last = page.at(-1);

  return {
    // id is the family root so the card URL stays stable across versions.
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
    nextCursor:
      hasMore && last
        ? encodeArtifactListCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
            botId: scopeBotId,
            asOf: asOf.toISOString(),
          })
        : null,
  };
}

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

type ArtifactMember = { id: string; storageKey: string; botId: string | null };

// Delete each blob before its row, and the root only while it has no versions.
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

  for (;;) {
    const members = await deps.prisma.artifact.findMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        OR: [{ id: rootId }, { rootArtifactId: rootId }],
      },
      select: { id: true, storageKey: true, botId: true },
    });
    if (members.length === 0) return { ok: true as const };
    const child = members.find((row) => row.id !== rootId);
    if (child) {
      await removeArtifactBlob(deps.artifacts, actor, child);
      await deleteArtifactRowIfPresent(deps.prisma, child.id);
      continue;
    }
    const root = members.find((row) => row.id === rootId);
    if (!root) throw new IsolationError();
    const outcome = await deleteArtifactRootIfChildless(deps, actor, root);
    if (outcome === "has-child") continue;
    return { ok: true as const };
  }
}

async function deleteArtifactRootIfChildless(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  actor: Actor,
  root: ArtifactMember,
): Promise<"deleted" | "gone" | "has-child"> {
  let outcome: "deleted" | "gone" | "has-child" = "gone";
  await deps.prisma.$transaction(async (tx) => {
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
    await removeArtifactBlob(deps.artifacts, actor, root);
    try {
      await tx.artifact.delete({ where: { id: root.id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
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
  actor: Actor,
  member: ArtifactMember,
): Promise<void> {
  try {
    await artifacts.remove(
      member.storageKey,
      adapterContext(actor, member.botId ?? member.id, `artifact-delete:${member.id}`),
    );
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return;
    throw error;
  }
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
        // Uploads from before group ownership was stored, still tied to a current member.
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
