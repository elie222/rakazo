import { randomUUID } from "node:crypto";
import { createRouterClient, ORPCError, onError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { taskCallbackJob } from "@rakazo/adapter-kit";
import {
  apiKeyStillGrants,
  assertCallbackUrl,
  readPublicTask,
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
import { ownSentTask, TASK_EVENTS } from "../threads/thread-send.js";

/** Live task streams and waits one key may hold open in one process. */
export const MAX_OPEN_FOLLOWS_PER_KEY = 20;

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

export type BotAccessDeps = {
  prisma: PrismaClient;
  auth: Pick<Auth, "verifyApiKey">;
  router: ReturnType<typeof createRouter>;
  jobs: Pick<JobPublisher, "enqueue" | "enqueueIn">;
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
  // Live follows each key holds in this process; each one listens and rechecks its key.
  const openFollows = new Map<string, number>();
  /** Checked before a message is sent too, so a refused follow never leaves a turn behind. */
  const assertCanFollow = (caller: KeyCaller) => {
    if ((openFollows.get(caller.keyId) ?? 0) >= MAX_OPEN_FOLLOWS_PER_KEY)
      throw new ClientError("TOO_MANY_REQUESTS", "Too many open streams for this API key");
  };
  const releaseFollow = (keyId: string) => {
    const open = (openFollows.get(keyId) ?? 1) - 1;
    if (open > 0) openFollows.set(keyId, open);
    else openFollows.delete(keyId);
  };

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
        // A long wait ends when the key is revoked, the account is turned off or the person
        // leaves the Space.
        stillAuthorized: () =>
          apiKeyStillGrants(prisma, {
            keyId: caller.keyId,
            userId: caller.userId,
            spaceId: actor.spaceId,
          }),
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

  async function readTask(actor: Actor, taskId: string, beforeSeq?: number): Promise<PublicTask> {
    const task = await runAsTenant(actor, () =>
      readPublicTask(prisma, { taskId, userId: actor.userId, spaceId: actor.spaceId }, beforeSeq),
    );
    if (!task) throw new ClientError("NOT_FOUND", "No task with that id");
    return task;
  }

  async function ownTaskId(
    actor: Actor,
    sent: { threadId: string; clientNonce: string; taskId: string },
  ): Promise<{ taskId: string; seq: number | undefined }> {
    const own = await runAsTenant(actor, () => ownSentTask(prisma, actor, sent));
    if (!own)
      throw new ClientError(
        "CONFLICT",
        "The bot is busy with someone else's request. Your message is in its chat, so do not send it again",
      );
    return own;
  }

  /** Sends one message to a bot's chat, as the person would from the app. */
  async function send(caller: KeyCaller, actor: Actor, botId: string, text: string) {
    const rpc = client(caller, actor);
    // Read before sending, so a follower sees every event the turn writes.
    const { threadId, cursor } = await rpc.threads.head({ botId });
    const clientNonce = `api:${randomUUID()}`;
    const sent = await rpc.threads.send({ botId, text, clientNonce });
    const own = await ownTaskId(actor, { threadId, clientNonce, taskId: sent.taskId });
    return { taskId: own.taskId, messageSeq: own.seq, cursor };
  }

  /**
   * Reports a task to `url`; the job commits with the row, so a stopped process loses nothing. It
   * looks at once, since a turn may have ended before the row existed for its end to find.
   */
  async function watchTask(keyId: string, actor: Actor, taskId: string, url: string) {
    await runAsTenant(actor, () =>
      prisma.$transaction(async (tx) => {
        await tx.taskCallback.upsert({
          where: { taskId },
          create: {
            taskId,
            url,
            spaceId: actor.spaceId,
            userId: actor.userId,
            issuerKeyId: keyId,
          },
          // A new address or key starts fresh, so its receiver hears the current state too.
          update: { url, issuerKeyId: keyId, deliveredRunId: null, deliveredStatus: null },
        });
        await deps.jobs.enqueueIn(tx, taskCallbackJob(taskId, new Date()));
      }),
    );
  }

  async function createTask(
    caller: KeyCaller,
    input: { bot: string; text: string; callbackUrl?: string },
  ) {
    if (input.callbackUrl) await assertCallbackUrl(input.callbackUrl);
    const bot = await resolveBot(caller, input.bot);
    const { taskId, messageSeq, cursor } = await send(caller, bot.actor, bot.id, input.text);
    if (input.callbackUrl) await watchTask(caller.keyId, bot.actor, taskId, input.callbackUrl);
    return {
      task: await readTask(bot.actor, taskId),
      // What the task said before this message, when the message joined a task already going.
      earlierOutput:
        messageSeq === undefined ? "" : (await readTask(bot.actor, taskId, messageSeq)).output,
      actor: bot.actor,
      cursor,
      callbackSecret: input.callbackUrl
        ? taskCallbackSecret(deps.taskCallbackRootKey, caller.keyId, input.callbackUrl)
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
    const [callback, joined] = await runAsTenant(actor, () =>
      Promise.all(
        [taskId, sent.taskId].map((id) =>
          prisma.taskCallback.findUnique({
            where: { taskId: id },
            select: { url: true, issuerKeyId: true },
          }),
        ),
      ),
    );
    if (callback && sent.taskId === taskId) {
      // The same task goes on: its callback checks again now.
      await deps.jobs.enqueue(taskCallbackJob(taskId, new Date()));
    } else if (callback && !joined) {
      // A new task, signed as before with the key that asked for the first callback. A task
      // that already reports somewhere keeps its own address.
      await watchTask(callback.issuerKeyId, actor, sent.taskId, callback.url);
    }
    return { task: await readTask(actor, sent.taskId), actor, cursor: sent.cursor };
  }

  async function getTask(caller: KeyCaller, taskId: string) {
    const { actor, botId } = await taskActor(caller, taskId);
    // A settled task is never followed, so it needs no cursor and stays readable once its bot
    // is archived.
    const settled = await readTask(actor, taskId);
    if (taskSettled(settled.status)) return { task: settled, actor, cursor: 0 };
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
    assertCanFollow(caller);
    openFollows.set(caller.keyId, (openFollows.get(caller.keyId) ?? 0) + 1);
    const events = await client(caller, start.actor, signal)
      .threads.subscribe({ botId: last.bot_id, cursor: start.cursor })
      .catch((error: unknown) => {
        releaseFollow(caller.keyId);
        throw error;
      });
    try {
      for await (const event of events) {
        if (event.type === "heartbeat") {
          yield null;
          continue;
        }
        if (!TASK_EVENTS.has(event.type)) continue;
        const next = await readTask(start.actor, last.id);
        if (
          next.output === last.output &&
          next.status === last.status &&
          next.question === last.question
        )
          continue;
        last = next;
        yield last;
        if (taskSettled(last.status)) return;
      }
    } finally {
      releaseFollow(caller.keyId);
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
    // The wait may end just as access does; the snapshot goes only to a caller still allowed it.
    const grant = { keyId: caller.keyId, userId: caller.userId, spaceId: start.actor.spaceId };
    if (!(await apiKeyStillGrants(prisma, grant)))
      throw new ApiKeyRefusal("UNAUTHORIZED", "Invalid API key");
    return last;
  }

  return {
    assertCanFollow,
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
