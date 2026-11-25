import { taskCallbackRootKey } from "@rakazo/adapters";
import type { PublicTask } from "@rakazo/contracts";
import { CreateTaskInputSchema, TaskMessageInputSchema, taskSettled } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import type * as z from "zod";
import { requestBodyLimit } from "../http/request-body-limit.js";
import type { BotAccess, BotAccessDeps, KeyCaller } from "./bot-access.js";
import { createBotAccess, publicApiFailure } from "./bot-access.js";
import { mountMcpRoute } from "./mcp-route.js";
import {
  ChatCompletionRequestSchema,
  chatCompletion,
  chatCompletionChunk,
  latestUserText,
  modelList,
  openAiError,
  taskAnswer,
  unsentText,
} from "./openai-compat.js";

/** Messages are text; this bounds a body before it is parsed. */
const MAX_PUBLIC_API_BODY_BYTES = 1024 * 1024;

const NON_STREAMING_WAIT_MS = 15 * 60_000;

type Answer = { status: number; body: unknown; retryAfterSeconds?: number };

async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await c.req.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) throw new ClientError("BAD_REQUEST", "Send a JSON body");
    throw error;
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ClientError(
      "BAD_REQUEST",
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid",
    );
  }
  return parsed.data;
}

/** Runs a handler for the key's person, answering a refusal in the surface's own error shape. */
function withCaller(
  access: BotAccess,
  errorBody: (status: number, message: string) => unknown,
  handler: (c: Context, caller: KeyCaller) => Promise<Response>,
) {
  return async (c: Context) => {
    let answer: Answer;
    try {
      return await handler(c, await access.authenticate(c.req.raw.headers));
    } catch (error) {
      const failure = publicApiFailure(error);
      if (!failure) throw error;
      answer = {
        status: failure.status,
        body: errorBody(failure.status, failure.message),
        retryAfterSeconds: failure.retryAfterSeconds,
      };
    }
    return c.json(answer.body, answer.status as 400, {
      ...(answer.status === 401 ? { "www-authenticate": 'Bearer realm="rakazo"' } : {}),
      ...(answer.retryAfterSeconds ? { "retry-after": String(answer.retryAfterSeconds) } : {}),
    });
  };
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
} as const;

/**
 * Writes server-sent events from `produce`. The run goes on when the client leaves; only the
 * stream stops, and a failure after the headers are sent ends it with an error event.
 */
function eventStream(
  request: AbortSignal,
  produce: (
    signal: AbortSignal,
    send: (data: unknown, event?: string) => void,
    ping: () => void,
    done: () => void,
  ) => Promise<void>,
  onFailure: (send: (data: unknown, event?: string) => void, message: string) => void,
  extraHeaders: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  // Ends the producer when the request goes or the reader cancels the body, whichever is first.
  const reader = new AbortController();
  const signal = AbortSignal.any([request, reader.signal]);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        if (!signal.aborted) controller.enqueue(encoder.encode(text));
      };
      const send = (data: unknown, event?: string) =>
        write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
      try {
        await produce(
          signal,
          send,
          () => write(": keep-alive\n\n"),
          () => write("data: [DONE]\n\n"),
        );
      } catch (error) {
        if (!signal.aborted) {
          const failure = publicApiFailure(error);
          if (!failure) getLogger().error("public API stream failed", error);
          onFailure(send, failure?.message ?? "The stream stopped");
        }
      } finally {
        if (!signal.aborted) controller.close();
      }
    },
    cancel() {
      reader.abort();
    },
  });
  return new Response(body, { headers: { ...SSE_HEADERS, ...extraHeaders } });
}

const taskIdParam = (c: Context) => c.req.param("id") ?? "";

const taskError = (status: number, message: string) => ({ error: { message, status } });

/**
 * `/api/v1`: the OpenAI-compatible chat endpoint and the task API, for scripts and other agents
 * holding one of the person's API keys.
 */
