import { createHash } from "node:crypto";
import type { ArtifactStore, MessagingInboundAttachment } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { inboundAttachmentMimeType, inboundAttachmentRefusal } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
  attachmentMaxCount,
  attachmentSizeLabel,
  isAttachmentArchiveMimeType,
  isAttachmentAudioMimeType,
  isStepScreenshotMimeType,
  STEP_SCREENSHOT_MIME_TYPES,
} from "@rakazo/contracts";
import {
  AttachmentValidationError,
  attachmentStoredName,
  ClientError,
  decodeAttachmentBase64,
  inferAttachmentMimeType,
  messageBlockForArtifact,
  promptTextForAttachments,
  requestDeadline,
  retry,
  validateAttachmentMimeType,
  withAbort,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  HIDDEN_ARTIFACT_MIME_TYPES,
  IsolationError,
  isRecordNotFound,
  Prisma,
  withResolvedArtifactVersion,
} from "@rakazo/db";
import { InboundAttachmentUnavailableError } from "../messaging/inbound-attachments.js";
import type { DownloadBudget } from "../messaging/intake/download-budget.js";

export async function createOwnedArtifact(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    maxUploadSizeBytes?: number;
  },
  actor: Actor,
  input: {
    botId: string;
    groupId?: string;
    name: string;
    description?: string;
    mimeType: string;
    contentBase64: string;
    clientNonce?: string;
  },
) {
  const replayed = await findReplayedArtifact(deps.prisma, actor, input);
  if (replayed) return createdArtifact(replayed);
  const inferredType = inferAttachmentMimeType(input.name, input.mimeType);
  const mimeType =
    inferredType &&
    (isAttachmentArchiveMimeType(inferredType) || isAttachmentAudioMimeType(inferredType))
      ? inferredType
      : input.mimeType;
  validateAttachmentMimeType(mimeType);
  const bytes = decodeAttachmentBase64(input.contentBase64, deps.maxUploadSizeBytes);
  return storeOwnedArtifact(deps, actor, { ...input, mimeType, bytes });
}

/** Pauses after the first and second failed download tries; the last repeats. */
const DOWNLOAD_RETRY_DELAYS_MS = [1_000, 5_000];

/** A stored inbound attachment plus its downloaded content when it was fresh. */
export type StoredInboundAttachment = ReturnType<typeof createdArtifact> & {
  bytes?: Uint8Array;
};

export async function storeInboundAttachment(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    maxUploadSizeBytes?: number;
    /** This process's memory for downloads: each reserves its size before it starts. */
    downloadBudget?: DownloadBudget;
  },
  owner: ArtifactOwner,
  input: {
    botId: string;
    attachment: MessagingInboundAttachment;
    clientNonce: string;
    downloadDeadline?: number;
    /** Time one download try may take, within `downloadDeadline`. */
    downloadTimeoutMs?: number;
    /** Download tries in total, with a pause between them. */
    attempts?: number;
    /** Stored as a file of its own, never as the next version of one with the same name. */
    standalone?: boolean;
  },
): Promise<StoredInboundAttachment> {
  const replayed = await findReplayedArtifact(deps.prisma, owner, input);
  if (replayed) return createdArtifact(replayed);
  const { attachment } = input;
  const name = attachment.name.slice(0, ARTIFACT_NAME_MAX_LENGTH);
  const mimeType = inboundAttachmentMimeType(name, attachment.mimeType);
  const maxBytes = deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
  const tooLarge = new InboundAttachmentUnavailableError(
    "too large",
    `Attachment exceeds the ${attachmentSizeLabel(maxBytes)} limit`,
  );
  // The backup settle job judges a file it never got by the same rule.
  const refused = inboundAttachmentRefusal(attachment, maxBytes);
  if (refused === "unsupported type") {
    throw new InboundAttachmentUnavailableError(
      "unsupported type",
      `Unsupported attachment type: ${mimeType}`,
    );
  }
  if (refused === "too large") throw tooLarge;
  const { downloadDeadline = Infinity, downloadTimeoutMs = 2_000, attempts = 1 } = input;
  // What the download may hold in memory: its reported size, else as much as is allowed.
  const reserved = attachment.size ?? maxBytes;
  // Whether any try reached the platform: a file no try reached was never received, not failed.
  let fetched = false;
  const outOfTime = () =>
    fetched
      ? new AttachmentValidationError("Attachment download timed out")
      : new InboundAttachmentUnavailableError(
          "not received",
          "Attachment download timed out before it started",
        );
  // The last try's download, which keeps running, and holding its copy and its share of the
  // download budget, past its own time.
  let running: Promise<unknown> = Promise.resolve();
  const fetch = (release: () => void) => {
    fetched = true;
    const bytes = Promise.resolve().then(() => attachment.fetch());
    running = Promise.allSettled([bytes]).then(release);
    return bytes;
  };
  const download = async () => {
    // Each try gets its own budget, capped by what is left of the shared deadline. Waiting for
    // room in the download budget, or for a try that ran out of time to settle, counts against it.
    const timeoutMs = Math.min(downloadTimeoutMs, downloadDeadline - Date.now());
    if (timeoutMs <= 0) throw outOfTime();
    const deadline = requestDeadline(timeoutMs, "Attachment download timed out");
    try {
      // One copy of a file downloads at a time: the next try starts once the last has settled.
      const started = withAbort(running, deadline.signal).then(async () => {
        deadline.signal.throwIfAborted();
        const release =
          (await deps.downloadBudget?.acquire(reserved, deadline.signal)) ?? (() => {});
        try {
          // The room may come free just as the try runs out of time.
          deadline.signal.throwIfAborted();
        } catch (error) {
          release();
          throw error;
        }
        return fetch(release);
      });
      return await withAbort(started, deadline.signal);
    } catch (error) {
      if (deadline.signal.aborted) throw outOfTime();
      throw error;
    } finally {
      deadline.dispose();
    }
  };
  const bytes = await retry(download, {
    attempts,
    delayMs: DOWNLOAD_RETRY_DELAYS_MS,
    retryable: () => Date.now() < downloadDeadline,
  });
  if (bytes.byteLength === 0) throw new AttachmentValidationError("Attachment content is empty");
  if (bytes.byteLength > maxBytes) throw tooLarge;
  const stored = await storeOwnedArtifact(deps, owner, {
    botId: input.botId,
    name,
    mimeType,
    bytes,
    clientNonce: input.clientNonce,
    standalone: input.standalone,
  });
  // The replay return above carries no bytes; callers treat them as optional.
  return { ...stored, bytes };
}

