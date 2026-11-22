import { ORPCError } from "@orpc/server";
import {
  BUILTIN_AGENT_SKILLS,
  MAX_SKILL_FILES,
  MAX_SKILL_FILES_BYTES,
  renameSkillInRoutines,
  signalRenamedRoutines,
} from "@rakazo/adapters";
import type { Actor, AgentSkill, AgentSkillSource } from "@rakazo/contracts";
import { UpdateAgentSkillInput } from "@rakazo/contracts";
import type { SkillSource } from "@rakazo/core";
import {
  buildSkillMd,
  ClientError,
  findSkillByName,
  isSkillReadOnly,
  mergeBuiltinSkills,
  parseSkillMd,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  AVAILABILITY_SELECT,
  assertNameFreeWhereAvailable,
  availableInSpace,
  IsolationError,
  isUniqueViolation,
  JsonObject,
  Prisma,
  readJsonColumn,
  runAsSystemInTransaction,
  spaceAvailability,
  TransactionConflictError,
  withTransactionRetry,
} from "@rakazo/db";
import { z } from "zod";
import { userAddedAvailability } from "../spaces/name-claims.js";

type AgentSkillRow = {
  id: string;
  spaceId: string;
  allSpaces: boolean;
  availableIn?: Array<{ spaceId: string }>;
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
    availability: spaceAvailability(row),
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
  const content = buildSkillMd({
    name,
    description,
    body,
    frontmatter: priorParsed && !("error" in priorParsed) ? priorParsed.frontmatter : undefined,
  });
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

// Preserve the original keys. A record parser can silently drop "__proto__".
const StoredSkillFiles = z.custom<Record<string, string>>((value) => {
  const parsed = JsonObject.safeParse(value);
  return (
    parsed.success &&
    !Object.hasOwn(parsed.data, "__proto__") &&
    Object.values(parsed.data).every((content) => typeof content === "string")
  );
});

export function createAgentSkillsService(
  prisma: PrismaClient,
  events?: Pick<ThreadEvents, "publishSpaceChange">,
) {
  async function owned(actor: Actor, skillId: string, db: Prisma.TransactionClient = prisma) {
    const row = await db.agentSkill.findFirst({
      where: { id: skillId, ...availableInSpace(actor) },
      omit: { files: true },
      include: { availableIn: AVAILABILITY_SELECT },
    });
    if (!row) throw new IsolationError();
    return row;
  }

  function listAvailableRows(actor: Actor) {
    return prisma.agentSkill.findMany({
      where: availableInSpace(actor),
      omit: { files: true },
      include: { availableIn: AVAILABILITY_SELECT },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  }

  async function updateFile(
    actor: Actor,
    skillId: string,
    file: NonNullable<UpdateAgentSkillInput["file"]>,
  ): Promise<AgentSkill> {
    const where = { id: skillId, ...availableInSpace(actor) };
    return withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        const existing = await tx.agentSkill.findFirst({
          where,
          include: { availableIn: AVAILABILITY_SELECT },
        });
        if (!existing) throw new IsolationError();
        if (existing.source !== "user") {
          throw new ClientError("BAD_REQUEST", "Only personal skills can have files updated.");
        }
        const current =
          existing.files === null
            ? {}
            : readJsonColumn(
                StoredSkillFiles,
                existing.files,
                { table: "agent_skills", column: "files", id: skillId },
                "reject",
              );
        if (Object.hasOwn(current, file.path) && current[file.path] === file.content) {
          return mapAgentSkill(existing);
        }

        const files = { ...current, [file.path]: file.content };
        const contents = Object.values(files);
        if (contents.length > MAX_SKILL_FILES) {
          throw new ClientError(
            "BAD_REQUEST",
            `A skill can have at most ${MAX_SKILL_FILES} files.`,
          );
        }
        if (
          contents.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) >
          MAX_SKILL_FILES_BYTES
        ) {
          throw new ClientError(
            "BAD_REQUEST",
            `Skill files can use at most ${MAX_SKILL_FILES_BYTES} UTF-8 bytes in total.`,
          );
        }

        // Compare the file map itself. Document edits can commit without invalidating this write.
        const updated = await tx.agentSkill.updateMany({
          where: {
            ...where,
            source: "user",
            files: { equals: existing.files ?? Prisma.AnyNull },
          },
          data: { files },
        });
        if (updated.count !== 1) {
          throw new TransactionConflictError("The skill changed while saving its file. Try again.");
        }
        return mapAgentSkill(await owned(actor, skillId, tx));
      }),
    );
  }

  return {
    async list(actor: Actor): Promise<Omit<AgentSkill, "content">[]> {
      const rows = await listAvailableRows(actor);
      return mergeBuiltinSkills(builtinCatalog(), rows.map(mapAgentSkill)).map(
        ({ content: _content, ...entry }) => entry,
      );
    },

    async listWithContent(actor: Actor): Promise<AgentSkill[]> {
      const rows = await listAvailableRows(actor);
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
      const rows = await listAvailableRows(actor);
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
      if (builtinCatalog().some((s) => s.name.toLowerCase() === resolved.name.toLowerCase())) {
        throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
      }
      try {
        const row = await prisma.$transaction(async (tx) => {
          await assertNameFreeWhereAvailable(
            tx,
            "skill",
            actor,
            resolved.name,
            userAddedAvailability(actor),
          );
          return tx.agentSkill.create({
            data: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              name: resolved.name,
              description: resolved.description,
              content: resolved.content,
              source: "user",
              allSpaces: true,
            },
          });
        });
        return mapAgentSkill(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ClientError("CONFLICT", "A skill with that name already exists.");
        }
        throw error;
      }
    },

    async update(actor: Actor, input: UpdateAgentSkillInput): Promise<AgentSkill> {
      if (input.file !== undefined) {
        const validated = UpdateAgentSkillInput.safeParse(input);
        if (!validated.success || !validated.data.file) {
          throw new ClientError(
            "BAD_REQUEST",
            validated.error?.issues[0]?.message ?? "Invalid skill file.",
          );
        }
        return updateFile(actor, validated.data.skillId, validated.data.file);
      }
      const existing = await owned(actor, input.skillId);
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      const resolved = resolveSkillContent({ ...input, prior: existing });
      const renamed = !findSkillByName([existing], resolved.name);
      const previousName = existing.name;
      if (
        renamed &&
        builtinCatalog().some((s) => s.name.toLowerCase() === resolved.name.toLowerCase())
      ) {
        throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
      }
      // Mutate only owner-scoped user rows (never builtin/plugin), even if source was tampered.
      let renamedRoutineSpaces: string[] = [];
      try {
        const updated = await prisma.$transaction(async (tx) => {
          if (renamed)
            await assertNameFreeWhereAvailable(
              tx,
              "skill",
              actor,
              resolved.name,
              spaceAvailability(existing),
              existing.id,
            );
          const result = await tx.agentSkill.updateMany({
            where: {
              id: existing.id,
              ...availableInSpace(actor),
              source: "user",
              // A rename that lost a race must not leave routines pointing at a stale name.
              ...(renamed ? { name: previousName } : {}),
            },
            data: {
              name: resolved.name,
              description: resolved.description,
              content: resolved.content,
            },
          });
          if (result.count === 0 && renamed) {
            throw new ClientError("CONFLICT", "This skill changed. Reload and try again.");
          }
          if (result.count === 1 && renamed) {
            const { allSpaces, spaceIds } = spaceAvailability(existing);
            // The owner's routines in the other spaces the skill is available in sit outside
            // this request's Space, so read them by owner as the name checks do.
            renamedRoutineSpaces = await runAsSystemInTransaction(
              tx,
              "owner's routines in the spaces a renamed skill is available in",
              () =>
                renameSkillInRoutines(
                  tx,
                  { userId: existing.userId, spaceIds: allSpaces ? null : spaceIds },
                  previousName,
                  resolved.name,
                ),
            );
          }
          return result;
        });
        if (updated.count !== 1) throw new IsolationError();
      } catch (error) {
        if (error instanceof IsolationError) throw error;
        if (isUniqueViolation(error)) {
          throw new ClientError("CONFLICT", "A skill with that name already exists.");
        }
        throw error;
      }
      await signalRenamedRoutines(events, renamedRoutineSpaces);
      return mapAgentSkill(await owned(actor, existing.id));
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const existing = await owned(actor, skillId);
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      const deleted = await prisma.agentSkill.deleteMany({
        where: { id: existing.id, ...availableInSpace(actor), source: "user" },
      });
      if (deleted.count !== 1) throw new IsolationError();
      return { ok: true };
    },
  };
}