export function mountPublicApiRoutes(app: Hono, access: BotAccess) {
  for (const path of ["/api/v1/chat/*", "/api/v1/tasks", "/api/v1/tasks/*"])
    app.use(path, requestBodyLimit(MAX_PUBLIC_API_BODY_BYTES));

  app.get(
    "/api/v1/models",
    withCaller(access, openAiError, async (c, caller) =>
      c.json(modelList(await access.listBots(caller))),
    ),
  );

  app.post(
    "/api/v1/chat/completions",
    withCaller(access, openAiError, async (c, caller) => {
      const request = await readJson(c, ChatCompletionRequestSchema);
      const text = latestUserText(request.messages);
      const started = await access.createTask(caller, { bot: request.model, text });
      const created = Math.floor(Date.now() / 1000);
      const headers = { "x-rakazo-task-id": started.task.id };
      if (!request.stream) {
        // Past this, the answer so far is returned; the task goes on and the chat shows the rest.
        const task = await access.waitForTask(
          caller,
          started,
          NON_STREAMING_WAIT_MS,
          c.req.raw.signal,
        );
        // A turn that ended badly is an error even when it said something first.
        if (task.status === "failed" || task.status === "cancelled")
          return c.json(openAiError(502, task.error ?? "The bot stopped"), 502, headers);
        return c.json(chatCompletion(task, request.model, created), 200, headers);
      }
      return eventStream(
        c.req.raw.signal,
        async (signal, send, ping, done) => {
          send(chatCompletionChunk(started.task, request.model, created, { role: "assistant" }));
          let sent = "";
          let last: PublicTask = started.task;
          for await (const task of access.followTask(caller, started, signal)) {
            if (!task) {
              ping();
              continue;
            }
            last = task;
            const content = unsentText(sent, taskAnswer(task));
            if (content) {
              sent += content;
              send(chatCompletionChunk(task, request.model, created, { content }));
            }
          }
          if (last.status === "failed" || last.status === "cancelled")
            send(openAiError(502, last.error ?? "The bot stopped"));
          else if (taskSettled(last.status))
            send(chatCompletionChunk(last, request.model, created, {}, "stop"));
          done();
        },
        (send, message) => send(openAiError(500, message)),
        headers,
      );
    }),
  );

  app.post(
    "/api/v1/tasks",
    withCaller(access, taskError, async (c, caller) => {
      const input = await readJson(c, CreateTaskInputSchema);
      const started = await access.createTask(caller, {
        bot: input.bot,
        text: input.input,
        callbackUrl: input.callback_url,
      });
      return c.json(
        {
          ...started.task,
          ...(started.callbackSecret ? { callback_secret: started.callbackSecret } : {}),
        },
        201,
      );
    }),
  );

  app.get(
    "/api/v1/tasks/:id",
    withCaller(access, taskError, async (c, caller) =>
      c.json((await access.getTask(caller, taskIdParam(c))).task),
    ),
  );

  // The task each time it changes, as `task` events, until it settles.
  app.get(
    "/api/v1/tasks/:id/events",
    withCaller(access, taskError, async (c, caller) => {
      const started = await access.getTask(caller, taskIdParam(c));
      return eventStream(
        c.req.raw.signal,
        async (signal, send, ping) => {
          for await (const task of access.followTask(caller, started, signal)) {
            if (task) send(task, "task");
            else ping();
          }
        },
        (send, message) => send(taskError(500, message), "error"),
      );
    }),
  );

  app.post(
    "/api/v1/tasks/:id/messages",
    withCaller(access, taskError, async (c, caller) => {
      const input = await readJson(c, TaskMessageInputSchema);
      return c.json((await access.sendToTask(caller, taskIdParam(c), input.input)).task, 201);
    }),
  );
}

/** The public API and MCP server, which let a person's API keys use their bots. */
export function mountBotAccess(
  app: Hono,
  deps: Omit<BotAccessDeps, "taskCallbackRootKey"> & { encryptionKey: string },
) {
  const { encryptionKey, ...rest } = deps;
  const access = createBotAccess({
    ...rest,
    taskCallbackRootKey: taskCallbackRootKey(encryptionKey),
  });
  mountPublicApiRoutes(app, access);
  mountMcpRoute(app, access);
}
