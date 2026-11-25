import * as z from "zod";
import { Id } from "../ids.js";
import { THREAD_MESSAGE_TEXT_MAX_LENGTH } from "../threads/thread.js";

/** The longest key name; the auth library's plugin is configured with it too. */
export const API_KEY_NAME_LIMIT = 64;

export const ApiKeySchema = z.object({
  id: Id,
  name: z.string(),
  /** The key's first characters, so a person can tell keys apart. */
  start: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

/** The only time the key itself is sent; the server keeps a hash. */
export const CreatedApiKeySchema = ApiKeySchema.extend({ key: z.string() });
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

export const ApiKeyNameSchema = z.string().trim().min(1).max(API_KEY_NAME_LIMIT);

/**
 * A task's state as the public API reports it. `needs_input` waits on an answer or approval:
 * send a follow-up message to answer, or open the chat for anything else.
 */
export const TaskStatusSchema = z.enum([
  "working",
  "needs_input",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** The task states a caller waits for: nothing changes until someone acts. */
export function taskSettled(status: TaskStatus): boolean {
  return status !== "working";
}

export const PublicBotSchema = z.object({
  id: Id,
  name: z.string(),
  space: z.object({ id: Id, name: z.string() }),
});
export type PublicBot = z.infer<typeof PublicBotSchema>;

export const PublicTaskSchema = z.object({
  id: Id,
  object: z.literal("task"),
  bot_id: Id,
  status: TaskStatusSchema,
  /** The bot's replies for this task, joined in order. */
  output: z.string(),
  /** What the bot asked, while the task needs input. */
  question: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PublicTask = z.infer<typeof PublicTaskSchema>;

const TaskInputText = z.string().trim().min(1).max(THREAD_MESSAGE_TEXT_MAX_LENGTH);

export const CreateTaskInputSchema = z.object({
  /** A bot id, or a bot's exact name when only one bot the key can use has it. */
  bot: z.string().trim().min(1).max(200),
  input: TaskInputText,
  /** An HTTPS address told once the task settles, signed with the returned secret. */
  callback_url: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const TaskMessageInputSchema = z.object({ input: TaskInputText });

/**
 * What a callback POSTs, with `x-rakazo-signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`. `id`
 * names the settled state and stays the same on a retry, so a receiver can drop a repeat.
 */
export const TaskCallbackBodySchema = z.object({
  type: z.literal("task.settled"),
  id: z.string(),
  task: PublicTaskSchema,
});
export type TaskCallbackBody = z.infer<typeof TaskCallbackBodySchema>;
export const TASK_CALLBACK_SIGNATURE_HEADER = "x-rakazo-signature";
export const TASK_CALLBACK_DELIVERY_HEADER = "x-rakazo-delivery";
