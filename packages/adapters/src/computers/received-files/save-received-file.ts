import path from "node:path";
import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import { sanitizeMessagingLabel } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { parseComputerMode } from "@rakazo/db";
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
  const home = {
    list: (directory: string) => deps.home.list(computer.homeKey, directory, context),
    write: (filePath: string, content: Uint8Array) =>
      deps.home.writeBinaryFile(computer.homeKey, filePath, content, context),
  };
  // The computer works in the server's home directory itself, whatever its state.
  if (sandboxKindCapabilities(computer.kind).serverHomeMount === "always") return home;
  // Otherwise only a stopped computer whose next start restores the stored home gets it from
  // there: a machine the provider kept resumes with its own disk, and a save or restore under
  // way could replace or miss the file.
  if (
    computer.state === "stopped" &&
    !computer.providerRef &&
    serverOwnsTeamHome(deps.sandbox, computer.kind)
  ) {
    return home;
  }
  return undefined;
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

/**
 * Copies a received file into the bot's computer under `received/` (`shared/received/` on a
 * team computer), never over a file already there. A computer neither running nor booting
 * from a home the server holds is skipped.
 */
export async function saveReceivedFile(
  deps: {
    prisma: Pick<PrismaClient, "computer">;
    home: AgentHomeStore;
    sandbox: SandboxProvider;
    timeZone: string;
  },
  input: ReceivedFile,
  context: AdapterContext,
): Promise<SaveReceivedFileResult> {
  if (!input.bot.computerId) return { skipped: "no_computer" };
  const computer = await deps.prisma.computer.findUnique({
    where: { id: input.bot.computerId },
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
  const folder = path.posix.dirname(receivedFilePath({ ...naming, taken: () => false }));
  const taken = await pathsIn(target, folder);
  const relative = receivedFilePath({ ...naming, taken: (candidate) => taken.has(candidate) });
  const stored = normalizeWorkspacePath(resolveBotWorkspacePath(mode, input.bot.id, relative));
  const root = mode === "team" ? "shared/received/" : "received/";
  if (stored !== relative || !stored.startsWith(root)) {
    throw new Error("received file path left the received folder");
  }
  await target.write(stored, input.bytes);
  return { saved: stored };
}
