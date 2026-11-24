import { THREAD_MESSAGE_TEXT_MAX_LENGTH } from "@rakazo/contracts";
import * as z from "zod";

/** The longest one tool call waits for a task; past it, get_task picks up where it left off. */
export const MAX_TOOL_WAIT_SECONDS = 600;

const message = z.string().trim().min(1).max(THREAD_MESSAGE_TEXT_MAX_LENGTH);
const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(MAX_TOOL_WAIT_SECONDS)
  .optional()
  .describe(
    "Seconds to wait for the task to finish or ask something before returning. Default 60; 0 returns at once.",
  );

/** The tools Rakazo's MCP server offers agents that hold one of the person's keys. */
export const BOT_ACCESS_TOOLS = {
  list_bots: {
    title: "List bots",
    description:
      "List the Rakazo bots you can hand work to, with their ids, names and the Space each is in.",
    inputSchema: {},
  },
  create_task: {
    title: "Give a bot a task",
    description:
      "Send a bot a message that starts a task in its chat. Bots keep their own conversation and memory, so send only what is new. Long work keeps running after this returns; check it with get_task. A task with status needs_input is waiting for an answer: reply with send_task_message.",
    inputSchema: {
      bot: z.string().trim().min(1).max(200).describe("The bot's id, or its exact name."),
      message: message.describe("What you want the bot to do."),
      wait_seconds: waitSeconds,
    },
  },
  get_task: {
    title: "Check a task",
    description:
      "Read a task's status and the bot's replies so far. Statuses: working, needs_input, completed, failed, cancelled.",
    inputSchema: {
      task_id: z.string().trim().min(1).max(200),
      wait_seconds: waitSeconds,
    },
  },
  send_task_message: {
    title: "Reply in a task",
    description:
      "Send a follow-up to the bot that has a task: answer its question, add details or change course.",
    inputSchema: {
      task_id: z.string().trim().min(1).max(200),
      message,
      wait_seconds: waitSeconds,
    },
  },
} as const;

export const DEFAULT_TOOL_WAIT_SECONDS = 60;
