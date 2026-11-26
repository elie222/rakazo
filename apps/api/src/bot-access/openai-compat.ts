import type { PublicBot, PublicTask } from "@rakazo/contracts";
import { THREAD_MESSAGE_TEXT_MAX_LENGTH, taskSettled } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import * as z from "zod";

const ContentPart = z.looseObject({ type: z.string(), text: z.string().optional() });

/** The fields of an OpenAI chat request this endpoint reads; the rest are accepted and ignored. */
export const ChatCompletionRequestSchema = z.looseObject({
  model: z.string().trim().min(1).max(200),
  messages: z
    .array(
      z.looseObject({
        role: z.string(),
        content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
      }),
    )
    .min(1)
    .max(1000),
  stream: z.boolean().nullish(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

/**
 * The new message for the bot. Rakazo keeps each bot's conversation itself, so only the last user
 * message is sent; the history and system messages a client repeats are already in the chat.
 */
export function latestUserText(messages: ChatCompletionRequest["messages"]): string {
  const message = messages.findLast((entry) => entry.role === "user");
  const content = message?.content;
  const text = (
    typeof content === "string"
      ? content
      : (content ?? [])
          .filter((part) => part.type === "text" && part.text)
          .map((part) => part.text)
          .join("\n")
  ).trim();
  if (!text) throw new ClientError("BAD_REQUEST", "messages: include a user message with text");
  if (text.length > THREAD_MESSAGE_TEXT_MAX_LENGTH)
    throw new ClientError(
      "BAD_REQUEST",
      `messages: the last user message is longer than ${THREAD_MESSAGE_TEXT_MAX_LENGTH} characters`,
    );
  return text;
}

/**
 * What the assistant says for a task: its replies, then any question it is waiting on. Replies in
 * `earlierOutput`, written before the request's message joined the task, are left out.
 */
export function taskAnswer(task: PublicTask, earlierOutput = ""): string {
  const output =
    earlierOutput && task.output.startsWith(earlierOutput)
      ? task.output.slice(earlierOutput.length).replace(/^\n\n/, "")
      : task.output;
  return [output, task.question].filter(Boolean).join("\n\n");
}

/**
 * `stop` once the turn settled. `length` marks an answer cut off while the bot still works (the
 * wait ran out or the stream ended), so a client does not take it as complete.
 */
export function finishReason(task: PublicTask): "stop" | "length" {
  return taskSettled(task.status) ? "stop" : "length";
}

export function completionId(task: PublicTask): string {
  return `chatcmpl-${task.id}`;
}

const NO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } as const;

export function chatCompletion(
  task: PublicTask,
  model: string,
  created: number,
  earlierOutput = "",
) {
  return {
    id: completionId(task),
    object: "chat.completion" as const,
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: taskAnswer(task, earlierOutput),
          refusal: null,
        },
        logprobs: null,
        finish_reason: finishReason(task),
      },
    ],
    usage: NO_USAGE,
  };
}

export function chatCompletionChunk(
  task: PublicTask,
  model: string,
  created: number,
  delta: { role?: "assistant"; content?: string },
  finish: "stop" | "length" | null = null,
) {
  return {
    id: completionId(task),
    object: "chat.completion.chunk" as const,
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  };
}

/**
 * The text a stream has not sent yet. Sent text cannot be taken back, so when the answer no
 * longer starts with it (a reply was edited, or an answered question left the answer), the part
 * after what both share follows on a new paragraph.
 */
export function unsentText(sent: string, answer: string): string {
  if (answer.startsWith(sent)) return answer.slice(sent.length);
  let shared = 0;
  while (shared < sent.length && sent[shared] === answer[shared]) shared += 1;
  const rest = answer.slice(shared).trim();
  return rest ? `\n\n${rest}` : "";
}

/** Each bot the key can use, as a model; `owned_by` names the Space the bot is in. */
export function modelList(bots: PublicBot[]) {
  return {
    object: "list" as const,
    data: bots.map((bot) => ({
      id: bot.id,
      object: "model" as const,
      created: 0,
      owned_by: bot.space.name,
      name: bot.name,
    })),
  };
}

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  409: "invalid_request_error",
  429: "rate_limit_error",
};

/** An error body in the shape OpenAI clients read. */
export function openAiError(status: number, message: string) {
  return {
    error: { message, type: ERROR_TYPES[status] ?? "api_error", param: null, code: null },
  };
}
