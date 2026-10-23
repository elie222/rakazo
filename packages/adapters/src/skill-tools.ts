import {
  buildSkillMd,
  findSkillByName,
  isSkillReadOnly,
  mergeBuiltinSkills,
  parseSkillMd,
  type SkillRecord,
  type SkillSource,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { lockSpaceForContentCreation } from "@rakazo/db";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";

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
  userId: string;
  name: string;
  description: string;
  content: string;
  source: string;
};

function asSource(value: string): SkillSource {
  if (value === "builtin" || value === "plugin" || value === "user") return value;
  return "user";
}

type SpaceSkillRecord = SkillRecord & { id: string; userId?: string };

function toRecord(row: AgentSkillRow): SpaceSkillRecord {
  const source = asSource(row.source);
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    description: row.description,
    content: row.content,
    source,
    readOnly: isSkillReadOnly(source),
  };
}

function builtinRecords(): Array<SkillRecord & { id: string }> {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin" as const,
    readOnly: true,
  }));
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

/** Skills are the space's: every member's runs see the same set. */
export async function listAgentSkillRecords(
  prisma: PrismaClient,
  space: Pick<SkillOwner, "spaceId">,
): Promise<SpaceSkillRecord[]> {
  const rows = await prisma.agentSkill.findMany({
    where: { spaceId: space.spaceId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return mergeBuiltinSkills(builtinRecords(), rows.map(toRecord));
}

/**
 * The skills a run nobody is watching may expand: builtins and the ones `userId` last wrote.
 * Its instructions then always come from the person whose accounts it uses.
 */
export function skillsRunnableBy<T extends { userId?: string }>(
  skills: readonly T[],
  userId: string,
): T[] {
  return skills.filter((skill) => skill.userId === undefined || skill.userId === userId);
}

/** A user skill in the space with this name, ignoring case; read under the space lock. */
async function spaceSkillNamed(
  tx: Pick<PrismaClient, "agentSkill">,
  spaceId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const clash = await tx.agentSkill.findFirst({
    where: {
      spaceId,
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });
  return clash !== null;
}

async function findOwnedSkill(
  prisma: PrismaClient,
  owner: Pick<SkillOwner, "spaceId">,
  input: { skillId?: string; name?: string },
): Promise<SpaceSkillRecord | null> {
  const skills = await listAgentSkillRecords(prisma, owner);
  if (input.skillId) {
    return skills.find((skill) => skill.id === input.skillId) ?? null;
  }
  if (input.name) return findSkillByName(skills, input.name) ?? null;
  return null;
}

export async function skillReadFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
): Promise<Record<string, unknown>> {
  const skill = await findOwnedSkill(prisma, owner, input);
  if (!skill) return { error: "Skill not found." };
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    readOnly: skill.readOnly,
    content: skill.content,
  };
}

export async function skillCreateFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; description?: string; body?: string; content?: string },
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

  const existing = await findOwnedSkill(prisma, owner, { name });
  if (existing) return { error: `A skill named "${existing.name}" already exists.` };

  try {
    // Names are unique per space: the lock makes the check and the write one step.
    const row = await prisma.$transaction(async (tx) => {
      await lockSpaceForContentCreation(tx, owner);
      if (await spaceSkillNamed(tx, owner.spaceId, name)) return null;
      return tx.agentSkill.create({
        data: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          name,
          description,
          content,
          source: "user",
        },
      });
    });
    if (!row) return { error: `A skill named "${name}" already exists.` };
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
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(prisma, owner, {
    skillId: input.skillId,
    name: input.name,
  });
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
    const clash = await findOwnedSkill(prisma, owner, { name: nextName });
    if (clash && clash.id !== existing.id) {
      return { error: `A skill named "${clash.name}" already exists.` };
    }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      await lockSpaceForContentCreation(tx, owner);
      if (
        nextName.toLowerCase() !== existing.name.toLowerCase() &&
        (await spaceSkillNamed(tx, owner.spaceId, nextName, existing.id))
      ) {
        return null;
      }
      // Re-scope mutate to the space + user source so a stale id cannot cross tenants.
      return tx.agentSkill.updateMany({
        where: {
          id: existing.id,
          spaceId: owner.spaceId,
          source: "user",
        },
        // The editor owns what it now says, so routines run it only on the editor's accounts.
        data: {
          userId: owner.userId,
          name: nextName,
          description: nextDescription,
          content: nextContent,
        },
      });
    });
    if (!updated) return { error: `A skill named "${nextName}" already exists.` };
    if (updated.count !== 1) return { error: "Could not update skill." };
    return { ok: true, id: existing.id, name: nextName, description: nextDescription };
  } catch {
    return { error: "Could not update skill." };
  }
}

export async function skillDeleteFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(prisma, owner, input);
  if (!existing) return { error: "Skill not found." };
  if (existing.readOnly || existing.source !== "user" || existing.id.startsWith("builtin:")) {
    return { error: "Builtin and plugin skills are read-only." };
  }
  const deleted = await prisma.agentSkill.deleteMany({
    where: {
      id: existing.id,
      spaceId: owner.spaceId,
      source: "user",
    },
  });
  if (deleted.count !== 1) return { error: "Could not delete skill." };
  return { ok: true, name: existing.name };
}
