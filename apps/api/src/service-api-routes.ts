import type { RouterClient } from "@orpc/server";
import type {
  Actor,
  Bot,
  MessageBlock,
  ServiceBlock,
  ServiceRouteId,
  ServiceScope,
} from "@rakazo/contracts";
import {
  buildServiceOpenApi,
  MessageBlock as MessageBlockSchema,
  SERVICE_ROUTES,
} from "@rakazo/contracts";
import { isTerminal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recordAuditEvent, runAsSystem } from "@rakazo/db";
import type { createRouter } from "./router.js";
import type { AuthenticatedServiceCredential } from "./service-credentials.js";

type Routes = typeof SERVICE_ROUTES;
type Client = RouterClient<ReturnType<typeof createRouter>>;
type Parsed<R, Field extends string> =
  R extends Record<Field, { _output: infer Output }> ? Output : undefined;

export class ServiceRejection extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    readonly fields?: Array<{ path: string; message: string }>,
    readonly detail?: string,
  ) {
    super(code);
  }
}

export const SERVICE_ERRORS = {
  invalid_request: [400, "Invalid request."],
  idempotency_key_required: [400, "This call needs a valid Idempotency-Key header."],
  unauthenticated: [401, "Service credential required."],
  forbidden: [403, "This key does not have that scope."],
  bot_limited_key: [403, "A key limited to certain bots cannot make this call."],
  not_permitted: [403, "The person who made this key cannot do that."],
  not_found: [404, "Resource not found."],
  method_not_allowed: [405, "Method not allowed."],
  idempotency_conflict: [409, "Idempotency key already used for a different request."],
  idempotency_in_progress: [409, "The first request with this key has not finished."],
  conflict: [409, "The resource changed. Read it again and retry."],
  payload_too_large: [413, "Request exceeds limits."],
  unsupported_media_type: [415, "Expected application/json."],
  rate_limited: [429, "Too many requests for this key."],
  too_many_streams: [429, "This key has too many open event streams or waiting calls."],
  service_unavailable: [503, "Service unavailable. Retry writes with the same idempotency key."],
} as const;
export type ServiceErrorCode = keyof typeof SERVICE_ERRORS;

export type ServiceContext<Id extends ServiceRouteId> = {
  request: Request;
  abort: AbortController;
  client: Client;
  prisma: PrismaClient;
  actor: Actor;
  credential: AuthenticatedServiceCredential;
  params: Record<string, string>;
  query: Parsed<Routes[Id], "query">;
  body: Parsed<Routes[Id], "body">;
  idempotencyKey: string;
  /** The bot in the path, already checked against this key. Null when the path has none. */
  bot: Bot | null;
  /** Takes one of the key's stream slots; the result gives it back. */
  openStream: () => Promise<() => void>;
};

type Handlers = {
  [Id in ServiceRouteId]: (
    context: ServiceContext<Id>,
  ) => Promise<Routes[Id]["response"]["_input"] | Response>;
};

/** Only what a person sees as the conversation. Tool calls and their results stay private. */
export function projectBlocks(blocks: MessageBlock[]): ServiceBlock[] {
  return blocks.flatMap((block): ServiceBlock[] => {
    switch (block.kind) {
      case "text":
        return [{ kind: "text", text: block.text }];
      case "ask":
        return [{ kind: "ask", text: block.text, status: block.status ?? "pending" }];
      case "image":
      case "file":
        return [
          {
            kind: "file",
            artifactId: block.artifactId,
            name: block.name,
            mimeType: block.mimeType,
          },
        ];
      case "page":
        return [{ kind: "page", pageId: block.pageId, title: block.title }];
      case "bot_message_received":
        return [{ kind: "bot_message", fromBotName: block.fromBotName, text: block.text }];
      case "channel_message":
        return [{ kind: "channel_message", fromLabel: block.fromLabel, text: block.text }];
      case "service_origin":
        return [{ kind: "sent_with_key", name: block.name }];
      default:
        return [];
    }
  });
}

