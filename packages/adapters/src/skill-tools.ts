import type { SkillRecord, SkillSource } from "@rakazo/core";
import {
  buildSkillMd,
  findSkillByName,
  isSkillReadOnly,
  mergeBuiltinSkills,
  parseSkillMd,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { availableInSpace } from "@rakazo/db";
import { BUILTIN_AGENT_SKILLS, CURSOR_CLI_SKILL } from "./builtin-skills.js";
import { userHasCloudAgentCredential } from "./cloud-agent-credentials.js";

export const SKILL_TOOL_NAMES = new Set([
  "skill_read",
  "skill_create",
  "skill_update",
  "skill_delete",
]);

/** Match CreateAgentSkillInput / UpdateAgentSkillInput / parseSkillMd bounds. */
const MAX_SKILL_CONTENT_CHARS = 100_000;
const MAX_SKILL_NAME_CHARS = 80;
const MAX_SKILL_DESCRIPTION_CHARS = 2000;

type SkillOwner = {
  spaceId: string;
  userId: string;
};

type AgentSkillRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
};

function asSource(value: string): SkillSource {
  if (value === "builtin" || value === "plugin" || value === "user") return value;
  return "user";
}

function toRecord(row: AgentSkillRow): SkillRecord & { id: string } {
  const source = asSource(row.source);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    source,
    readOnly: isSkillReadOnly(source),
  };
}

export type AgentSkillCatalogOptions = {
  /** When set, a saved key for this provider adds the computer CLI skill. */
  cloudAgentProviderId?: string;
};

function skillRecord(skill: {
  name: string;
  description: string;
  content: string;
}): SkillRecord & { id: string } {
  return {
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin",
    readOnly: true,
  };
}

function builtinRecords(includeCursorCli: boolean): Array<SkillRecord & { id: string }> {
  const skills = includeCursorCli
    ? [...BUILTIN_AGENT_SKILLS, CURSOR_CLI_SKILL]
    : BUILTIN_AGENT_SKILLS;
  return skills.map(skillRecord);
}

/** The computer CLI skill name is reserved even while that skill is hidden. */
function reservedSkillName(name: string): boolean {
  return Boolean(findSkillByName([CURSOR_CLI_SKILL], name));
}

function rejectOversizedContent(content: string): string | undefined {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `Skill content must be at most ${MAX_SKILL_CONTENT_CHARS} characters.`;
  }
  return undefined;
}

function rejectInvalidSkillFields(name: string, description: string): string | undefined {
  if (!name) return "Skill name is required.";
  if (!description) return "Skill description is required.";
  if (name.length > MAX_SKILL_NAME_CHARS) {
    return `Skill name must be at most ${MAX_SKILL_NAME_CHARS} characters.`;
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return `Skill description must be at most ${MAX_SKILL_DESCRIPTION_CHARS} characters.`;
  }
  return undefined;
}

/**
 * A bot changes only skills that live in its own space alone: writing this space's details into
 * a skill other spaces read would carry them across the boundary.
 */
function onlyInSpace(owner: SkillOwner) {
  return {
    spaceId: owner.spaceId,
    userId: owner.userId,
    allSpaces: false,
    availableIn: { none: {} },
  };
}

const SHARED_SKILL_ERROR =
  "Could not change this skill. A skill available in other spaces can only be changed by the user.";

