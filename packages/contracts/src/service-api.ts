import * as z from "zod";
import { AuditEventSchema } from "./audit-events.js";
import {
  BoardSchema,
  TicketCommentSchema,
  TicketPrioritySchema,
  TicketSchema,
  TicketStatusSchema,
} from "./board.js";
import {
  ArtifactSchema,
  BotSchema,
  CreateBotInput,
  CreateRoutineInput,
  CreateScratchpadItemInput,
  GroupSchema,
  MemoryDocumentSchema,
  RoutineSchema,
  ScratchpadItemSchema,
  ScratchpadItemStatusSchema,
  TaughtSkillSchema,
  UpdateBotInput,
  UsageSummarySchema,
} from "./domain.js";
import { PageSummarySchema } from "./pages.js";
import { RoutineRunSchema, RunActivityRowSchema } from "./runs.js";
import { SearchHitSchema } from "./search.js";
import type { ServiceScope } from "./service-credentials.js";
import { ServiceScopeSchema } from "./service-credentials.js";

export const SERVICE_API_PREFIX = "/api/service/v1";
export const SERVICE_PROMPT_MAX_LENGTH = 8_000;
export const SERVICE_BODY_MAX_BYTES = 32_768;
const LARGE_BODY_BYTES = 1_100_000;

const nothing = z.object({ ok: z.literal(true) });
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,14})$/)
  .transform(Number);
const pageCursor = z.string().min(1).max(512);

/** Conversation as a person sees it. Tool calls, their results and secrets never leave. */
export const ServiceBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("ask"), text: z.string(), status: z.enum(["pending", "answered"]) }),
  z.object({
    kind: z.literal("file"),
    artifactId: z.string(),
    name: z.string(),
    mimeType: z.string(),
  }),
  z.object({ kind: z.literal("page"), pageId: z.string(), title: z.string() }),
  z.object({ kind: z.literal("bot_message"), fromBotName: z.string(), text: z.string() }),
  z.object({ kind: z.literal("channel_message"), fromLabel: z.string(), text: z.string() }),
  z.object({ kind: z.literal("sent_with_key"), name: z.string() }),
]);
export type ServiceBlock = z.infer<typeof ServiceBlockSchema>;

const ServiceMessageSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  role: z.string(),
  runId: z.string().nullable(),
  blocks: z.array(ServiceBlockSchema),
});

const conversationPage = z.object({
  threadId: z.string(),
  olderCursor: z.number().int().nullable(),
  messages: z.array(ServiceMessageSchema),
});

const ServiceBotSummary = BotSchema.pick({
  id: true,
  name: true,
  description: true,
  color: true,
  status: true,
  archivedAt: true,
  pinned: true,
  computerMode: true,
  modelProvider: true,
  modelId: true,
  thinkingLevel: true,
  replyMode: true,
  notifyOnFinish: true,
  threadId: true,
  createdAt: true,
  updatedAt: true,
});
const ServiceBotDetail = ServiceBotSummary.extend({ instructions: z.string() });

const ServiceGroup = GroupSchema.pick({
  id: true,
  name: true,
  archivedAt: true,
  threadId: true,
  createdAt: true,
  updatedAt: true,
}).extend({ members: z.array(z.object({ botId: z.string(), name: z.string() })) });

const ServiceRoutine = RoutineSchema.pick({
  id: true,
  botId: true,
  name: true,
  prompt: true,
  crons: true,
  timezone: true,
  active: true,
  notify: true,
  webhookEnabled: true,
  githubEnabled: true,
  modelProvider: true,
  modelId: true,
  thinkingLevel: true,
  lastRunAt: true,
  nextRunAt: true,
  createdAt: true,
});

const ServiceRun = RunActivityRowSchema.pick({
  runId: true,
  botId: true,
  groupId: true,
  threadId: true,
  status: true,
  trigger: true,
  promptSnippet: true,
  updatedAt: true,
});

const ServiceComputer = z.object({
  botId: z.string(),
  mode: z.string(),
  state: z.string(),
  controlHolder: z.string(),
  screenAvailable: z.boolean(),
  terminalAvailable: z.boolean(),
  busyBotName: z.string().nullable(),
});

