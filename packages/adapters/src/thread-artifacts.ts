import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode, MessageBlock } from "@rakazo/contracts";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  attachmentSizeLabel,
} from "@rakazo/contracts";
import {
  attachmentExtensionForMimeType,
  inferAttachmentMimeType,
  messageBlockForArtifact,
  validateAttachmentMimeType,
} from "@rakazo/core";
import type { Artifact, Prisma, PrismaClient } from "@rakazo/db";
import { withResolvedArtifactVersion } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
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
    maxUploadSizeBytes?: number;
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
    name?: string;
    description?: string;
    /** Checkpoint a caller's durable state atomically with attachment creation. */
    onAttached?: (tx: Prisma.TransactionClient, artifact: Artifact) => Promise<void>;
  },
): Promise<{ artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> }> {
  const fileName = path.basename(input.filePath) || input.filePath;
  const mimeType = inferAttachmentMimeType(fileName);
  if (!mimeType) {
    throw new Error(`Unsupported attachment type for ${fileName}`);
  }
  const name = (input.name?.trim() || fileName).slice(0, ARTIFACT_NAME_MAX_LENGTH);
  validateAttachmentMimeType(mimeType);
  if (input.bytes.byteLength > (deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)) {
    throw new Error(
      `file exceeds the ${attachmentSizeLabel(deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)} attachment limit`,
    );
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
  const row = await withResolvedArtifactVersion(
    deps.prisma,
    {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      groupId: input.groupId,
      name,
    },
    async (tx, { rootArtifactId, version }) => {
      const artifact = await tx.artifact.create({
        data: {
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          groupId: input.groupId,
          runId: input.runId,
          name,
          description: input.description?.trim().slice(0, ARTIFACT_DESCRIPTION_MAX_LENGTH) || null,
          mimeType,
          size: input.bytes.byteLength,
          hash,
          storageKey: stored.id,
          rootArtifactId,
          version,
        },
      });
      await input.onAttached?.(tx, artifact);
      return artifact;
    },
  ).catch(async (error) => {
    await deps.artifacts.remove(stored.id, context).catch(() => undefined);
    throw error;
  });
  return { artifactId: row.id, block: messageBlockForArtifact(row) };
}

export async function materializeCurrentTurnFiles(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
    maxUploadSizeBytes?: number;
    sandbox: SandboxProvider;
  },
  blocks: MessageBlock[] | undefined,
  input: {
    context: AdapterContext & { botId: string };
    /** Starts the computer; called only when there is a file to copy onto it. */
    computer: () => Promise<ComputerRef>;
    computerMode: ComputerMode;
    markWorkspaceDirty?: () => void;
  },
): Promise<MaterializedThreadFile[]> {
  return materializeThreadFiles(deps, blocks, input, false);
}

async function materializeThreadFiles(
  deps: Parameters<typeof materializeCurrentTurnFiles>[0],
  blocks: MessageBlock[] | undefined,
  input: Parameters<typeof materializeCurrentTurnFiles>[2],
  preserveExisting: boolean,
): Promise<MaterializedThreadFile[]> {
  // "image" attachments (e.g. a photo pasted or uploaded in chat) are backed
  // by a real artifact exactly like "file" ones — the model seeing them
  // inline for vision (loadCurrentTurnImages) doesn't put them on disk, so
  // they must be included here too or a bot can describe a photo it can't
  // actually attach, forward, or hand to a tool that needs the file.
  const fileBlocks = blocks?.filter(
    (block): block is Extract<MessageBlock, { kind: "file" | "image" }> =>
      block.kind === "file" || block.kind === "image",
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
    const relativePath = `attachments/${row.id}${attachmentExtensionForMimeType(row.mimeType)}`;
    const workspacePath = resolveBotWorkspacePath(
      input.computerMode,
      input.context.botId,
      relativePath,
    );
    const exists = preserveExisting
      ? await deps.sandbox.readFile(await input.computer(), workspacePath, input.context).then(
          () => true,
          () => false,
        )
      : false;
    if (!exists) {
      const bytes = await deps.artifacts.get(row.storageKey, input.context);
      if (bytes.byteLength > (deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)) {
        throw new Error(
          `Attached file exceeds the ${attachmentSizeLabel(deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES)} limit: ${row.name}`,
        );
      }
      input.markWorkspaceDirty?.();
      await deps.sandbox.writeFile(
        await input.computer(),
        { path: workspacePath, content: bytes },
        input.context,
      );
    }
    materialized.push({
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
      path: relativePath,
    });
  }

  return materialized;
}