function projectMessage(message: {
  id: string;
  seq: number;
  role: string;
  runId?: string;
  blocks: MessageBlock[];
}) {
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    runId: message.runId ?? null,
    blocks: projectBlocks(message.blocks),
  };
}

function param(context: { params: Record<string, string> }, name: string): string {
  const value = context.params[name];
  if (!value) throw new ServiceRejection("not_found");
  return value;
}

function botOf(context: { bot: Bot | null; params: Record<string, string> }): string {
  return context.bot?.id ?? param(context, "botId");
}

function mayReach(credential: AuthenticatedServiceCredential, botId: string): boolean {
  return credential.botIds.length === 0 || credential.botIds.includes(botId);
}

/** A child id must really belong to the bot in the path, or a limited key could reach past it. */
async function assertOwned(found: Promise<{ id: string } | null>): Promise<void> {
  if (!(await found)) throw new ServiceRejection("not_found");
}

function nonce(credentialId: string, key: string): string {
  return `service:${credentialId}:${key}`;
}

async function sendPrompt(
  context: ServiceContext<"sendPrompt" | "sendGroupPrompt">,
  target: { botId: string } | { groupId: string },
  label: { type: string; id: string; name: string },
) {
  const { client, prisma, actor, credential, idempotencyKey } = context;
  const text = (context.body as { text: string }).text;
  const clientNonce = nonce(credential.id, idempotencyKey);
  const { threadId } = await client.threads.head(target);
  const saved = () =>
    prisma.message.findUnique({
      where: { threadId_clientNonce: { threadId, clientNonce } },
      select: {
        id: true,
        seq: true,
        runId: true,
        blocks: true,
        createdAt: true,
        sourceRuns: { select: { id: true }, take: 1 },
      },
    });
  const existing = await saved();
  const replayed = Boolean(existing);
  // A message still waiting for its run has nothing for the native send to replay, and that send
  // would go on to save it a second time.
  const sent =
    existing && existing.sourceRuns.length === 0 && !existing.runId
      ? { runId: null, seq: existing.seq }
      : await client.threads.send({ ...target, text, clientNonce });
  // After the send, so a concurrent retry that lost the unique nonce is checked as well.
  const message = await saved();
  if (!message) throw new ServiceRejection("idempotency_conflict");
  const blocks = MessageBlockSchema.array().safeParse(message.blocks);
  const savedText = blocks.success && blocks.data[0]?.kind === "text" ? blocks.data[0].text : null;
  if (savedText !== text) throw new ServiceRejection("idempotency_conflict");
  const placement = await placementOf(prisma, message.id, sent.runId);
  // Checked rather than inferred from a replay: the send commits before this point, so a request
  // that failed after it left the message unaudited, and its retry is the one to write it.
  if (!replayed || !(await promptAudited(prisma, credential.id, threadId, message))) {
    await recordAuditEvent({
      action: "service_api.prompt",
      actor: { type: "service", id: credential.id, label: credential.name },
      spaceId: actor.spaceId,
      target: { type: label.type, id: label.id, label: label.name },
      runId: placement.runId ?? undefined,
      threadId,
      metadata: { onBehalfOf: actor.userId, seq: sent.seq },
    });
  }
  return { ...placement, messageId: message.id, seq: sent.seq, idempotencyKey };
}

/** Audit metadata keeps no message ids, so the thread and the message's place in it name it. */
function promptAudited(
  prisma: PrismaClient,
  credentialId: string,
  threadId: string,
  message: { seq: number; createdAt: Date },
): Promise<boolean> {
  return runAsSystem("check a key's prompt audit", async () =>
    Boolean(
      await prisma.auditEvent.findFirst({
        where: {
          action: "service_api.prompt",
          actorType: "service",
          actorId: credentialId,
          threadId,
          createdAt: { gte: message.createdAt },
          metadata: { path: ["seq"], equals: message.seq },
        },
        select: { id: true },
      }),
    ),
  );
}

