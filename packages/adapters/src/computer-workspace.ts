import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { ComputerMode } from "@rakazo/contracts";
import { parseScreenLeaseId } from "@rakazo/core";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { normalizeWorkspacePath, teamBotWorkspaceDirectory } from "./computer-support.js";
import { LocalAgentHomeStore } from "./home.js";

export const PORTABLE_TRANSFER_BATCH_BYTES = 8 * 1024 * 1024;

const skippedBrowserProfileDirectories = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Crashpad",
]);
const skippedBrowserProfileFiles = new Set([
  "BrowserMetrics",
  "DevToolsActivePort",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  ".parentlock",
  "lock",
]);

/** Excludes transient browser state that is unsafe or wasteful to restore. */
export function shouldSkipPortableWorkspaceFile(relative: string) {
  if (!relative.startsWith(".browser-profiles/")) return false;
  const segments = relative.split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.some((segment) => skippedBrowserProfileDirectories.has(segment)) ||
    skippedBrowserProfileFiles.has(name)
  );
}

export async function restoreComputerWorkspace(
  home: AgentHomeStore,
  sandbox: SandboxProvider,
  homeKey: string,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<void> {
  if (computer.kind === "docker" && home instanceof LocalAgentHomeStore) return;
  await sandbox.importWorkspace(computer, home.exportHome(homeKey, context), context);
}

export async function ensureComputerWorkspaceLayout(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  scope: ComputerMode,
  botId: string | undefined,
  context: AdapterContext,
): Promise<void> {
  if (scope !== "team" || !botId) return;
  let exitCode: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    { argv: ["mkdir", "-p", "shared", teamBotWorkspaceDirectory(botId)] },
    context,
  )) {
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) {
    throw new Error(`Could not prepare Team Computer folders${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

const TEAM_BOT_FOLDER_NAME = /^[A-Za-z0-9_-]+$/;

/** A bot id that names exactly one folder under bots/ on a Team Computer. */
export function isTeamBotFolderName(botId: string) {
  return TEAM_BOT_FOLDER_NAME.test(botId);
}

/** The bot's browser profile folder under .browser-profiles on a Team Computer. */
export function teamBrowserProfileName(botId: string) {
  const name = path.posix.basename(browserProfilePathForScreen(botId));
  if (!/^chromium-bot-[0-9a-f]{32}$/.test(name)) return null;
  return name;
}

const REMOVE_CONTAINED_DIRECTORIES = [
  'parent="$1"',
  "shift",
  'case "$parent" in',
  "  .browser-profiles) pattern='^chromium-bot-[0-9a-f]{32}$' ;;",
  "  bots) pattern='^[A-Za-z0-9_-]+$' ;;",
  '  *) echo "folder escapes the team home" >&2; exit 1 ;;',
  "esac",
  'if [ -L "$parent" ]; then echo "folder escapes the team home" >&2; exit 1; fi',
  "remove_one() {",
  '  name="$1"',
  '  if [[ ! "$name" =~ $pattern ]]; then echo "folder escapes the team home" >&2; return 1; fi',
  '  target="$parent/$name"',
  '  if [ ! -e "$target" ] && [ ! -L "$target" ]; then return 0; fi',
  '  if [ -L "$target" ]; then rm -- "$target"; return; fi',
  '  if [ ! -d "$target" ]; then echo "folder escapes the team home" >&2; return 1; fi',
  '  resolved_parent=$(cd -- "$parent" && pwd -P)',
  '  resolved_target=$(cd -- "$target" && pwd -P)',
  '  case "$resolved_target" in',
  '    "$resolved_parent/$name") ;;',
  '    *) echo "folder escapes the team home" >&2; return 1 ;;',
  "  esac",
  '  rm -rf -- "$target"',
  "}",
  "status=0",
  'for name in "$@"; do remove_one "$name" || status=1; done',
  'exit "$status"',
].join("\n");

/**
 * Delete folders on the computer. Each name is checked on its own: a symlinked parent is
 * refused, a final symlink is unlinked, and one refused name does not stop the rest.
 */
export async function removeComputerWorkspaceDirectories(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  parent: ".browser-profiles" | "bots",
  names: readonly string[],
  context: AdapterContext,
): Promise<void> {
  let exitCode: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    {
      argv: ["bash", "-eu", "-c", REMOVE_CONTAINED_DIRECTORIES, "bash", parent, ...names],
      cwd: ".",
    },
    context,
  )) {
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "workspace folder cleanup failed");
  }
}

const DELETED_BOT_FOLDER_BATCH = 200;
const DELETED_BOT_FOLDER_BUDGET_MS = 20_000;

/**
 * Remove folders and browser profiles left by bots deleted while this Team Computer was asleep
 * or unreachable. Waits at most budgetMs; anything left is retried on a later boot.
 */
export async function removeDeletedBotWorkspaces(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  computer: ComputerRef,
  spaceId: string,
  context: AdapterContext,
  budgetMs = DELETED_BOT_FOLDER_BUDGET_MS,
): Promise<void> {
  await withCleanupDeadline(context, budgetMs, (cleanupContext) =>
    removeDeletedBotFolders(deps, computer, spaceId, cleanupContext),
  );
}

/**
 * Run best-effort cleanup for at most budgetMs. Its commands are aborted at the deadline, and
 * a provider that ignores the abort still cannot hold the caller past it.
 */
export async function withCleanupDeadline(
  context: AdapterContext,
  budgetMs: number,
  work: (context: AdapterContext) => Promise<void>,
): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("team bot folder cleanup ran out of time")),
    budgetMs,
  );
  const expired = new Promise<never>((_, reject) => {
    deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), {
      once: true,
    });
  });
  const signal = AbortSignal.any([context.signal, deadline.signal]);
  try {
    await Promise.race([work({ ...context, signal }), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function removeDeletedBotFolders(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  computer: ComputerRef,
  spaceId: string,
  context: AdapterContext,
) {
  // Work follows what is still on the computer, not the space's whole deletion history, so
  // every boot makes progress on the leftovers.
  const present = new Set(await listTeamBotEntries(deps.sandbox, computer, context));
  if (!present.size) return;
  const deleted = await deps.prisma.botDeletion.findMany({
    where: { spaceId },
    select: { id: true },
  });
  const folders: string[] = [];
  const profiles: string[] = [];
  for (const { id } of deleted) {
    if (!isTeamBotFolderName(id)) continue;
    if (present.has(`bots/${id}`)) folders.push(id);
    const profile = teamBrowserProfileName(id);
    if (profile && present.has(`.browser-profiles/${profile}`)) profiles.push(profile);
  }
  for (const [parent, names] of [
    ["bots", folders],
    [".browser-profiles", profiles],
  ] as const) {
    for (let start = 0; start < names.length; start += DELETED_BOT_FOLDER_BATCH) {
      if (context.signal.aborted) return;
      await removeComputerWorkspaceDirectories(
        deps.sandbox,
        computer,
        parent,
        names.slice(start, start + DELETED_BOT_FOLDER_BATCH),
        context,
      ).catch((error) => {
        getLogger().error("team bot folder cleanup", error);
      });
    }
  }
}

// A shell glob also lists the symlinks some provider file listings leave out.
const LIST_TEAM_BOT_ENTRIES = [
  "for dir in bots .browser-profiles; do",
  '  if [ ! -d "$dir" ] || [ -L "$dir" ]; then continue; fi',
  '  for entry in "$dir"/*; do',
  '    if [ -e "$entry" ] || [ -L "$entry" ]; then printf \'%s\\n\' "$entry"; fi',
  "  done",
  "done",
].join("\n");

async function listTeamBotEntries(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string[]> {
  let exitCode: number | undefined;
  let stdout = "";
  let stderr = "";
  for await (const event of sandbox.execute(
    computer,
    { argv: ["bash", "-eu", "-c", LIST_TEAM_BOT_ENTRIES], cwd: "." },
    context,
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) throw new Error(stderr.trim() || "workspace folder listing failed");
  return stdout.split("\n").filter(Boolean);
}

export async function checkpointComputerWorkspace(
  home: AgentHomeStore,
  sandbox: SandboxProvider,
  homeKey: string,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string> {
  if (computer.kind === "docker" && home instanceof LocalAgentHomeStore) {
    return home.revise(homeKey);
  }
  const staging = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-"));
  try {
    for await (const file of sandbox.exportWorkspace(computer, context)) {
      await writePortableFile(staging, file);
    }
    return await home.commit(homeKey, staging, context);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Remote exports quiesce browsers, so a run must not checkpoint while peers are driving them. */
export async function checkpointRunComputerWorkspace(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider; prisma: PrismaClient },
  computerRecord: { id: string; homeKey: string; scope: string },
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string | undefined> {
  if (computerRecord.scope !== "team" || computer.kind === "docker") {
    return checkpointAndRecordComputerWorkspace(deps, computerRecord, computer, context);
  }
  const now = new Date();
  const ownLease = context.screenLeaseId ? parseScreenLeaseId(context.screenLeaseId) : undefined;
  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerRecord.id,
      state: "running",
      providerRef: computer.providerRef,
      executionLeases: {
        none: {
          expiresAt: { gt: now },
          ...(ownLease ? { NOT: { runId: ownLease.ownerId, fence: ownLease.fence } } : {}),
        },
      },
      OR: [
        { controlHolder: { not: "user" } },
        { controlLeaseId: null },
        { controlLeaseExpiresAt: null },
        { controlLeaseExpiresAt: { lte: now } },
        ...(context.botId ? [{ controlBotId: context.botId }] : []),
      ],
    },
    data: { state: "suspending", updatedAt: now },
  });
  // The last finishing run or the already scheduled idle job will checkpoint the shared home.
  if (claimed.count !== 1) return undefined;
  try {
    return await checkpointAndRecordComputerWorkspace(deps, computerRecord, computer, context);
  } finally {
    await deps.prisma.computer.updateMany({
      where: { id: computerRecord.id, state: "suspending", providerRef: computer.providerRef },
      data: { state: "running" },
    });
  }
}

export async function checkpointAndRecordComputerWorkspace(
  deps: { home: AgentHomeStore; sandbox: SandboxProvider; prisma: PrismaClient },
  computerRecord: { id: string; homeKey: string },
  computer: ComputerRef,
  context: AdapterContext,
): Promise<string> {
  const revision = await checkpointComputerWorkspace(
    deps.home,
    deps.sandbox,
    computerRecord.homeKey,
    computer,
    context,
  );
  await deps.prisma.computer.updateMany({
    where: { id: computerRecord.id },
    data: { homeRevision: revision },
  });
  return revision;
}

async function writePortableFile(root: string, file: PortableFile) {
  const relative = normalizeWorkspacePath(file.path);
  if (!relative) throw new Error("Workspace snapshots cannot contain an empty file path");
  const target = path.resolve(root, relative);
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Workspace snapshot path escapes its staging directory");
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.content, { mode: file.executable ? 0o700 : 0o600 });
}
