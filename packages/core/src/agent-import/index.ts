import type {
  AgentImportFile,
  AgentImportInstruction,
  AgentImportPlan,
  AgentImportSource,
} from "@rakazo/contracts";
import {
  AGENT_IMPORT_CONFIG_FILES,
  isAgentImportSecretFile,
  stripAgentImportSecrets,
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
import type { AgentImportParse } from "./shared.js";
import { isPrivatePath, isSkillPath, renameSkillMd } from "./shared.js";

export {
  hasAgentImportSecrets,
  isAgentImportSecretFile,
  readAgentImportConfig,
  stripAgentImportSecrets,
} from "./config.js";
export { AGENT_IMPORT_PROMPT } from "./document.js";

export const AGENT_IMPORT_NOT_FOUND = "No OpenClaw, Hermes or agent document found.";

const WORKSPACE_FILES = new Set<string>([
  ...OPENCLAW_INSTRUCTION_FILES,
  ...OPENCLAW_MEMORY_FILES,
  ...OPENCLAW_RUNTIME_FILES,
  ...HERMES_INSTRUCTION_FILES,
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
export function agentImportFolder(paths: readonly string[]): {
  root: string;
  files: Map<string, string>;
} {
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
      files: new Map(relative.filter(([, path]) => isAgentImportCandidate(path))),
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
    if (inHome.startsWith(`${workspace}/`) && isAgentImportCandidate(inWorkspace)) {
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
  const folder = agentImportFolder(files.map((file) => file.path));
  const kept = new Map<string, string>();
  for (const file of files) {
    const path = folder.files.get(file.path);
    if (!path) continue;
    if (!options.includeSecrets && isAgentImportSecretFile(path)) continue;
    kept.set(
      path,
      options.includeSecrets ? file.content : stripAgentImportSecrets(path, file.content),
    );
  }
  const source = detectSource(new Set(kept.keys()), folder.root);
  return source ? { source, root: folder.root, files: kept } : null;
}

/**
 * Reads files from an OpenClaw workspace or home, a Hermes home or an exported agent
 * document into one plan. Imported text is data: nothing here follows it. Settings
 * (model, MCP servers, scheduled jobs, API keys) are added by the server.
 */
export function parseAgentImport(files: AgentImportFile[]): AgentImportPlan | { error: string } {
  const only = files.length === 1 ? files[0] : undefined;
  if (only && isAgentDocument(only.content)) {
    return plan("document", parseAgentDocument(only.content));
  }
  const folder = readAgentImportFolder(files, { includeSecrets: false });
  if (!folder) return { error: AGENT_IMPORT_NOT_FOUND };
  const kept = [...folder.files].map(([path, content]) => ({ path, content }));
  const parsed = folder.source === "hermes" ? parseHermes(kept) : parseOpenClaw(kept, folder.root);
  if (!parsed.instructions.length && !parsed.memory.length && !parsed.skills.length) {
    return { error: AGENT_IMPORT_NOT_FOUND };
  }
  return plan(folder.source, parsed);
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

/** Instruction files as one text, each under its own heading when there are several. */
export function combineImportedInstructions(
  items: readonly Pick<AgentImportInstruction, "title" | "content">[],
): string {
  if (items.length === 1) return items[0]!.content.trim();
  return items.map((item) => `# ${item.title}\n\n${item.content.trim()}`).join("\n\n");
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
