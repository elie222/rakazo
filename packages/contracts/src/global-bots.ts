import * as z from "zod";
import { BotAvatarValueSchema } from "./bot-avatar.js";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  ThinkingLevelSchema,
} from "./domain.js";
import { Id, SpacePermission } from "./ids.js";

/** Catalog / connector slug: lowercase, starts with a letter or digit. */
export const CatalogSlug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const GlobalBotSchema = z.object({
  id: Id,
  slug: CatalogSlug,
  name: z.string(),
  title: z.string(),
  description: z.string(),
  instructions: z.string(),
  color: z.string(),
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  thinkingLevel: ThinkingLevelSchema.nullable(),
  disabledBuiltinTools: z.array(z.string()),
  publishedAt: z.string().nullable(),
  connectorIds: z.array(Id),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GlobalBot = z.infer<typeof GlobalBotSchema>;

export const CreateGlobalBotInput = z.object({
  slug: CatalogSlug,
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH),
  title: z.string().trim().max(BOT_TITLE_MAX_LENGTH).default(""),
  description: z.string().trim().max(BOT_DESCRIPTION_MAX_LENGTH).default(""),
  instructions: z.string().trim().max(BOT_INSTRUCTIONS_MAX_LENGTH).default(""),
  color: BotAvatarValueSchema,
  modelProvider: z.string().trim().min(1).max(80).nullable().optional(),
  modelId: z.string().trim().min(1).max(200).nullable().optional(),
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  disabledBuiltinTools: z.array(z.string().trim().min(1).max(120)).default([]),
  /** When true, the bot is published immediately. */
  publish: z.boolean().optional(),
});
export type CreateGlobalBotInput = z.infer<typeof CreateGlobalBotInput>;

export const UpdateGlobalBotInput = z
  .object({
    globalBotId: Id,
    slug: CatalogSlug.optional(),
    name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH).optional(),
    title: z.string().trim().max(BOT_TITLE_MAX_LENGTH).optional(),
    description: z.string().trim().max(BOT_DESCRIPTION_MAX_LENGTH).optional(),
    instructions: z.string().trim().max(BOT_INSTRUCTIONS_MAX_LENGTH).optional(),
    color: BotAvatarValueSchema.optional(),
    modelProvider: z.string().trim().min(1).max(80).nullable().optional(),
    modelId: z.string().trim().min(1).max(200).nullable().optional(),
    thinkingLevel: ThinkingLevelSchema.nullable().optional(),
    disabledBuiltinTools: z.array(z.string().trim().min(1).max(120)).optional(),
  })
  .refine(
    (input) =>
      Object.keys(input).some((key) => key !== "globalBotId" && input[key as keyof typeof input] !== undefined),
    { message: "At least one field to update is required" },
  );
export type UpdateGlobalBotInput = z.infer<typeof UpdateGlobalBotInput>;

export const PublishGlobalBotInput = z.object({
  globalBotId: Id,
  published: z.boolean(),
});
export type PublishGlobalBotInput = z.infer<typeof PublishGlobalBotInput>;

export const SetGlobalBotConnectorsInput = z.object({
  globalBotId: Id,
  connectorIds: z.array(Id),
});
export type SetGlobalBotConnectorsInput = z.infer<typeof SetGlobalBotConnectorsInput>;

export const ConnectorSchema = z.object({
  id: Id,
  slug: CatalogSlug,
  name: z.string(),
  description: z.string(),
  skillRefs: z.array(z.string()),
  mcpConfig: z.unknown(),
  version: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Connector = z.infer<typeof ConnectorSchema>;

export const CreateConnectorInput = z.object({
  slug: CatalogSlug,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  skillRefs: z.array(z.string().trim().min(1).max(200)).default([]),
  mcpConfig: z.unknown().optional(),
  version: z.string().trim().min(1).max(40).default("1"),
});
export type CreateConnectorInput = z.infer<typeof CreateConnectorInput>;

export const UpdateConnectorInput = z
  .object({
    connectorId: Id,
    slug: CatalogSlug.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    skillRefs: z.array(z.string().trim().min(1).max(200)).optional(),
    mcpConfig: z.unknown().optional(),
    version: z.string().trim().min(1).max(40).optional(),
  })
  .refine(
    (input) =>
      Object.keys(input).some((key) => key !== "connectorId" && input[key as keyof typeof input] !== undefined),
    { message: "At least one field to update is required" },
  );
export type UpdateConnectorInput = z.infer<typeof UpdateConnectorInput>;

export const SpaceGlobalBotSchema = z.object({
  globalBotId: Id,
  botId: Id.nullable(),
  enabled: z.boolean(),
  enabledAt: z.string().nullable(),
  slug: CatalogSlug,
  name: z.string(),
  title: z.string(),
  description: z.string(),
  color: z.string(),
  publishedAt: z.string().nullable(),
});
export type SpaceGlobalBot = z.infer<typeof SpaceGlobalBotSchema>;

export const SetSpaceGlobalBotEnabledInput = z.object({
  globalBotId: Id,
  enabled: z.boolean(),
});
export type SetSpaceGlobalBotEnabledInput = z.infer<typeof SetSpaceGlobalBotEnabledInput>;

export const SpaceRolePermissionsSchema = z.object({
  role: z.string().trim().min(1).max(40),
  permissions: z.array(SpacePermission),
  /** True when this space stores explicit rows for the role (defaults otherwise). */
  overridden: z.boolean(),
});

export const SpacePermissionsViewSchema = z.object({
  roles: z.array(SpaceRolePermissionsSchema),
});
export type SpacePermissionsView = z.infer<typeof SpacePermissionsViewSchema>;

export const SetSpacePermissionsInput = z.object({
  roles: z.array(
    z.object({
      role: z.string().trim().min(1).max(40),
      /** Empty clears the override so product defaults apply. */
      permissions: z.array(SpacePermission),
    }),
  ),
});
export type SetSpacePermissionsInput = z.infer<typeof SetSpacePermissionsInput>;