const ServiceSkill = TaughtSkillSchema.pick({
  id: true,
  botId: true,
  name: true,
  goal: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

const ServiceAuditEvent = AuditEventSchema.omit({ ip: true, userAgent: true });

/** How long a call may hold on for a run to settle, in seconds. */
export const SERVICE_WAIT_MAX_SECONDS = 60;
const wait = z
  .string()
  .regex(/^(0|[1-9][0-9]?)$/)
  .transform(Number)
  .refine((seconds) => seconds <= SERVICE_WAIT_MAX_SECONDS, {
    error: `wait is at most ${SERVICE_WAIT_MAX_SECONDS} seconds`,
  });

/** A run with what the bot has said in it so far. */
const ServiceRunDetail = z.object({
  runId: z.string(),
  botId: z.string(),
  threadId: z.string(),
  status: z.string(),
  trigger: z.string(),
  updatedAt: z.string(),
  /** True once nothing more happens without a person: it ended, or it is waiting on a question. */
  settled: z.boolean(),
  messages: z.array(ServiceMessageSchema),
});

export const ServicePromptBody = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(SERVICE_PROMPT_MAX_LENGTH)
    .refine((text) => text === text.trim(), { error: "text must not start or end with space" }),
});

const promptAccepted = z.object({
  /** Null until the message has a run of its own. */
  taskId: z.string().nullable(),
  runId: z.string().nullable(),
  /** The bot was busy, so the message is waiting for a run of its own. */
  held: z.boolean(),
  messageId: z.string(),
  seq: z.number().int(),
  idempotencyKey: z.string(),
});

const shape = UpdateBotInput.shape;
const routineShape = CreateRoutineInput.shape;
const routinePatch = z.strictObject({
  name: routineShape.name.optional(),
  prompt: routineShape.prompt.optional(),
  crons: z.array(z.string().min(1)).optional(),
  timezone: z.string().optional(),
  active: z.boolean().optional(),
  notify: z.boolean().optional(),
  modelProvider: shape.modelProvider,
  modelId: shape.modelId,
  thinkingLevel: shape.thinkingLevel,
});

export type ServiceRouteDefinition = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  /** Null: any valid key. */
  scope: ServiceScope | null;
  summary: string;
  /** Touches more than a single bot, so a key limited to certain bots may not use it. */
  spaceWide?: true;
  /** The bot in the path may be archived. */
  allowArchived?: true;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  /** "stored" replays the first answer; "native" hands the key to the operation itself. */
  idempotency?: "stored" | "native";
  /** Defaults to SERVICE_BODY_MAX_BYTES. */
  maxBodyBytes?: number;
  /** The operation writes its own audit event. */
  selfAudited?: true;
  stream?: true;
};

function route<const R extends ServiceRouteDefinition>(definition: R): R {
  return definition;
}

