import type { SkillCatalogEntry } from "./agent-skill.js";

export function skillCatalogLine(entry: Pick<SkillCatalogEntry, "name" | "description">): string {
  return `- ${entry.name}: ${entry.description}`;
}

export function formatSkillsCatalogInstruction(entries: SkillCatalogEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const lines = entries.map(skillCatalogLine).join("\n");
  return [
    "Available skills (reusable how-to recipes, not account-specific routines):",
    lines,
    "When a skill matches the user's request, call skill_read for that name and follow it immediately. Prefer matching skills over improvising multi-step recipes.",
    "Users can force a skill with /Name in the composer. Routines may mention a skill as @Name — that loads the skill at fire time.",
    "Create a skill with skill_create when a multi-step task is worth repeating (or when asked). After creating one, mention /Name so the user can open it.",
    "Only skill_update / skill_delete user-created skills (not builtin or plugin).",
  ].join("\n");
}

export function formatForcedSkillPrompt(name: string, content: string, rest?: string): string {
  const parts = [`Use skill: ${name}`, "", content.trim()];
  const trailing = rest?.trim();
  if (trailing) parts.push("", trailing);
  return parts.join("\n");
}
