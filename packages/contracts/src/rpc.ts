import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { ATTACHMENT_MAX_BASE64_LENGTH, ATTACHMENT_MAX_COUNT } from "./attachments.js";
import {
  AppBootstrapSchema,
  ArtifactSchema,
  ArtifactWithContentSchema,
  BotSchema,
  CapabilityInstallSchema,
  ComputerModeSchema,
  ComputerStatusSchema,
  ConnectionCatalogItemSchema,
  ConnectionSchema,
  CreateBotInput,
  CreateRoutineInput,
  DeploymentSettingsSchema,
  ExportManifestSchema,
  MemoryDocumentSchema,
  MeSchema,
  ModelCatalogEntrySchema,
  ModelCredentialSchema,
  RoutineSchema,
  ThreadMessagePageSchema,
  ThreadSnapshotSchema,
  UpdateBotInput,
  UsageRecordSchema,
} from "./domain.js";
import { ProductEventSchema } from "./events.js";
import { Id } from "./ids.js";
import { SearchQueryOutputSchema } from "./search.js";

const botId = z.object({ botId: Id });

export const appContract = {
  health: oc.output(z.object({ ok: z.literal(true), version: z.string() })),
  me: oc.output(MeSchema),
  bootstrap: oc.input(z.object({ botId: Id.optional() })).output(AppBootstrapSchema),
  deployment: {
    get: oc.output(DeploymentSettingsSchema),
    update: oc
      .input(
        z.object({
          signupsEnabled: z.boolean().optional(),
          signupAllowlist: z.array(z.string()).optional(),
          computerHost: z.enum(["docker", "this-mac"]).nullable().optional(),
        }),
      )
      .output(DeploymentSettingsSchema),
  },
  models: {
    list: oc.output(z.array(ModelCatalogEntrySchema)),
    credentials: oc.output(z.array(ModelCredentialSchema)),
    connect: oc
      .input(
        z.object({
          provider: z.string(),
          apiKey: z.string().min(8),
          label: z.string().optional(),
          modelId: z.string().optional(),
        }),
      )
      .output(ModelCredentialSchema),
    beginOAuth: oc
      .input(
        z.object({
          provider: z.string(),
          label: z.string().optional(),
          modelId: z.string().optional(),
        }),
      )
      .output(
        z.object({
          loginId: z.string(),
          verificationUri: z.string().url(),
          userCode: z.string(),
          expiresInSeconds: z.number().int(),
        }),
      ),
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
      .input(z.object({ loginId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    setDefault: oc
      .input(z.object({ provider: z.string(), modelId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
  },
  bots: {
    list: oc.output(z.array(BotSchema)),
    listArchived: oc.output(z.array(BotSchema)),
    get: oc.input(botId).output(BotSchema),
    create: oc.input(CreateBotInput).output(BotSchema),
    duplicate: oc.input(botId).output(BotSchema),
    update: oc.input(UpdateBotInput).output(BotSchema),
    setComputer: oc.input(z.object({ botId: Id, mode: ComputerModeSchema })).output(BotSchema),
    archive: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    remove: oc
      .input(z.object({ botId: Id, deleteMemories: z.boolean().default(false) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  threads: {
    get: oc.input(z.object({ botId: Id })).output(ThreadSnapshotSchema),
    messages: oc
      .input(
        z.object({
          botId: Id,
          before: z.number().int().nonnegative().optional(),
          around: z
            .object({
              messageId: Id.optional(),
              seq: z.number().int().nonnegative().optional(),
            })
            .optional(),
        }),
      )
      .output(ThreadMessagePageSchema),
    subscribe: oc
      .input(z.object({ botId: Id, cursor: z.number().int().min(-1) }))
      .output(eventIterator(ProductEventSchema)),
    send: oc
      .input(
        z
          .object({
            botId: Id,
            text: z.string().optional(),
            artifactIds: z.array(Id).max(ATTACHMENT_MAX_COUNT).optional(),
            clientNonce: z.string().optional(),
          })
          .superRefine((input, ctx) => {
            const text = input.text?.trim() ?? "";
            const artifactIds = input.artifactIds ?? [];
            if (!text && artifactIds.length === 0) {
              ctx.addIssue({
                code: "custom",
                message: "Provide text or at least one attachment",
                path: ["text"],
              });
            }
          }),
      )
      .output(z.object({ taskId: Id, runId: Id, seq: z.number().int() })),
    stop: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    followUp: oc
      .input(z.object({ botId: Id, text: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true) })),
    answer: oc
      .input(z.object({ botId: Id, runId: Id, messageId: Id, answer: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true) })),
    markRead: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    markUnread: oc.input(botId).output(z.object({ ok: z.literal(true) })),
  },
  computer: {
    status: oc.input(botId).output(ComputerStatusSchema),
    boot: oc.input(botId).output(ComputerStatusSchema),
    stop: oc.input(botId).output(ComputerStatusSchema),
    takeover: oc.input(botId).output(z.object({ leaseId: Id, expiresAt: z.string() })),
    release: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    input: oc
      .input(
        z.object({
          botId: Id,
          kind: z.enum(["key", "pointer", "clipboard"]),
          payload: z.record(z.string(), z.unknown()),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    files: oc
      .input(z.object({ botId: Id, path: z.string().default("/") }))
      .output(
        z.array(z.object({ path: z.string(), kind: z.enum(["file", "dir"]), size: z.number() })),
      ),
    readFile: oc
      .input(z.object({ botId: Id, path: z.string() }))
      .output(z.object({ path: z.string(), content: z.string() })),
    screenUrl: oc.input(botId).output(z.object({ url: z.string().nullable() })),
    heartbeat: oc.input(botId).output(z.object({ ok: z.literal(true) })),
  },
  memory: {
    list: oc
      .input(z.object({ botId: Id.optional(), scope: z.enum(["bot", "user"]).optional() }))
      .output(z.array(MemoryDocumentSchema)),
    update: oc
      .input(z.object({ documentId: Id, content: z.string() }))
      .output(MemoryDocumentSchema),
    exportMarkdown: oc.input(z.object({ botId: Id.optional() })).output(z.string()),
  },
  routines: {
    list: oc.input(botId).output(z.array(RoutineSchema)),
    create: oc.input(CreateRoutineInput).output(RoutineSchema),
    update: oc
      .input(
        z.object({
          routineId: Id,
          name: z.string().optional(),
          prompt: z.string().optional(),
          cron: z.string().optional(),
          timezone: z.string().optional(),
          active: z.boolean().optional(),
          notify: z.boolean().optional(),
        }),
      )
      .output(RoutineSchema),
    remove: oc.input(z.object({ routineId: Id })).output(z.object({ ok: z.literal(true) })),
    testRun: oc.input(z.object({ routineId: Id })).output(z.object({ runId: Id })),
  },
  capabilities: {
    list: oc.output(z.array(CapabilityInstallSchema)),
    install: oc
      .input(
        z.object({
          kind: z.enum(["skill", "plugin", "mcp"]),
          name: z.string(),
          source: z.string(),
          config: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .output(CapabilityInstallSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  connections: {
    catalog: oc
      .input(z.object({ query: z.string().optional() }))
      .output(z.array(ConnectionCatalogItemSchema)),
    list: oc.output(z.array(ConnectionSchema)),
    begin: oc
      .input(z.object({ provider: z.string(), displayName: z.string() }))
      .output(z.object({ connectionId: Id, authorizationUrl: z.string().nullable() })),
    complete: oc
      .input(z.object({ connectionId: Id, code: z.string().optional() }))
      .output(ConnectionSchema),
    revoke: oc.input(z.object({ connectionId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  artifacts: {
    list: oc.input(botId).output(z.array(ArtifactSchema)),
    create: oc
      .input(
        z.object({
          botId: Id,
          name: z.string().min(1).max(255),
          mimeType: z.string().min(1),
          contentBase64: z.string().min(1).max(ATTACHMENT_MAX_BASE64_LENGTH),
        }),
      )
      .output(ArtifactSchema),
    get: oc.input(z.object({ botId: Id, artifactId: Id })).output(ArtifactWithContentSchema),
  },
  usage: {
    list: oc.output(z.array(UsageRecordSchema)),
    summary: oc.output(
      z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        runs: z.number(),
      }),
    ),
  },
  export: {
    bot: oc.input(botId).output(ExportManifestSchema),
  },
  notifications: {
    registerPush: oc
      .input(z.object({ token: z.string().min(8).max(512) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  search: {
    query: oc.input(z.object({ q: z.string().max(200) })).output(SearchQueryOutputSchema),
  },
};

export type AppContract = typeof appContract;
