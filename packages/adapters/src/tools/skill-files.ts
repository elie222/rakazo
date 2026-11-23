import type { PrismaClient } from "@rakazo/db";
import {
  availableInSpace,
  JsonObject,
  Prisma,
  readJsonColumn,
  TransactionConflictError,
  withTransactionRetry,
} from "@rakazo/db";
import { z } from "zod";
import { MAX_SKILL_FILES, MAX_SKILL_FILES_BYTES } from "../integrations/plugin-connectors.js";

/** One reference file stored beside a skill's SKILL.md. */
export type SkillFile = { path: string; content: string };

type SkillScope = { spaceId: string; userId: string };

/**
 * Why a skill's files were not changed. `missing` covers a skill the caller cannot reach and a
 * file the skill does not have, so the answer never says whether either exists elsewhere.
 */
export type SkillFileRefusal = "missing" | "read-only" | "limit";

export class SkillFileError extends Error {
  constructor(
    readonly refusal: SkillFileRefusal,
    message: string,
  ) {
    super(message);
    this.name = "SkillFileError";
  }
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

function storedSkillFiles(value: Prisma.JsonValue, skillId: string): Record<string, string> {
  if (value === null) return {};
  return readJsonColumn(
    StoredSkillFiles,
    value,
    { table: "agent_skills", column: "files", id: skillId },
    "reject",
  );
}

/** The limit a skill's whole file map breaks, or undefined when it fits. */
export function skillFilesLimitError(files: Record<string, string>): string | undefined {
  const contents = Object.values(files);
  if (contents.length > MAX_SKILL_FILES) {
    return `A skill can have at most ${MAX_SKILL_FILES} files.`;
  }
  const bytes = contents.reduce((total, text) => total + Buffer.byteLength(text), 0);
  if (bytes > MAX_SKILL_FILES_BYTES) {
    return `Skill files can use at most ${MAX_SKILL_FILES_BYTES} UTF-8 bytes in total.`;
  }
  return undefined;
}

/**
 * The files of a skill the owner can use in this space, keyed by path, or undefined when the
 * skill is out of reach. Personal and plugin skills both keep their files here.
 */
export async function readSkillFiles(
  prisma: PrismaClient,
  scope: SkillScope,
  skillId: string,
): Promise<Record<string, string> | undefined> {
  const row = await prisma.agentSkill.findFirst({
    where: { id: skillId, ...availableInSpace(scope) },
    select: { files: true },
  });
  return row ? storedSkillFiles(row.files, skillId) : undefined;
}

/**
 * Change the file map of a personal skill. `change` returns the next map, or undefined to leave
 * it as it is. The write compares only the file map, so parallel changes to different files all
 * survive and a document edit never invalidates one.
 */
async function changeSkillFiles(
  prisma: PrismaClient,
  scope: SkillScope,
  skillId: string,
  change: (current: Record<string, string>) => Record<string, string> | undefined,
): Promise<void> {
  const where = { id: skillId, ...availableInSpace(scope) };
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.agentSkill.findFirst({
        where,
        select: { source: true, files: true },
      });
      if (!existing) throw new SkillFileError("missing", "Skill not found.");
      if (existing.source !== "user") {
        throw new SkillFileError("read-only", "Only personal skills can have files updated.");
      }
      const files = change(storedSkillFiles(existing.files, skillId));
      if (!files) return;
      const updated = await tx.agentSkill.updateMany({
        where: { ...where, source: "user", files: { equals: existing.files ?? Prisma.AnyNull } },
        data: { files },
      });
      if (updated.count !== 1) {
        throw new TransactionConflictError("The skill changed while saving its files. Try again.");
      }
    }),
  );
}

/**
 * Add or replace one file of a personal skill. The path and text must already be validated
 * (AgentSkillFileInput). Other files and the SKILL.md stay as they are, and repeating an
 * identical write changes nothing.
 */
export async function writeSkillFile(
  prisma: PrismaClient,
  scope: SkillScope,
  skillId: string,
  file: SkillFile,
): Promise<void> {
  await changeSkillFiles(prisma, scope, skillId, (current) => {
    if (Object.hasOwn(current, file.path) && current[file.path] === file.content) return undefined;
    const files = { ...current, [file.path]: file.content };
    const tooMuch = skillFilesLimitError(files);
    if (tooMuch) throw new SkillFileError("limit", tooMuch);
    return files;
  });
}

/** Remove one file of a personal skill, keeping its other files and the SKILL.md. */
export async function removeSkillFile(
  prisma: PrismaClient,
  scope: SkillScope,
  skillId: string,
  path: string,
): Promise<void> {
  await changeSkillFiles(prisma, scope, skillId, (current) => {
    if (!Object.hasOwn(current, path)) {
      throw new SkillFileError("missing", `No file "${path}" in this skill.`);
    }
    const { [path]: _removed, ...rest } = current;
    return rest;
  });
}
