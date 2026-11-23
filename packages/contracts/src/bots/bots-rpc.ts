import { oc } from "@orpc/contract";
import * as z from "zod";
import { ComputerModeSchema } from "../computers/computer.js";
import { Id } from "../ids.js";
import {
  AgentImportCreateInput,
  AgentImportPlanSchema,
  AgentImportPreviewInput,
} from "../integrations/agent-import.js";
import {
  AgentImportSetupStateInput,
  AgentImportSetupStateSchema,
} from "../integrations/agent-import-setup.js";
import { VaultImportInput, VaultImportResult } from "../integrations/vault-import.js";
import { MemoryProviderDescriptorSchema } from "../models/provider-settings.js";
import { botId } from "../rpc/inputs.js";
import { settingsScopeInput } from "../settings-scope.js";
import { SpaceMemoryConfigSchema } from "../spaces/space.js";
import { threadTarget } from "../threads/thread-send.js";
import {
  AgentSecretInputSchema,
  AgentSecretSchema,
  BotSchema,
  BotSectionName,
  BotSectionSchema,
  CreateBotInput,
  ReorderBotsInput,
  UpdateBotInput,
} from "./bot.js";
import { BotEmailAddressesSchema, BotEmailAddressSchema, BotEmailNameSchema } from "./bot-email.js";
import { MemoryDocumentSchema, MemoryPromptBudgetSchema, MemoryScopeSchema } from "./bot-memory.js";
import {
  BotSecretMetadata,
  BotSecretPutInput,
  StoredBotSecretName,
  VAULT_ACTIVITY_LIMIT,
  VaultPutInput,
  VaultRevealed,
  VaultRevealInput,
  VaultUse,
} from "./bot-secrets.js";
import {
  BotTemplateListingSchema,
  CreateBotFromTemplateInput,
  CreateBotFromTemplateOutput,
} from "./bot-template.js";
import {
  CreateScratchpadItemInput,
  ScratchpadItemSchema,
  ScratchpadItemStatusSchema,
  ScratchpadItemTitle,
} from "./scratchpad.js";

