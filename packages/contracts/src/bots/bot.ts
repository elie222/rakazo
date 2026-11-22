import * as z from "zod";
import { ComputerModeSchema } from "../computers/computer.js";
import { Id, ReplyModeSchema, ThinkingLevelSchema } from "../ids.js";
import { ApprovalModeSchema } from "../integrations/approvals.js";
import { TEAM_CHAT_RULES_MAX_LENGTH } from "../threads/external-conversations.js";
import { BotSettingsValuesSchema } from "../threads/message-blocks.js";
import { AGENT_SECRET_NAME_PATTERN } from "./agent-secret-name.js";
import { BotAvatarSetSchema, BotAvatarValueSchema } from "./bot-avatar.js";
import { MemoryScopeSchema } from "./bot-memory.js";
import { BotWorkspacePathSchema } from "./bot-workspace.js";
import { DisabledBuiltinToolsSchema } from "./builtin-tools.js";

/** The spawn key of the bot a new account starts with. */
export const FIRST_BOT_SPAWN_KEY = "onboarding:first";

export const AgentSecretSchema = z.object({
  id: Id,
  name: z.string().regex(AGENT_SECRET_NAME_PATTERN),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentSecret = z.infer<typeof AgentSecretSchema>;

export const AgentSecretInputSchema = z.object({
  name: z.string().trim().regex(AGENT_SECRET_NAME_PATTERN),
  value: z.string().min(1).max(16_384),
});

export const InstructionVersionSchema = z.object({
  id: Id,
  instructions: z.string(),
  reason: z.string(),
  createdAt: z.string(),
});

/** Background helpers one bot may run at once when it has no setting of its own. */
export const DEFAULT_MAX_CONCURRENT_HELPERS = 3;
/** The most background helpers a bot's setting can ask for. */
export const MAX_CONCURRENT_HELPERS_LIMIT = 8;
export const BotMaxConcurrentHelpersSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_CONCURRENT_HELPERS_LIMIT);

/** When a bot summarizes older messages. */
export const CONVERSATION_COMPACTION_MODES = [
  "automatic",
  "earlier",
  "near_limit",
  "custom",
] as const;
export const ConversationCompactionModeSchema = z.enum(CONVERSATION_COMPACTION_MODES);
export type ConversationCompactionMode = z.infer<typeof ConversationCompactionModeSchema>;
export function normalizeConversationCompactionMode(
  value: string | null | undefined,
): ConversationCompactionMode {
  return value === "earlier" || value === "near_limit" || value === "custom" ? value : "automatic";
}
export const MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS = 20_000;
export const MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS = 1_000_000;
export const DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS = 100_000;
/** A custom threshold never exceeds this share of the model's context window. */
export const MAX_CONVERSATION_COMPACTION_WINDOW_RATIO = 0.9;
export const BotConversationCompactionTokensSchema = z
  .number()
  .int()
  .min(MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS)
  .max(MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS);

/**
 * The observed input-token threshold for a mode. `null` means the mode keeps the existing
 * message-count behavior, or no positive model window was known.
 */
export function conversationCompactionTokenThreshold(
  mode: ConversationCompactionMode | null | undefined,
  customTokens: number | null | undefined,
  contextWindow: number | null | undefined,
): number | null {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow < 1) return null;
  switch (mode) {
    case "earlier":
      return Math.max(1, Math.floor(contextWindow * 0.5));
    case "near_limit":
      return Math.max(1, Math.floor(contextWindow * 0.8));
    case "custom":
      return Math.max(
        1,
        Math.min(
          customTokens ?? DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS,
          Math.floor(contextWindow * MAX_CONVERSATION_COMPACTION_WINDOW_RATIO),
        ),
      );
    default:
      return null;
  }
}

/** The most tool calls one turn may make when a bot sets its own limit. */
export const MAX_TOOL_CALLS_PER_TURN_LIMIT = 1_000;
export const BotMaxToolCallsPerTurnSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TOOL_CALLS_PER_TURN_LIMIT);

