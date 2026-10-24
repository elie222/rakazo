import type {
  AgentImportFile,
  AgentImportInstruction,
  AgentImportPlan,
  AgentImportSource,
} from "@rakazo/contracts";
import {
  AGENT_IMPORT_MAX_FILE_LENGTH,
  AGENT_IMPORT_MAX_FILES,
  AGENT_IMPORT_MAX_TOTAL_LENGTH,
} from "@rakazo/contracts";
import { AgentImportArchiveError } from "./archive.js";
import {
  AGENT_IMPORT_CONFIG_FILES,
  isAgentImportSecretFile,
  prepareAgentImportFiles,
} from "./config.js";
import { isAgentDocument, parseAgentDocument } from "./document.js";
import { HERMES_INSTRUCTION_FILES, HERMES_MEMORY_FILES, parseHermes } from "./hermes.js";
import {
  isOpenClawDailyMemory,
  OPENCLAW_INSTRUCTION_FILES,
  OPENCLAW_MEMORY_FILES,
  OPENCLAW_RUNTIME_FILES,
  parseOpenClaw,
} from "./openclaw.js";
import type { AgentImportParse, SkillFiles } from "./shared.js";
import { isPrivatePath, isSkillPath, renameSkillMd } from "./shared.js";

export {
  AGENT_IMPORT_ARCHIVE_LIMITS,
  AgentImportArchiveError,
  type AgentImportArchiveErrorReason,
  type AgentImportArchiveLimits,
  openAgentImportArchive,
  safeArchivePath,
} from "./archive.js";
export {
  AGENT_IMPORT_PROVIDER_KEYS,
  hasAgentImportSecrets,
  isAgentImportSecretFile,
  mcpServerImportable,
  normalizeImportProvider,
  parseDotEnv,
  prepareAgentImportFiles,
  readAgentImportConfig,
  stripAgentImportSecrets,
} from "./config.js";
export { AGENT_IMPORT_PROMPT } from "./document.js";
export type { SkillFiles } from "./shared.js";

export const AGENT_IMPORT_NOT_FOUND = "No OpenClaw, Hermes or agent document found.";

const WORKSPACE_FILES = new Set<string>([
  ...OPENCLAW_INSTRUCTION_FILES.map(([path]) => path),
  "IDENTITY.md",
  ...OPENCLAW_MEMORY_FILES,
  ...OPENCLAW_RUNTIME_FILES,
  ...HERMES_INSTRUCTION_FILES.map(([path]) => path),
  ...HERMES_MEMORY_FILES.map(([source]) => source),
]);
/** Top-level folders a source keeps; a path starting with one has no upload root. */
const SOURCE_FOLDERS = new Set(["skills", "memory", "memories", ".agents"]);
const WORKSPACE_FOLDER = /^workspace(?:-[^/]+)?$/;

/**
 * True for a path inside a chosen OpenClaw or Hermes folder (without the folder name)
 * that an import can use. Clients send only these, so unrelated files stay on the device.
 */
export function isAgentImportCandidate(path: string): boolean {
  if (AGENT_IMPORT_CONFIG_FILES.has(path)) return true;
  if (isPrivatePath(path)) return false;
  return WORKSPACE_FILES.has(path) || isOpenClawDailyMemory(path) || isSkillPath(path);
}

/** Files only an OpenClaw or Hermes agent keeps (AGENTS.md alone is common in projects). */
const AGENT_SIGNATURES = new Set([
  "openclaw.json",
  "SOUL.md",
  "IDENTITY.md",
  "HERMES.md",
  ".hermes.md",
]);

/**
 * True when a folder's or backup's file names look like an OpenClaw or Hermes home or
 * workspace. Only names are looked at, so this can decide before anything is read or sent.
 * Paths an archive reader already mapped to `.openclaw/` or `.hermes/` count as recognised.
 */
export function isAgentHome(paths: readonly string[]): boolean {
  if (paths.some((path) => path.startsWith(".openclaw/") || path.startsWith(".hermes/"))) {
    return true;
  }
  const homes = [...agentImportFolder(paths).files.values()];
  return homes.some(
    (home) =>
      AGENT_SIGNATURES.has(home) ||
      home.startsWith("memories/") ||
      AGENT_SIGNATURES.has(home.split("/").slice(1).join("/")),
  );
}

/**
 * The files of a chosen folder an import uses, keyed by their path in the upload (which
 * starts with the folder's name) and mapped to their path in the agent's workspace or home.
 * Clients read and send only these; the server applies the same choice to what it receives.
 *
 * Choosing the OpenClaw home (`~/.openclaw`) uses its `workspace/` folder (or the only
 * `workspace-<id>` folder when there is no `workspace/`) plus the managed skills in
 * `skills/` and the settings files at the home's root; workspace skills win over managed
 * ones with the same path, as in OpenClaw.
 */
