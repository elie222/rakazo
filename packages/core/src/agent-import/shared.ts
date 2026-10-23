import type {
  AgentImportFile,
  AgentImportInstruction,
  AgentImportMemory,
  AgentImportPlan,
  AgentImportSkill,
} from "@rakazo/contracts";
import { parseSkillMd } from "../agent-skill.js";

/** What a source parser returns; detection adds the source. */
export type AgentImportParse = Omit<
  AgentImportPlan,
  "source" | "model" | "mcpServers" | "routines" | "apiKeys"
>;

const SKILL_CONTENT_MAX_LENGTH = 100_000;
const SKILL_FILE = /^(?:\.agents\/)?skills\/(?:[^/]+\/){1,4}SKILL\.md$/;

/** Folders that hold sessions, logs, schedules or credentials. Never read. */
const PRIVATE_FOLDERS = new Set(["sessions", "logs", "cron", "credentials"]);

export function isPrivatePath(path: string): boolean {
  return PRIVATE_FOLDERS.has(path.split("/")[0] ?? "");
}

export function isSkillPath(path: string): boolean {
  return SKILL_FILE.test(path);
}

/** Code-unit order, so plans do not depend on the upload order or locale. */
export function byPath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function fileMap(files: AgentImportFile[]): Map<string, string> {
  return new Map(files.filter((file) => !isPrivatePath(file.path)).map((f) => [f.path, f.content]));
}

export function instructionItems(
  files: Map<string, string>,
  paths: readonly string[],
): AgentImportInstruction[] {
  return paths.flatMap((path) => {
    const content = files.get(path);
    return content?.trim() ? [{ id: `instructions:${path}`, title: path, content }] : [];
  });
}

export function memoryItem(id: string, title: string, path: string, content: string) {
  return { id: `memory:${id}`, title, path, spacePath: path, content } satisfies AgentImportMemory;
}

/** Skill items from SKILL.md files; invalid ones are reported, not imported. */
export function skillItems(
  files: Map<string, string>,
): Pick<AgentImportParse, "skills" | "skipped"> {
  const skills: AgentImportSkill[] = [];
  const skipped: AgentImportParse["skipped"] = [];
  for (const path of [...files.keys()].filter(isSkillPath).sort()) {
    const item = skillItem(`skills:${path}`, files.get(path) ?? "");
    if (item) skills.push(item);
    else skipped.push({ path, reason: "invalid_skill" });
  }
  return { skills, skipped };
}

/**
 * A skill item that keeps the SKILL.md text as written (only a BOM and CRLF line endings are
 * normalised): the frontmatter parser here is minimal and would flatten nested metadata.
 */
export function skillItem(id: string, markdown: string): AgentImportSkill | null {
  const content = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const parsed = parseSkillMd(content);
  if ("error" in parsed || content.length > SKILL_CONTENT_MAX_LENGTH) return null;
  return {
    id,
    title: parsed.name,
    name: parsed.name,
    description: parsed.description,
    content,
  };
}

/** Rewrites only the frontmatter `name:` entry, keeping every other byte of the SKILL.md. */
export function renameSkillMd(content: string, name: string): string {
  const match = /^---\n([\s\S]*?)\n---(?=\n|$)/.exec(content);
  if (!match) return content;
  const lines = match[1]!.split("\n");
  const index = lines.findIndex((line) => /^name\s*:/.test(line));
  if (index < 0) return content;
  let end = index + 1;
  // A block scalar name continues on indented lines.
  if (/^name\s*:\s*[|>]/.test(lines[index]!)) {
    while (end < lines.length && (/^\s/.test(lines[end]!) || lines[end] === "")) end += 1;
  }
  lines.splice(index, end - index, `name: ${yamlScalar(name)}`);
  return `---\n${lines.join("\n")}\n---${content.slice(match[0].length)}`;
}

function yamlScalar(value: string): string {
  const plain =
    /^[A-Za-z0-9][\w .-]*$/.test(value) &&
    !/\s$/.test(value) &&
    !/^(?:true|false|null|yes|no|on|off|~|-?\d+(?:\.\d+)?)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}
