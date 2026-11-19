import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging";
import { ensureComputerWorkspaceLayout, isTeamBotFolderName } from "./computer-workspace.js";
import { sandboxKindCapabilities } from "./sandbox/sandbox-kind-capabilities.js";
import { teamBotWorkspaceDirectory } from "./screens/computer-support.js";

/** A computer as a bot's files see it: whose stored home it is, and which part is the bot's. */
export interface BotFilesHome {
  homeKey: string;
  scope: ComputerMode;
}

/**
 * The bot's files in a computer's saved home: the visible entries of its folder, which is
 * bots/<id> on a Team Computer and the whole home on its own. Hidden entries at the top of that
 * folder (browser profiles, shell and tool settings) belong to the computer they are on: they
 * are never brought, replaced or removed, on either side.
 */
function savedBotFiles(
  home: AgentHomeStore,
  from: BotFilesHome,
  botId: string,
  context: AdapterContext,
): AsyncIterable<PortableFile> {
  return home.exportHome(from.homeKey, context, {
    ...(from.scope === "team" ? { directory: teamBotWorkspaceDirectory(botId) } : {}),
    skipHidden: true,
  });
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

/** Where the bot's older files wait, inside its folder, until the ones brought have arrived. */
const SET_ASIDE = ".rakazo-replaced";

/**
 * Sets the visible entries of the bot's folder aside, puts them back, or drops them. Hidden
 * entries are never touched: the glob leaves them out. Files left set aside by an attempt that
 * died are put back first. Folders may be read-only (a module cache), so they are opened up
 * before a removal; find does not follow links.
 */
const REPLACE_VISIBLE_ENTRIES = [
  'step="$1"',
  'folder="$2"',
  `aside="${SET_ASIDE}"`,
  // The folder is the home itself or bots/<id>; neither may lead out of the home through a link.
  'if [ "$folder" != "." ]; then',
  '  if [ -L bots ] || [ -L "$folder" ] || [ ! -d "$folder" ]; then',
  '    echo "folder escapes the team home" >&2; exit 1',
  "  fi",
  "fi",
  'cd -- "$folder"',
  "shopt -s nullglob",
  "remove_visible() {",
  "  for entry in *; do",
  '    if [ -d "$entry" ] && [ ! -L "$entry" ]; then',
  '      find "$entry" -type d ! -perm -0200 -exec chmod u+w {} + 2>/dev/null || true',
  "    fi",
  '    rm -rf -- "$entry"',
  "  done",
  "}",
  "drop() {",
  '  if [ -d "$1" ] && [ ! -L "$1" ]; then',
  '    find "$1" -type d ! -perm -0200 -exec chmod u+w {} + 2>/dev/null || true',
  "  fi",
  '  rm -rf -- "$1"',
  "}",
  "put_back() {",
  '  if [ -L "$aside" ] || [ ! -d "$aside" ]; then return 0; fi',
  "  remove_visible",
  '  for entry in "$aside"/*; do mv -- "$entry" .; done',
  '  rmdir -- "$aside"',
  "}",
  'case "$step" in',
  "  aside)",
  // Files already replaced by a finished import are only waiting to be removed.
  '    drop "$aside.done"',
  "    put_back",
  '    drop "$aside"',
  '    mkdir -- "$aside"',
  // A folder that is itself read-only cannot be moved until it is opened up.
  "    for entry in *; do",
  '      if [ -d "$entry" ] && [ ! -L "$entry" ]; then chmod u+w -- "$entry" 2>/dev/null || true; fi',
  '      mv -- "$entry" "$aside"/',
  "    done",
  "    ;;",
  "  back) put_back ;;",
  // Renamed first, so a removal cut short is never taken for files to put back.
  "  drop)",
  '    if [ -d "$aside" ] && [ ! -L "$aside" ]; then',
  '      drop "$aside.done"',
  '      mv -- "$aside" "$aside.done"',
  "    fi",
  '    drop "$aside.done"',
  "    ;;",
  "esac",
].join("\n");

async function replaceVisibleEntries(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  step: "aside" | "back" | "drop",
  folder: string,
  context: AdapterContext,
) {
  let exitCode: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    { argv: ["bash", "-eu", "-c", REPLACE_VISIBLE_ENTRIES, "bash", step, folder], cwd: "." },
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
 * Files the bot already had on the destination are replaced, not mixed with the ones brought:
 * they are set aside first, dropped once the import has finished, and put back when it fails.
 * Nothing is touched when there is nothing to bring. Safe to run again after a failure.
 * Returns whether any file was brought.
 *
 * A computer without the standard shell cannot set files aside or remove only the visible
 * ones, so there the bot's older files stay beside the ones brought.
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
  const folder = to.scope === "team" ? teamBotWorkspaceDirectory(botId) : ".";
  const prefix = to.scope === "team" ? `${folder}/` : "";
  const setsAside = !sandboxKindCapabilities(to.computer.kind).nativeShell;
  if (to.scope === "team") {
    await ensureComputerWorkspaceLayout(deps.sandbox, to.computer, "team", botId, context);
  }
  if (setsAside) await replaceVisibleEntries(deps.sandbox, to.computer, "aside", folder, context);
  let brought = 0;
  async function* placed(): AsyncIterable<PortableFile> {
    for await (const file of savedBotFiles(deps.home, from, botId, context)) {
      brought += 1;
      yield prefix ? { ...file, path: `${prefix}${file.path}` } : file;
    }
  }
  // The older files come back, so a move that brought nothing leaves the computer as it found it.
  const putBack = async () => {
    if (!setsAside) return;
    await bestEffort(
      "put back a bot's older files",
      replaceVisibleEntries(deps.sandbox, to.computer, "back", folder, context),
    );
  };
  try {
    await deps.sandbox.importWorkspace(to.computer, placed(), context);
  } catch (error) {
    await putBack();
    throw error;
  }
  // The saved home was emptied between the check above and the export.
  if (brought === 0) {
    await putBack();
    return false;
  }
  // Left behind, the folder is hidden and the next move drops it.
  if (setsAside) {
    await bestEffort(
      "drop a bot's replaced files",
      replaceVisibleEntries(deps.sandbox, to.computer, "drop", folder, context),
    );
  }
  return true;
}
