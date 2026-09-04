import * as z from "zod";
import { ThreadMessageSchema } from "./events.js";
import { Id, MemoryScope, RunStatus, SandboxKind } from "./ids.js";
import { McpHeadersSchema, McpRemoteEndpointSchema, McpTransportSchema } from "./mcp.js";

export const ComputerModeSchema = z.enum(["team", "dedicated"]);
export type ComputerMode = z.infer<typeof ComputerModeSchema>;

export const MemoryScopeSchema = z.enum(["isolated", "shared"]);
export type MemoryScopeValue = z.infer<typeof MemoryScopeSchema>;

export const AvatarStyleSchema = z.enum(["robot", "organic"]);
export type AvatarStyle = z.infer<typeof AvatarStyleSchema>;

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const BotSchema = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  title: z.string(),
  description: z.string(),
  instructions: z.string(),
  color: z.string(),
  notifyOnFinish: z.boolean(),
  pinned: z.boolean(),
  sectionId: Id.nullable(),
  archivedAt: z.string().nullable(),
  unread: z.boolean(),
  parentBotId: Id.nullable(),
  memoryScope: MemoryScopeSchema.nullable(),
  threadId: Id,
  preview: z.string(),
  status: z.string(),
  computerMode: ComputerModeSchema,
  updatedAt: z.string(),
  createdAt: z.string(),
  voiceId: z.string().nullable(),
  autoSpeak: z.boolean(),
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  thinkingLevel: ThinkingLevelSchema.nullable(),
  webhookConfigured: z.boolean(),
});
export type Bot = z.infer<typeof BotSchema>;

export const ReorderBotsInput = z.object({
  botIds: z
    .array(Id)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, { error: "botIds must be distinct" }),
});
export type ReorderBotsInput = z.infer<typeof ReorderBotsInput>;

export const GroupMemberSchema = z.object({
  botId: Id,
  name: z.string(),
  color: z.string(),
  status: z.string().optional(),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const GROUP_MEMBER_MIN = 2;
export const GROUP_MEMBER_MAX = 6;

export const GroupSchema = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  pinned: z.boolean(),
  sectionId: Id.nullable(),
  archivedAt: z.string().nullable(),
  members: z.array(GroupMemberSchema),
  threadId: Id,
  preview: z.string(),
  unread: z.boolean(),
  updatedAt: z.string(),
  createdAt: z.string(),
});
export type Group = z.infer<typeof GroupSchema>;

const GroupBotIds = z
  .array(Id)
  .min(GROUP_MEMBER_MIN)
  .max(GROUP_MEMBER_MAX)
  .refine((ids) => new Set(ids).size === ids.length, { error: "botIds must be distinct" });

export const CreateGroupInput = z.object({
  name: z.string().trim().min(1).max(80),
  botIds: GroupBotIds,
});
export type CreateGroupInput = z.infer<typeof CreateGroupInput>;

export const UpdateGroupInput = z.object({
  groupId: Id,
  name: z.string().trim().min(1).max(80).optional(),
  botIds: GroupBotIds.optional(),
  pinned: z.boolean().optional(),
  sectionId: Id.nullable().optional(),
});
export type UpdateGroupInput = z.infer<typeof UpdateGroupInput>;

export const GroupDetailSchema = GroupSchema.extend({
  messages: z.array(ThreadMessageSchema).optional(),
});
export type GroupDetail = z.infer<typeof GroupDetailSchema>;

