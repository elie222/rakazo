import { oc } from "@orpc/contract";
import * as z from "zod";
import { AnalyticsSurface, ModelSignInCancelReason } from "../account/analytics.js";
import { Id, ThinkingLevelSchema } from "../ids.js";
import { SettingsScopeSchema, settingsScopeInput } from "../settings-scope.js";
import { DeploymentModelSettingsSchema, DeploymentModelUpdateSchema } from "./deployment-model.js";
import {
  ModelApiProtocolSchema,
  ModelCatalogEntrySchema,
  ModelConnectInputSchema,
  ModelConnectionLabelSchema,
  ModelConnectionTargetSchema,
  ModelCredentialSchema,
  ModelOAuthBeginSchema,
  ModelSettingsSaveSchema,
  modelChoiceListSchema,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "./model-connections.js";
import { ModelHeadersSchema } from "./model-headers.js";
import {
  ModelRoleChoiceSchema,
  ModelRoleSchema,
  ModelRoleUpdateSchema,
  ModelRoleViewSchema,
} from "./model-roles.js";
import {
  MAX_TRANSCRIPTION_VOCABULARY_LENGTH,
  VoiceCatalogEntrySchema,
  VoiceCredentialSchema,
  VoiceInfoSchema,
  VoiceModelInfoSchema,
  VoiceStatusSchema,
} from "./voice.js";

export const modelsRpc = {
  models: {
    forRole: oc
      .input(z.object({ role: ModelRoleSchema, expectedUserId: Id.optional() }))
      .output(z.array(ModelCatalogEntrySchema)),
    role: oc
      .input(
        z.object({
          role: ModelRoleSchema,
          expectedUserId: Id.optional(),
          scope: SettingsScopeSchema.optional(),
        }),
      )
      .output(ModelRoleViewSchema),
    setRole: oc
      .input(
        ModelRoleUpdateSchema.extend({
          role: ModelRoleSchema,
          expectedUserId: Id.optional(),
          scope: SettingsScopeSchema.optional(),
        }),
      )
      .output(ModelRoleViewSchema),
    list: oc.output(z.array(ModelCatalogEntrySchema)),
    credentials: oc.output(z.array(ModelCredentialSchema)),
    backups: oc.output(z.array(ModelRoleChoiceSchema)),
    setBackups: oc
      .input(modelChoiceListSchema(ModelRoleChoiceSchema))
      .output(z.object({ ok: z.literal(true) })),
    connect: oc
      .input(ModelConnectInputSchema.and(z.object({ surface: AnalyticsSurface.optional() })))
      .output(ModelCredentialSchema),
    probeOpenAiCompatible: oc
      .input(
        z.object({
          baseUrl: z.string(),
          credentialId: z.string().optional(),
          headers: ModelHeadersSchema.optional(),
          apiKey: z.string().optional(),
          apiProtocol: ModelApiProtocolSchema.optional(),
        }),
      )
      .output(z.object({ models: z.array(z.string()) })),
    probeCatalog: oc
      .input(
        z.object({
          provider: z.string().trim().min(1),
          apiKey: z.string().trim().min(8),
        }),
      )
      .output(z.object({ models: z.array(z.string()) })),
    beginOAuth: oc
      .input(
        z.object({
          provider: z.string(),
          label: z.string().optional(),
          /** Signs an existing connection in again; null adds another, as connect does. */
          credentialId: ModelConnectionTargetSchema,
          modelId: z.string().optional(),
          thinkingLevel: ThinkingLevelSchema.nullable().optional(),
          makeDefault: z.boolean().optional(),
          scope: SettingsScopeSchema.optional(),
          /** No loopback listener (web, mobile): the provider shows a code to paste instead. */
          codePage: z.boolean().optional(),
          surface: AnalyticsSurface.optional(),
        }),
      )
      .output(ModelOAuthBeginSchema),
    submitOAuthCode: oc
      .input(z.object({ loginId: z.string(), code: z.string().trim().min(1).max(8_192) }))
      .output(z.object({ ok: z.literal(true) })),
    completeOAuth: oc
      .input(z.object({ loginId: z.string() }))
      .output(
        z.discriminatedUnion("status", [
          z.object({ status: z.literal("pending") }),
          z.object({ status: z.literal("ready") }),
          z.object({ status: z.literal("error"), error: z.string() }),
        ]),
      ),
    finishOAuth: oc.input(z.object({ loginId: z.string() })).output(ModelCredentialSchema),
    cancelOAuth: oc
      .input(z.object({ loginId: z.string(), reason: ModelSignInCancelReason.optional() }))
      .output(z.object({ ok: z.literal(true) })),
    setDefault: oc
      .input(
        z.object({
          provider: z.string(),
          modelId: z.string(),
          thinkingLevel: ThinkingLevelSchema.nullable().optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    rename: oc
      .input(z.object({ credentialId: Id, label: ModelConnectionLabelSchema }))
      .output(z.object({ ok: z.literal(true) })),
    saveModelSettings: oc.input(ModelSettingsSaveSchema).output(z.object({ ok: z.literal(true) })),
    /** Removes one connection, or every connection of the provider when older apps omit it. */
    disconnect: oc
      .input(z.object({ provider: z.string().trim().min(1), credentialId: Id.optional() }))
      .output(z.object({ ok: z.literal(true) })),
    /** Admin choice of the model members without their own run on, over the environment's. */
    deployment: {
      get: oc.output(DeploymentModelSettingsSchema),
      update: oc.input(DeploymentModelUpdateSchema).output(DeploymentModelSettingsSchema),
    },
  },
  voice: {
    catalog: oc.output(z.array(VoiceCatalogEntrySchema)),
    status: oc.input(settingsScopeInput.optional()).output(VoiceStatusSchema),
    credentials: oc.input(settingsScopeInput.optional()).output(z.array(VoiceCredentialSchema)),
    connect: oc
      .input(
        z
          .object({
            provider: z.string(),
            /**
             * Optional for a self-hosted server, for providers without keys, and for a provider
             * the account's model connection authenticates (the catalog's `modelConnection`).
             */
            apiKey: z.string().max(4096).default(""),
            voiceId: z.string().max(120).optional(),
            speechModel: z.string().max(64).optional(),
            /** Self-hosted (OpenAI-compatible) server address and model ids. */
            baseUrl: z.string().max(2048).optional(),
            /** Blank means the server at `baseUrl` transcribes; omitted keeps the saved one. */
            sttBaseUrl: z.string().max(2048).optional(),
            /** Sent only to the transcription server; blank keeps the saved one. */
            sttApiKey: z.string().max(4096).optional(),
            ttsModel: z.string().max(200).optional(),
            sttModel: z.string().max(200).optional(),
            /** Omitted keeps the hint for the same server. Blank clears it. */
            transcriptionVocabulary: z
              .string()
              .trim()
              .max(MAX_TRANSCRIPTION_VOCABULARY_LENGTH)
              .optional(),
            /** Where the connection becomes the default voice. */
            scope: SettingsScopeSchema.optional(),
          })
          .superRefine((input, ctx) => {
            // Hosted keys are checked by the server, which knows which providers are keyless.
            if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID && !input.baseUrl?.trim()) {
              ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter a server URL." });
            }
          }),
      )
      .output(VoiceCredentialSchema),
    disconnect: oc
      .input(z.object({ provider: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true) })),
    setVoice: oc
      .input(
        settingsScopeInput.extend({
          voiceId: z.string().min(1).max(120),
          provider: z.string().optional(),
        }),
      )
      .output(VoiceStatusSchema),
    setSpeechModel: oc
      .input(
        settingsScopeInput.extend({
          provider: z.string().min(1),
          speechModel: z.string().max(64),
        }),
      )
      .output(VoiceCredentialSchema),
    voices: oc
      .input(
        settingsScopeInput.extend({
          provider: z.string().optional(),
          /** BCP-47 tag or ISO 639-1 code; providers narrow it to what they support. */
          language: z.string().max(35).optional(),
        }),
      )
      .output(z.array(VoiceInfoSchema)),
    models: oc
      .input(settingsScopeInput.extend({ provider: z.string().min(1) }))
      .output(z.array(VoiceModelInfoSchema)),
    prepare: oc
      .input(
        z.object({
          text: z.string().max(20000),
          voiceId: z.string().max(120).optional(),
          botId: Id.optional(),
          scope: SettingsScopeSchema.optional(),
        }),
      )
      .output(z.object({ ready: z.boolean(), utterances: z.array(z.string()) })),
  },
};
