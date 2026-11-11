import { parse as parseYaml } from "yaml";

/**
 * Claude Agent Skills: reusable SKILL.md recipes shared across assistants.
 * The Pi runtime already understands this format; we persist and inject them.
 * Distinct from taught skills (demo/record playbooks on a single bot).
 */

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export type SkillSource = "user" | "builtin" | "plugin";

export type ParsedSkillMd = {
  name: string;
  description: string;
  body: string;
  /**
   * All frontmatter keys as parsed scalars/structures. Unknown keys are preserved
   * so Claude Agent Skills with extra fields round-trip safely.
   */
  frontmatter: Record<string, unknown>;
};

export type SkillCatalogEntry = {
  name: string;
  description: string;
  source: SkillSource;
  readOnly: boolean;
};

export type SkillRecord = SkillCatalogEntry & {
  id?: string;
  content: string;
};

const FORCE_SKILL_PREFIX = /^(?:\/|use\s+skill:\s*)(.+?)(?:\n|$)/i;
const ROUTINE_SKILL_STOP = new Set([
  "then",
  "and",
  "or",
  "to",
  "for",
  "with",
  "from",
  "via",
  "before",
  "after",
  "please",
  "the",
  "a",
  "an",
]);
// Detection, expansion, and import renames must agree on mention boundaries.
const ROUTINE_SKILL_LEAD = "[\\s(,，。、；：！？（【「『《]";
const ROUTINE_SKILL_END = "(?=[\\s,.)，。、；：！？）】」』》]|$)";
/** Fallback when no catalog is available: @Token with optional Title-case words. */
const ROUTINE_SKILL_MENTION = new RegExp(
  `(?:^|${ROUTINE_SKILL_LEAD})@([A-Za-z][\\w-]*(?:[ ]+[A-Za-z][\\w-]*){0,5})${ROUTINE_SKILL_END}`,
  "g",
);

export function isSkillReadOnly(source: SkillSource): boolean {
  return source === "builtin" || source === "plugin";
}

/** Requires YAML frontmatter with `name` and `description`; extra keys are kept in `frontmatter`. */
export function parseSkillMd(content: string): ParsedSkillMd | { error: string } {
  const trimmed = content.replace(/^\uFEFF/, "");
  const match = FRONTMATTER_FENCE.exec(trimmed);
  if (!match) {
    return { error: "SKILL.md must start with YAML frontmatter (--- ... ---)." };
  }
  const frontmatterText = match[1] ?? "";
  const body = trimmed.slice(match[0].length).replace(/^\r?\n/, "");
  let frontmatter: Record<string, unknown>;
  try {
    const parsed = parseSkillFrontmatter(`${frontmatterText}\n`);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("SKILL.md frontmatter must be a YAML object.");
    }
    frontmatter = parsed as Record<string, unknown>;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid SKILL.md frontmatter.",
    };
  }
  const name = stringifyScalar(frontmatter.name).trim();
  const description = stringifyScalar(frontmatter.description).trim();
  if (!name) return { error: "SKILL.md frontmatter requires name." };
  if (!description) return { error: "SKILL.md frontmatter requires description." };
  if (name.length > 80) return { error: "Skill name must be at most 80 characters." };
  if (description.length > 2000) {
    return { error: "Skill description must be at most 2000 characters." };
  }
  return { name, description, body, frontmatter };
}

function parseSkillFrontmatter(text: string): unknown {
  const options = { maxAliasCount: 100, stringKeys: true, uniqueKeys: true } as const;
  try {
    return parseYaml(text, options);
  } catch (error) {
    const repaired = text.replace(/"(?:[^"\\\r\n]|\\.)*"/g, (value) =>
      value.replace(
        /\\(?!["\\/0abtnvfreN_LP]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g,
        (slash) => `${slash}${slash}`,
      ),
    );
    if (repaired === text) throw error;
    return parseYaml(repaired, options);
  }
}