const WAIT_POLL_MS = 400;

/**
 * The run that will answer this message. While a bot is busy, the send reports the busy run, which
 * is not this message's: it waits in the queue and gets a run of its own once the bot is free.
 */
async function placementOf(
  prisma: ServiceContext<ServiceRouteId>["prisma"],
  messageId: string,
  preferredRunId?: string | null,
) {
  const [started, waiting, saved] = await Promise.all([
    prisma.run.findMany({
      where: { sourceMessageId: messageId },
      orderBy: { createdAt: "asc" },
      select: { id: true, taskId: true },
    }),
    prisma.steeringMessage.findMany({
      where: { messageId, originTrigger: "service" },
      select: { runId: true, run: { select: { id: true, taskId: true } } },
    }),
    prisma.message.findUnique({ where: { id: messageId }, select: { runId: true } }),
  ]);
  // Its waiting row is gone once the shared run has answered it, so the message carries the link.
  const linked =
    !started.length && !waiting.some((row) => row.run) && saved?.runId
      ? await prisma.run.findUnique({
          where: { id: saved.runId },
          select: { id: true, taskId: true },
        })
      : null;
  // Several held messages share one follow-up run, whose source is only the newest of them.
  const run =
    started.find(({ id }) => id === preferredRunId) ??
    started[0] ??
    waiting.find((row) => row.run)?.run ??
    linked;
  return {
    taskId: run?.taskId ?? null,
    runId: run?.id ?? null,
    held: waiting.some((row) => row.runId === null),
  };
}

/**
 * A call that waits polls the database until it returns, so it holds one of the key's stream
 * slots meanwhile; otherwise the request budget alone would let a key keep about 120 waiting.
 */
async function holdingSlot<T>(
  context: Pick<ServiceContext<ServiceRouteId>, "openStream">,
  waitSeconds: number,
  work: () => Promise<T>,
): Promise<T> {
  if (waitSeconds <= 0) return work();
  const release = await context.openStream();
  try {
    return await work();
  } finally {
    release();
  }
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
}

/** Follows a held message until it has a run of its own, is dropped by a stop, or time is up. */
async function awaitPlacement(
  context: Pick<ServiceContext<ServiceRouteId>, "prisma" | "abort">,
  messageId: string,
  placement: Awaited<ReturnType<typeof placementOf>>,
  deadline: number,
) {
  let current = placement;
  while (!current.runId && current.held && Date.now() < deadline && !context.abort.signal.aborted) {
    await pause();
    current = await placementOf(context.prisma, messageId);
  }
  return current;
}

/** One of the creator's own runs that this key may reach, with the bot's replies in it. */
async function runDetail(
  context: Pick<ServiceContext<ServiceRouteId>, "prisma" | "actor" | "credential" | "abort">,
  runId: string,
  waitSeconds: number,
) {
  const { prisma, actor, credential, abort } = context;
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const run = await prisma.run.findFirst({
      where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
      select: {
        id: true,
        botId: true,
        threadId: true,
        status: true,
        trigger: true,
        updatedAt: true,
        thread: { select: { groupId: true } },
      },
    });
    if (!run || !mayReach(credential, run.botId)) throw new ServiceRejection("not_found");
    // Group chats are refused to a key limited to some bots, and their runs with them.
    if (credential.botIds.length && run.thread.groupId) throw new ServiceRejection("not_found");
    const settled = isTerminal(run.status) || run.status === "waiting_input";
    if (settled || Date.now() >= deadline || abort.signal.aborted) {
      const messages = await prisma.message.findMany({
        where: { threadId: run.threadId, runId: run.id, role: { not: "user" } },
        orderBy: { seq: "asc" },
        take: 100,
        select: { id: true, seq: true, role: true, runId: true, blocks: true },
      });
      return {
        runId: run.id,
        botId: run.botId,
        threadId: run.threadId,
        status: run.status,
        trigger: run.trigger,
        updatedAt: run.updatedAt.toISOString(),
        settled,
        messages: messages.flatMap((message) => {
          const blocks = MessageBlockSchema.array().safeParse(message.blocks);
          return blocks.success
            ? [
                projectMessage({
                  ...message,
                  runId: message.runId ?? undefined,
                  blocks: blocks.data,
                }),
              ]
            : [];
        }),
      };
    }
    await pause();
  }
}

