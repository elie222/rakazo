import type { PublicBot, PublicTask } from "@rakazo/contracts";
import { THREAD_MESSAGE_TEXT_MAX_LENGTH } from "@rakazo/contracts";
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
export function latestUserText(messages: ChatCompletionRequest["messages"]): string | null {
  const message = messages.findLast((entry) => entry.role === "user");
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : (content ?? [])
          .filter((part) => part.type === "text" && part.text)
          .map((part) => part.text)
          .join("\n");
  const trimmed = text.trim();
  return trimmed && trimmed.length <= THREAD_MESSAGE_TEXT_MAX_LENGTH ? trimmed : null;
}

/** What the assistant says for a task: its replies, then any question it is waiting on. */
export function taskAnswer(task: PublicTask): string {
  return [task.output, task.question].filter(Boolean).join("\n\n");
}

export function completionId(task: PublicTask): string {
  return `chatcmpl-${task.id}`;
}

const NO_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } as const;

export function chatCompletion(task: PublicTask, model: string, created: number) {
  return {
    id: completionId(task),
    object: "chat.completion" as const,
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: taskAnswer(task), refusal: null },
        logprobs: null,
        finish_reason: "stop" as const,
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
  finishReason: "stop" | null = null,
) {
  return {
    id: completionId(task),
    object: "chat.completion.chunk" as const,
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
}

/**
 * The text a stream has not sent yet. Replies only grow, so the answer so far starts with what
 * was sent; a reply edited after it was streamed is not sent again.
 */
export function unsentText(sent: string, answer: string): string {
  if (!answer.startsWith(sent)) return "";
  return answer.slice(sent.length);
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