/** Build SKILL.md, preserving unknown frontmatter keys from a prior parse. */
export function buildSkillMd(input: {
  name: string;
  description: string;
  body: string;
  frontmatter?: Record<string, unknown>;
}): string {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!name) throw new Error("Skill name is required.");
  if (!description) throw new Error("Skill description is required.");
  if (name.length > 80) throw new Error("Skill name must be at most 80 characters.");
  if (description.length > 2000) {
    throw new Error("Skill description must be at most 2000 characters.");
  }
  const merged: Record<string, unknown> = { ...(input.frontmatter ?? {}) };
  merged.name = name;
  merged.description = description;
  // Stable order: name, description, then remaining keys alphabetically.
  const rank = (key: string) => (key === "name" ? 0 : key === "description" ? 1 : 2);
  const keys = Object.keys(merged).sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  const lines = keys.map((key) => formatYamlLine(key, merged[key]));
  const body = input.body.replace(/^\r?\n/, "");
  return `---\n${lines.join("\n")}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

export function skillCatalogLine(entry: Pick<SkillCatalogEntry, "name" | "description">): string {
  return `- ${entry.name}: ${entry.description}`;
}

export function formatSkillsCatalogInstruction(entries: SkillCatalogEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const lines = entries.slice(0, 50).map(skillCatalogLine).join("\n");
  return [
    "Available Claude Agent Skills (SKILL.md recipes shared across assistants; generic how-tos, not account-specific routines). The Pi runtime already understands this format; we persist and inject them:",
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

/** Detect a composer-forced skill (`/Name` or `Use skill: Name`) at the start of a prompt. */
export function extractForcedSkillName(prompt: string): { name: string; rest: string } | null {
  const text = prompt.trimStart();
  const match = FORCE_SKILL_PREFIX.exec(text);
  if (!match) return null;
  const name = (match[1] ?? "").trim().replace(/^\/+/, "").trim();
  if (!name || name.length > 80) return null;
  // Avoid treating `/` settings actions as skills.
  if (/^(chat\s+settings|settings:)/i.test(name)) return null;
  const rest = text.slice(match[0].length).trimStart();
  return { name, rest };
}

/**
 * Mentions like `@Daily standup` inside a routine prompt. Returns unique names in order.
 * When `knownNames` is provided, matches those names (longest first). Otherwise uses a
 * heuristic that stops before common connector words and skips `@everyone`.
 */
export function extractRoutineSkillMentions(prompt: string, knownNames?: string[]): string[] {
  if (knownNames && knownNames.length > 0) {
    const sorted = knownNames
      .map((name) => name.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (sorted.length === 0) return [];
    // Match each mention once so a longer name does not also select its prefix.
    // Each capture identifies its catalog name without changing regex case matching.
    const alternatives = sorted.map((name) => `(${escapeRegExp(name)})`).join("|");
    const re = new RegExp(
      `(?:^|${ROUTINE_SKILL_LEAD})@(?:${alternatives})${ROUTINE_SKILL_END}`,
      "gi",
    );
    const mentionedIndices = new Set(
      [...prompt.matchAll(re)].map((match) =>
        match.slice(1).findIndex((capture) => capture !== undefined),
      ),
    );
    const found: string[] = [];
    const seen = new Set<string>();
    for (const [index, name] of sorted.entries()) {
      const key = name.toLowerCase();
      if (!mentionedIndices.has(index) || seen.has(key)) continue;
      seen.add(key);
      found.push(name);
    }
    return found;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  ROUTINE_SKILL_MENTION.lastIndex = 0;
  let match = ROUTINE_SKILL_MENTION.exec(prompt);
  while (match !== null) {
    const raw = (match[1] ?? "").trim();
    if (!raw) {
      match = ROUTINE_SKILL_MENTION.exec(prompt);
      continue;
    }
    const parts = raw.split(/\s+/);
    while (parts.length > 1 && ROUTINE_SKILL_STOP.has(parts[parts.length - 1]!.toLowerCase())) {
      parts.pop();
    }
    const name = parts.join(" ").trim();
    if (!name || name.toLowerCase() === "everyone") {
      match = ROUTINE_SKILL_MENTION.exec(prompt);
      continue;
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
    match = ROUTINE_SKILL_MENTION.exec(prompt);
  }
  return names;
}

/** Keep user-owned skills reachable when a later builtin claims the same name. */
export function mergeBuiltinSkills<T extends { name: string }>(
  builtins: readonly T[],
  userSkills: readonly T[],
): T[] {
  return [...builtins.filter((skill) => !findSkillByName(userSkills, skill.name)), ...userSkills];
}

export function findSkillByName<T extends { name: string }>(
  skills: readonly T[],
  name: string,
): T | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return skills.find((skill) => skill.name.trim().toLowerCase() === needle);
}

/** True when `rest` already begins with the skill body (prior expand pass). */
function restAlreadyIncludesSkillContent(rest: string, content: string): boolean {
  const trimmedRest = rest.trim();
  const trimmedContent = content.trim();
  if (!trimmedContent) return false;
  return (
    trimmedRest === trimmedContent ||
    trimmedRest.startsWith(`${trimmedContent}\n`) ||
    trimmedRest.startsWith(`${trimmedContent}\r\n`)
  );
}

/** Expand forced `/Name` or routine `@Name` mentions into full skill bodies for the task prompt. */
export function expandSkillReferencesInPrompt(
  prompt: string,
  skills: readonly SkillRecord[],
): string {
  const forced = extractForcedSkillName(prompt);
  if (forced) {
    const skill = findSkillByName(skills, forced.name);
    if (skill) {
      // Routines expand at fire time into `Use skill: …`; run time expands again — stay idempotent.
      if (restAlreadyIncludesSkillContent(forced.rest, skill.content)) {
        return prompt.trimStart();
      }
      return formatForcedSkillPrompt(skill.name, skill.content, forced.rest);
    }
  }

  const mentions = extractRoutineSkillMentions(
    prompt,
    skills.map((skill) => skill.name),
  );
  if (mentions.length === 0) return prompt;

  const blocks: string[] = [];
  let remaining = prompt;
  for (const mention of mentions) {
    const skill = findSkillByName(skills, mention);
    if (!skill) continue;
    blocks.push(formatForcedSkillPrompt(skill.name, skill.content));
    // Strip the @mention token so the agent is not confused by a dangling pointer.
    remaining = remaining.replace(
      new RegExp(`(^|${ROUTINE_SKILL_LEAD})@${escapeRegExp(mention)}${ROUTINE_SKILL_END}`, "gi"),
      "$1",
    );
  }
  if (blocks.length === 0) return prompt;
  const rest = remaining.replace(/[ \t]{2,}/g, " ").trim();
  return [...blocks, rest].filter(Boolean).join("\n\n");
}

/**
 * Points `@old` skill mentions in a routine prompt at their new names, in one pass. Names
 * mapped to themselves are still matched, so a longer name wins over a renamed prefix.
 */
export function renameRoutineSkillMentions(
  prompt: string,
  renames: ReadonlyMap<string, string>,
): string {
  const names = [...renames.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return prompt;
  const next = new Map([...renames].map(([from, to]) => [from.toLowerCase(), to]));
  return prompt.replace(
    new RegExp(
      `(^|${ROUTINE_SKILL_LEAD})@(${names.map(escapeRegExp).join("|")})${ROUTINE_SKILL_END}`,
      "gi",
    ),
    (match, lead: string, name: string) => {
      const to = next.get(name.toLowerCase());
      return to ? `${lead}@${to}` : match;
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function formatYamlBlockScalar(key: string, value: string): string {
  // Choose chomp so decodeYamlBlockScalar round-trips trailing newlines:
  // strip (0), clip (1), keep (2+). Folded (`>`) style is not preserved — only the string value.
  const trailing = /\n*$/.exec(value)?.[0].length ?? 0;
  let indicator = "|";
  let lines: string[];
  if (trailing === 0) {
    indicator = "|-";
    lines = value.split("\n");
  } else if (trailing === 1) {
    indicator = "|";
    lines = value.slice(0, -1).split("\n");
  } else {
    indicator = "|+";
    const core = value.slice(0, -trailing);
    // keep decoder yields 1 + trailingBlanks newlines; emit trailingBlanks blank lines.
    lines = [...core.split("\n"), ...Array.from({ length: trailing - 1 }, () => "")];
  }
  const indented = lines.map((line) => `  ${line}`).join("\n");
  return `${key}: ${indicator}\n${indented}`;
}

function isPlainYamlString(value: string): boolean {
  try {
    return typeof parseYaml(value) === "string";
  } catch {
    return false;
  }
}

function formatYamlLine(key: string, value: unknown): string {
  if (value === null || value === undefined) return `${key}:`;
  if (typeof value === "string") {
    if (value.includes("\n") || value.includes(": ")) {
      return formatYamlBlockScalar(key, value);
    }
    if (
      value === "" ||
      /[#{}[\],&*?|>!%@`]/.test(value) ||
      value !== value.trim() ||
      value.startsWith('"') ||
      value.startsWith("'") ||
      !isPlainYamlString(value)
    ) {
      return `${key}: ${JSON.stringify(value)}`;
    }
    return `${key}: ${value}`;
  }
  if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number")) {
      return `${key}: [${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
    }
    const items = value
      .map((item) => `  - ${typeof item === "string" ? item : JSON.stringify(item)}`)
      .join("\n");
    return `${key}:\n${items}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${key}:`;
    const nested = entries
      .map(([nestedKey, nestedValue]) => `  ${formatYamlLine(nestedKey, nestedValue)}`)
      .join("\n");
    return `${key}:\n${nested}`;
  }
  return `${key}: ${JSON.stringify(String(value))}`;
}
