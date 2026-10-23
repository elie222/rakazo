import { ORPCError } from "@orpc/server";
import { BUILTIN_AGENT_SKILLS } from "@rakazo/adapters";
import type { Actor, AgentSkill, AgentSkillSource } from "@rakazo/contracts";
import {
  buildSkillMd,
  findSkillByName,
  isSkillReadOnly,
  mergeBuiltinSkills,
  parseSkillMd,
  type SkillSource,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, lockSpaceForContentCreation } from "@rakazo/db";

type AgentSkillRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
};

function asSource(value: string): AgentSkillSource {
  if (value === "builtin" || value === "plugin" || value === "user") return value;
  return "user";
}

export function mapAgentSkill(row: AgentSkillRow): AgentSkill {
  const source = asSource(row.source);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    source,
    readOnly: isSkillReadOnly(source as SkillSource),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function builtinCatalog(): AgentSkill[] {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin" as const,
    readOnly: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
}

export function resolveSkillContent(input: {
  content?: string;
  name?: string;
  description?: string;
  body?: string;
  prior?: { content: string };
}): { name: string; description: string; content: string } {
  const ensureContentLimit = (content: string): string => {
    if (content.length > 100_000) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Skill content must be at most 100000 characters.",
      });
    }
    return content;
  };

  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) {
      throw new ORPCError("BAD_REQUEST", { message: parsed.error });
    }
    return {
      name: parsed.name,
      description: parsed.description,
      content: ensureContentLimit(buildSkillMd(parsed)),
    };
  }

  const priorParsed = input.prior ? parseSkillMd(input.prior.content) : null;
  if (priorParsed && "error" in priorParsed) {
    throw new ORPCError("BAD_REQUEST", { message: priorParsed.error });
  }

  const name = (input.name ?? priorParsed?.name ?? "").trim();
  const description = (input.description ?? priorParsed?.description ?? "").trim();
  const body = input.body ?? priorParsed?.body ?? "";
  if (!name || !description) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Provide content (SKILL.md) or name + description (+ optional body)",
    });
  }
  let content: string;
  try {
    content = buildSkillMd({
      name,
      description,
      body,
      frontmatter: priorParsed && !("error" in priorParsed) ? priorParsed.frontmatter : undefined,
    });
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Invalid skill fields.",
    });
  }
  const validated = parseSkillMd(content);
  if ("error" in validated) {
    throw new ORPCError("BAD_REQUEST", { message: validated.error });
  }
  return {
    name: validated.name,
    description: validated.description,
    content: ensureContentLimit(buildSkillMd(validated)),
  };
}

/** Skills are the space's: every member's bots see and edit the same set. */
export function createAgentSkillsService(prisma: PrismaClient) {
  async function owned(actor: Actor, skillId: string) {
    const row = await prisma.agentSkill.findFirst({
      where: {
        id: skillId,
        spaceId: actor.spaceId,
      },
    });
    if (!row) throw new IsolationError();
    return row;
  }

  return {
    async list(actor: Actor): Promise<Omit<AgentSkill, "content">[]> {
      const rows = await prisma.agentSkill.findMany({
        where: { spaceId: actor.spaceId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return mergeBuiltinSkills(builtinCatalog(), rows.map(mapAgentSkill)).map(
        ({ content: _content, ...entry }) => entry,
      );
    },

    async listWithContent(actor: Actor): Promise<AgentSkill[]> {
      const rows = await prisma.agentSkill.findMany({
        where: { spaceId: actor.spaceId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return mergeBuiltinSkills(builtinCatalog(), rows.map(mapAgentSkill));
    },

    async get(actor: Actor, input: { skillId?: string; name?: string }): Promise<AgentSkill> {
      if (input.skillId?.startsWith("builtin:")) {
        const builtin = builtinCatalog().find((skill) => skill.id === input.skillId);
        if (!builtin) throw new IsolationError();
        return builtin;
      }
      if (input.skillId) {
        return mapAgentSkill(await owned(actor, input.skillId));
      }
      const name = input.name?.trim() ?? "";
      const rows = await prisma.agentSkill.findMany({
        where: {
          spaceId: actor.spaceId,
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      const row = findSkillByName(rows, name);
      if (row) return mapAgentSkill(row);
      const builtin = findSkillByName(builtinCatalog(), name);
      if (!builtin) throw new IsolationError();
      return builtin;
    },

    async create(
      actor: Actor,
      input: { content?: string; name?: string; description?: string; body?: string },
    ): Promise<AgentSkill> {
      const resolved = resolveSkillContent(input);
      try {
        // Names are unique per space: the lock makes the check and the write one step.
        const row = await prisma.$transaction(async (tx) => {
          await lockSpaceForContentCreation(tx, actor);
          await assertSkillNameFree(tx, actor, resolved.name);
          return tx.agentSkill.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              name: resolved.name,
              description: resolved.description,
              content: resolved.content,
              source: "user",
            },
          });
        });
        return mapAgentSkill(row);
      } catch (error) {
        throw skillNameConflict(error);
      }
    },

    async update(
      actor: Actor,
      input: {
        skillId: string;
        content?: string;
        name?: string;
        description?: string;
        body?: string;
      },
    ): Promise<AgentSkill> {
      const existing = await owned(actor, input.skillId);
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      const resolved = resolveSkillContent({ ...input, prior: existing });
      try {
        await prisma.$transaction(async (tx) => {
          await lockSpaceForContentCreation(tx, actor);
          if (!findSkillByName([existing], resolved.name)) {
            await assertSkillNameFree(tx, actor, resolved.name, existing.id);
          }
          // Mutate only the space's user rows (never builtin/plugin), even if source was tampered.
          const updated = await tx.agentSkill.updateMany({
            where: { id: existing.id, spaceId: actor.spaceId, source: "user" },
            // The editor owns what it now says, so routines run it only on the editor's accounts.
            data: {
              userId: actor.userId,
              name: resolved.name,
              description: resolved.description,
              content: resolved.content,
            },
          });
          if (updated.count !== 1) throw new IsolationError();
        });
      } catch (error) {
        throw skillNameConflict(error);
      }
      const row = await prisma.agentSkill.findFirst({
        where: {
          id: existing.id,
          spaceId: actor.spaceId,
        },
      });
      if (!row) throw new IsolationError();
      return mapAgentSkill(row);
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const existing = await owned(actor, skillId);
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      const deleted = await prisma.agentSkill.deleteMany({
        where: {
          id: existing.id,
          spaceId: actor.spaceId,
          source: "user",
        },
      });
      if (deleted.count !== 1) throw new IsolationError();
      return { ok: true };
    },
  };
}

export type AgentSkillsService = ReturnType<typeof createAgentSkillsService>;

const SKILL_NAME_TAKEN = "A skill with that name already exists.";

async function assertSkillNameFree(
  tx: Pick<PrismaClient, "agentSkill">,
  actor: Actor,
  name: string,
  exceptId?: string,
): Promise<void> {
  const clash = await tx.agentSkill.findFirst({
    where: {
      spaceId: actor.spaceId,
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
  });
  if (clash || builtinCatalog().some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    throw new ORPCError("CONFLICT", { message: SKILL_NAME_TAKEN });
  }
}

function skillNameConflict(error: unknown): unknown {
  if (error instanceof Error && "code" in error && (error as { code?: string }).code === "P2002") {
    return new ORPCError("CONFLICT", { message: SKILL_NAME_TAKEN });
  }
  return error;
}