export async function materializeRecentThreadFiles(
  deps: Parameters<typeof materializeCurrentTurnFiles>[0],
  history: ReadonlyArray<{ id?: string; role: string }>,
  messages: ReadonlyArray<{ id: string; blocks: MessageBlock[] }>,
  input: Parameters<typeof materializeCurrentTurnFiles>[2] & {
    skipMessageId?: string | null;
    maxTurns: number;
  },
): Promise<MaterializedThreadFile[]> {
  const materialized: MaterializedThreadFile[] = [];
  for (const block of recentAttachmentBlocks(history, messages, input)) {
    if (materialized.length >= ATTACHMENT_MAX_COUNT) break;
    try {
      materialized.push(
        ...(await materializeThreadFiles(
          deps,
          [block],
          { ...input, markWorkspaceDirty: undefined },
          true,
        )),
      );
    } catch (error) {
      if (input.context.signal.aborted) throw error;
      getLogger().warn("earlier thread attachment was not copied to the computer", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return materialized;
}

/**
 * The earlier attachments a run can expect on its computer, without starting it. The run
 * copies them with materializeRecentThreadFiles once something first uses the computer.
 */
export async function listRecentThreadFiles(
  deps: Pick<Parameters<typeof materializeCurrentTurnFiles>[0], "prisma" | "maxUploadSizeBytes">,
  history: ReadonlyArray<{ id?: string; role: string }>,
  messages: ReadonlyArray<{ id: string; blocks: MessageBlock[] }>,
  input: {
    context: AdapterContext;
    skipMessageId?: string | null;
    maxTurns: number;
  },
): Promise<MaterializedThreadFile[]> {
  const blocks = recentAttachmentBlocks(history, messages, input);
  if (!blocks.length) return [];
  const rows = await deps.prisma.artifact.findMany({
    where: {
      id: { in: blocks.map((block) => block.artifactId) },
      spaceId: input.context.spaceId,
      userId: input.context.userId,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const limit = deps.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
  return blocks
    .flatMap((block) => {
      const row = byId.get(block.artifactId);
      if (!row || row.size > limit) return [];
      return [
        {
          name: row.name,
          mimeType: row.mimeType,
          size: row.size,
          path: `attachments/${row.id}${attachmentExtensionForMimeType(row.mimeType)}`,
        },
      ];
    })
    .slice(0, ATTACHMENT_MAX_COUNT);
}

/** The newest attachments across the last `maxTurns` user turns that carry any. */
function recentAttachmentBlocks(
  history: ReadonlyArray<{ id?: string; role: string }>,
  messages: ReadonlyArray<{ id: string; blocks: MessageBlock[] }>,
  input: { skipMessageId?: string | null; maxTurns: number },
): Array<Extract<MessageBlock, { kind: "file" | "image" }>> {
  const blocksByMessageId = new Map(messages.map((message) => [message.id, message.blocks]));
  const selected = new Map<string, Extract<MessageBlock, { kind: "file" | "image" }>>();
  let turns = 0;
  for (let index = history.length - 1; index >= 0 && turns < input.maxTurns; index -= 1) {
    const entry = history[index];
    if (!entry?.id || entry.role !== "user" || entry.id === input.skipMessageId) continue;
    const attached = (blocksByMessageId.get(entry.id) ?? []).filter(
      (block): block is Extract<MessageBlock, { kind: "file" | "image" }> =>
        block.kind === "file" || block.kind === "image",
    );
    if (!attached.length) continue;
    turns += 1;
    for (const block of attached.reverse()) {
      if (!selected.has(block.artifactId)) selected.set(block.artifactId, block);
    }
  }
  return [...selected.values()];
}

function fileLine(file: MaterializedThreadFile): string {
  return `- ${JSON.stringify(file.name)} (${file.mimeType}, ${file.size} bytes): ${JSON.stringify(file.path)}`;
}

export function currentTurnFilesInstruction(files: readonly MaterializedThreadFile[]): string {
  if (!files.length) return "";
  return [
    "Current-turn attached files are available on your computer. Inspect them before answering:",
    ...files.map(fileLine),
  ].join("\n");
}

export function recentThreadFilesInstruction(files: readonly MaterializedThreadFile[]): string {
  if (!files.length) return "";
  return [
    "Files attached earlier in this conversation are also on your computer:",
    ...files.map(fileLine),
  ].join("\n");
}
