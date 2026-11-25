import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactStore,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { AttachmentCopy, CopyAttachmentResult } from "@rakazo/adapters";
import { bestEffortWithoutPaths, copyAttachmentToComputer } from "@rakazo/adapters";
import { deadlineSignal, withAbort } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { SenderQueue } from "../messaging/intake/sender-queue.js";
import { createSenderQueue } from "../messaging/intake/sender-queue.js";

/**
 * Time copying one attachment into the bot's computer may take before the message goes on
 * without it. With voice transcripts it stays inside the margin a direct message's backup job
 * leaves after its settle budget.
 */
export const ATTACHMENT_ARRIVAL_COPY_TIMEOUT_MS = 30_000;

/** Copies one attachment into the bot's computer. */
export type CopyAttachment = (
  input: AttachmentCopy,
  context: AdapterContext,
) => Promise<CopyAttachmentResult>;

export interface ArrivalCopyDeps {
  prisma: PrismaClient;
  artifacts: Pick<ArtifactStore, "get">;
  /** ATTACHMENT_COPY_ON_ARRIVAL: nothing is copied on arrival unless it is on. */
  enabled: boolean;
  copy: CopyAttachment;
  /** This process's copies, one at a time per computer. */
  queue: SenderQueue;
}

/** A stored attachment: its path in the bot's computer, and its bytes or where storage keeps them. */
export type ArrivalFile = { computerPath: string | null } & (
  | { bytes: Uint8Array }
  | { storageKey: string }
);

/** The arrival copies of one process, shared by every way a message arrives. */
export function createArrivalCopy(deps: {
  prisma: PrismaClient;
  artifacts: Pick<ArtifactStore, "get">;
  home: AgentHomeStore;
  sandbox: SandboxProvider;
  env: { copyAttachmentsOnArrival: boolean };
}): ArrivalCopyDeps {
  const { prisma, artifacts, home, sandbox, env } = deps;
  return {
    prisma,
    artifacts,
    enabled: env.copyAttachmentsOnArrival,
    copy: (input, context) => copyAttachmentToComputer({ prisma, home, sandbox }, input, context),
    queue: createSenderQueue(),
  };
}

/**
 * Starts `copyOnArrival` without waiting for it, for a caller that must not be held up. Any
 * rejection is caught and logged by its code only, so none goes unhandled.
 */
export function startArrivalCopy(
  deps: ArrivalCopyDeps,
  ids: { botId: string; spaceId: string; userId: string },
  files: ArrivalFile[],
): void {
  void bestEffortWithoutPaths(
    "start copying attachments into the bot's computer",
    copyOnArrival(deps, ids, files),
  );
}

/**
 * Copies each attachment that has a stored path into the bot's computer, when the setting is
 * on. One that has none (an id-named file) is left for the run to copy, as it is otherwise. Each
 * copy is best effort, has its own deadline, and never throws. A copy that ends after its
 * deadline can still leave its file, at the attachment's own path.
 */
export async function copyOnArrival(
  deps: ArrivalCopyDeps,
  ids: { botId: string; spaceId: string; userId: string },
  files: ArrivalFile[],
): Promise<void> {
  if (!deps.enabled) return;
  for (const file of files) {
    const path = file.computerPath;
    if (path === null) continue;
    const signal = deadlineSignal(ATTACHMENT_ARRIVAL_COPY_TIMEOUT_MS);
    const operationId = `attachment-arrival-copy:${ids.botId}`;
    const context: AdapterContext = {
      operationId,
      traceId: operationId,
      spaceId: ids.spaceId,
      userId: ids.userId,
      botId: ids.botId,
      signal,
    };
    const copy = async () => {
      const bot = await deps.prisma.bot.findUnique({
        where: { id: ids.botId },
        select: { computerId: true },
      });
      const computerId = bot?.computerId ?? null;
      if (!computerId) return;
      const bytes =
        "bytes" in file ? file.bytes : await deps.artifacts.get(file.storageKey, context);
      // Bots on one team computer share it. The copy also holds it against other processes;
      // this only keeps this process's copies from waiting on that. The queue stops waiting on
      // a copy at its deadline, so one that hangs never holds up the next.
      await deps.queue.run(computerId, async () => {
        signal.throwIfAborted();
        return withAbort(
          deps.copy({ bot: { id: ids.botId, computerId }, path, bytes }, context),
          signal,
        );
      });
    };
    await bestEffortWithoutPaths(
      "copy an attachment into the bot's computer",
      withAbort(copy(), signal),
    );
  }
}