type ArtifactOwner = Pick<Actor, "spaceId" | "userId">;

async function storeOwnedArtifact(
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  actor: ArtifactOwner,
  input: {
    botId: string;
    groupId?: string;
    name: string;
    description?: string;
    mimeType: string;
    bytes: Uint8Array;
    clientNonce?: string;
    standalone?: boolean;
  },
) {
  const { mimeType, bytes } = input;
  // An Office file keeps its type's own extension (attachmentStoredName).
  input = { ...input, name: attachmentStoredName(input.name, mimeType) };
  const context = createAdapterContext(actor, input.botId, `artifact-create:${input.botId}`);
  const stored = await deps.artifacts.put({ name: input.name, mimeType, bytes }, context);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const { row, replay } = await withResolvedArtifactVersion(
    deps.prisma,
    {
      spaceId: actor.spaceId,
      botId: input.botId,
      groupId: input.groupId,
      name: input.name,
    },
    async (tx, { rootArtifactId, version }) => {
      // A retry of the same upload has the same name and target, so it waits on the same lock.
      const raced = await findReplayedArtifact(tx, actor, input);
      if (raced) return { row: raced, replay: true };
      const created = await tx.artifact.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: input.botId,
          groupId: input.groupId,
          name: input.name,
          description: input.description?.trim() || null,
          mimeType,
          size: bytes.byteLength,
          hash,
          storageKey: stored.id,
          ...(input.standalone
            ? { rootArtifactId: null, version: 1, standalone: true }
            : { rootArtifactId, version }),
          clientNonce: input.clientNonce,
        },
      });
      return { row: created, replay: false };
    },
  ).catch(async (error) => {
    await deps.artifacts.remove(stored.id, context).catch(() => undefined);
    throw error;
  });
  if (replay) await deps.artifacts.remove(stored.id, context).catch(() => undefined);
  return createdArtifact(row);
}

/** The artifact an earlier upload with this nonce created; a nonce reused for another chat is refused. */
async function findReplayedArtifact(
  db: Pick<Prisma.TransactionClient, "artifact">,
  actor: ArtifactOwner,
  input: { botId: string; groupId?: string; clientNonce?: string },
) {
  if (!input.clientNonce) return null;
  const row = await db.artifact.findFirst({
    where: { spaceId: actor.spaceId, userId: actor.userId, clientNonce: input.clientNonce },
  });
  if (!row) return null;
  // A group upload is stored under whichever member bot was first, which can change between retries.
  const sameTarget = input.groupId
    ? row.groupId === input.groupId
    : row.botId === input.botId && row.groupId === null;
  if (!sameTarget) throw new IsolationError();
  return row;
}

function createdArtifact(row: Prisma.ArtifactGetPayload<Record<string, never>>) {
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
  // A reply's kept screenshot is for the bot's own later runs, never for a person's client.
  if (isStepScreenshotMimeType(row.mimeType)) throw new IsolationError();
  const bytes = await artifacts.get(
    row.storageKey,
    createAdapterContext(actor, contextBotId, `artifact-get:${row.id}`),
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

export class ArtifactListCursorError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "Invalid artifact cursor");
    this.name = "ArtifactListCursorError";
  }
}

type ArtifactListCursor = {
  createdAt: string;
  id: string;
  botId: string | null;
  madeByBots: boolean;
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
  const madeByBots = record.madeByBots ?? false;
  if (typeof madeByBots !== "boolean") throw new ArtifactListCursorError();
  const createdAt = new Date(record.createdAt);
  const asOf = new Date(record.asOf);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(asOf.getTime())) {
    throw new ArtifactListCursorError();
  }
  return {
    createdAt: createdAt.toISOString(),
    id: record.id,
    botId,
    madeByBots,
    asOf: asOf.toISOString(),
  };
}

