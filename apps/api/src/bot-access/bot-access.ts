import { randomUUID } from "node:crypto";
import { createRouterClient, ORPCError, onError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { taskCallbackJob } from "@rakazo/adapter-kit";
import {
  assertCallbackUrl,
  readPublicTask,
  TASK_CALLBACK_RECHECK_MS,
  taskCallbackSecret,
} from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type { Actor, PublicBot, PublicTask } from "@rakazo/contracts";
import { taskSettled } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { clientErrorStatus } from "../client-error-status.js";
import type { createRouter } from "../router.js";
import { handleRpcError } from "../rpc-errors.js";

/** The person a request's API key acts for. */
export type KeyCaller = { userId: string; email: string; keyId: string };

/** Why a request was refused before it reached a bot, answered as each surface's own error. */
export class ApiKeyRefusal extends ClientError {
  constructor(
    kind: "UNAUTHORIZED" | "TOO_MANY_REQUESTS",
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(kind, message);
  }
}

/** The key a request presents: `Authorization: Bearer <key>`, as OpenAI clients send it. */
export function presentedApiKey(headers: Headers): string | null {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "")?.[1];
  return bearer ?? headers.get("x-api-key")?.trim() ?? null;
}

/**
 * How a public API surface answers a failure: a refusal the caller can act on keeps its status
 * and message; anything else is a server error, which propagates to be logged.
 */