export function agentImportFolder(
  paths: readonly string[],
  options: { bundledSkills?: ReadonlySet<string> } = {},
): {
  root: string;
  files: Map<string, string>;
} {
  // Hermes' own skills (named in skills/.bundled_manifest) are never read or sent.
  const bundled = options.bundledSkills;
  const candidate = (path: string) =>
    isAgentImportCandidate(path) && !(bundled && isBundledSkill(path, bundled));
  const first = paths[0]?.split("/")[0] ?? "";
  const shared =
    first && !SOURCE_FOLDERS.has(first) && paths.every((path) => path.startsWith(`${first}/`));
  const relative = paths.map(
    (path) => [path, shared ? path.slice(first.length + 1) : path] as const,
  );
  const root = shared ? first : "";
  const workspaces = new Set(
    relative.flatMap(([, path]) => {
      const [folder = "", ...rest] = path.split("/");
      return WORKSPACE_FOLDER.test(folder) && isAgentImportCandidate(rest.join("/"))
        ? [folder]
        : [];
    }),
  );
  const ownFiles = relative.some(
    ([, path]) => WORKSPACE_FILES.has(path) || path.startsWith("memories/"),
  );
  if (ownFiles || workspaces.size === 0) {
    return {
      root,
      files: new Map(relative.filter(([, path]) => candidate(path))),
    };
  }
  const workspace = workspaces.has("workspace")
    ? "workspace"
    : workspaces.size === 1
      ? [...workspaces][0]!
      : null;
  const files = new Map<string, string>();
  if (!workspace) return { root, files };
  for (const [path, inHome] of relative) {
    const inWorkspace = inHome.slice(workspace.length + 1);
    if (inHome.startsWith(`${workspace}/`) && candidate(inWorkspace)) {
      files.set(path, inWorkspace);
    }
  }
  const used = new Set(files.values());
  for (const [path, inHome] of relative) {
    const managedSkill = inHome.startsWith("skills/") && isSkillPath(inHome);
    if ((managedSkill || AGENT_IMPORT_CONFIG_FILES.has(inHome)) && !used.has(inHome)) {
      files.set(path, inHome);
    }
  }
  return { root: workspace, files };
}

/**
 * For each chosen SKILL.md, the names of the other files in its folder. Only names are
 * sent: those files are not imported, and their names show what a skill would be missing.
 */
export function agentImportSkillFiles(
  paths: readonly string[],
  used: ReadonlyMap<string, string>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, home] of used) {
    if (!home.endsWith("SKILL.md") || !isSkillPath(home)) continue;
    const folder = path.slice(0, -"SKILL.md".length);
    const names = paths
      .filter((other) => other !== path && other.startsWith(folder))
      .map((other) => other.slice(folder.length))
      .slice(0, 200);
    if (names.length) out[home] = names;
  }
  return out;
}

/**
 * The source of an upload and its files by path in the agent's workspace or home. Without
 * the API key opt-in, secret files are dropped and settings keep only what an import reads,
 * with the same function the browser applies before sending.
 */
export function readAgentImportFolder(
  files: AgentImportFile[],
  options: { includeSecrets: boolean },
): {
  source: Exclude<AgentImportSource, "document">;
  root: string;
  files: Map<string, string>;
} | null {
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const folder = chooseFolder(
    files.map((file) => file.path),
    (path) => contents.get(path) ?? "",
  );
  const home = new Map<string, string>();
  for (const [path, inHome] of folder.files) home.set(inHome, contents.get(path) ?? "");
  const kept = prepareAgentImportFiles(home, options);
  const source = detectSource(new Set(kept.keys()), folder.root);
  return source ? { source, root: folder.root, files: kept } : null;
}