export const BotSchema = z.object({
  meetingsEnabled: z.boolean().optional(),
  id: Id,
  spaceId: Id,
  name: z.string(),
  /** Always empty; installed mobile apps still read it. */
  title: z.string(),
  description: z.string(),
  instructions: z.string(),
  instructionHistory: z.array(InstructionVersionSchema).optional(),
  color: z.string(),
  avatarSet: BotAvatarSetSchema.optional(),
  notifyOnFinish: z.boolean(),
  pinned: z.boolean(),
  sectionId: Id.nullable(),
  archivedAt: z.string().nullable(),
  unread: z.boolean(),
  /** Hidden from the viewer's chat list until then; past, the chat has just woken. */
  snoozedUntil: z.string().nullable().optional(),
  parentBotId: Id.nullable(),
  memoryScope: MemoryScopeSchema.nullable(),
  /** The bot's own notes reach its prompt; its settings turn this off. */
  useOwnMemory: z.boolean().default(true),
  /** The Space's shared notes reach its prompt; its settings turn this off. */
  useSharedMemory: z.boolean().default(true),
  threadId: Id,
  preview: z.string(),
  status: z.string(),
  threadStatus: z.string().optional(),
  runErrorId: Id.nullable().default(null),
  computerMode: ComputerModeSchema,
  /** The paired computer this bot's tools reach, from its owner's account; null uses any. */
  hostDevice: z
    .object({ id: Id, name: z.string(), platform: z.string(), ownerUserId: Id })
    .nullable()
    .default(null),
  /** Background helpers this bot may run at once; null uses the default. */
  maxConcurrentHelpers: BotMaxConcurrentHelpersSchema.nullable().default(null),
  /** How this bot compacts older messages; absent means automatic. */
  conversationCompactionMode: ConversationCompactionModeSchema.optional(),
  /** Observed input-token threshold when the mode is custom. */
  conversationCompactionTokens: BotConversationCompactionTokensSchema.nullable().optional(),
  /** Tool calls one turn may make; null or absent follows the deployment default. */
  maxToolCallsPerTurn: BotMaxToolCallsPerTurnSchema.nullable().optional(),
  updatedAt: z.string(),
  createdAt: z.string(),
  voiceId: z.string().nullable(),
  autoSpeak: z.boolean(),
  modelProvider: z.string().nullable(),
  modelId: z.string().nullable(),
  thinkingLevel: ThinkingLevelSchema.nullable(),
  /** The bot's own folder on its computer; null uses the default. Absent from older servers. */
  workspacePath: z.string().nullable().default(null),
  teamChatAmbientEnabled: z.boolean(),
  teamChatRules: z.string(),
  crossSpaceCommunication: z.boolean().optional(),
  dailyCheckIns: z.boolean().optional(),
  fleetManagement: z.boolean().default(true),
  replyMode: ReplyModeSchema.default("chat"),
  /** Overrides the owner's Space mode for this bot; null or absent follows the Space. */
  approvalMode: ApprovalModeSchema.nullable().default(null),
  disabledBuiltinTools: z.array(z.string()).default([]),
  webhookConfigured: z.boolean(),
  /** Present when created with an idempotency key (e.g. onboarding:first). */
  spawnKey: z.string().nullable(),
  /** The bot is ringing the user right now. */
  incomingCall: z
    .object({
      callId: z.string(),
      reason: z.string(),
      opening: z.string(),
      expiresAt: z.string(),
    })
    .nullable()
    .optional(),
});
export type Bot = z.infer<typeof BotSchema>;

/** The caller identity and request needed by every incoming-call surface. */
export const IncomingBotCallSchema = BotSchema.pick({
  id: true,
  spaceId: true,
  name: true,
  color: true,
  avatarSet: true,
}).extend({
  incomingCall: BotSchema.shape.incomingCall.unwrap().unwrap(),
});
export type IncomingBotCall = z.infer<typeof IncomingBotCallSchema>;

export const ReorderBotsInput = z.object({
  botIds: z
    .array(Id)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, { error: "botIds must be distinct" }),
});
export type ReorderBotsInput = z.infer<typeof ReorderBotsInput>;

export const BOT_SECTION_NAME_MAX_LENGTH = 60;
export const BotSectionName = z.string().trim().min(1).max(BOT_SECTION_NAME_MAX_LENGTH);

