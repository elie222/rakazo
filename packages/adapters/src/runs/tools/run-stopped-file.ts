import { isSandboxProviderOutage } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { isSandboxGoneError } from "../../computers/sandbox/sandbox-errors.js";
import { sandboxKindCapabilities } from "../../computers/sandbox/sandbox-kind-capabilities.js";
import {
  normalizeWorkspacePath,
  teamBotWorkspaceDirectory,
  toComputerRef,
} from "../../computers/screens/computer-support.js";
import type { RunContext } from "../assembly/run-context.js";

export async function readStoppedRunFile(ctx: RunContext, storedPath: string, maxBytes: number) {
  const { bot, computer, context, deps, run } = ctx;
  const stored = computer.stored;
  if (
    computer.lazy.ready ||
    computer.kind !== stored.kind ||
    !sandboxKindCapabilities(stored.kind).readStoppedFiles ||
    !deps.sandbox.readStoppedFile
  )
    return undefined;

  const path = normalizeWorkspacePath(storedPath);
  // Normal startup materializes attachments and removes deleted bots' folders. The provider's
  // snapshot predates that work, so use only ordinary files in this bot's home or shared files.
  if (
    !path ||
    path.split("/").includes("attachments") ||
    (computer.mode === "team" &&
      !path.startsWith(`${teamBotWorkspaceDirectory(bot.id)}/`) &&
      !path.startsWith("shared/"))
  )
    return undefined;

  const where = {
    id: stored.id,
    spaceId: run.spaceId,
    scope: stored.scope,
    kind: stored.kind,
    state: "suspended",
    providerRef: { not: null },
    restorePending: false,
    maintenanceId: null,
    controlLeaseId: null,
    bots: { some: { id: bot.id, archivedAt: null } },
  } as const;
  const suspended = await deps.prisma.computer.findFirst({
    where,
    select: {
      homeKey: true,
      kind: true,
      providerRef: true,
      screenGeneration: true,
      homeRevision: true,
      homeRevisionAt: true,
    },
  });
  if (!suspended?.providerRef) return undefined;

  const bytes = await deps.sandbox
    .readStoppedFile(toComputerRef(suspended), path, context, {
      maxBytes,
      savedAt:
        suspended.homeRevision === "empty" ? undefined : (suspended.homeRevisionAt ?? undefined),
    })
    .catch((error: unknown) => {
      context.signal.throwIfAborted();
      if (!isSandboxGoneError(error) && !isSandboxProviderOutage(error)) throw error;
      getLogger().warn("computer.stopped_file_read_failed", { error });
      return undefined;
    });
  if (!bytes) return undefined;

  // Discard a snapshot read if another caller woke, reset or moved the computer during it.
  const unchanged = await deps.prisma.computer.findFirst({
    where: {
      ...where,
      providerRef: suspended.providerRef,
      screenGeneration: suspended.screenGeneration,
      homeRevision: suspended.homeRevision,
      homeRevisionAt: suspended.homeRevisionAt,
    },
    select: { id: true },
  });
  if (!unchanged) return undefined;
  getLogger().info("computer.file_read_without_wake", { "computer.id": stored.id });
  return bytes;
}
