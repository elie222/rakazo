import path from "node:path";
import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import { retry, sanitizeMessagingLabel } from "@rakazo/core";
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
import { receivedFilePath } from "./received-path.js";

/** A file a chat app brought the bot, to copy into its computer. */
export interface ReceivedFile {
  bot: { id: string; computerId: string | null };
  sender: string;
  name?: string;
  mimeType: string;
  bytes: Uint8Array;
  at: Date;
}

export type SaveReceivedFileResult =
  | { saved: string }
  | { skipped: "no_computer" | "home_not_reachable" };

/** The line that tells the bot where its copy of a received file is. */
export function savedFileLine(savedPath: string): string {
  return `[saved to ${savedPath}]`;
}

type ComputerRow = {
  scope: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  state: string;
};

/**
 * `bestEffort` for work on received files, logging only the failure's code or kind. A file
 * error's message and fields name the full path, which holds the sender's address, such as a
 * phone number, and the file's name.
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
  const failure = new Error(`received file work failed: ${reason}`);
  // A cancellation stays one, so it is still not logged as a failure.
  failure.name =
    error instanceof Error && error.name === "AbortError" ? "AbortError" : "ReceivedFileError";
  return failure;
}

/** Where a copy can go now: the running computer itself, or the stored home it boots from. */
type Target = {
  list: (directory: string) => Promise<Array<{ path: string }>>;
  write: (filePath: string, content: Uint8Array) => Promise<void>;
};

function writeTarget(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider },
  computer: ComputerRow,
  context: AdapterContext,
): Target | undefined {
  if (computer.state === "running" && computer.providerRef) {
    const ref = toComputerRef(computer);
    return {
      list: (directory) => deps.sandbox.listFiles(ref, directory, context),
      write: (filePath, content) =>
        deps.sandbox.writeFile(ref, { path: filePath, content }, context),
    };
  }
  if (!homeHoldsReceivedFiles(deps.sandbox, computer)) return undefined;
  return {
    list: (directory) => deps.home.list(computer.homeKey, directory, context),
    write: (filePath, content) =>
      deps.home.writeBinaryFile(computer.homeKey, filePath, content, context),
  };
}

/**
 * Whether the server may write and delete in this computer's stored home now: the computer is
 * stopped and no machine of it is left, so nothing else has the home open, and its next start
 * begins from it. A computer is marked stopped with no machine only once its machine was
 * deleted or found gone. A Docker computer's container mounts the server's copy of its home and
 * is kept while the computer sleeps; a bot with a shell in it could swap a folder for a link
 * between the server's checks and its write or delete, so a running one is written through the
 * container and one in any other state is left alone. A machine the provider kept resumes with
 * its own disk, and a save or restore under way could replace or miss the file.
 */
export function homeHoldsReceivedFiles(
  sandbox: SandboxProvider,
  computer: Pick<ComputerRow, "kind" | "state" | "providerRef">,
): boolean {
  if (computer.state !== "stopped" || computer.providerRef) return false;
  return (
    sandboxKindCapabilities(computer.kind).serverHomeMount === "always" ||
    serverOwnsTeamHome(sandbox, computer.kind)
  );
}

/**
 * The paths in `directory`. A listing can fail because the folder is not there yet, which
 * the listing of its parent tells apart from a folder that is there and could not be read.
 */
async function pathsIn(target: Target, directory: string): Promise<Set<string>> {
  try {
    const entries = await target.list(directory);
    return new Set(entries.map((entry) => normalizeWorkspacePath(entry.path)));
  } catch (error) {
    if (!directory) throw error;
    const parent = path.posix.dirname(directory);
    const siblings = await pathsIn(target, parent === "." ? "" : parent);
    if (siblings.has(directory)) throw error;
    return new Set();
  }
}

/** How long a save holds its computer's received folder before another process may take it. */
const RECEIVED_FOLDER_LEASE_MS = 60_000;
/** How often a save waiting on another process's save on the same computer looks again. */
const RECEIVED_FOLDER_RETRY_MS = 250;
/** Names a save tries when the stored home turns out to hold each one already. */
const MAX_NAME_TRIES = 20;

function isFileExists(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * Copies a received file into the bot's computer under `received/` (`shared/received/` on a
 * team computer), never over a file already there. A running computer is written through its
 * machine, a stopped one whose home the server holds into that stored home, and any other is
 * skipped. One save at a time picks a name on a computer, in
 * every process, so two bots or two API instances never pick the same one.
 */
export async function saveReceivedFile(
  deps: {
    prisma: PrismaClient;
    home: AgentHomeStore;
    sandbox: SandboxProvider;
    timeZone: string;
  },
  input: ReceivedFile,
  context: AdapterContext,
): Promise<SaveReceivedFileResult> {
  const computerId = input.bot.computerId;
  if (!computerId) return { skipped: "no_computer" };
  const save = async (): Promise<SaveReceivedFileResult> => {
    // Read under the folder's lease, so the target follows the latest state of the computer,
    // and only in the message's Space: a computer of another Space never gets the file.
    const computer = await deps.prisma.computer.findFirst({
      where: { id: computerId, spaceId: context.spaceId },
      select: { scope: true, homeKey: true, kind: true, providerRef: true, state: true },
    });
    if (!computer) return { skipped: "no_computer" };
    const target = writeTarget(deps, computer, context);
    if (!target) return { skipped: "home_not_reachable" };
    const mode = parseComputerMode(computer.scope);
    const naming = {
      at: input.at,
      timeZone: deps.timeZone,
      // The path goes into the bot's prompt, so it carries no framing characters.
      sender: sanitizeMessagingLabel(input.sender),
      name: input.name === undefined ? undefined : sanitizeMessagingLabel(input.name),
      mimeType: input.mimeType,
      computerMode: mode,
    };
    const root = mode === "team" ? "shared/received/" : "received/";
    const folder = path.posix.dirname(receivedFilePath({ ...naming, taken: () => false }));
    const taken = await pathsIn(target, folder);
    for (let tries = 1; ; tries += 1) {
      const relative = receivedFilePath({ ...naming, taken: (candidate) => taken.has(candidate) });
      const stored = normalizeWorkspacePath(resolveBotWorkspacePath(mode, input.bot.id, relative));
      if (stored !== relative || !stored.startsWith(root)) {
        throw new Error("received file path left the received folder");
      }
      try {
        await target.write(stored, input.bytes);
        return { saved: stored };
      } catch (error) {
        // The stored home never replaces a file: one written since the listing takes the next name.
        if (!isFileExists(error) || tries >= MAX_NAME_TRIES) throw error;
        taken.add(stored);
      }
    }
  };
  return retry(
    () =>
      withLease(
        deps.prisma,
        `received-files:${computerId}`,
        { ttlMs: RECEIVED_FOLDER_LEASE_MS, signal: context.signal },
        save,
      ),
    {
      attempts: Number.POSITIVE_INFINITY,
      retryable: (error) => error instanceof LeaseHeldError,
      delayMs: RECEIVED_FOLDER_RETRY_MS,
      signal: context.signal,
    },
  );
}
