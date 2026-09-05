import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode, MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import {
  attachmentExtensionForMimeType,
  inferAttachmentMimeType,
  messageBlockForArtifact,
  validateAttachmentMimeType,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { resolveBotWorkspacePath } from "./computer-support.js";

export type MaterializedThreadFile = {
  name: string;
  mimeType: string;
  size: number;
  path: string;
};

export async function attachWorkspaceFileToThread(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string;
    runId: string;
    filePath: string;
    bytes: Uint8Array;
    operationId: string;
  },
): Promise<{ artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> }> {
  const name = path.basename(input.filePath) || input.filePath;
  const mimeType = inferAttachmentMimeType(name);
  if (!mimeType) {
    throw new Error(`Unsupported attachment type for ${name}`);
  }
  validateAttachmentMimeType(mimeType);
  if (input.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error("file exceeds the 10 MiB attachment limit");
  }

  const context = {
    operationId: input.operationId,
    traceId: input.operationId,
    spaceId: input.spaceId,
    userId: input.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  };
  const stored = await deps.artifacts.put({ name, mimeType, bytes: input.bytes }, context);
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const row = await deps.prisma.artifact
    .create({
      data: {
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.botId,
        groupId: input.groupId,
        runId: input.runId,
        name,
        mimeType,
        size: input.bytes.byteLength,
        hash,
        storageKey: stored.id,
      },
    })
    .catch(async (error) => {
      await deps.artifacts.remove(stored.id, context).catch(() => undefined);
      throw error;
    });
  return {
    artifactId: row.id,
    block: messageBlockForArtifact({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
    }),
  };
}

export async function materializeCurrentTurnFiles(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    sandbox: SandboxProvider;
  },
  blocks: MessageBlock[] | undefined,
  input: {
    context: AdapterContext & { botId: string };
    computer: ComputerRef;
    computerMode: ComputerMode;
    markWorkspaceDirty?: () => void;
  },
): Promise<MaterializedThreadFile[]> {
  const fileBlocks = blocks?.filter(
    (block): block is Extract<MessageBlock, { kind: "file" }> => block.kind === "file",
  );
  if (!fileBlocks?.length) return [];

  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: fileBlocks.map((block) => block.artifactId) },
      spaceId: input.context.spaceId,
      userId: input.context.userId,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const materialized: MaterializedThreadFile[] = [];

  for (const block of fileBlocks) {
    const row = byId.get(block.artifactId);
    if (!row) throw new Error(`Attached file is unavailable: ${block.name}`);
    const bytes = await deps.artifacts.get(row.storageKey, input.context);
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
      throw new Error(`Attached file exceeds the 10 MiB limit: ${row.name}`);
    }
    const relativePath = `attachments/${row.id}${attachmentExtensionForMimeType(row.mimeType)}`;
    input.markWorkspaceDirty?.();
    await deps.sandbox.writeFile(
      input.computer,
      {
        path: resolveBotWorkspacePath(input.computerMode, input.context.botId, relativePath),
        content: bytes,
      },
      input.context,
    );
    materialized.push({
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
      path: relativePath,
    });
  }

  return materialized;
}

export function currentTurnFilesInstruction(files: readonly MaterializedThreadFile[]): string {
  if (!files.length) return "";
  return [
    "Current-turn attached files are available on your computer. Inspect them before answering:",
    ...files.map(
      (file) =>
        `- ${JSON.stringify(file.name)} (${file.mimeType}, ${file.size} bytes): ${JSON.stringify(file.path)}`,
    ),
  ].join("\n");
}