/** The skill folder names a Hermes `skills/.bundled_manifest` lists (`name:hash` lines). */
export function bundledSkillNames(manifest: string): Set<string> {
  return new Set(
    manifest
      .split(/\r?\n/)
      .map((line) => line.split(":")[0]!.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isBundledSkill(path: string, bundled: ReadonlySet<string>): boolean {
  if (!isSkillPath(path)) return false;
  const folder = path.split("/").at(-2)?.toLowerCase() ?? "";
  return bundled.has(folder);
}

/** The folder choice, with Hermes' bundled skills left out once its manifest is read. */
function chooseFolder(paths: readonly string[], read: (path: string) => string) {
  const first = agentImportFolder(paths);
  const manifest = [...first.files].find(([, home]) => home === BUNDLED_MANIFEST)?.[0];
  if (!manifest) return first;
  return agentImportFolder(paths, { bundledSkills: bundledSkillNames(read(manifest)) });
}

const BUNDLED_MANIFEST = "skills/.bundled_manifest";

/**
 * What a client reads from a chosen folder or backup: the same choice the server makes.
 * Sizes are checked before anything is read; the manifest is read first so bundled skills
 * are never read; `.env` and `auth.json` are read only with the API key opt-in.
 */
export async function chooseAgentImportFiles(
  paths: readonly string[],
  read: (path: string) => Promise<string> | string,
  options: { includeSecrets: boolean; size?: (path: string) => number | undefined },
): Promise<{
  entries: { path: string; home: string; content: string }[];
  /** Whether the folder has `.env` or `auth.json`, read only after the opt-in. */
  hasSecretFiles: boolean;
}> {
  const first = agentImportFolder(paths);
  const manifestPath = [...first.files].find(([, home]) => home === BUNDLED_MANIFEST)?.[0];
  if (manifestPath) checkSizes([manifestPath], options.size);
  const folder = manifestPath
    ? agentImportFolder(paths, { bundledSkills: bundledSkillNames(await read(manifestPath)) })
    : first;
  const all = [...folder.files];
  const hasSecretFiles = all.some(([, home]) => isAgentImportSecretFile(home));
  const wanted = all.filter(([, home]) => options.includeSecrets || !isAgentImportSecretFile(home));
  checkSizes(
    wanted.map(([path]) => path),
    options.size,
  );
  const entries = await Promise.all(
    wanted.map(async ([path, home]) => ({ path, home, content: await read(path) })),
  );
  return { entries, hasSecretFiles };
}

/** Refuses a choice too large to upload before any of it is read. */
function checkSizes(paths: readonly string[], size?: (path: string) => number | undefined) {
  if (paths.length > AGENT_IMPORT_MAX_FILES) throw new AgentImportArchiveError("too_large");
  let total = 0;
  for (const path of paths) {
    // A character takes at least one byte, so a byte size bounds the text the server checks.
    const bytes = size?.(path) ?? 0;
    if (bytes > AGENT_IMPORT_MAX_FILE_LENGTH * 4) throw new AgentImportArchiveError("too_large");
    total += bytes;
  }
  if (total > AGENT_IMPORT_MAX_TOTAL_LENGTH * 4) throw new AgentImportArchiveError("too_large");
}

/**
 * The upload for files chosen from a folder or backup: the shared rule of
 * `prepareAgentImportFiles`, keyed back to the upload paths. Secret files are sent only
 * with the opt-in, and then only their allowlisted entries.
 */
export function agentImportUpload(
  entries: readonly { path: string; home: string; content: string }[],
  options: { includeSecrets: boolean },
): AgentImportFile[] {
  const prepared = prepareAgentImportFiles(
    new Map(entries.map((entry) => [entry.home, entry.content])),
    options,
  );
  return entries.flatMap(({ path, home }) => {
    const content = prepared.get(home);
    return content === undefined ? [] : [{ path, content }];
  });
}

/**
 * Reads files from an OpenClaw workspace or home, a Hermes home or an exported agent
 * document into one plan. Imported text is data: nothing here follows it. Settings
 * (model, MCP servers, scheduled jobs, API keys) are added by the server.
 */
export function parseAgentImport(
  files: AgentImportFile[],
  skillFiles: SkillFiles = {},
): AgentImportPlan | { error: string } {
  const only = files.length === 1 ? files[0] : undefined;
  // A known agent file (SOUL.md, MEMORY.md, memories/…) is read as one even when its text
  // has the document's headings; only another file or the pasted reply is a document.
  if (only && !isKnownAgentFile(only.path) && isAgentDocument(only.content)) {
    return plan("document", parseAgentDocument(only.content));
  }
  const folder = readAgentImportFolder(files, { includeSecrets: false });
  if (!folder) return { error: AGENT_IMPORT_NOT_FOUND };
  const kept = [...folder.files].map(([path, content]) => ({ path, content }));
  const parsed =
    folder.source === "hermes"
      ? parseHermes(kept, skillFiles)
      : parseOpenClaw(kept, folder.root, skillFiles);
  if (!parsed.instructions.length && !parsed.memory.length && !parsed.skills.length) {
    return { error: AGENT_IMPORT_NOT_FOUND };
  }
  return plan(folder.source, parsed);
}

/** True when a path, from any folder down, names a file an OpenClaw or Hermes agent keeps. */
function isKnownAgentFile(path: string): boolean {
  const parts = path.split("/");
  return parts.some((_, index) => {
    const tail = parts.slice(index).join("/");
    return isAgentImportCandidate(tail) && !AGENT_IMPORT_CONFIG_FILES.has(tail);
  });
}

function plan(source: AgentImportSource, parsed: AgentImportParse): AgentImportPlan {
  return resolveAgentImportNames(
    { source, ...parsed, model: null, mcpServers: [], routines: [], apiKeys: [] },
    { spaceMemoryPaths: [], skillNames: [] },
  );
}

function detectSource(
  paths: Set<string>,
  root: string,
): Exclude<AgentImportSource, "document"> | null {
  const has = (path: string) => paths.has(path);
  if (
    root === ".hermes" ||
    HERMES_MEMORY_FILES.some(([source]) => has(source)) ||
    has("HERMES.md") ||
    has(".hermes.md") ||
    has("config.yaml")
  ) {
    return "hermes";
  }
  return [...paths].some((path) => path.endsWith(".md")) ? "openclaw" : null;
}

/** Neutral headings for the two kinds of instruction text, when both are imported. */
export const IMPORTED_INSTRUCTION_HEADINGS = {
  persona: "Persona",
  working: "Working instructions",
} as const;

/**
 * A bot's instructions from imported files, keeping what each file is for: the persona
 * (who the agent is, its tone and boundaries) first, then the working instructions (how it
 * works). With both, each gets a short heading of its own; with one, it is used as is. A
 * file's own title naming the file (`# SOUL.md - Who You Are`) is left out, since it would
 * read as a heading about a file the bot does not have.
 */
export function combineImportedInstructions(
  items: readonly Pick<AgentImportInstruction, "title" | "content" | "role">[],
): string {
  const text = (role: AgentImportInstruction["role"]) =>
    items
      .filter((item) => item.role === role)
      .map((item) => withoutFileTitle(item.title, item.content))
      .filter(Boolean)
      .join("\n\n");
  const persona = text("persona");
  const working = text("working");
  if (!persona || !working) return persona || working;
  return [
    `# ${IMPORTED_INSTRUCTION_HEADINGS.persona}`,
    persona,
    `# ${IMPORTED_INSTRUCTION_HEADINGS.working}`,
    working,
  ].join("\n\n");
}

function withoutFileTitle(file: string, content: string): string {
  const text = content.replace(/\r\n?/g, "\n").trim();
  const name = file.split("/").at(-1) ?? file;
  const first = text.split("\n", 1)[0] ?? "";
  if (/^#\s/.test(first) && first.replace(/^#\s+/, "").startsWith(name)) {
    return text.slice(first.length).trim();
  }
  return text;
}

/**
 * Never overwrite: space memory paths and skill names already taken (case-insensitive,
 * like skills) get the first free `-2`, `-3`, ... suffix. Imported bot memory goes into a
 * new bot, so its paths are kept.
 */
export function resolveAgentImportNames(
  plan: AgentImportPlan,
  taken: { spaceMemoryPaths: readonly string[]; skillNames: readonly string[] },
): AgentImportPlan {
  const paths = new Set(taken.spaceMemoryPaths.map((path) => path.toLowerCase()));
  const names = new Set(taken.skillNames.map((name) => name.trim().toLowerCase()));
  return {
    ...plan,
    memory: plan.memory.map((item) => ({ ...item, spacePath: freeName(item.path, paths, ".md") })),
    skills: plan.skills.map((item) => {
      const name = freeName(item.title, names, "");
      return name === item.name
        ? item
        : { ...item, name, content: renameSkillMd(item.content, name) };
    }),
  };
}

const NAME_MAX_LENGTH = 80;

/**
 * A memory path that is not yet in `used` (lowercase): the first free `-2`, `-3`, ... before
 * `.md`. Adds the result to `used`, so several imported documents never share a path.
 */
export function freeAgentImportMemoryPath(path: string, used: Set<string>): string {
  return freeName(path, used, ".md");
}

function freeName(value: string, used: Set<string>, extension: string): string {
  const hasExtension = extension && value.toLowerCase().endsWith(extension);
  const base = hasExtension ? value.slice(0, -extension.length) : value;
  const suffix = hasExtension ? value.slice(-extension.length) : "";
  let candidate = value;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    const tail = `-${n}${suffix}`;
    candidate = `${base.slice(0, Math.max(1, NAME_MAX_LENGTH - tail.length))}${tail}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
