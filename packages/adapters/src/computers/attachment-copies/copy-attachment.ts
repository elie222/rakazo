import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import { retry } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { LeaseHeldError, parseComputerMode, withLease } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { serverOwnsTeamHome } from "../computer-workspace.js";
import { sandboxKindCapabilities } from "../sandbox/sandbox-kind-capabilities.js";
import {
  normalizeWorkspacePath,
  resolveBotWorkspacePath,
  toComputerRef,
} from "../screens/computer-support.js";

/** An attachment to copy into its bot's computer, at the path stored when it arrived. */
export interface AttachmentCopy {
  bot: { id: string; computerId: string | null };
  /** Relative to the bot's workspace, under its `attachments/` folder. */
  path: string;
  bytes: Uint8Array;
}

export type CopyAttachmentResult =
  | { copied: string }
  | { skipped: "no_computer" | "home_not_reachable" | "already_there" };

type ComputerRow = {
  scope: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  state: string;
};

/**
 * `bestEffort` for work on attachment copies, logging only the failure's code or kind. A file
 * error's message and fields name the full path, which holds the sender's name or address, such
 * as a phone number, and the file's name.
 */
export function bestEffortWithoutPaths<T>(
  label: string,
  attempt: Promise<T>,
): Promise<T | undefined> {
  return bestEffort(
    label,
    attempt.catch((error: unknown) => {
      throw pathFreeError(error);
    }),
  );
}

function pathFreeError(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  const reason =
    typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)
      ? code
      : error instanceof Error
        ? error.name
        : "unknown";
  const failure = new Error(`attachment copy work failed: ${reason}`);
  // A cancellation stays one, so it is still not logged as a failure.
  failure.name =
    error instanceof Error && error.name === "AbortError" ? "AbortError" : "AttachmentCopyError";
  return failure;
}

/** Where a copy can go now: the running computer itself, or the stored home it boots from. */
type Target = { write: (filePath: string, content: Uint8Array) => Promise<void> };

function writeTarget(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider },
  computer: ComputerRow,
  context: AdapterContext,
): Target | undefined {
  if (computer.state === "running" && computer.providerRef) {
    const ref = toComputerRef(computer);
    return {
      write: (filePath, content) =>
        deps.sandbox.writeFile(ref, { path: filePath, content }, context),
    };
  }
  if (!homeHoldsAttachmentCopies(deps.sandbox, computer)) return undefined;
  return {
    write: (filePath, content) =>
      deps.home.writeBinaryFile(computer.homeKey, filePath, content, context),
  };
}

/**
 * Whether the server may write and delete in this computer's stored home now: nothing runs in
 * a machine that has the home open, and its next start begins from it. A computer is marked
 * stopped with no machine only once its machine was deleted or found gone. A Docker computer's
 * container mounts the server's copy of its home and is kept while the computer sleeps; a bot
 * with a shell in it could swap a folder for a link between the server's checks and its write
 * or delete. So a running one is written through the container, an asleep one only when its
 * kind stops the container rather than pausing it, and one starting or stopping is left alone.
 * A machine the provider kept resumes with its own disk, and a save or restore under way could
 * replace or miss the file.
 */
export function homeHoldsAttachmentCopies(
  sandbox: SandboxProvider,
  computer: Pick<ComputerRow, "kind" | "state" | "providerRef">,
): boolean {
  const { serverHomeMount, sleepStopsMachine } = sandboxKindCapabilities(computer.kind);
  if (computer.state === "suspended") return serverHomeMount === "always" && sleepStopsMachine;
  if (computer.state !== "stopped" || computer.providerRef) return false;
  return serverHomeMount === "always" || serverOwnsTeamHome(sandbox, computer.kind);
}

/** How long a copy holds its computer's attachment copies before another process may take them. */
const ATTACHMENT_COPIES_LEASE_MS = 60_000;
/** How often a copy waiting on another process's copy or prune on the same computer looks again. */
const ATTACHMENT_COPIES_RETRY_MS = 250;

function isFileExists(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * Copies an attachment into its bot's computer at the path stored when it arrived, under the
 * bot's `attachments/` folder (`bots/<id>/attachments/` on a team computer). A running computer
 * is written through its machine, a stopped one whose home the server holds into that stored
 * home, and any other is skipped. The stored home never replaces a file: the path is the
 * attachment's own, so one already there is this copy. The computer's lease keeps a copy from
 * running beside a prune of its folder, in every process.
 */
export async function copyAttachmentToComputer(
  deps: { prisma: PrismaClient; home: AgentHomeStore; sandbox: SandboxProvider },
  input: AttachmentCopy,
  context: AdapterContext,
): Promise<CopyAttachmentResult> {
  const computerId = input.bot.computerId;
  if (!computerId) return { skipped: "no_computer" };
  const copy = async (): Promise<CopyAttachmentResult> => {
    // Read under the lease, so the target follows the latest state of the computer, and only
    // in the message's Space: a computer of another Space never gets the file.
    const computer = await deps.prisma.computer.findFirst({
      where: { id: computerId, spaceId: context.spaceId },
      select: { scope: true, homeKey: true, kind: true, providerRef: true, state: true },
    });
    if (!computer) return { skipped: "no_computer" };
    const mode = parseComputerMode(computer.scope);
    const folder = `${resolveBotWorkspacePath(mode, input.bot.id, "attachments")}/`;
    const stored = normalizeWorkspacePath(resolveBotWorkspacePath(mode, input.bot.id, input.path));
    if (!stored.startsWith(folder)) throw new Error("attachment path left the attachments folder");
    const target = writeTarget(deps, computer, context);
    if (!target) return { skipped: "home_not_reachable" };
    try {
      await target.write(stored, input.bytes);
      return { copied: stored };
    } catch (error) {
      if (isFileExists(error)) return { skipped: "already_there" };
      throw error;
    }
  };
  return retry(
    () =>
      withLease(
        deps.prisma,
        `attachment-copies:${computerId}`,
        { ttlMs: ATTACHMENT_COPIES_LEASE_MS, signal: context.signal },
        copy,
      ),
    {
      attempts: Number.POSITIVE_INFINITY,
      retryable: (error) => error instanceof LeaseHeldError,
      delayMs: ATTACHMENT_COPIES_RETRY_MS,
      signal: context.signal,
    },
  );
}