export function publicApiFailure(
  error: unknown,
): { status: number; message: string; retryAfterSeconds?: number } | null {
  if (error instanceof ApiKeyRefusal)
    return {
      status: clientErrorStatus(error.kind),
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  if (error instanceof ClientError)
    return { status: clientErrorStatus(error.kind), message: error.message };
  if (error instanceof ORPCError && (error.status < 500 || error.status === 503))
    return { status: error.status, message: error.message };
  return null;
}

/** Thread events after which a task may read differently. Progress and activity change nothing. */
const TASK_EVENTS = new Set([
  "thread.message.created",
  "thread.message.updated",
  "thread.ask",
  "thread.choice",
  "run.started",
  "run.waiting_input",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export type BotAccessDeps = {
  prisma: PrismaClient;
  auth: Pick<Auth, "verifyApiKey">;
  router: ReturnType<typeof createRouter>;
  jobs: Pick<JobPublisher, "enqueueIn">;
  /** Derives each callback's signing secret; see `taskCallbackRootKey`. */
  taskCallbackRootKey: string;
};

/**
 * What an API key can do with the bots its person can use. Every bot action goes through the
 * app's own procedures as that person, in the Space the bot is in, so a key sees exactly what
 * its person sees and a turn runs the way a message from the app does.
 */
export function createBotAccess(deps: BotAccessDeps) {
  const { prisma } = deps;

  async function authenticate(headers: Headers): Promise<KeyCaller> {
    const key = presentedApiKey(headers);
    if (!key) throw new ApiKeyRefusal("UNAUTHORIZED", "Missing API key");
    const verified = await deps.auth.verifyApiKey(key);
    if (!verified.ok) {
      if (verified.reason === "rate_limited")
        throw new ApiKeyRefusal(
          "TOO_MANY_REQUESTS",
          "Too many requests for this API key",
          Math.max(1, Math.ceil(verified.retryAfterMs / 1000)),
        );
      throw new ApiKeyRefusal("UNAUTHORIZED", "Invalid API key");
    }
    const user = await prisma.user.findUnique({
      where: { id: verified.userId },
      select: { email: true, deactivatedAt: true },
    });
    // The directory turned the account off: its keys stop with its sessions.
    if (!user || user.deactivatedAt) throw new ApiKeyRefusal("UNAUTHORIZED", "Invalid API key");
    return { userId: verified.userId, email: user.email, keyId: verified.keyId };
  }

  /** The member the caller is in a Space, or nothing once they left it or it is being deleted. */
  async function memberActor(caller: KeyCaller, spaceId: string): Promise<Actor | null> {
    const membership = await prisma.spaceMember.findFirst({
      where: { userId: caller.userId, spaceId, space: { deletingAt: null } },
      select: { spaceId: true },
    });
    return membership
      ? { userId: caller.userId, spaceId, email: caller.email, isDeploymentOwner: false }
      : null;
  }

  function client(caller: KeyCaller, actor: Actor, signal?: AbortSignal) {
    return createRouterClient(deps.router, {
      // Domain errors become the same answers the app's own requests get.
      interceptors: [onError((error, { path }) => handleRpcError(error, path, signal))],
      context: {
        actor,
        signal,
        // A long wait ends when the key is revoked or the person leaves the Space.
        stillAuthorized: async () =>
          Boolean(
            (await prisma.apiKey.findFirst({
              where: { id: caller.keyId, referenceId: caller.userId, enabled: { not: false } },
              select: { id: true },
            })) && (await memberActor(caller, actor.spaceId)),
          ),
      },
    });
  }

  async function spaceActors(caller: KeyCaller) {
    const memberships = await prisma.spaceMember.findMany({
      where: { userId: caller.userId, space: { deletingAt: null } },
      orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }],
      select: { spaceId: true, space: { select: { name: true } } },
    });
    return memberships.map(({ spaceId, space }) => ({
      actor: { userId: caller.userId, spaceId, email: caller.email, isDeploymentOwner: false },
      spaceName: space.name,
    }));
  }

  async function listBots(caller: KeyCaller): Promise<Array<PublicBot & { actor: Actor }>> {
    const spaces = await spaceActors(caller);
    const listed = await Promise.all(
      spaces.map(async ({ actor, spaceName }) =>
        (await client(caller, actor).bots.list()).map((bot) => ({
          id: bot.id,
          name: bot.name,
          space: { id: actor.spaceId, name: spaceName },
          actor,
        })),
      ),
    );
    return listed.flat();
  }

  /** A bot by id, or by a name only one of the caller's bots has. */
  async function resolveBot(caller: KeyCaller, ref: string) {
    const bots = await listBots(caller);
    const byId = bots.find((bot) => bot.id === ref);
    if (byId) return byId;
    const named = bots.filter((bot) => bot.name.toLowerCase() === ref.toLowerCase());
    if (named.length === 1) return named[0]!;
    if (named.length > 1)
      throw new ClientError("BAD_REQUEST", "More than one bot has that name; use its id");
    throw new ClientError("NOT_FOUND", "No bot with that id or name");
  }

  /** The task's Space as its owner's member, found by a narrow lookup that spans Spaces. */
  async function taskActor(caller: KeyCaller, taskId: string) {
    const task = await runAsSystem("find the Space of an API caller's task", () =>
      prisma.task.findFirst({
        where: { id: taskId, userId: caller.userId },
        select: { spaceId: true, botId: true },
      }),
    );
    const actor = task && (await memberActor(caller, task.spaceId));
    if (!task || !actor) throw new ClientError("NOT_FOUND", "No task with that id");
    return { actor, botId: task.botId };
  }

  async function readTask(actor: Actor, taskId: string): Promise<PublicTask> {
    const task = await runAsTenant(actor, () =>
      readPublicTask(prisma, { taskId, userId: actor.userId, spaceId: actor.spaceId }),
    );
    if (!task) throw new ClientError("NOT_FOUND", "No task with that id");
    return task;
  }

  /**
   * The person's own task for a message they sent. A send names the run that holds the chat,
   * which in a shared Space can be another member's; the message itself names its own run.
   */
  async function ownTaskId(
    actor: Actor,
    sent: { threadId: string; clientNonce: string; taskId: string },
  ): Promise<string> {
    const own = await runAsTenant(actor, async () => {
      const message = await prisma.message.findFirst({
        where: { threadId: sent.threadId, clientNonce: sent.clientNonce },
        select: { runId: true },
      });
      const run = message?.runId
        ? await prisma.run.findFirst({
            where: { id: message.runId, userId: actor.userId },
            select: { taskId: true },
          })
        : null;
      if (run) return run.taskId;
      const task = await prisma.task.findFirst({
        where: { id: sent.taskId, userId: actor.userId },
        select: { id: true },
      });
      return task?.id ?? null;
    });
    if (!own)
      throw new ClientError("CONFLICT", "The bot is busy with someone else's request; try again");
    return own;
  }

  /** Sends one message to a bot's chat, as the person would from the app. */
  async function send(caller: KeyCaller, actor: Actor, botId: string, text: string) {
    const rpc = client(caller, actor);
    // Read before sending, so a follower sees every event the turn writes.
    const { threadId, cursor } = await rpc.threads.head({ botId });
    const clientNonce = `api:${randomUUID()}`;
    const sent = await rpc.threads.send({ botId, text, clientNonce });
    return {
      taskId: await ownTaskId(actor, { threadId, clientNonce, taskId: sent.taskId }),
      cursor,
    };
  }

  /** Reports a task to `url`; the job commits with the row, so a stopped process loses nothing. */
  async function watchTask(actor: Actor, taskId: string, url: string) {
    await runAsTenant(actor, () =>
      prisma.$transaction(async (tx) => {
        await tx.taskCallback.upsert({
          where: { taskId },
          create: { taskId, url, spaceId: actor.spaceId, userId: actor.userId },
          update: { url },
        });
        await deps.jobs.enqueueIn(
          tx,
          taskCallbackJob(taskId, new Date(Date.now() + TASK_CALLBACK_RECHECK_MS)),
        );
      }),
    );
  }

  async function createTask(
    caller: KeyCaller,
    input: { bot: string; text: string; callbackUrl?: string },
  ) {
    if (input.callbackUrl) await assertCallbackUrl(input.callbackUrl);
    const bot = await resolveBot(caller, input.bot);
    const { taskId, cursor } = await send(caller, bot.actor, bot.id, input.text);
    if (input.callbackUrl) await watchTask(bot.actor, taskId, input.callbackUrl);
    return {
      task: await readTask(bot.actor, taskId),
      actor: bot.actor,
      cursor,
      callbackSecret: input.callbackUrl
        ? taskCallbackSecret(deps.taskCallbackRootKey, caller.userId, input.callbackUrl)
        : undefined,
    };
  }

  /**
   * A follow-up in the task's chat; it answers a question the task is waiting on. Once the task
   * has ended, the follow-up starts a new one, which is returned and reported to the same address.
   */
  async function sendToTask(caller: KeyCaller, taskId: string, text: string) {
    const { actor, botId } = await taskActor(caller, taskId);
    const sent = await send(caller, actor, botId, text);
    const callback = await runAsTenant(actor, () =>
      prisma.taskCallback.findUnique({ where: { taskId }, select: { url: true } }),
    );
    if (callback) await watchTask(actor, sent.taskId, callback.url);
    return { task: await readTask(actor, sent.taskId), actor, cursor: sent.cursor };
  }

  async function getTask(caller: KeyCaller, taskId: string) {
    const { actor, botId } = await taskActor(caller, taskId);
    const { cursor } = await client(caller, actor).threads.head({ botId });
    return { task: await readTask(actor, taskId), actor, cursor };
  }

  /**
   * The task each time it reads differently, ending once it settles. Follows the chat's own
   * live events from `cursor`; `null` marks a quiet stretch so a stream can keep its connection.
   */
  async function* followTask(
    caller: KeyCaller,
    start: { task: PublicTask; actor: Actor; cursor: number },
    signal?: AbortSignal,
  ): AsyncGenerator<PublicTask | null> {
    let last = start.task;
    yield last;
    if (taskSettled(last.status)) return;
    const events = await client(caller, start.actor, signal).threads.subscribe({
      botId: last.bot_id,
      cursor: start.cursor,
    });
    try {
      for await (const event of events) {
        if (event.type === "heartbeat") {
          yield null;
          continue;
        }
        if (!TASK_EVENTS.has(event.type)) continue;
        const next = await readTask(start.actor, last.id);
        if (next.output === last.output && next.status === last.status) continue;
        last = next;
        yield last;
        if (taskSettled(last.status)) return;
      }
    } finally {
      await events.return?.();
    }
  }

  /** The task once it settles, or as it reads when `waitMs` runs out. */
  async function waitForTask(
    caller: KeyCaller,
    start: { task: PublicTask; actor: Actor; cursor: number },
    waitMs: number,
    parent?: AbortSignal,
  ): Promise<PublicTask> {
    let last = start.task;
    if (waitMs <= 0 || taskSettled(last.status)) return last;
    const signal = deadlineSignal(waitMs, parent);
    try {
      for await (const task of followTask(caller, start, signal)) if (task) last = task;
    } catch (error) {
      if (!signal.aborted) throw error;
    }
    return last;
  }

  return {
    authenticate,
    listBots,
    resolveBot,
    createTask,
    sendToTask,
    getTask,
    followTask,
    waitForTask,
  };
}

export type BotAccess = ReturnType<typeof createBotAccess>;
