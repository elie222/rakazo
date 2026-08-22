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
import { IsolationError, type PrismaClient } from "@rakazo/db";

function adapterContext(actor: Actor, botId: string, operationId: string) {
  return {
    operationId,
    traceId: operationId,
    workspaceId: actor.workspaceId,
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
  input: { botId: string; name: string; mimeType: string; contentBase64: string },
) {
  validateAttachmentMimeType(input.mimeType);
  const bytes = decodeAttachmentBase64(input.contentBase64);
  const context = adapterContext(actor, input.botId, `artifact-create:${input.botId}`);
  const stored = await deps.artifacts.put(
    { name: input.name, mimeType: input.mimeType, bytes },
    context,
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  const row = await deps.prisma.artifact
    .create({
      data: {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        botId: input.botId,
        name: input.name,
        mimeType: input.mimeType,
        size: bytes.byteLength,
        hash,
        storageKey: stored.id,
      },
    })
    .catch(async (error) => {
      await deps.artifacts.remove(stored.id, context).catch(() => undefined);
      throw error;
    });
  return {
    id: row.id,
    botId: row.botId,
    runId: row.runId,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
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
      workspaceId: actor.workspaceId,
    },
  });
  if (!row) throw new IsolationError();
  const bytes = await deps.artifacts.get(
    row.storageKey,
    adapterContext(actor, input.botId, `artifact-get:${input.artifactId}`),
  );
  return {
    id: row.id,
    botId: row.botId,
    runId: row.runId,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    contentBase64: Buffer.from(bytes).toString("base64"),
  };
}

export async function resolveSendAttachments(
  deps: { prisma: PrismaClient },
  actor: Actor,
  botId: string,
  artifactIds: string[] | undefined,
) {
  const ids = [...new Set(artifactIds ?? [])];
  if (ids.length > ATTACHMENT_MAX_COUNT) {
    throw new AttachmentValidationError(`At most ${ATTACHMENT_MAX_COUNT} attachments per message`);
  }
  if (!ids.length) {
    return {
      blocks: [] as ReturnType<typeof messageBlockForArtifact>[],
      artifacts: [] as Array<{
        id: string;
        name: string;
        mimeType: string;
        size: number;
        storageKey: string;
      }>,
    };
  }

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: ids },
      botId,
      workspaceId: actor.workspaceId,
    },
  });
  if (rows.length !== ids.length) throw new IsolationError();

  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id)!);
  const blocks = ordered.map((row) =>
    messageBlockForArtifact({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
    }),
  );
  return { blocks, artifacts: ordered };
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
) {
  return promptTextForAttachments(text, artifacts);
}
