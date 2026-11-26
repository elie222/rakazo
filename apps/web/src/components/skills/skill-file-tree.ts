import type { AgentSkillFileEntry } from "@rakazo/contracts";

/** The skill's own instructions, always the first file in its folder. */
export const SKILL_DOCUMENT = "SKILL.md";

export type SkillFileRow =
  | { kind: "folder"; key: string; name: string; depth: number }
  | { kind: "file"; key: string; path: string; name: string; depth: number; bytes?: number };

/**
 * A skill's folder as rows to show: SKILL.md first, then each folder before the files in it, in
 * path order, with the depth to indent each row by.
 */
export function skillFileRows(files: readonly AgentSkillFileEntry[]): SkillFileRow[] {
  const rows: SkillFileRow[] = [
    { kind: "file", key: SKILL_DOCUMENT, path: SKILL_DOCUMENT, name: SKILL_DOCUMENT, depth: 0 },
  ];
  const folders = new Set<string>();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const parts = file.path.split("/");
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const folder = parts.slice(0, depth + 1).join("/");
      if (folders.has(folder)) continue;
      folders.add(folder);
      rows.push({ kind: "folder", key: `${folder}/`, name: `${parts[depth]}/`, depth });
    }
    rows.push({
      kind: "file",
      key: file.path,
      path: file.path,
      name: parts.at(-1) ?? file.path,
      depth: parts.length - 1,
      bytes: file.bytes,
    });
  }
  return rows;
}

/** Whether a file's text reads as markdown rather than as source to show verbatim. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}