export const SERVICE_ROUTES = {
  me: route({
    method: "GET",
    path: "/me",
    scope: null,
    summary: "The key making this call",
    response: z.object({
      id: z.string(),
      name: z.string(),
      spaceId: z.string(),
      scopes: z.array(ServiceScopeSchema),
      botIds: z.array(z.string()),
      expiresAt: z.string(),
    }),
  }),
  openapi: route({
    method: "GET",
    path: "/openapi.json",
    scope: null,
    summary: "This API as an OpenAPI 3.1 document",
    response: z.record(z.string(), z.unknown()),
  }),

  listBots: route({
    method: "GET",
    path: "/bots",
    scope: "bots:read",
    summary: "List bots",
    query: z.strictObject({ after: pageCursor.optional(), archived: z.literal("true").optional() }),
    response: z.object({ bots: z.array(ServiceBotSummary), nextCursor: z.string().nullable() }),
  }),
  createBot: route({
    maxBodyBytes: LARGE_BODY_BYTES,
    method: "POST",
    path: "/bots",
    scope: "bots:write",
    summary: "Create a bot",
    spaceWide: true,
    idempotency: "stored",
    body: z.strictObject({
      name: CreateBotInput.shape.name,
      description: CreateBotInput.shape.description.optional(),
      instructions: CreateBotInput.shape.instructions.optional(),
      notifyOnFinish: z.boolean().optional(),
      color: CreateBotInput.shape.color,
    }),
    response: ServiceBotDetail,
  }),
  getBot: route({
    method: "GET",
    path: "/bots/:botId",
    scope: "bots:read",
    summary: "Read a bot and its instructions",
    response: ServiceBotDetail,
  }),
  updateBot: route({
    maxBodyBytes: LARGE_BODY_BYTES,
    method: "PATCH",
    path: "/bots/:botId",
    scope: "bots:write",
    summary: "Change a bot's name, instructions or model",
    body: z.strictObject({
      name: shape.name,
      description: shape.description,
      instructions: shape.instructions,
      expectedInstructions: shape.expectedInstructions,
      notifyOnFinish: shape.notifyOnFinish,
      color: shape.color,
      modelProvider: shape.modelProvider,
      modelId: shape.modelId,
      thinkingLevel: shape.thinkingLevel,
      replyMode: shape.replyMode,
    }),
    response: ServiceBotDetail,
  }),
  archiveBot: route({
    method: "POST",
    path: "/bots/:botId/archive",
    scope: "bots:write",
    summary: "Archive a bot",
    response: nothing,
  }),
  restoreBot: route({
    method: "POST",
    path: "/bots/:botId/restore",
    scope: "bots:write",
    summary: "Restore an archived bot",
    allowArchived: true,
    response: nothing,
  }),
  botStatus: route({
    method: "GET",
    path: "/bots/:botId/status",
    scope: "bots:read",
    summary: "What a bot is doing now",
    response: z.object({
      botId: z.string(),
      name: z.string(),
      threadId: z.string(),
      cursor: z.number().int(),
      runs: z.array(z.object({ id: z.string(), status: z.string() })),
      computer: z.object({ state: z.string(), screenAvailable: z.boolean() }),
    }),
  }),

  botActivity: route({
    method: "GET",
    path: "/bots/:botId/activity",
    scope: "conversations:read",
    summary: "A page of the conversation, newest first by cursor",
    query: z.strictObject({ before: decimal.optional() }),
    response: conversationPage.extend({ botId: z.string() }),
  }),
  botEvents: route({
    method: "GET",
    path: "/bots/:botId/events",
    scope: "conversations:read",
    summary: "Server-sent events as the conversation changes",
    query: z.strictObject({ cursor: decimal.optional() }),
    stream: true,
    response: z.object({
      seq: z.number().int(),
      type: z.string(),
      runId: z.string().nullable(),
      createdAt: z.string(),
      message: z
        .object({ id: z.string(), role: z.string(), blocks: z.array(ServiceBlockSchema) })
        .nullable(),
    }),
  }),
  sendPrompt: route({
    method: "POST",
    path: "/bots/:botId/prompts",
    scope: "prompts:write",
    summary: "Send a bot a message, which is marked as coming from this key",
    idempotency: "native",
    selfAudited: true,
    query: z.strictObject({ wait: wait.optional() }),
    body: ServicePromptBody,
    response: promptAccepted.extend({ botId: z.string(), run: ServiceRunDetail.optional() }),
  }),
  stopBot: route({
    method: "POST",
    path: "/bots/:botId/stop",
    scope: "prompts:write",
    summary: "Stop what a bot is doing",
    response: nothing,
  }),
  listRuns: route({
    method: "GET",
    path: "/runs",
    scope: "conversations:read",
    summary: "Runs that are active or recently ended",
    query: z.strictObject({ filter: z.enum(["active", "recent"]).optional() }),
    response: z.object({ runs: z.array(ServiceRun) }),
  }),
  getRun: route({
    method: "GET",
    path: "/runs/:runId",
    scope: "conversations:read",
    summary: "One run and the bot's replies in it, optionally waiting for it to settle",
    query: z.strictObject({ wait: wait.optional() }),
    response: ServiceRunDetail,
  }),

  getComputer: route({
    method: "GET",
    path: "/bots/:botId/computer",
    scope: "computer:read",
    summary: "The state of a bot's computer",
    response: ServiceComputer,
  }),
  bootComputer: route({
    method: "POST",
    path: "/bots/:botId/computer/boot",
    scope: "computer:write",
    summary: "Start a bot's computer",
    response: ServiceComputer,
  }),
  stopComputer: route({
    method: "POST",
    path: "/bots/:botId/computer/stop",
    scope: "computer:write",
    summary: "Stop a bot's computer",
    response: ServiceComputer,
  }),

  listMemory: route({
    method: "GET",
    path: "/bots/:botId/memory",
    scope: "memory:read",
    summary: "A bot's memory documents",
    response: z.object({ documents: z.array(MemoryDocumentSchema) }),
  }),
  updateMemory: route({
    maxBodyBytes: LARGE_BODY_BYTES,
    method: "PUT",
    path: "/bots/:botId/memory/:documentId",
    scope: "memory:write",
    summary: "Replace a memory document, optionally only at a known revision",
    body: z.strictObject({
      content: z.string().max(1_000_000),
      expectedRevision: z.number().int().positive().optional(),
    }),
    response: MemoryDocumentSchema,
  }),

  listRoutines: route({
    method: "GET",
    path: "/bots/:botId/routines",
    scope: "routines:read",
    summary: "A bot's routines",
    response: z.object({ routines: z.array(ServiceRoutine) }),
  }),
  createRoutine: route({
    maxBodyBytes: LARGE_BODY_BYTES,
    method: "POST",
    path: "/bots/:botId/routines",
    scope: "routines:write",
    summary: "Create a scheduled routine",
    idempotency: "stored",
    body: z.strictObject({
      name: routineShape.name,
      prompt: routineShape.prompt,
      crons: z.array(z.string().min(1)).min(1),
      timezone: z.string().optional(),
      active: z.boolean().optional(),
      notify: z.boolean().optional(),
      modelProvider: routineShape.modelProvider.optional(),
      modelId: routineShape.modelId.optional(),
      thinkingLevel: routineShape.thinkingLevel.optional(),
    }),
    response: ServiceRoutine,
  }),
  updateRoutine: route({
    maxBodyBytes: LARGE_BODY_BYTES,
    method: "PATCH",
    path: "/bots/:botId/routines/:routineId",
    scope: "routines:write",
    summary: "Change a routine",
    body: routinePatch,
    response: ServiceRoutine,
  }),
  routineHistory: route({
    method: "GET",
    path: "/bots/:botId/routines/:routineId/history",
    scope: "routines:read",
    summary: "A routine's past runs",
    query: z.strictObject({ after: pageCursor.optional() }),
    response: z.object({
      runs: z.array(RoutineRunSchema.omit({ error: true })),
      nextCursor: z.string().nullable(),
    }),
  }),
  runRoutine: route({
    method: "POST",
    path: "/bots/:botId/routines/:routineId/run",
    scope: "routines:write",
    summary: "Run a routine once, now",
    idempotency: "native",
    response: z.object({ runId: z.string() }),
  }),

  listArtifacts: route({
    method: "GET",
    path: "/bots/:botId/artifacts",
    scope: "artifacts:read",
    summary: "Files a bot has made or received",
    response: z.object({ artifacts: z.array(ArtifactSchema) }),
  }),
  getArtifact: route({
    method: "GET",
    path: "/bots/:botId/artifacts/:artifactId",
    scope: "artifacts:read",
    summary: "A file with its content in base64",
    response: ArtifactSchema.extend({ contentBase64: z.string() }),
  }),

  listScratchpad: route({
    method: "GET",
    path: "/bots/:botId/scratchpad",
    scope: "scratchpad:read",
    summary: "A bot's scratchpad",
    query: z.strictObject({ status: ScratchpadItemStatusSchema.optional() }),
    response: z.object({ items: z.array(ScratchpadItemSchema) }),
  }),
  createScratchpadItem: route({
    method: "POST",
    path: "/bots/:botId/scratchpad",
    scope: "scratchpad:write",
    summary: "Add a scratchpad item",
    idempotency: "stored",
    body: z.strictObject({
      title: CreateScratchpadItemInput.shape.title,
      status: ScratchpadItemStatusSchema.optional(),
      notes: z.string().max(4_000).optional(),
    }),
    response: ScratchpadItemSchema,
  }),
  updateScratchpadItem: route({
    method: "PATCH",
    path: "/bots/:botId/scratchpad/:itemId",
    scope: "scratchpad:write",
    summary: "Change a scratchpad item",
    body: z.strictObject({
      title: z.string().min(1).max(200).optional(),
      status: ScratchpadItemStatusSchema.optional(),
      notes: z.string().max(4_000).optional(),
    }),
    response: ScratchpadItemSchema,
  }),
  removeScratchpadItem: route({
    method: "DELETE",
    path: "/bots/:botId/scratchpad/:itemId",
    scope: "scratchpad:write",
    summary: "Delete a scratchpad item",
    response: nothing,
  }),

  listSkills: route({
    method: "GET",
    path: "/bots/:botId/skills",
    scope: "skills:read",
    summary: "Skills a bot was taught",
    response: z.object({ skills: z.array(ServiceSkill) }),
  }),
  listPages: route({
    method: "GET",
    path: "/bots/:botId/pages",
    scope: "pages:read",
    summary: "Pages a bot saved",
    query: z.strictObject({ after: z.string().max(500).optional() }),
    response: z.object({
      pages: z.array(z.object(PageSummarySchema.shape)),
      nextCursor: z.string().nullable(),
    }),
  }),

  listGroups: route({
    method: "GET",
    path: "/groups",
    scope: "groups:read",
    summary: "List group chats",
    spaceWide: true,
    response: z.object({ groups: z.array(ServiceGroup) }),
  }),
  createGroup: route({
    method: "POST",
    path: "/groups",
    scope: "groups:write",
    summary: "Create a group chat",
    spaceWide: true,
    idempotency: "stored",
    body: z.strictObject({ name: z.string().min(1).max(80), botIds: z.array(z.string()).max(32) }),
    response: ServiceGroup,
  }),
  getGroup: route({
    method: "GET",
    path: "/groups/:groupId",
    scope: "groups:read",
    summary: "Read a group chat",
    spaceWide: true,
    response: ServiceGroup,
  }),
  updateGroup: route({
    method: "PATCH",
    path: "/groups/:groupId",
    scope: "groups:write",
    summary: "Rename a group or change who is in it",
    spaceWide: true,
    body: z.strictObject({
      name: z.string().min(1).max(80).optional(),
      botIds: z.array(z.string()).max(32).optional(),
    }),
    response: ServiceGroup,
  }),
  archiveGroup: route({
    method: "POST",
    path: "/groups/:groupId/archive",
    scope: "groups:write",
    summary: "Archive a group chat",
    spaceWide: true,
    response: nothing,
  }),
  groupActivity: route({
    method: "GET",
    path: "/groups/:groupId/activity",
    scope: "conversations:read",
    summary: "A page of a group's conversation",
    spaceWide: true,
    query: z.strictObject({ before: decimal.optional() }),
    response: conversationPage.extend({ groupId: z.string() }),
  }),
  sendGroupPrompt: route({
    method: "POST",
    path: "/groups/:groupId/prompts",
    scope: "prompts:write",
    summary: "Send a group a message, which is marked as coming from this key",
    spaceWide: true,
    idempotency: "native",
    selfAudited: true,
    body: ServicePromptBody,
    response: promptAccepted.extend({ groupId: z.string() }),
  }),
  stopGroup: route({
    method: "POST",
    path: "/groups/:groupId/stop",
    scope: "prompts:write",
    summary: "Stop what a group is doing",
    spaceWide: true,
    response: nothing,
  }),

  listBoards: route({
    method: "GET",
    path: "/boards",
    scope: "tickets:read",
    summary: "List ticket boards",
    response: z.object({ boards: z.array(BoardSchema) }),
  }),
  listTickets: route({
    method: "GET",
    path: "/tickets",
    scope: "tickets:read",
    summary: "List tickets",
    query: z.strictObject({
      boardId: z.string().optional(),
      status: TicketStatusSchema.optional(),
      assigneeBotId: z.string().optional(),
      q: z.string().max(200).optional(),
    }),
    response: z.object({ tickets: z.array(TicketSchema) }),
  }),
  createTicket: route({
    method: "POST",
    path: "/tickets",
    scope: "tickets:write",
    summary: "Create a ticket for a bot",
    idempotency: "stored",
    body: z.strictObject({
      boardId: z.string().optional(),
      title: z.string().min(1).max(200),
      description: z.string().max(20_000).optional(),
      priority: TicketPrioritySchema.optional(),
      assigneeBotId: z.string(),
    }),
    response: TicketSchema,
  }),
  getTicket: route({
    method: "GET",
    path: "/tickets/:ticketId",
    scope: "tickets:read",
    summary: "Read a ticket",
    response: TicketSchema,
  }),
  updateTicket: route({
    method: "PATCH",
    path: "/tickets/:ticketId",
    scope: "tickets:write",
    summary: "Change a ticket",
    body: z.strictObject({
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(20_000).nullable().optional(),
      priority: TicketPrioritySchema.nullable().optional(),
      status: TicketStatusSchema.optional(),
      assigneeBotId: z.string().optional(),
    }),
    response: TicketSchema,
  }),
  listTicketComments: route({
    method: "GET",
    path: "/tickets/:ticketId/comments",
    scope: "tickets:read",
    summary: "A ticket's comments",
    response: z.object({ comments: z.array(TicketCommentSchema) }),
  }),
  addTicketComment: route({
    method: "POST",
    path: "/tickets/:ticketId/comments",
    scope: "tickets:write",
    summary: "Comment on a ticket",
    idempotency: "stored",
    body: z.strictObject({ body: z.string().min(1).max(20_000) }),
    response: TicketCommentSchema,
  }),

  usageSummary: route({
    method: "GET",
    path: "/usage/summary",
    scope: "usage:read",
    summary: "Usage totals",
    spaceWide: true,
    response: UsageSummarySchema,
  }),
  search: route({
    method: "GET",
    path: "/search",
    scope: "search:read",
    summary: "Search bots, conversations and files",
    spaceWide: true,
    query: z.strictObject({ q: z.string().min(1).max(200) }),
    response: z.object({ hits: z.array(SearchHitSchema) }),
  }),
  auditEvents: route({
    method: "GET",
    path: "/audit/events",
    scope: "audit:read",
    summary: "The organization's audit log, for those who may read it",
    spaceWide: true,
    query: z.strictObject({
      from: z.string().optional(),
      to: z.string().optional(),
      action: z.string().max(128).optional(),
      actorId: z.string().max(128).optional(),
      cursor: z.string().max(128).optional(),
      limit: decimal.optional(),
    }),
    response: z.object({ events: z.array(ServiceAuditEvent), nextCursor: z.string().nullable() }),
  }),
} as const;