function cursorBotId(value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new ArtifactListCursorError();
}

export async function listSpaceArtifacts(
  deps: { prisma: Pick<PrismaClient, "artifact" | "$queryRaw"> },
  actor: Actor,
  input: { botId?: string; madeByBots?: boolean; cursor?: string; limit?: number },
) {
  const take = Math.min(Math.max(input.limit ?? 30, 1), 60);
  const scopeBotId = input.botId ?? null;
  const botFilter = scopeBotId ? Prisma.sql`AND "botId" = ${scopeBotId}` : Prisma.empty;
  const madeByBots = input.madeByBots ?? false;
  const madeByBotsFilter = madeByBots
    ? Prisma.sql`AND (latest."runId" IS NOT NULL OR latest."meetingSessionId" IS NOT NULL)`
    : Prisma.empty;

  let asOf = new Date();
  let cursorFilter = Prisma.empty;
  if (input.cursor) {
    // Position is stored on the cursor so a deleted row cannot replay the first page.
    const cursor = decodeArtifactListCursor(input.cursor);
    if (cursor.botId !== scopeBotId || cursor.madeByBots !== madeByBots)
      throw new ArtifactListCursorError();
    asOf = new Date(cursor.asOf);
    cursorFilter = Prisma.sql`AND (latest."createdAt", latest.id) < (${new Date(cursor.createdAt)}, ${cursor.id})`;
  }

  const rows = await deps.prisma.$queryRaw<ListSpaceRow[]>(Prisma.sql`
    WITH scoped AS (
      SELECT * FROM "artifacts"
      WHERE "spaceId" = ${actor.spaceId} ${botFilter}
        AND "createdAt" <= ${asOf} AND "mimeType" NOT IN (${Prisma.join(HIDDEN_ARTIFACT_MIME_TYPES)})
    ),
    latest AS (
      SELECT DISTINCT ON (COALESCE("rootArtifactId", id))
        id, "botId", "groupId", "runId", "meetingSessionId", name, description, "mimeType", size, version, "createdAt", "rootArtifactId"
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
    WHERE true ${madeByBotsFilter} ${cursorFilter}
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
            madeByBots,
            asOf: asOf.toISOString(),
          })
        : null,
  };
}

const NOT_STEP_SCREENSHOT = { mimeType: { notIn: STEP_SCREENSHOT_MIME_TYPES } };

export async function listArtifactVersions(
  deps: { prisma: Pick<PrismaClient, "artifact"> },
  actor: Actor,
  input: { familyId: string },
) {
  const anchor = await deps.prisma.artifact.findFirst({
    // A reply's kept screenshot is the bot's own, not a file a person manages.
    where: { id: input.familyId, spaceId: actor.spaceId, ...NOT_STEP_SCREENSHOT },
    select: { id: true, rootArtifactId: true },
  });
  if (!anchor) throw new IsolationError();
  const rootId = anchor.rootArtifactId ?? anchor.id;
  const rows = await deps.prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
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
    where: { id: input.familyId, spaceId: actor.spaceId, ...NOT_STEP_SCREENSHOT },
    select: { id: true, rootArtifactId: true, botId: true },
  });
  if (!anchor) throw new IsolationError();
  const rootId = anchor.rootArtifactId ?? anchor.id;

  for (;;) {
    const members = await deps.prisma.artifact.findMany({
      where: {
        spaceId: actor.spaceId,
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
  actor: Actor,
  member: ArtifactMember,
): Promise<void> {
  try {
    await artifacts.remove(
      member.storageKey,
      createAdapterContext(actor, member.botId ?? member.id, `artifact-delete:${member.id}`),
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
    if (isRecordNotFound(error)) return;
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

function normalizeAttachmentIds(artifactIds: string[] | undefined, maxCount: number) {
  const ids = [...new Set(artifactIds ?? [])];
  if (ids.length > maxCount) {
    throw new AttachmentValidationError(`At most ${maxCount} attachments per message`);
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
  deps: { prisma: Pick<PrismaClient, "artifact">; maxAttachmentsPerMessage?: number },
  actor: Actor,
  botId: string,
  artifactIds: string[] | undefined,
) {
  const ids = normalizeAttachmentIds(artifactIds, attachmentMaxCount(deps));
  if (!ids.length) return toAttachmentResolution(ids, [] as SendAttachmentRow[]);

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: ids },
      botId,
      groupId: null,
      spaceId: actor.spaceId,
    },
  });
  return toAttachmentResolution(ids, rows);
}

export async function resolveGroupSendAttachments(
  deps: { prisma: Pick<PrismaClient, "artifact">; maxAttachmentsPerMessage?: number },
  actor: Actor,
  groupId: string,
  memberBotIds: string[],
  artifactIds: string[] | undefined,
) {
  const ids = normalizeAttachmentIds(artifactIds, attachmentMaxCount(deps));
  if (!ids.length) return toAttachmentResolution(ids, [] as SendAttachmentRow[]);

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: ids },
      spaceId: actor.spaceId,
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
