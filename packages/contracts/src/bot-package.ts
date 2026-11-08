import * as z from "zod";
import { BotAvatarValueSchema } from "./bot-avatar.js";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  TimeZoneSchema,
} from "./domain.js";
import { Id } from "./ids.js";

/** Bot titles are not a concept in this fork; packages keep the field so they stay portable. */
const BOT_PACKAGE_TITLE_MAX_LENGTH = 500;

export const BOT_PACKAGE_FORMAT = "coginebot.package/v1";
export const BOT_PACKAGE_MAX_BYTES = 4 * 1024 * 1024;
export const BOT_PACKAGE_MAX_SKILLS = 200;
export const BOT_PACKAGE_MAX_ROUTINES = 50;
export const BOT_PACKAGE_MAX_CONNECTIONS = 30;
export const BOT_PACKAGE_MAX_MEMORY_FILES = 100;
export const BOT_PACKAGE_MEMORY_FILE_MAX_BYTES = 256 * 1024;
export const BOT_PACKAGE_MEMORY_MAX_BYTES = 1024 * 1024;
export const BotPackageNonceSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("\0"));

export function botPackageUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export const BotPackageProfileSchema = z.object({
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH),
  title: z.string().max(BOT_PACKAGE_TITLE_MAX_LENGTH).default(""),
  description: z.string().max(BOT_DESCRIPTION_MAX_LENGTH).default(""),
  instructions: z.string().max(BOT_INSTRUCTIONS_MAX_LENGTH).default(""),
  color: BotAvatarValueSchema.optional(),
});

export const BotPackageSkillSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().min(1).max(2000),
  content: z
    .string()
    .min(1)
    .max(100_000)
    .refine((value) => botPackageUtf8Bytes(value) <= 100_000, "Skill is too large"),
});

export const BotPackageRoutineSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().min(1).max(20_000),
  crons: z.array(z.string().min(1).max(256)).min(1).max(50),
  timezone: TimeZoneSchema,
});

export const BotPackageConnectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  note: z.string().max(2000).default(""),
});

export const BotPackageMemorySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(200)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
        !value.includes("\\") &&
        !Array.from(value).some(
          (char) =>
            char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
        ) &&
        value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      "Use a relative memory path",
    ),
  content: z
    .string()
    .refine(
      (value) => botPackageUtf8Bytes(value) <= BOT_PACKAGE_MEMORY_FILE_MAX_BYTES,
      "Memory note is too large",
    ),
});

export const BotPackageDocumentSchema = z.object({
  format: z.literal(BOT_PACKAGE_FORMAT),
  profile: BotPackageProfileSchema,
  skills: z.array(BotPackageSkillSchema).max(BOT_PACKAGE_MAX_SKILLS).default([]),
  routines: z.array(BotPackageRoutineSchema).max(BOT_PACKAGE_MAX_ROUTINES).default([]),
  connections: z.array(BotPackageConnectionSchema).max(BOT_PACKAGE_MAX_CONNECTIONS).default([]),
  memory: z.array(BotPackageMemorySchema).max(BOT_PACKAGE_MAX_MEMORY_FILES).default([]),
});
export type BotPackageDocument = z.infer<typeof BotPackageDocumentSchema>;

export const BotPackageLeftOutSchema = z.object({
  kind: z.enum([
    "instructions",
    "skill",
    "routine",
    "connection",
    "memory",
    "secrets",
    "unsupported",
  ]),
  name: z.string().max(200),
  reason: z.string().max(500),
});
export type BotPackageLeftOut = z.infer<typeof BotPackageLeftOutSchema>;

export const BotPackagePreviewInput = z.object({
  source: z.string().min(1).max(BOT_PACKAGE_MAX_BYTES),
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH).optional(),
  includeMemory: z.boolean().default(false),
});
export type BotPackagePreviewInput = z.infer<typeof BotPackagePreviewInput>;

export const BotPackagePreviewSchema = z.object({
  previewToken: z.string().min(1).max(200),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string(),
  sourceFormat: z.enum([BOT_PACKAGE_FORMAT, "openmaus.grok/1", "grokbot-bundle/v1"]),
  includeMemory: z.boolean(),
  availableMemoryCount: z.number().int().nonnegative(),
  document: BotPackageDocumentSchema,
  leftOut: z.array(BotPackageLeftOutSchema),
});
export type BotPackagePreview = z.infer<typeof BotPackagePreviewSchema>;

export const BotPackageImportInput = z.object({
  previewToken: z.string().min(1).max(200),
  clientNonce: BotPackageNonceSchema,
});
export type BotPackageImportInput = z.infer<typeof BotPackageImportInput>;

export const BotPackageSkillReceiptSchema = BotPackageSkillSchema.omit({ content: true }).extend({
  id: Id,
  key: z.string(),
  status: z.enum(["pending", "activated", "removed"]),
  revision: z.number().int().positive(),
  skillId: Id.nullable(),
  content: z.string().nullable(),
});
export type BotPackageSkillReceipt = z.infer<typeof BotPackageSkillReceiptSchema>;

export const BotPackageReceiptSchema = z.object({
  importId: Id,
  clientNonce: z.string(),
  digest: z.string(),
  status: z.enum(["importing", "completed", "failed", "cancelled", "removed"]),
  revision: z.number().int().positive(),
  botId: Id.nullable(),
  botName: z.string(),
  createdAt: z.string(),
  skills: z.array(BotPackageSkillReceiptSchema),
  connections: z.array(BotPackageConnectionSchema.extend({ id: Id, key: z.string() })),
  leftOut: z.array(BotPackageLeftOutSchema),
});
export type BotPackageReceipt = z.infer<typeof BotPackageReceiptSchema>;

export const BotPackageRecentReceiptSchema = BotPackageReceiptSchema.pick({
  importId: true,
  clientNonce: true,
  status: true,
  revision: true,
  botId: true,
  botName: true,
  createdAt: true,
}).extend({
  skillCount: z.number().int().nonnegative(),
  connectionCount: z.number().int().nonnegative(),
});
export type BotPackageRecentReceipt = z.infer<typeof BotPackageRecentReceiptSchema>;

export const BotPackageActivateSkillInput = z.object({
  componentId: Id,
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(80).optional(),
});
export type BotPackageActivateSkillInput = z.infer<typeof BotPackageActivateSkillInput>;

export const BotPackageExportInput = z.object({
  botId: Id,
  skillIds: z.array(Id).max(BOT_PACKAGE_MAX_SKILLS).default([]),
  includeMemory: z.boolean().default(false),
});
export type BotPackageExportInput = z.infer<typeof BotPackageExportInput>;

export const BotPackageExportSchema = z.object({
  document: BotPackageDocumentSchema,
  json: z.string(),
  filename: z.string(),
  leftOut: z.array(BotPackageLeftOutSchema),
});
export type BotPackageExport = z.infer<typeof BotPackageExportSchema>;