export async function listAgentSkillRecords(
  prisma: PrismaClient,
  owner: SkillOwner,
  options?: AgentSkillCatalogOptions,
): Promise<Array<SkillRecord & { id: string }>> {
  const rows = await prisma.agentSkill.findMany({
    where: availableInSpace(owner),
    // Reference files are read one at a time through skill_read, never with the catalog.
    omit: { files: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const includeCursorCli = await userHasCloudAgentCredential(
    prisma,
    owner.userId,
    options?.cloudAgentProviderId,
  );
  return mergeBuiltinSkills(builtinRecords(includeCursorCli), rows.map(toRecord));
}

async function findOwnedSkill(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { skillId?: string; name?: string },
  options?: AgentSkillCatalogOptions,
): Promise<(SkillRecord & { id: string }) | null> {
  const skills = await listAgentSkillRecords(prisma, owner, options);
  if (input.skillId) {
    return skills.find((skill) => skill.id === input.skillId) ?? null;
  }
  if (input.name) return findSkillByName(skills, input.name) ?? null;
  return null;
}

/** The text files stored beside a skill's SKILL.md, keyed by relative path. */
export function skillFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export async function skillReadFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; skillId?: string; file?: string },
  options?: AgentSkillCatalogOptions,
): Promise<Record<string, unknown>> {
  const skill = await findOwnedSkill(prisma, owner, input, options);
  if (!skill) return { error: "Skill not found." };
  const row = skill.id.startsWith("builtin:")
    ? null
    : await prisma.agentSkill.findFirst({
        where: { id: skill.id, ...availableInSpace(owner) },
        select: { files: true },
      });
  const files = skillFiles(row?.files);
  const paths = Object.keys(files).sort();
  const wanted = input.file?.trim().replace(/^\.\//, "");
  if (wanted) {
    // Only exact stored paths resolve, so no path can reach outside the skill.
    const text = files[wanted];
    if (text === undefined) return { error: `No file "${wanted}" in this skill.`, files: paths };
    return { name: skill.name, file: wanted, content: text };
  }
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    readOnly: skill.readOnly,
    content: skill.content,
    ...(paths.length ? { files: paths } : {}),
  };
}

export async function skillCreateFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; description?: string; body?: string; content?: string },
  options?: AgentSkillCatalogOptions,
): Promise<Record<string, unknown>> {
  let name = "";
  let description = "";
  let content = "";
  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    name = parsed.name;
    description = parsed.description;
    content = buildSkillMd(parsed);
  } else {
    name = String(input.name ?? "").trim();
    description = String(input.description ?? "").trim();
    const body = String(input.body ?? "").trim();
    if (!name || !description) {
      return {
        error: "Provide name and description (and optional body), or full SKILL.md content.",
      };
    }
    const invalid = rejectInvalidSkillFields(name, description);
    if (invalid) return { error: invalid };
    content = buildSkillMd({ name, description, body });
  }

  const oversized = rejectOversizedContent(content);
  if (oversized) return { error: oversized };

  if (reservedSkillName(name)) return { error: `A skill named "${name}" already exists.` };
  const existing = await findOwnedSkill(prisma, owner, { name }, options);
  if (existing) return { error: `A skill named "${existing.name}" already exists.` };

  try {
    const row = await prisma.agentSkill.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name,
        description,
        content,
        source: "user",
      },
    });
    return {
      ok: true,
      id: row.id,
      name: row.name,
      description: row.description,
      hint: `Created skill. Mention /${row.name} so the user can open it.`,
    };
  } catch {
    return { error: "Could not create skill (name may already exist)." };
  }
}

export async function skillUpdateFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: {
    name?: string;
    skillId?: string;
    newName?: string;
    description?: string;
    body?: string;
    content?: string;
  },
  options?: AgentSkillCatalogOptions,
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(
    prisma,
    owner,
    {
      skillId: input.skillId,
      name: input.name,
    },
    options,
  );
  if (!existing) return { error: "Skill not found." };
  if (existing.readOnly || existing.source !== "user" || existing.id.startsWith("builtin:")) {
    return { error: "Builtin and plugin skills are read-only." };
  }

  let nextContent = existing.content;
  let nextName = existing.name;
  let nextDescription = existing.description;

  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    nextName = parsed.name;
    nextDescription = parsed.description;
    nextContent = buildSkillMd(parsed);
  } else {
    const prior = parseSkillMd(existing.content);
    if ("error" in prior) return { error: prior.error };
    // `name` is only a lookup key (see findOwnedSkill above); renames require `newName`.
    nextName = String(input.newName ?? existing.name).trim() || existing.name;
    nextDescription =
      input.description !== undefined ? String(input.description).trim() : existing.description;
    const body = input.body !== undefined ? String(input.body) : prior.body;
    const invalidFields = rejectInvalidSkillFields(nextName, nextDescription);
    if (invalidFields) return { error: invalidFields };
    nextContent = buildSkillMd({
      name: nextName,
      description: nextDescription,
      body,
      frontmatter: prior.frontmatter,
    });
  }

  const invalid = rejectInvalidSkillFields(nextName, nextDescription);
  if (invalid) return { error: invalid };
  const oversized = rejectOversizedContent(nextContent);
  if (oversized) return { error: oversized };

  if (nextName.toLowerCase() !== existing.name.toLowerCase()) {
    if (reservedSkillName(nextName))
      return { error: `A skill named "${nextName}" already exists.` };
    const clash = await findOwnedSkill(prisma, owner, { name: nextName }, options);
    if (clash && clash.id !== existing.id) {
      return { error: `A skill named "${clash.name}" already exists.` };
    }
  }

  try {
    // Re-scope mutate to owner + user source so a stale id cannot cross tenants.
    const updated = await prisma.agentSkill.updateMany({
      where: { id: existing.id, ...onlyInSpace(owner), source: "user" },
      data: {
        name: nextName,
        description: nextDescription,
        content: nextContent,
      },
    });
    if (updated.count !== 1) return { error: SHARED_SKILL_ERROR };
    return { ok: true, id: existing.id, name: nextName, description: nextDescription };
  } catch {
    return { error: "Could not update skill." };
  }
}

export async function skillDeleteFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
  options?: AgentSkillCatalogOptions,
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(prisma, owner, input, options);
  if (!existing) return { error: "Skill not found." };
  if (existing.readOnly || existing.source !== "user" || existing.id.startsWith("builtin:")) {
    return { error: "Builtin and plugin skills are read-only." };
  }
  const deleted = await prisma.agentSkill.deleteMany({
    where: { id: existing.id, ...onlyInSpace(owner), source: "user" },
  });
  if (deleted.count !== 1) return { error: SHARED_SKILL_ERROR };
  return { ok: true, name: existing.name };
}