export const botsRpc = {
  bots: {
    list: oc.output(z.array(BotSchema)),
    listArchived: oc.output(z.array(BotSchema)),
    get: oc.input(botId).output(BotSchema),
    create: oc.input(CreateBotInput).output(BotSchema),
    importPreview: oc.input(AgentImportPreviewInput).output(AgentImportPlanSchema),
    importCreate: oc.input(AgentImportCreateInput).output(BotSchema),
    importSetupState: oc.input(AgentImportSetupStateInput).output(AgentImportSetupStateSchema),
    templates: oc.output(z.array(BotTemplateListingSchema)),
    createFromTemplate: oc.input(CreateBotFromTemplateInput).output(CreateBotFromTemplateOutput),
    duplicate: oc.input(botId).output(BotSchema),
    reorder: oc.input(ReorderBotsInput).output(z.object({ ok: z.literal(true) })),
    update: oc.input(UpdateBotInput).output(BotSchema),
    restoreInstructions: oc
      .input(
        z.object({
          botId: Id,
          versionId: Id,
          expectedInstructions: z.string(),
          undo: z.boolean().optional(),
        }),
      )
      .output(BotSchema),
    setComputer: oc.input(z.object({ botId: Id, mode: ComputerModeSchema })).output(BotSchema),
    archive: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    remove: oc
      .input(z.object({ botId: Id, deleteMemories: z.boolean().default(false) }))
      // Optional for clients talking to older servers; current servers return committed group IDs.
      .output(
        z.object({
          ok: z.literal(true),
          removedGroupIds: z.array(Id).optional(),
          alreadyRemoved: z.boolean().optional(),
        }),
      ),
    /** Groups this delete removes because fewer than two active bots would remain. */
    removePreview: oc.input(botId).output(z.array(z.object({ id: Id, name: z.string() }))),
    emailAddress: oc.input(botId).output(BotEmailAddressSchema),
    emailAddresses: oc.output(BotEmailAddressesSchema),
    claimEmailAddress: oc
      .input(z.object({ botId: Id, name: BotEmailNameSchema }))
      .output(z.object({ address: z.string() })),
    rotateWebhookSecret: oc.input(botId).output(
      z.object({
        secret: z.string(),
        path: z.string(),
        webhookConfigured: z.literal(true),
      }),
    ),
    revealWebhookSecret: oc
      .input(botId)
      // `url` is set when the deployment publishes its webhooks at a public address.
      .output(z.object({ secret: z.string(), url: z.string().optional() })),
  },
  botSections: {
    list: oc.output(z.array(BotSectionSchema)),
    create: oc.input(threadTarget.safeExtend({ name: BotSectionName })).output(BotSectionSchema),
    update: oc.input(z.object({ sectionId: Id, name: BotSectionName })).output(BotSectionSchema),
    remove: oc.input(z.object({ sectionId: Id })).output(
      z.object({
        id: Id,
        releasedBots: z.number().int().nonnegative(),
        releasedGroups: z.number().int().nonnegative(),
      }),
    ),
  },
  memory: {
    list: oc
      .input(z.object({ botId: Id.optional(), scope: z.enum(["bot", "user"]).optional() }))
      .output(z.array(MemoryDocumentSchema)),
    budget: oc.input(z.object({ botId: Id })).output(MemoryPromptBudgetSchema),
    update: oc
      .input(
        z.object({
          documentId: Id,
          content: z.string(),
          expectedRevision: z.number().int().positive().optional(),
        }),
      )
      .output(MemoryDocumentSchema),
    remove: oc.input(z.object({ documentId: Id })).output(z.object({ ok: z.literal(true) })),
    exportMarkdown: oc.input(z.object({ botId: Id.optional() })).output(z.string()),
    providerConfig: oc.output(SpaceMemoryConfigSchema.nullable()),
    /** The providers a Space can connect, with the settings form each one asks for. */
    providers: oc.output(z.array(MemoryProviderDescriptorSchema)),
    connectProvider: oc
      .input(
        z.object({
          provider: z.string().min(1),
          settings: z.record(z.string(), z.string()),
          credentials: z.record(z.string(), z.string()),
          defaultMemoryScope: MemoryScopeSchema.default("isolated"),
        }),
      )
      .output(SpaceMemoryConfigSchema),
    setDefaultScope: oc
      .input(z.object({ defaultMemoryScope: MemoryScopeSchema }))
      .output(SpaceMemoryConfigSchema),
    /** Change a connected provider's settings; credentials left out keep the stored ones. */
    updateProvider: oc
      .input(
        z.object({
          settings: z.record(z.string(), z.string()),
          credentials: z.record(z.string(), z.string()).default({}),
        }),
      )
      .output(SpaceMemoryConfigSchema),
    disconnectProvider: oc.output(z.object({ ok: z.literal(true) })),
  },
  scratchpad: {
    list: oc
      .input(
        z.object({
          botId: Id,
          status: ScratchpadItemStatusSchema.optional(),
          includeDone: z.boolean().optional(),
        }),
      )
      .output(z.array(ScratchpadItemSchema)),
    create: oc.input(CreateScratchpadItemInput).output(ScratchpadItemSchema),
    update: oc
      .input(
        z.object({
          itemId: Id,
          title: ScratchpadItemTitle.optional(),
          status: ScratchpadItemStatusSchema.optional(),
          notes: z.string().max(4_000).optional(),
        }),
      )
      .output(ScratchpadItemSchema),
    remove: oc.input(z.object({ itemId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  agentSecrets: {
    list: oc.output(z.array(AgentSecretSchema)),
    put: oc.input(AgentSecretInputSchema).output(AgentSecretSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  vault: {
    list: oc.input(settingsScopeInput.optional()).output(z.array(BotSecretMetadata)),
    put: oc.input(VaultPutInput).output(BotSecretMetadata),
    /** Needs a recent identity confirmation on this session (IDENTITY_CONFIRMATION_REQUIRED). */
    reveal: oc.input(VaultRevealInput).output(VaultRevealed),
    import: oc.input(VaultImportInput).output(VaultImportResult),
    activity: oc
      .input(settingsScopeInput.extend({ name: StoredBotSecretName }))
      .output(z.array(VaultUse).max(VAULT_ACTIVITY_LIMIT)),
    remove: oc
      .input(settingsScopeInput.extend({ name: StoredBotSecretName }))
      .output(z.object({ ok: z.literal(true) })),
  },
  /** The vault this Space uses, for apps that predate it. The bot only checks access. */
  botSecrets: {
    list: oc.input(z.object({ botId: Id })).output(z.array(BotSecretMetadata)),
    put: oc.input(BotSecretPutInput).output(BotSecretMetadata),
    remove: oc
      .input(z.object({ botId: Id, name: StoredBotSecretName }))
      .output(z.object({ ok: z.literal(true) })),
  },
};