export type ServiceRouteId = keyof typeof SERVICE_ROUTES;

const ERROR_RESPONSE = {
  description: "The call was refused",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const { $schema: _unused, ...document } = z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  return document;
}

/** Generated from the same table the server enforces, so the two cannot disagree. */
export function buildServiceOpenApi(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [operationId, definition] of Object.entries(SERVICE_ROUTES) as Array<
    [string, ServiceRouteDefinition]
  >) {
    const path = definition.path.replace(/:([A-Za-z]+)/g, "{$1}");
    const parameters: unknown[] = [...definition.path.matchAll(/:([A-Za-z]+)/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (definition.query) {
      const query = jsonSchema(definition.query, "input") as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, schema] of Object.entries(query.properties ?? {})) {
        parameters.push({
          name,
          in: "query",
          required: query.required?.includes(name) ?? false,
          schema,
        });
      }
    }
    if (definition.idempotency) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
      });
    }
    const operation: Record<string, unknown> = {
      operationId,
      summary: definition.summary,
      parameters,
      "x-required-scope": definition.scope,
      "x-allowed-for-bot-limited-keys": !definition.spaceWide,
      responses: {
        "200": {
          description: "Success",
          content: {
            [definition.stream ? "text/event-stream" : "application/json"]: {
              schema: jsonSchema(definition.response, "output"),
            },
          },
        },
        default: ERROR_RESPONSE,
      },
    };
    if (definition.body) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: jsonSchema(definition.body, "input") } },
      };
    }
    paths[path] = { ...paths[path], [definition.method.toLowerCase()]: operation };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Rakazo service API", version },
    servers: [{ url: SERVICE_API_PREFIX }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                fields: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { path: { type: "string" }, message: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    paths,
  };
}