export const BotSectionSchema = z.object({
  id: Id,
  name: z.string(),
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotSection = z.infer<typeof BotSectionSchema>;

/**
 * A space is a real privacy boundary, not just sidebar organization.
 * Bots are included so clients can keep every space visible without granting
 * those bots access to the currently active space.
 */
export const SpaceBotSchema = BotSchema.pick({
  id: true,
  spaceId: true,
  name: true,
  title: true,
  color: true,
  notifyOnFinish: true,
  pinned: true,
  sectionId: true,
  unread: true,
  preview: true,
  status: true,
  updatedAt: true,
});
export type SpaceBot = z.infer<typeof SpaceBotSchema>;

export const SpaceGroupSchema = GroupSchema.pick({
  id: true,
  spaceId: true,
  name: true,
  pinned: true,
  sectionId: true,
  members: true,
  preview: true,
  unread: true,
  updatedAt: true,
});
export type SpaceGroup = z.infer<typeof SpaceGroupSchema>;

export const SpaceSchema = z.object({
  id: Id,
  name: z.string(),
  isDefault: z.boolean(),
  bots: z.array(SpaceBotSchema),
  groups: z.array(SpaceGroupSchema),
  botSections: z.array(BotSectionSchema),
});
export type Space = z.infer<typeof SpaceSchema>;

export const SpaceNavigationSchema = z.object({
  current: z.object({
    id: Id,
    name: z.string(),
    bots: z.array(BotSchema),
    groups: z.array(GroupSchema),
    botSections: z.array(BotSectionSchema),
  }),
  spaces: z.array(SpaceSchema),
});
export type SpaceNavigation = z.infer<typeof SpaceNavigationSchema>;

export const BOT_NAME_MAX_LENGTH = 80;
export const BOT_TITLE_MAX_LENGTH = 500;
export const BOT_DESCRIPTION_MAX_LENGTH = 4000;
export const BOT_INSTRUCTIONS_MAX_LENGTH = 20000;

export const CreateBotInput = z.object({
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH),
  title: z.string().max(BOT_TITLE_MAX_LENGTH).default(""),
  description: z.string().max(BOT_DESCRIPTION_MAX_LENGTH).default(""),
  instructions: z.string().max(BOT_INSTRUCTIONS_MAX_LENGTH).default(""),
  notifyOnFinish: z.boolean().default(true),
  color: z.string().optional(),
  computerMode: ComputerModeSchema.default("team"),
});
export type CreateBotInput = z.infer<typeof CreateBotInput>;

export function normalizeCreateBotProfile(
  input: Pick<CreateBotInput, "name" | "title" | "description">,
) {
  const description = input.description.trim();
  return {
    name: input.name.trim().slice(0, BOT_NAME_MAX_LENGTH),
    title: input.title.trim().slice(0, BOT_TITLE_MAX_LENGTH),
    description: description.slice(0, BOT_DESCRIPTION_MAX_LENGTH),
    instructions: description.slice(0, BOT_INSTRUCTIONS_MAX_LENGTH),
  };
}

export const UpdateBotInput = z
  .object({
    botId: Id,
    name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH).optional(),
    title: z.string().trim().max(BOT_TITLE_MAX_LENGTH).optional(),
    description: z.string().trim().max(BOT_DESCRIPTION_MAX_LENGTH).optional(),
    instructions: z.string().trim().max(BOT_INSTRUCTIONS_MAX_LENGTH).optional(),
    notifyOnFinish: z.boolean().optional(),
    color: z.string().optional(),
    pinned: z.boolean().optional(),
    memoryScope: MemoryScopeSchema.nullable().optional(),
    sectionId: Id.nullable().optional(),
    voiceId: z.string().max(120).nullable().optional(),
    autoSpeak: z.boolean().optional(),
    modelProvider: z.string().trim().min(1).max(80).nullable().optional(),
    modelId: z.string().trim().min(1).max(200).nullable().optional(),
    thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const providerProvided = value.modelProvider !== undefined;
    const modelProvided = value.modelId !== undefined;
    if (!providerProvided && !modelProvided) return;
    // Reject partial shapes like `{ modelId: null }` (provider omitted) so a
    // clear cannot succeed without updating both persisted fields.
    if (providerProvided !== modelProvided) {
      ctx.addIssue({
        code: "custom",
        message: "Model provider and model id must both be set or both cleared",
        path: ["modelId"],
      });
      return;
    }
    const bothNull = value.modelProvider === null && value.modelId === null;
    const bothSet = Boolean(value.modelProvider) && Boolean(value.modelId);
    if (!bothNull && !bothSet) {
      ctx.addIssue({
        code: "custom",
        message: "Model provider and model id must both be set or both cleared",
        path: ["modelId"],
      });
    }
  });

