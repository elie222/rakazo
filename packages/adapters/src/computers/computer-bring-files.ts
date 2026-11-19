import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import {
  ensureComputerWorkspaceLayout,
  isTeamBotFolderName,
  removeComputerWorkspaceDirectories,
} from "./computer-workspace.js";
import { sandboxKindCapabilities } from "./sandbox/sandbox-kind-capabilities.js";
import { teamBotWorkspaceDirectory } from "./screens/computer-support.js";

/** A computer as a bot's files see it: whose stored home it is, and which part is the bot's. */
export interface BotFilesHome {
  homeKey: string;
  scope: ComputerMode;
}

/**
 * The bot's files in a computer's saved home. On a Team Computer they are its folder under
 * bots/. On its own computer they are the home's visible entries: the hidden ones at the top
 * (browser profiles, shell and tool settings) belong to that computer and stay on it.
 */
function savedBotFiles(
  home: AgentHomeStore,
  from: BotFilesHome,
  botId: string,
  context: AdapterContext,
): AsyncIterable<PortableFile> {
  return from.scope === "team"
    ? home.exportHome(from.homeKey, context, { directory: teamBotWorkspaceDirectory(botId) })
    : home.exportHome(from.homeKey, context, { skipHidden: true });
}

/** Whether a computer's saved home holds any file of the bot's. */
export async function hasSavedBotFiles(
  home: AgentHomeStore,
  from: BotFilesHome,
  botId: string,
  context: AdapterContext,
): Promise<boolean> {
  if (from.scope === "team" && !isTeamBotFolderName(botId)) return false;
  for await (const _file of savedBotFiles(home, from, botId, context)) return true;
  return false;
}

// The glob leaves hidden entries out. Folders may be read-only (a module cache), so they are
// opened up before the removal; find does not follow links.
const REMOVE_VISIBLE_ENTRIES = [
  "shopt -s nullglob",
  "for entry in *; do",
  '  if [ -d "$entry" ] && [ ! -L "$entry" ]; then',
  '    find "$entry" -type d ! -perm -0200 -exec chmod u+w {} + 2>/dev/null || true',
  "  fi",
  '  rm -rf -- "$entry"',
  "done",
].join("\n");

async function removeVisibleEntries(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
) {
  let exitCode: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    { argv: ["bash", "-eu", "-c", REMOVE_VISIBLE_ENTRIES], cwd: "." },
    context,
  )) {
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) throw new Error(stderr.trim() || "could not replace the bot's older files");
}

/**
 * Copies a bot's files from the saved home of the computer it left onto the running computer
 * it moved to, the way a start restores a home: the saved copy is exported and imported into
 * the computer. The copy left behind is not changed.
 *
 * Files the bot already had on the destination are removed first, so the copy brought replaces
 * them instead of mixing with them. Nothing is removed when there is nothing to bring. Safe to
 * run again after a failure. Returns whether any file was brought.
 */
export async function bringBotFiles(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider },
  input: { botId: string; from: BotFilesHome; to: { computer: ComputerRef; scope: ComputerMode } },
  context: AdapterContext,
): Promise<boolean> {
  const { botId, from, to } = input;
  if ((from.scope === "team" || to.scope === "team") && !isTeamBotFolderName(botId)) {
    throw new Error("Bot id cannot name a Team Computer folder");
  }
  if (!(await hasSavedBotFiles(deps.home, from, botId, context))) return false;
  let prefix = "";
  if (to.scope === "team") {
    prefix = `${teamBotWorkspaceDirectory(botId)}/`;
    await removeComputerWorkspaceDirectories(deps.sandbox, to.computer, "bots", [botId], context);
    await ensureComputerWorkspaceLayout(deps.sandbox, to.computer, "team", botId, context);
  } else if (!sandboxKindCapabilities(to.computer.kind).nativeShell) {
    // A computer without the standard shell keeps its older files beside the ones brought.
    await removeVisibleEntries(deps.sandbox, to.computer, context);
  }
  async function* placed(): AsyncIterable<PortableFile> {
    for await (const file of savedBotFiles(deps.home, from, botId, context)) {
      yield prefix ? { ...file, path: `${prefix}${file.path}` } : file;
    }
  }
  await deps.sandbox.importWorkspace(to.computer, placed(), context);
  return true;
}