export type ServiceTool = {
  name: ServiceRouteId;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Top-level arguments that travel in the query string. */
  queryKeys: string[];
};

/**
 * The same routes as tools for a Model Context Protocol client. Path and query parameters are
 * top-level arguments and the JSON body is `body`, so a tool is exactly its route.
 */
export function buildServiceTools(): ServiceTool[] {
  return (Object.entries(SERVICE_ROUTES) as Array<[ServiceRouteId, ServiceRouteDefinition]>)
    .filter(([id, definition]) => !definition.stream && id !== "openapi")
    .map(([name, definition]) => {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const match of definition.path.matchAll(/:([A-Za-z]+)/g)) {
        const param = match[1] as string;
        properties[param] = { type: "string" };
        required.push(param);
      }
      const query = definition.query
        ? (jsonSchema(definition.query, "input") as {
            properties?: Record<string, unknown>;
            required?: string[];
          })
        : {};
      const queryKeys = Object.keys(query.properties ?? {});
      Object.assign(properties, query.properties);
      required.push(...(query.required ?? []));
      if (definition.body) {
        properties.body = jsonSchema(definition.body, "input");
        required.push("body");
      }
      if (definition.idempotency) {
        properties.idempotencyKey = {
          type: "string",
          pattern: "^[A-Za-z0-9._:-]{1,128}$",
          description:
            "Repeat the same value to retry this exact call safely. One is made up when omitted.",
        };
      }
      return {
        name,
        description: definition.summary,
        inputSchema: { type: "object", properties, required, additionalProperties: false },
        queryKeys,
      };
    });
}