export const RoutineSchema = z.object({
  id: Id,
  botId: Id,
  name: z.string(),
  prompt: z.string(),
  crons: z.array(z.string()),
  timezone: z.string(),
  active: z.boolean(),
  notify: z.boolean(),
  webhookEnabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Routine = z.infer<typeof RoutineSchema>;

export const CreateRoutineInput = z
  .object({
    botId: Id,
    name: z.string().min(1).max(80),
    prompt: z.string().min(1),
    crons: z.array(z.string().min(1)).default([]),
    timezone: z.string().default("UTC"),
    notify: z.boolean().default(true),
    active: z.boolean().default(false),
    webhookEnabled: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.crons.length === 0 && !value.webhookEnabled) {
      ctx.addIssue({
        code: "custom",
        message: "Add a schedule or webhook trigger",
        path: ["crons"],
      });
    }
  });

export const ScratchpadItemStatusSchema = z.enum(["open", "parked", "done"]);
export type ScratchpadItemStatus = z.infer<typeof ScratchpadItemStatusSchema>;

export const ScratchpadItemSchema = z.object({
  id: Id,
  botId: Id,
  title: z.string(),
  status: ScratchpadItemStatusSchema,
  notes: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScratchpadItem = z.infer<typeof ScratchpadItemSchema>;

export const CreateScratchpadItemInput = z.object({
  botId: Id,
  title: z.string().min(1).max(200),
  status: ScratchpadItemStatusSchema.default("open"),
  notes: z.string().max(4_000).default(""),
});

export const TaughtSkillStatusSchema = z.enum(["recording", "drafting", "draft", "saved"]);
export type TaughtSkillStatus = z.infer<typeof TaughtSkillStatusSchema>;

export const SkillPlaybookSchema = z.object({
  whenToUse: z.string(),
  inputs: z.array(z.string()),
  steps: z.array(z.string()),
  howToCheck: z.string(),
  whatToReturn: z.string(),
  approvalBoundaries: z.string(),
  failureHandling: z.string(),
});
export type SkillPlaybook = z.infer<typeof SkillPlaybookSchema>;

export const TeachRecordingEventSchema = z.object({
  at: z.string(),
  kind: z.enum(["pointer", "key", "clipboard", "snapshot", "scroll"]),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.string().optional(),
  type: z.string().optional(),
  key: z.string().optional(),
  text: z.string().optional(),
  summary: z.string().optional(),
});
export type TeachRecordingEvent = z.infer<typeof TeachRecordingEventSchema>;

export const TeachSnapshotSchema = z.object({
  at: z.string(),
  summary: z.string(),
  hash: z.string().optional(),
});
export type TeachSnapshot = z.infer<typeof TeachSnapshotSchema>;

export const TeachRecordingSchema = z.object({
  events: z.array(TeachRecordingEventSchema),
  snapshots: z.array(TeachSnapshotSchema),
  controlLeaseId: z.string().optional(),
});
export type TeachRecording = z.infer<typeof TeachRecordingSchema>;

export const TaughtSkillSchema = z.object({
  id: Id,
  botId: Id,
  name: z.string(),
  goal: z.string(),
  status: TaughtSkillStatusSchema,
  playbook: SkillPlaybookSchema,
  recording: TeachRecordingSchema,
  startedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaughtSkill = z.infer<typeof TaughtSkillSchema>;

export const AgentSkillSourceSchema = z.enum(["user", "builtin", "plugin"]);
export type AgentSkillSource = z.infer<typeof AgentSkillSourceSchema>;

export const AgentSkillSchema = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  content: z.string(),
  source: AgentSkillSourceSchema,
  readOnly: z.boolean(),
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

export const UpdateAgentSkillInput = z
  .object({
    skillId: Id,
    content: z.string().min(1).max(100_000).optional(),
    name: z.string().min(1).max(80).optional(),
    description: z.string().min(1).max(2000).optional(),
    body: z.string().max(100_000).optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.content === undefined &&
      input.name === undefined &&
      input.description === undefined &&
      input.body === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Provide at least one field to update",
        path: ["content"],
      });
    }
  });

export const MemoryDocumentSchema = z.object({
  id: Id,
  scope: MemoryScope,
  botId: Id.nullable(),
  path: z.string(),
  content: z.string(),
  revision: z.number().int(),
  updatedAt: z.string(),
});
export type MemoryDocument = z.infer<typeof MemoryDocumentSchema>;

export const ConnectionSchema = z.object({
  id: Id,
  connectorId: z.string(),
  provider: z.string(),
  displayName: z.string(),
  status: z.enum(["pending", "connected", "revoked", "error"]),
  capabilities: z.array(z.string()),
  createdAt: z.string(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const ConnectionCatalogItemSchema = z.object({
  connectorId: z.string(),
  slug: z.string(),
  name: z.string(),
  logo: z.string().nullable(),
  connected: z.boolean(),
  noAuth: z.boolean(),
});
export type ConnectionCatalogItem = z.infer<typeof ConnectionCatalogItemSchema>;

export const ActionApprovalRuleSchema = z.object({
  id: Id,
  effect: z.enum(["always_allow", "require_approval"]),
  matchKind: z.enum(["tool", "connector", "category"]),
  matchValue: z.string(),
  createdAt: z.string(),
});
export type ActionApprovalRule = z.infer<typeof ActionApprovalRuleSchema>;

export const ActionAutoReviewSettingsSchema = z.object({
  enabled: z.boolean(),
  checkerAvailable: z.boolean(),
});
export type ActionAutoReviewSettings = z.infer<typeof ActionAutoReviewSettingsSchema>;

export const CapabilityInstallSchema = z.object({
  id: Id,
  kind: z.enum(["skill", "plugin", "mcp", "api", "connection"]),
  name: z.string(),
  source: z.string(),
  version: z.string().nullable(),
  digest: z.string().nullable(),
  secretConfigured: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type CapabilityInstall = z.infer<typeof CapabilityInstallSchema>;

export type { McpTransport } from "./mcp.js";

const McpServerBaseInput = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  enabled: z.boolean().default(true),
  /** Update-only: drop the stored static credential (secret/env/headers).
   * OAuth state survives so a connected server stays connected. */
  clearCredential: z.boolean().optional(),
});
export const McpServerConfigInput = z.discriminatedUnion("transport", [
  McpServerBaseInput.extend({
    transport: z.literal("streamable_http"),
    endpoint: McpRemoteEndpointSchema,
    headers: McpHeadersSchema.default({}),
    secret: z.string().max(16384).optional(),
  }),
  McpServerBaseInput.extend({
    transport: z.literal("sse"),
    endpoint: McpRemoteEndpointSchema,
    headers: McpHeadersSchema.default({}),
    secret: z.string().max(16384).optional(),
  }),
  McpServerBaseInput.extend({
    transport: z.literal("stdio"),
    command: z.string().min(1).max(512),
    args: z.array(z.string().max(2048)).max(64).default([]),
    env: z
      .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4096))
      .superRefine((value, ctx) => {
        if (Object.keys(value).length > 32) {
          ctx.addIssue({ code: "custom", message: "At most 32 environment variables are allowed" });
        }
      })
      .default({}),
    secret: z.string().max(16384).optional(),
  }),
]);
export type McpServerConfigInput = z.infer<typeof McpServerConfigInput>;

export const McpServerSchema = z.object({
  id: Id,
  spaceId: Id,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  transport: McpTransportSchema,
  endpoint: z.string().url().nullable(),
  command: z.string().nullable(),
  args: z.array(z.string()),
  envKeys: z.array(z.string()),
  headerKeys: z.array(z.string()),
  hasSecret: z.boolean(),
  oauthStatus: z.enum(["none", "connected", "reconnect"]),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const BotMcpServerSchema = z.object({
  id: Id,
  botId: Id,
  serverId: Id,
  allowAllTools: z.boolean(),
  allowedTools: z.array(z.string().min(1).max(200)),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotMcpServer = z.infer<typeof BotMcpServerSchema>;

export const ArtifactSchema = z.object({
  id: Id,
  botId: Id.nullable(),
  groupId: Id.nullable(),
  runId: Id.nullable(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  createdAt: z.string(),
});

export const ArtifactWithContentSchema = ArtifactSchema.extend({
  contentBase64: z.string(),
});
export type ArtifactWithContent = z.infer<typeof ArtifactWithContentSchema>;

export const UsageRecordSchema = z.object({
  id: Id,
  botId: Id.nullable(),
  runId: Id.nullable(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  createdAt: z.string(),
});

export const ComputerStatusSchema = z.object({
  botId: Id,
  mode: ComputerModeSchema,
  kind: SandboxKind,
  state: z.enum(["stopped", "booting", "running", "suspended", "error"]),
  controlHolder: z.enum(["bot", "user", "none"]),
  controlBotId: Id.nullable(),
  takeoverRequested: z.boolean(),
  screenAvailable: z.boolean(),
  screenWidth: z.number().int().positive(),
  screenHeight: z.number().int().positive(),
  homeRevision: z.string().nullable(),
  busyBotName: z.string().nullable(),
  updateAvailable: z.boolean(),
});
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;

export const ComputerReleaseReasonSchema = z.enum(["done", "skipped"]);
export type ComputerReleaseReason = z.infer<typeof ComputerReleaseReasonSchema>;

export const MessagingLinkedIdentitySchema = z.object({
  id: Id,
  provider: z.string(),
  address: z.string(),
  botId: Id,
  botName: z.string(),
});
export type MessagingLinkedIdentity = z.infer<typeof MessagingLinkedIdentitySchema>;

export const MessagingStatusSchema = z.object({
  enabled: z.boolean(),
  /** Messaging platforms mounted on this deployment (sendblue, slack, …). */
  providers: z.array(z.string()),
  /** True when unknown senders auto-provision their own accounts. */
  openSignup: z.boolean(),
  /** The caller's linked chat apps, one entry per (provider, address). */
  identities: z.array(MessagingLinkedIdentitySchema),
});
export type MessagingStatus = z.infer<typeof MessagingStatusSchema>;

export const MessagingChannelMembershipSchema = z.object({
  /** One row per linked identity: the same group can hold two of the caller's. */
  id: Id,
  channelId: Id,
  /** Which of the caller's linked chat apps this membership belongs to. */
  identityId: Id,
  provider: z.string(),
  name: z.string().nullable(),
  status: z.enum(["invited", "approved", "declined", "left"]),
  memberCount: z.number().int().nonnegative(),
});
export type MessagingChannelMembership = z.infer<typeof MessagingChannelMembershipSchema>;

export const MessagingAgentConnectionSchema = z.object({
  id: Id,
  peerBotName: z.string(),
  peerOwnerLabel: z.string(),
  status: z.enum(["pending", "approved", "declined", "revoked"]),
  /** true when the caller's bot is the target (only the target can respond). */
  incoming: z.boolean(),
});
export type MessagingAgentConnection = z.infer<typeof MessagingAgentConnectionSchema>;

export const RunSchema = z.object({
  id: Id,
  botId: Id,
  threadId: Id,
  taskId: Id,
  status: RunStatus,
  trigger: z.enum([
    "user",
    "routine",
    "resume",
    "follow_up",
    "reaction",
    "spawn",
    "skill",
    "bot_message",
    "webhook",
    "messaging",
  ]),
  routineId: Id.nullable(),
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

export const ThreadMessagePageSchema = z.object({
  threadId: Id,
  messages: z.array(ThreadMessageSchema),
  olderCursor: z.number().int().nonnegative().nullable(),
});
export type ThreadMessagePage = z.infer<typeof ThreadMessagePageSchema>;

export const ThreadSnapshotSchema = z.object({
  threadId: Id,
  cursor: z.number().int().min(-1),
  messages: z.array(ThreadMessageSchema),
  olderCursor: z.number().int().nonnegative().nullable(),
  botId: Id.optional(),
  groupId: Id.optional(),
  groupName: z.string().optional(),
  members: z.array(GroupMemberSchema).optional(),
  run: RunSchema.nullable(),
  activeRuns: z.array(RunSchema).optional(),
  computer: ComputerStatusSchema.optional(),
});
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>;

export const ModelCredentialSchema = z.object({
  id: Id,
  provider: z.string(),
  label: z.string(),
  hasKey: z.boolean(),
  isDefault: z.boolean(),
  baseUrl: z.string().optional(),
  modelId: z.string().optional(),
});
export type ModelCredential = z.infer<typeof ModelCredentialSchema>;

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

export const ModelConnectInputSchema = z
  .object({
    provider: z.string(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    label: z.string().optional(),
    modelId: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      if (!value.baseUrl?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Base URL is required for OpenAI-compatible models",
          path: ["baseUrl"],
        });
      }
      if (!value.modelId?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Model id is required for OpenAI-compatible models",
          path: ["modelId"],
        });
      }
      return;
    }
    if (!value.apiKey || value.apiKey.trim().length < 8) {
      ctx.addIssue({
        code: "custom",
        message: "API key must contain at least 8 characters",
        path: ["apiKey"],
      });
    }
  });
export type ModelConnectInput = z.infer<typeof ModelConnectInputSchema>;

export const ModelOAuthSignInModeSchema = z.enum(["device-code", "auth-url"]);
export type ModelOAuthSignInMode = z.infer<typeof ModelOAuthSignInModeSchema>;

const ModelOAuthBeginBaseSchema = z.object({
  loginId: z.string(),
  provider: z.string(),
  verificationUri: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), "Expected an HTTPS authorization URL"),
  expiresInSeconds: z.number().int().positive(),
});

export const ModelOAuthBeginSchema = z.discriminatedUnion("mode", [
  ModelOAuthBeginBaseSchema.extend({
    mode: z.literal("device-code"),
    userCode: z.string().min(1),
  }),
  ModelOAuthBeginBaseSchema.extend({ mode: z.literal("auth-url") }),
]);
export type ModelOAuthBegin = z.infer<typeof ModelOAuthBeginSchema>;

export const SpaceMemoryConfigSchema = z.object({
  provider: z.string(),
  settings: z.record(z.string(), z.string()),
  defaultMemoryScope: MemoryScopeSchema,
  updatedAt: z.string(),
});
export type SpaceMemoryConfig = z.infer<typeof SpaceMemoryConfigSchema>;

export const ModelCatalogEntrySchema = z.object({
  provider: z.string(),
  providerName: z.string().optional(),
  id: z.string(),
  label: z.string(),
  billing: z.string(),
  auth: z.enum(["api-key", "oauth", "both"]).optional(),
  oauthLabel: z.string().optional(),
  authHint: z.string().optional(),
  subscription: z.boolean().optional(),
  signIn: ModelOAuthSignInModeSchema.optional(),
  reasoning: z.boolean().optional(),
  thinkingLevels: z.array(ThinkingLevelSchema).optional(),
  /** Catalog stand-in so a provider appears before the user enters a real model id. */
  placeholder: z.boolean().optional(),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const VoiceCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  transcribe: z.boolean(),
});
export type VoiceCatalogEntry = z.infer<typeof VoiceCatalogEntrySchema>;

export const VoiceInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type VoiceInfo = z.infer<typeof VoiceInfoSchema>;

export const VoiceCredentialSchema = z.object({
  id: Id,
  provider: z.string(),
  hasKey: z.boolean(),
  isDefault: z.boolean(),
  voiceId: z.string(),
  transcribe: z.boolean(),
});
export type VoiceCredential = z.infer<typeof VoiceCredentialSchema>;

export const VoiceStatusSchema = z.object({
  configured: z.boolean(),
  ready: z.boolean(),
  transcribe: z.boolean(),
  provider: z.string().nullable(),
  voiceId: z.string(),
});
export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;

export const DeploymentSettingsSchema = z.object({
  ownerUserId: Id.nullable(),
  signupsEnabled: z.boolean(),
  signupAllowlist: z.array(z.string()),
  hasDeploymentModelCredential: z.boolean(),
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  computerHost: z.enum(["docker", "this-mac"]).nullable(),
  canChooseHostComputer: z.boolean(),
  sandboxProvider: z.string(),
});

export const ServerUpdateSourceSchema = z.object({
  repoUrl: z.string().max(400),
  branch: z.string().max(200),
  official: z.boolean(),
});
export type ServerUpdateSource = z.infer<typeof ServerUpdateSourceSchema>;

export const ServerUpdateStepSchema = z.object({
  id: z.string().max(40),
  label: z.string().max(200),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  output: z.string().max(8_001),
});

/** How an update reaches new code: published images, a build on the server, or a git checkout. */
export const ServerUpdateStrategySchema = z.enum(["pull", "build", "checkout"]);
export type ServerUpdateStrategy = z.infer<typeof ServerUpdateStrategySchema>;

/** `sidecar` is the Compose deployment; `checkout` is a supervised source install. */
export const ServerUpdateModeSchema = z.enum(["sidecar", "checkout", "unavailable"]);
export type ServerUpdateMode = z.infer<typeof ServerUpdateModeSchema>;

/**
 * What Settings should render for a deployment owner.
 * `sidecar`: Check / Update / Rollback through the updater sidecar.
 * `compose`: Compose install without a reachable sidecar; show host pull/up commands.
 * `source`: git checkout / `pnpm dev`; show terminal commands, never a fake Apply.
 */
export const ServerUpdateInstallKindSchema = z.enum(["sidecar", "compose", "source"]);
export type ServerUpdateInstallKind = z.infer<typeof ServerUpdateInstallKindSchema>;

export const ServerUpdateRunSchema = z.object({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  ok: z.boolean(),
  fromCommit: z.string().nullable(),
  toCommit: z.string().nullable(),
  fromTag: z.string().nullable(),
  toTag: z.string().nullable(),
  strategy: ServerUpdateStrategySchema.nullable(),
  repoUrl: z.string().max(400),
  branch: z.string().max(200),
  /**
   * `recreated` means the updater sidecar replaced the containers and no restart is owed.
   * `supervised` means the process exited and its supervisor is bringing it back.
   */
  restart: z.enum(["recreated", "supervised", "manual", "not-required"]),
  restartAdvice: z.string(),
  error: z.string().nullable(),
  steps: z.array(ServerUpdateStepSchema),
});
export type ServerUpdateRun = z.infer<typeof ServerUpdateRunSchema>;

export const ServerUpdateStatusSchema = z.object({
  supported: z.boolean(),
  unsupportedReason: z.string().nullable(),
  installKind: ServerUpdateInstallKindSchema,
  /** Host commands to run when `installKind` is not `sidecar`. Empty when the sidecar applies. */
  manualCommands: z.array(z.string()),
  mode: ServerUpdateModeSchema,
  strategy: ServerUpdateStrategySchema.nullable(),
  strategyNote: z.string().nullable(),
  version: z.string(),
  revision: z.string().nullable(),
  commit: z.string().nullable(),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  dirty: z.boolean(),
  dirtyPaths: z.array(z.string()),
  image: z.string().nullable(),
  imageTag: z.string().nullable(),
  previousImageTag: z.string().nullable(),
  canRollback: z.boolean(),
  source: ServerUpdateSourceSchema,
  officialRepoUrl: z.string(),
  restartSupervisor: z.enum(["systemd", "pm2", "declared", "none"]),
  restartAdvice: z.string(),
  running: z.boolean(),
  lastRun: ServerUpdateRunSchema.nullable(),
});
export type ServerUpdateStatus = z.infer<typeof ServerUpdateStatusSchema>;

export const ServerUpdateCheckSchema = z.object({
  status: z.enum(["unavailable", "dirty", "up-to-date", "available"]),
  reason: z.string().nullable(),
  changed: z.array(z.string()),
  commit: z.string().nullable(),
  targetCommit: z.string().nullable(),
  targetTag: z.string().nullable(),
  behindBy: z.number().int().nonnegative(),
});
export type ServerUpdateCheck = z.infer<typeof ServerUpdateCheckSchema>;

export const ServerUpdateRequestSchema = z.object({
  repoUrl: z.string().max(400).optional(),
  branch: z.string().max(200).optional(),
});
export type ServerUpdateRequest = z.infer<typeof ServerUpdateRequestSchema>;

export const MeSchema = z.object({
  userId: Id,
  email: z.string().email(),
  name: z.string(),
  spaceId: Id,
  isDeploymentOwner: z.boolean(),
  needsModel: z.boolean(),
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  computerHost: z.enum(["docker", "this-mac"]).nullable(),
  canChooseHostComputer: z.boolean(),
  sandboxProvider: z.string(),
  avatarStyle: AvatarStyleSchema,
});
export type Me = z.infer<typeof MeSchema>;

export const AppBootstrapSchema = z.object({
  me: MeSchema,
  bots: z.array(BotSchema),
  groups: z.array(GroupSchema),
  botSections: z.array(BotSectionSchema),
  archivedBots: z.array(BotSchema),
  archivedGroups: z.array(GroupSchema),
  thread: ThreadSnapshotSchema.nullable(),
  routines: z.array(RoutineSchema),
  spaces: z.array(SpaceSchema),
});
export type AppBootstrap = z.infer<typeof AppBootstrapSchema>;

export const ExportManifestSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  bot: BotSchema.pick({ name: true, title: true, description: true, instructions: true }),
  memory: z.array(z.object({ path: z.string(), content: z.string() })),
  routines: z.array(RoutineSchema.pick({ name: true, prompt: true, crons: true, timezone: true })),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  history: z.array(ThreadMessageSchema),
});
export type ExportManifest = z.infer<typeof ExportManifestSchema>;