const FORWARDED_EVENTS = new Set([
  "thread.message.created",
  "thread.message.updated",
  "thread.cleared",
  "run.started",
  "run.waiting_input",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

const STREAM_MS = 15 * 60 * 1000;

function eventFrame(event: {
  seq: number;
  type: string;
  runId?: string | null;
  createdAt: string;
  payload: unknown;
}): string | null {
  if (!FORWARDED_EVENTS.has(event.type)) return null;
  const payload = (event.payload ?? {}) as { messageId?: string; role?: string; blocks?: unknown };
  const blocks = MessageBlockSchema.array().safeParse(payload.blocks);
  const message =
    payload.messageId && payload.role && blocks.success
      ? { id: payload.messageId, role: payload.role, blocks: projectBlocks(blocks.data) }
      : null;
  const data = JSON.stringify({
    seq: event.seq,
    type: event.type,
    runId: event.runId ?? null,
    createdAt: event.createdAt,
    message,
  });
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

async function streamBotEvents(context: ServiceContext<"botEvents">): Promise<Response> {
  const { client, abort, request } = context;
  const botId = botOf(context);
  const resumed = request.headers.get("last-event-id");
  const cursor =
    context.query?.cursor ??
    (resumed && /^(0|[1-9][0-9]{0,14})$/.test(resumed)
      ? Number(resumed)
      : (await client.threads.head({ botId })).cursor);
  const release = await context.openStream();
  const timer = setTimeout(() => abort.abort(), STREAM_MS);
  const finish = () => {
    clearTimeout(timer);
    release();
  };
  let events: Awaited<ReturnType<Client["threads"]["subscribe"]>>;
  try {
    events = await client.threads.subscribe({ botId, cursor });
  } catch (error) {
    finish();
    throw error;
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Headers leave with the first bytes. Without this a quiet bot looks like a hung connection.
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    async pull(controller) {
      try {
        for (;;) {
          const next = await events.next();
          if (next.done) break;
          if (next.value.type === "heartbeat") {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            return;
          }
          const frame = eventFrame(next.value);
          if (frame) {
            controller.enqueue(encoder.encode(frame));
            return;
          }
        }
      } catch {
        // A revoked key, a timeout and a closed connection all end the stream the same way.
      }
      finish();
      controller.close();
    },
    async cancel() {
      finish();
      abort.abort();
      await events.return?.(undefined).catch(() => undefined);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

function encodeCursor(cursor: unknown): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

function decodeCursor(cursor: string | undefined): { id: string; createdAt: string } | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ServiceRejection("invalid_request");
  }
}

const BOT_PAGE_SIZE = 200;
const RECENT_RUNS = 5;

export const SERVICE_HANDLERS: Handlers = {
  async me({ credential }) {
    return {
      id: credential.id,
      name: credential.name,
      spaceId: credential.spaceId,
      scopes: credential.scopes as ServiceScope[],
      botIds: credential.botIds,
      expiresAt: credential.expiresAt,
    };
  },
  async openapi() {
    return buildServiceOpenApi("1");
  },

  async listBots({ client, credential, query }) {
    const all = query?.archived ? await client.bots.listArchived() : await client.bots.list();
    const visible = all
      .filter((bot) => mayReach(credential, bot.id))
      .filter((bot) => !query?.after || bot.id > query.after)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const page = visible.slice(0, BOT_PAGE_SIZE);
    return {
      bots: page,
      nextCursor: visible.length > BOT_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
    };
  },
  async createBot({ client, body }) {
    return client.bots.create(body as Parameters<Client["bots"]["create"]>[0]);
  },
  async getBot(context) {
    if (!context.bot) throw new ServiceRejection("not_found");
    return context.bot;
  },
  async updateBot(context) {
    return context.client.bots.update({ botId: botOf(context), ...context.body });
  },
  async archiveBot(context) {
    return context.client.bots.archive({ botId: botOf(context) });
  },
  async restoreBot(context) {
    return context.client.bots.restore({ botId: botOf(context) });
  },
  async botStatus(context) {
    const { client, prisma, actor, credential } = context;
    if (!context.bot) throw new ServiceRejection("not_found");
    const botId = context.bot.id;
    // The computer's state is for keys that may read the computer, and runs for keys that may
    // read conversations.
    const readsComputer = credential.scopes.includes("computer:read");
    const readsRuns = credential.scopes.includes("conversations:read");
    const [head, computer, runs] = await Promise.all([
      client.threads.head({ botId }),
      readsComputer ? client.computer.status({ botId }) : null,
      readsRuns
        ? prisma.run.findMany({
            // Only the creator's runs, as everywhere else a key reads runs.
            where: { botId, spaceId: actor.spaceId, userId: actor.userId },
            select: { id: true, status: true },
            orderBy: [{ createdAt: "desc" }, { id: "asc" }],
            take: RECENT_RUNS,
          })
        : null,
    ]);
    return {
      botId,
      name: context.bot.name,
      threadId: head.threadId,
      cursor: head.cursor,
      ...(runs ? { runs } : {}),
      ...(computer
        ? { computer: { state: computer.state, screenAvailable: computer.screenAvailable } }
        : {}),
    };
  },

  async botActivity(context) {
    const botId = botOf(context);
    const before = context.query?.before;
    const page = await context.client.threads.messages({
      botId,
      ...(before === undefined ? {} : { before }),
    });
    return {
      botId,
      threadId: page.threadId,
      olderCursor: page.olderCursor,
      messages: page.messages.map(projectMessage),
    };
  },
  botEvents: streamBotEvents,
  async sendPrompt(context) {
    const bot = context.bot;
    if (!bot) throw new ServiceRejection("not_found");
    const waitSeconds = context.query?.wait;
    // Waiting returns the bot's reply, which is conversation content. Both checks come before the
    // send, so a refused call sends nothing.
    if (waitSeconds !== undefined && !context.credential.scopes.includes("conversations:read")) {
      throw new ServiceRejection("forbidden");
    }
    const send = () =>
      sendPrompt(context as never, { botId: bot.id }, { type: "bot", id: bot.id, name: bot.name });
    if (waitSeconds === undefined) return { botId: bot.id, ...(await send()) };
    return holdingSlot(context, waitSeconds, async () => {
      const sent = await send();
      const deadline = Date.now() + waitSeconds * 1000;
      const placement = await awaitPlacement(context, sent.messageId, sent, deadline);
      const remaining = Math.max(0, (deadline - Date.now()) / 1000);
      return {
        botId: bot.id,
        ...sent,
        ...placement,
        ...(placement.runId ? { run: await runDetail(context, placement.runId, remaining) } : {}),
      };
    });
  },
  async stopBot(context) {
    return context.client.threads.stop({ botId: botOf(context) });
  },
  async listRuns({ client, credential, query }) {
    const { runs } = await client.runs.list({ filter: query?.filter ?? "active" });
    // Group chats are refused to a key limited to some bots, and their runs with them.
    return {
      runs: runs.filter(
        (run) => mayReach(credential, run.botId) && (!credential.botIds.length || !run.groupId),
      ),
    };
  },

  async getRun(context) {
    const waitSeconds = context.query?.wait ?? 0;
    return holdingSlot(context, waitSeconds, () =>
      runDetail(context, param(context, "runId"), waitSeconds),
    );
  },

  async getComputer(context) {
    return context.client.computer.status({ botId: botOf(context) });
  },
  async bootComputer(context) {
    return context.client.computer.boot({ botId: botOf(context) });
  },
  async stopComputer(context) {
    return context.client.computer.stop({ botId: botOf(context) });
  },

  async listMemory(context) {
    const documents = await context.client.memory.list({ botId: botOf(context), scope: "bot" });
    return { documents };
  },
  async updateMemory(context) {
    const documentId = param(context, "documentId");
    await assertOwned(
      context.prisma.memoryDocument.findFirst({
        where: { id: documentId, botId: botOf(context), spaceId: context.actor.spaceId },
        select: { id: true },
      }),
    );
    return context.client.memory.update({ documentId, ...context.body });
  },

  async listRoutines(context) {
    return { routines: await context.client.routines.list({ botId: botOf(context) }) };
  },
  async createRoutine(context) {
    return context.client.routines.create({
      botId: botOf(context),
      ...context.body,
    } as Parameters<Client["routines"]["create"]>[0]);
  },
  async updateRoutine(context) {
    const routineId = param(context, "routineId");
    await assertRoutine(context, routineId);
    return context.client.routines.update({ routineId, ...context.body });
  },
  async routineHistory(context) {
    const routineId = param(context, "routineId");
    await assertRoutine(context, routineId);
    const before = decodeCursor(context.query?.after);
    const page = await context.client.routines.history({
      routineId,
      ...(before ? { before } : {}),
    });
    return { runs: page.runs, nextCursor: encodeCursor(page.nextCursor) };
  },
  async runRoutine(context) {
    const routineId = param(context, "routineId");
    await assertRoutine(context, routineId);
    return context.client.routines.testRun({
      routineId,
      clientNonce: nonce(context.credential.id, context.idempotencyKey),
    });
  },

  async listArtifacts(context) {
    return { artifacts: await context.client.artifacts.list({ botId: botOf(context) }) };
  },
  async getArtifact(context) {
    return context.client.artifacts.get({
      botId: botOf(context),
      artifactId: param(context, "artifactId"),
    });
  },

  async listScratchpad(context) {
    const items = await context.client.scratchpad.list({
      botId: botOf(context),
      includeDone: true,
      ...(context.query?.status ? { status: context.query.status } : {}),
    });
    return { items };
  },
  async createScratchpadItem(context) {
    return context.client.scratchpad.create({
      botId: botOf(context),
      ...context.body,
    } as Parameters<Client["scratchpad"]["create"]>[0]);
  },
  async updateScratchpadItem(context) {
    const itemId = param(context, "itemId");
    await assertScratchpadItem(context, itemId);
    return context.client.scratchpad.update({ itemId, ...context.body });
  },
  async removeScratchpadItem(context) {
    const itemId = param(context, "itemId");
    await assertScratchpadItem(context, itemId);
    return context.client.scratchpad.remove({ itemId });
  },

  async listSkills(context) {
    return { skills: await context.client.skills.list({ botId: botOf(context) }) };
  },
  async listPages(context) {
    const after = context.query?.after;
    const page = await context.client.pages.list({
      botId: botOf(context),
      ...(after ? { cursor: after } : {}),
    });
    return { pages: page.items, nextCursor: page.nextCursor };
  },

  async listGroups({ client }) {
    return { groups: await client.groups.list() };
  },
  async createGroup({ client, body }) {
    return client.groups.create(body as Parameters<Client["groups"]["create"]>[0]);
  },
  async getGroup(context) {
    return context.client.groups.get({ groupId: param(context, "groupId") });
  },
  async updateGroup(context) {
    return context.client.groups.update({ groupId: param(context, "groupId"), ...context.body });
  },
  async archiveGroup(context) {
    return context.client.groups.archive({ groupId: param(context, "groupId") });
  },
  async groupActivity(context) {
    const groupId = param(context, "groupId");
    const before = context.query?.before;
    const page = await context.client.threads.messages({
      groupId,
      ...(before === undefined ? {} : { before }),
    });
    return {
      groupId,
      threadId: page.threadId,
      olderCursor: page.olderCursor,
      messages: page.messages.map(projectMessage),
    };
  },
  async sendGroupPrompt(context) {
    const groupId = param(context, "groupId");
    const group = await context.client.groups.get({ groupId });
    const sent = await sendPrompt(
      context as never,
      { groupId },
      { type: "group", id: groupId, name: group.name },
    );
    return { groupId, ...sent };
  },
  async stopGroup(context) {
    return context.client.threads.stop({ groupId: param(context, "groupId") });
  },

  async listBoards({ client }) {
    return { boards: await client.boards.list() };
  },
  async listTickets({ client, credential, query }) {
    const { tickets } = await client.tickets.list(query ?? {});
    return {
      tickets: tickets.filter((ticket) => mayReach(credential, ticket.assigneeBotId ?? "")),
    };
  },
  async createTicket({ client, credential, body }) {
    const input = body as Parameters<Client["tickets"]["create"]>[0];
    if (!mayReach(credential, input.assigneeBotId)) throw new ServiceRejection("not_found");
    return client.tickets.create(input);
  },
  async getTicket(context) {
    return reachableTicket(context, param(context, "ticketId"));
  },
  async updateTicket(context) {
    const id = param(context, "ticketId");
    await reachableTicket(context, id);
    const assignee = context.body?.assigneeBotId;
    if (assignee && !mayReach(context.credential, assignee)) {
      throw new ServiceRejection("not_found");
    }
    return context.client.tickets.update({ id, ...context.body });
  },
  async listTicketComments(context) {
    const ticketId = param(context, "ticketId");
    await reachableTicket(context, ticketId);
    return { comments: await context.client.tickets.comments({ ticketId }) };
  },
  async addTicketComment(context) {
    const ticketId = param(context, "ticketId");
    await reachableTicket(context, ticketId);
    return context.client.tickets.comment({
      ticketId,
      body: (context.body as { body: string }).body,
    });
  },

  async usageSummary({ client }) {
    return client.usage.summary();
  },
  async search({ client, query }) {
    return client.search.query({ q: (query as { q: string }).q });
  },
  async auditEvents({ client, query }) {
    return client.audit.events({ limit: 100, ...query });
  },
};

function assertRoutine(
  context: ServiceContext<"updateRoutine" | "routineHistory" | "runRoutine">,
  routineId: string,
): Promise<void> {
  return assertOwned(
    context.prisma.routine.findFirst({
      where: { id: routineId, botId: botOf(context), spaceId: context.actor.spaceId },
      select: { id: true },
    }),
  );
}

function assertScratchpadItem(
  context: ServiceContext<"updateScratchpadItem" | "removeScratchpadItem">,
  itemId: string,
): Promise<void> {
  return assertOwned(
    context.prisma.scratchpadItem.findFirst({
      where: { id: itemId, botId: botOf(context) },
      select: { id: true },
    }),
  );
}

async function reachableTicket(
  context: ServiceContext<"getTicket" | "updateTicket" | "listTicketComments" | "addTicketComment">,
  id: string,
) {
  const ticket = await context.client.tickets.get({ id });
  if (!mayReach(context.credential, ticket.assigneeBotId ?? "")) {
    throw new ServiceRejection("not_found");
  }
  return ticket;
}

export const SERVICE_ROUTE_TABLE = Object.entries(SERVICE_ROUTES).map(([id, definition]) => ({
  id: id as ServiceRouteId,
  definition,
  pattern: new RegExp(
    `^${definition.path.replace(/:([A-Za-z]+)/g, "(?<$1>[A-Za-z0-9_-]{1,128})")}$`,
  ),
}));
