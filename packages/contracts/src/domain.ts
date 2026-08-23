import * as z from "zod";
import { ThreadMessageSchema } from "./events.js";
import { Id, MemoryScope, RunStatus, SandboxKind } from "./ids.js";
import { McpHeadersSchema, McpRemoteEndpointSchema, McpTransportSchema } from "./mcp.js";

export const ComputerModeSchema = z.enum(["team", "dedicated"]);
export type ComputerMode = z.infer<typeof ComputerModeSchema>;

export const MemoryScopeSchema = z.enum(["isolated", "shared"]);
export type MemoryScopeValue = z.infer<typeof MemoryScopeSchema>;

export const BotSchema = z.object({
  id: Id,
  workspaceId: Id,
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
});
export type Bot = z.infer<typeof BotSchema>;

export const GroupMemberSchema = z.object({
  botId: Id,
  name: z.string(),
  color: z.string(),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const GROUP_MEMBER_MIN = 2;
export const GROUP_MEMBER_MAX = 6;

export const GroupSchema = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string(),
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

export const UpdateBotInput = z.object({
  botId: Id,
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH).optional(),
  title: z.string().max(BOT_TITLE_MAX_LENGTH).optional(),
  description: z.string().max(BOT_DESCRIPTION_MAX_LENGTH).optional(),
  instructions: z.string().max(BOT_INSTRUCTIONS_MAX_LENGTH).optional(),
  notifyOnFinish: z.boolean().optional(),
  color: z.string().optional(),
  pinned: z.boolean().optional(),
  memoryScope: MemoryScopeSchema.nullable().optional(),
  sectionId: Id.nullable().optional(),
  voiceId: z.string().max(120).nullable().optional(),
  autoSpeak: z.boolean().optional(),
});

export const RoutineSchema = z.object({
  id: Id,
  botId: Id,
  name: z.string(),
  prompt: z.string(),
  cron: z.string(),
  timezone: z.string(),
  active: z.boolean(),
  notify: z.boolean(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Routine = z.infer<typeof RoutineSchema>;

export const CreateRoutineInput = z.object({
  botId: Id,
  name: z.string().min(1).max(80),
  prompt: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().default("UTC"),
  notify: z.boolean().default(true),
  active: z.boolean().default(false),
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
  workspaceId: Id,
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
});
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>;

export const ComputerReleaseReasonSchema = z.enum(["done", "skipped"]);
export type ComputerReleaseReason = z.infer<typeof ComputerReleaseReasonSchema>;

export const RunSchema = z.object({
  id: Id,
  botId: Id,
  threadId: Id,
  taskId: Id,
  status: RunStatus,
  trigger: z.enum(["user", "routine", "resume", "follow_up", "spawn", "skill"]),
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
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
});
export type ModelCredential = z.infer<typeof ModelCredentialSchema>;

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

export const WorkspaceMemoryConfigSchema = z.object({
  provider: z.string(),
  settings: z.record(z.string(), z.string()),
  defaultMemoryScope: MemoryScopeSchema,
  updatedAt: z.string(),
});
export type WorkspaceMemoryConfig = z.infer<typeof WorkspaceMemoryConfigSchema>;

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
});

export const MeSchema = z.object({
  userId: Id,
  email: z.string().email(),
  name: z.string(),
  workspaceId: Id,
  isDeploymentOwner: z.boolean(),
  needsModel: z.boolean(),
  defaultProvider: z.string().nullable(),
  defaultModel: z.string().nullable(),
  computerHost: z.enum(["docker", "this-mac"]).nullable(),
  canChooseHostComputer: z.boolean(),
});
export type Me = z.infer<typeof MeSchema>;

export const AppBootstrapSchema = z.object({
  me: MeSchema,
  bots: z.array(BotSchema),
  botSections: z.array(BotSectionSchema),
  archivedBots: z.array(BotSchema),
  thread: ThreadSnapshotSchema.nullable(),
  routines: z.array(RoutineSchema),
});
export type AppBootstrap = z.infer<typeof AppBootstrapSchema>;

export const ExportManifestSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  bot: BotSchema.pick({ name: true, title: true, description: true, instructions: true }),
  memory: z.array(z.object({ path: z.string(), content: z.string() })),
  routines: z.array(RoutineSchema.pick({ name: true, prompt: true, cron: true, timezone: true })),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  history: z.array(ThreadMessageSchema),
});
export type ExportManifest = z.infer<typeof ExportManifestSchema>;