export const BotSectionSchema = z.object({
  id: Id,
  name: z.string(),
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotSection = z.infer<typeof BotSectionSchema>;

export const BOT_NAME_MAX_LENGTH = 80;
export const BOT_DESCRIPTION_MAX_LENGTH = 4000;
export const BOT_INSTRUCTIONS_MAX_LENGTH = 20000;

export const CreateBotInput = z.object({
  /** Optional reserved identity so a creation preview uses the final bot seed. */
  id: z
    .string()
    .regex(/^c[a-z0-9]{24}$/)
    .optional(),
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH),
  description: z.string().max(BOT_DESCRIPTION_MAX_LENGTH).default(""),
  instructions: z.string().max(BOT_INSTRUCTIONS_MAX_LENGTH).default(""),
  notifyOnFinish: z.boolean().default(true),
  dailyCheckIns: z.boolean().optional(),
  fleetManagement: z.boolean().optional(),
  color: BotAvatarValueSchema.optional(),
  /** Ignored: a new bot takes its owner's set. Older apps still send one. */
  avatarSet: BotAvatarSetSchema.optional(),
  /** Organic body family (0-9); the server picks a matching id unless one is reserved. */
  avatarFamily: z.number().int().min(0).max(9).optional(),
  /** Unset follows the deployment's default computer. */
  computerMode: ComputerModeSchema.optional(),
  /** Idempotency key within a space (unique with spaceId). */
  spawnKey: z.string().trim().min(1).max(120).optional(),
});
export type CreateBotInput = z.infer<typeof CreateBotInput>;

export const UpdateBotInput = z
  .object({
    botId: Id,
    name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH).optional(),
    description: z.string().trim().max(BOT_DESCRIPTION_MAX_LENGTH).optional(),
    instructions: z.string().trim().max(BOT_INSTRUCTIONS_MAX_LENGTH).optional(),
    expectedInstructions: z.string().max(BOT_INSTRUCTIONS_MAX_LENGTH).optional(),
    /** Ignored; installed mobile apps may still send it. */
    selfUpdateInstructions: z.boolean().optional(),
    notifyOnFinish: z.boolean().optional(),
    color: BotAvatarValueSchema.optional(),
    avatarSet: BotAvatarSetSchema.optional(),
    pinned: z.boolean().optional(),
    memoryScope: MemoryScopeSchema.nullable().optional(),
    useOwnMemory: z.boolean().optional(),
    useSharedMemory: z.boolean().optional(),
    sectionId: Id.nullable().optional(),
    voiceId: z.string().max(120).nullable().optional(),
    autoSpeak: z.boolean().optional(),
    modelProvider: z.string().trim().min(1).max(80).nullable().optional(),
    modelId: z.string().trim().min(1).max(200).nullable().optional(),
    thinkingLevel: ThinkingLevelSchema.nullable().optional(),
    /** Set the bot's workspace folder; null restores the default. */
    workspacePath: BotWorkspacePathSchema.nullable().optional(),
    /** A paired computer of the bot owner's account; null reaches whichever connects first. */
    hostDeviceId: Id.nullable().optional(),
    /** Background helpers this bot may run at once; null restores the default. */
    maxConcurrentHelpers: BotMaxConcurrentHelpersSchema.nullable().optional(),
    /** How this bot compacts older messages. */
    conversationCompactionMode: ConversationCompactionModeSchema.optional(),
    /** Observed input-token threshold when the mode is custom. */
    conversationCompactionTokens: BotConversationCompactionTokensSchema.nullable().optional(),
    /** Tool calls one turn may make; null restores the deployment default. */
    maxToolCallsPerTurn: BotMaxToolCallsPerTurnSchema.nullable().optional(),
    teamChatAmbientEnabled: z.boolean().optional(),
    teamChatRules: z.string().max(TEAM_CHAT_RULES_MAX_LENGTH).optional(),
    crossSpaceCommunication: z.boolean().optional(),
    dailyCheckIns: z.boolean().optional(),
    fleetManagement: z.boolean().optional(),
    replyMode: ReplyModeSchema.optional(),
    /** Ask, auto or never for this bot alone; null follows the Space. */
    approvalMode: ApprovalModeSchema.nullable().optional(),
    disabledBuiltinTools: DisabledBuiltinToolsSchema.optional(),
    /** Write only while these settings still hold, as an undo does. */
    expectedSettings: BotSettingsValuesSchema.optional(),
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
export type UpdateBotInput = z.infer<typeof UpdateBotInput>;
