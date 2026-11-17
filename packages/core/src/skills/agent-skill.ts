import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ClientError } from "../primitives/client-error.js";
import { formatForcedSkillPrompt } from "./agent-skill.prompt.js";

/**
 * Skills: reusable how-to recipes written as SKILL.md files.
 * Distinct from taught skills (demo/record playbooks on a single bot).
 */

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MAX_FRONTMATTER_DEPTH = 32;

export type SkillSource = "user" | "builtin" | "plugin";

export type ParsedSkillMd = {
  name: string;
  description: string;
  body: string;
  /**
   * All frontmatter keys as parsed scalars/structures. Unknown keys are preserved
   * so skills with extra fields round-trip safely.
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

const FORCE_SKILL_PREFIX = /^(?:\/|use\s+skill:\s*)([^\n]*)/i;
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
  const name = stringifySkillField(frontmatter.name);
  const description = stringifySkillField(frontmatter.description);
  if (!name) return { error: "SKILL.md frontmatter requires name." };
  if (!description) return { error: "SKILL.md frontmatter requires description." };
  if (name.length > 80) return { error: "Skill name must be at most 80 characters." };
  if (description.length > 2000) {
    return { error: "Skill description must be at most 2000 characters." };
  }
  return { name, description, body, frontmatter };
}

function parseSkillFrontmatter(text: string): unknown {
  text = text.replace(/^(name|description):[ \t]+null[ \t]*$/gm, '$1: "null"');
  const options = { maxAliasCount: 100, stringKeys: true, uniqueKeys: false } as const;
  try {
    const parsed = parseYaml(text, options);
    assertSafeFrontmatter(parsed);
    return parsed;
  } catch (error) {
    let blockIndent: number | undefined;
    const repaired = text
      .split("\n")
      .map((line) => {
        const indent = line.length - line.trimStart().length;
        if (blockIndent !== undefined && (!line.trim() || indent > blockIndent)) return line;
        blockIndent = undefined;
        const colon = line.indexOf(":");
        const header = colon < 0 ? "" : line.slice(colon + 1).trim();
        const comment = header.indexOf("#");
        const separatedComment =
          comment > 0 && (header[comment - 1] === " " || header[comment - 1] === "\t");
        const indicator = separatedComment ? header.slice(0, comment).trimEnd() : header;
        if (/^[>|][1-9+-]*$/.test(indicator)) {
          blockIndent = indent;
          return line;
        }
        const normalized = line.replace(/^[ \t]+/, (prefix) => prefix.replaceAll("\t", "  "));
        return repairUnknownStringEscapes(quoteLegacyColonScalars(repairLegacyFields(normalized)));
      })
      .join("\n");
    if (repaired === text) throw error;
    const parsed = parseYaml(repaired, options);
    assertSafeFrontmatter(parsed);
    return parsed;
  }
}

function repairLegacyFields(text: string): string {
  return text.replace(
    /^(name|description):[ \t]+([^\r\n]+)$/gm,
    (line, key: string, value: string) => {
      if (/^["'>|]/.test(value)) return line;
      try {
        parseYaml(value);
        return line;
      } catch {
        return `${key}: ${JSON.stringify(value)}`;
      }
    },
  );
}

function quoteLegacyColonScalars(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon < 0 || !/^[ \t]*(?:-[ \t]+)?[A-Za-z_][\w-]*$/.test(line.slice(0, colon)))
        return line;
      let start = colon + 1;
      while (line[start] === " " || line[start] === "\t") start++;
      if (start === colon + 1) return line;
      const value = line.slice(start);
      if (/^["'{[|>!&*?]/.test(value) || !/:[ \t]/.test(value)) return line;
      return `${line.slice(0, start)}${JSON.stringify(value)}`;
    })
    .join("\n");
}

function repairUnknownStringEscapes(text: string): string {
  try {
    parseYaml(text);
    return text;
  } catch {
    // Only invalid YAML needs compatibility repair; valid scalars keep literal backslashes.
  }
  const parts: string[] = [];
  let start = 0;
  let quote = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\n" || char === "\r") quote = -1;
    else if (quote >= 0 && char === "\\") index++;
    else if (char === '"') {
      if (quote < 0) quote = index;
      else {
        parts.push(text.slice(start, quote));
        parts.push(
          text
            .slice(quote, index + 1)
            .replace(
              /\\(?:["\\/0abtnvfreN_LP]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})|\\/g,
              (sequence) => (sequence.length === 1 ? `${sequence}${sequence}` : sequence),
            ),
        );
        start = index + 1;
        quote = -1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.join("");
}

function assertSafeFrontmatter(value: unknown): void {
  const ancestors = new Set<object>();
  const checkedDepth = new Map<object, number>();
  const visit = (current: unknown, depth: number) => {
    if (depth > MAX_FRONTMATTER_DEPTH) {
      throw new ClientError("BAD_REQUEST", "SKILL.md frontmatter is nested too deeply.");
    }
    if (current === null || typeof current !== "object") return;
    if (ancestors.has(current)) {
      throw new ClientError(
        "BAD_REQUEST",
        "SKILL.md frontmatter cannot contain recursive YAML aliases.",
      );
    }
    if ((checkedDepth.get(current) ?? -1) >= depth) return;
    checkedDepth.set(current, depth);
    ancestors.add(current);
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      visit(child, depth + 1);
    }
    ancestors.delete(current);
  };
  visit(value, 0);
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
  if (!name) throw new ClientError("BAD_REQUEST", "Skill name is required.");
  if (!description) throw new ClientError("BAD_REQUEST", "Skill description is required.");
  if (name.length > 80) {
    throw new ClientError("BAD_REQUEST", "Skill name must be at most 80 characters.");
  }
  if (description.length > 2000) {
    throw new ClientError("BAD_REQUEST", "Skill description must be at most 2000 characters.");
  }
  const merged: Record<string, unknown> = { ...(input.frontmatter ?? {}) };
  merged.name = name;
  merged.description = description;
  assertSafeFrontmatter(merged);
  // Stable order: name, description, then remaining keys alphabetically.
  const rank = (key: string) => (key === "name" ? 0 : key === "description" ? 1 : 2);
  const keys = Object.keys(merged).sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  const ordered = Object.fromEntries(keys.map((key) => [key, merged[key]]));
  const frontmatter = stringifyYaml(ordered, { indent: 2, lineWidth: 0 }).replace(/\n$/, "");
  const body = input.body.replace(/^\r?\n/, "");
  return `---\n${frontmatter}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
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

function stringifySkillField(value: unknown): string {
  return stringifyScalar(value).trim();
}
