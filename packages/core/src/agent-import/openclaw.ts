import type { AgentImportFile } from "@rakazo/contracts";
import type { AgentImportParse } from "./shared.js";
import { byPath, fileMap, instructionItems, memoryItem, skillItems } from "./shared.js";

/** OpenClaw workspace files, in the order they are combined into instructions. */
export const OPENCLAW_INSTRUCTION_FILES = ["SOUL.md", "AGENTS.md", "IDENTITY.md"] as const;
export const OPENCLAW_MEMORY_FILES = ["MEMORY.md", "USER.md"] as const;
/** Runtime rituals with no Rakazo equivalent. */
export const OPENCLAW_RUNTIME_FILES = ["TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md", "BOOT.md"];
const DAILY_MEMORY = /^memory\/[^/]+\.md$/;

export function isOpenClawDailyMemory(path: string): boolean {
  return DAILY_MEMORY.test(path);
}

export function parseOpenClaw(files: AgentImportFile[], root: string): AgentImportParse {
  const byName = fileMap(files);
  const memoryPaths = [
    ...OPENCLAW_MEMORY_FILES.filter((path) => byName.has(path)),
    ...[...byName.keys()].filter(isOpenClawDailyMemory).sort(),
  ];
  const skills = skillItems(byName);
  return {
    suggestedName: identityName(byName.get("IDENTITY.md")) ?? workspaceAgentId(root) ?? "OpenClaw",
    instructions: instructionItems(byName, OPENCLAW_INSTRUCTION_FILES),
    memory: memoryPaths.flatMap((path) => {
      const content = byName.get(path) ?? "";
      return content.trim() ? [memoryItem(path, path, path, content)] : [];
    }),
    skills: skills.skills,
    skipped: [
      ...OPENCLAW_RUNTIME_FILES.filter((path) => byName.has(path)).map((path) => ({
        path,
        reason: "runtime" as const,
      })),
      ...skills.skipped,
    ].sort(byPath),
  };
}

/**
 * IDENTITY.md keeps the name on a `Name:` line, often bold and bulleted. The value is read
 * from that line only; the untouched template's `_(pick something you like)_` hint is empty.
 */
function identityName(identity: string | undefined): string | undefined {
  const match = /^[ \t>*-]*\**name\**[ \t]*:[ \t]*(.*)$/im.exec(identity ?? "");
  const name = (match?.[1] ?? "").replace(/\*+/g, "").trim();
  return name && !/^_?\(.*\)_?$/.test(name) ? name : undefined;
}

/** `workspace-<agentId>` is the folder of a named agent. */
function workspaceAgentId(root: string): string | undefined {
  return /^workspace-(.+)$/.exec(root)?.[1];
}
