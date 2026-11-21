import type { SkillRecord, SkillSource } from "@rakazo/core";
import {
  buildSkillMd,
  findSkillByName,
  isSkillReadOnly,
  mergeBuiltinSkills,
  parseSkillMd,
  renameRoutineSkillMentions,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  AVAILABILITY_SELECT,
  assertNameFreeWhereAvailable,
  availableInSpace,
  lockOwner,
  NameTakenError,
  runAsSystemInTransaction,
  spaceAvailability,
} from "@rakazo/db";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.prompt.js";

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

export function builtinAgentSkillRecords(): Array<SkillRecord & { id: string }> {
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

/**
 * Points the owner's routines that mention a skill as `@old` at its new name. Run it in the
 * transaction that renames the skill. Only routines in the spaces the skill is available in
 * change (every space when `spaceIds` is null), since only those can read it. Returns the
 * spaces whose routines changed, to signal once the transaction commits.
 */
export async function renameSkillInRoutines(
  db: Pick<Prisma.TransactionClient, "agentSkill" | "routine">,
  scope: { userId: string; spaceIds: string[] | null },
  from: string,
  to: string,
): Promise<string[]> {
  if (from.toLowerCase() === to.toLowerCase()) return [];
  const routines = await db.routine.findMany({
    where: {
      userId: scope.userId,
      ...(scope.spaceIds ? { spaceId: { in: scope.spaceIds } } : {}),
      prompt: { contains: `@${from}`, mode: "insensitive" },
    },
    select: { id: true, spaceId: true, prompt: true },
  });
  if (routines.length === 0) return [];
  // Every name stays in the map so `@garden tools` is never read as `@garden`.
  const others = await db.agentSkill.findMany({
    where: { userId: scope.userId },
    select: { name: true },
  });
  const renames = new Map<string, string>([
    ...BUILTIN_AGENT_SKILLS.map((skill): [string, string] => [skill.name, skill.name]),
    ...others.map((skill): [string, string] => [skill.name, skill.name]),
    [from, to],
  ]);
  const changed = new Set<string>();
  for (const routine of routines) {
    const prompt = renameRoutineSkillMentions(routine.prompt, renames);
    if (prompt === routine.prompt) continue;
    // A prompt edited since the read is left alone rather than overwritten.
    const { count } = await db.routine.updateMany({
      where: { id: routine.id, prompt: routine.prompt },
      data: { prompt },
    });
    if (count > 0) changed.add(routine.spaceId);
  }
  return [...changed];
}

/** Tells clients showing routines that a rename changed them; call after the commit. */
export async function signalRenamedRoutines(
  events: Pick<ThreadEvents, "publishSpaceChange"> | undefined,
  spaceIds: readonly string[],
): Promise<void> {
  for (const spaceId of spaceIds) await events?.publishSpaceChange?.(spaceId, "routines");
}

export async function listAgentSkillRecords(
  prisma: PrismaClient,
  owner: SkillOwner,
): Promise<Array<SkillRecord & { id: string }>> {
  const rows = await prisma.agentSkill.findMany({
    where: availableInSpace(owner),
    // Reference files are read one at a time through skill_read, never with the catalog.
    omit: { files: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return mergeBuiltinSkills(builtinAgentSkillRecords(), rows.map(toRecord));
}

async function findOwnedSkill(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { skillId?: string; name?: string },
): Promise<(SkillRecord & { id: string }) | null> {
  const skills = await listAgentSkillRecords(prisma, owner);
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
): Promise<Record<string, unknown>> {
  const skill = await findOwnedSkill(prisma, owner, input);
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
  events?: Pick<ThreadEvents, "publishSpaceChange">,
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

  const renamed = nextName !== existing.name;
  if (nextName.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await findOwnedSkill(prisma, owner, { name: nextName });
    if (clash && clash.id !== existing.id) {
      return { error: `A skill named "${clash.name}" already exists.` };
    }
  }

  try {
    // Re-scope mutate to owner + user source so a stale id cannot cross tenants.
    const changed = await prisma.$transaction(async (tx) => {
      // Held before the read, so a change to where the skill is available can't slip in between.
      if (renamed) await lockOwner(tx, owner.userId, "names:skill");
      const row = await tx.agentSkill.findFirst({
        where: { id: existing.id, ...availableInSpace(owner) },
        select: { spaceId: true, allSpaces: true, availableIn: AVAILABILITY_SELECT },
      });
      if (!row) return null;
      const availability = spaceAvailability(row);
      if (nextName.toLowerCase() !== existing.name.toLowerCase()) {
        await assertNameFreeWhereAvailable(tx, "skill", owner, nextName, availability, existing.id);
      }
      const updated = await tx.agentSkill.updateMany({
        where: {
          id: existing.id,
          ...availableInSpace(owner),
          source: "user",
          // A rename that lost a race must not leave routines pointing at a stale name.
          ...(renamed ? { name: existing.name } : {}),
        },
        data: {
          name: nextName,
          description: nextDescription,
          content: nextContent,
        },
      });
      if (updated.count !== 1) return null;
      if (!renamed) return [];
      // The owner's routines in the other spaces the skill is available in sit outside this run's
      // space, so read them by owner as the settings screen does.
      return runAsSystemInTransaction(
        tx,
        "owner's routines in the spaces a renamed skill is available in",
        () =>
          renameSkillInRoutines(
            tx,
            {
              userId: owner.userId,
              spaceIds: availability.allSpaces ? null : availability.spaceIds,
            },
            existing.name,
            nextName,
          ),
      );
    });
    if (!changed)
      return { error: "Could not update skill. It may have changed; read it and try again." };
    await signalRenamedRoutines(events, changed);
    return { ok: true, id: existing.id, name: nextName, description: nextDescription };
  } catch (error) {
    if (error instanceof NameTakenError) return { error: error.message };
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
    where: { id: existing.id, ...availableInSpace(owner), source: "user" },
  });
  if (deleted.count !== 1) return { error: "Skill not found." };
  return { ok: true, name: existing.name };
}
