import * as z from "zod";
import { SpaceAvailabilitySchema } from "../account/space-availability.js";
import { Id } from "../ids.js";

export const AgentSkillSourceSchema = z.enum(["user", "builtin", "plugin"]);
export type AgentSkillSource = z.infer<typeof AgentSkillSourceSchema>;

export const AvailabilityKindSchema = z.enum(["skill", "mcpServer", "install"]);
export type AvailabilityKind = z.infer<typeof AvailabilityKindSchema>;

/** One of the user's own items, across all their spaces, for choosing what a space can use. */
export const AccountItemSchema = z.object({
  kind: AvailabilityKindSchema,
  id: Id,
  name: z.string(),
  availability: SpaceAvailabilitySchema,
});
export type AccountItem = z.infer<typeof AccountItemSchema>;

export const AgentSkillSchema = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  content: z.string(),
  source: AgentSkillSourceSchema,
  readOnly: z.boolean(),
  /** Absent for built-in skills, which every space has. */
  availability: SpaceAvailabilitySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentSkill = z.infer<typeof AgentSkillSchema>;

export const AgentSkillCatalogEntrySchema = AgentSkillSchema.pick({
  id: true,
  name: true,
  description: true,
  source: true,
  readOnly: true,
  availability: true,
});
export type AgentSkillCatalogEntry = z.infer<typeof AgentSkillCatalogEntrySchema>;

export const CreateAgentSkillInput = z
  .object({
    content: z.string().min(1).max(100_000).optional(),
    name: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(2000).optional(),
    body: z.string().max(100_000).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.content?.trim()) return;
    if (!input.name?.trim() || !input.description?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Provide content (SKILL.md) or name + description (+ optional body)",
        path: ["content"],
      });
    }
  });

const MAX_SKILL_FILE_PATH_LENGTH = 240;
const MAX_SKILL_FILE_BYTES = 100_000;

const AgentSkillFileInput = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(MAX_SKILL_FILE_PATH_LENGTH, { abort: true })
    .refine(
      (path) =>
        !/[\\:%?#\p{Cc}\p{Cs}]/u.test(path) &&
        !Object.hasOwn(Object.prototype, path) &&
        path.toLowerCase() !== "skill.md" &&
        path
          .split("/")
          .every(
            (segment) =>
              segment !== "" && segment !== "." && segment !== ".." && segment === segment.trim(),
          ),
      "Use a relative file path within the skill.",
    ),
  content: z
    .string()
    .max(MAX_SKILL_FILE_BYTES, { abort: true })
    .refine(
      (content) => !/(?![\t\n\r])[\p{Cc}\p{Cs}]/u.test(content),
      "Skill files must contain plain text.",
    )
    .refine(
      (content) => new TextEncoder().encode(content).byteLength <= MAX_SKILL_FILE_BYTES,
      `Skill files must be at most ${MAX_SKILL_FILE_BYTES} UTF-8 bytes each.`,
    ),
});

export const UpdateAgentSkillInput = z
  .object({
    skillId: Id,
    content: z.string().min(1).max(100_000).optional(),
    name: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(2000).optional(),
    body: z.string().max(100_000).optional(),
    /** Add or replace one reference file. Keep document edits in a separate request. */
    file: AgentSkillFileInput.optional(),
  })
  .superRefine((input, ctx) => {
    const editsDocument =
      input.content !== undefined ||
      input.name !== undefined ||
      input.description !== undefined ||
      input.body !== undefined;
    if (input.file && editsDocument) {
      ctx.addIssue({
        code: "custom",
        message: "Update the skill file separately from the skill document.",
        path: ["file"],
      });
    }
    if (!input.file && !editsDocument) {
      ctx.addIssue({
        code: "custom",
        message: "Provide at least one field to update",
        path: ["content"],
      });
    }
  });
export type UpdateAgentSkillInput = z.infer<typeof UpdateAgentSkillInput>;
