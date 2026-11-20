import * as z from "zod";
import { Id } from "../ids.js";
import { ATTACHMENT_COUNT_CEILING } from "./attachments.js";
import { REPLY_QUOTE_MAX_LENGTH, THREAD_MESSAGE_TEXT_MAX_LENGTH } from "./thread.js";

export const threadTarget = z
  .object({
    botId: Id.optional(),
    groupId: Id.optional(),
    /** A topic in the bot's chat: a thread of replies to one of its messages. */
    topicId: Id.optional(),
  })
  .superRefine((input, ctx) => {
    const hasBot = Boolean(input.botId);
    const hasGroup = Boolean(input.groupId);
    if (hasBot === hasGroup) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of botId or groupId",
        path: ["botId"],
      });
    }
    if (input.topicId && !hasBot) {
      ctx.addIssue({ code: "custom", message: "topicId requires botId", path: ["topicId"] });
    }
  });

const structuredMentionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), id: Id }),
  z.object({ kind: z.literal("group"), id: Id }),
  z.object({ kind: z.literal("routine"), id: Id }),
  z.object({ kind: z.literal("connector"), id: Id }),
]);

const threadSendFields = threadTarget.safeExtend({
  imageHandling: z.enum(["confirm", "file"]).optional(),
  text: z.string().max(THREAD_MESSAGE_TEXT_MAX_LENGTH).optional(),
  artifactIds: z.array(Id).max(ATTACHMENT_COUNT_CEILING).optional(),
  /** Bare bot ids (legacy) or typed mention chips from the composer. */
  mentions: z
    .array(z.union([Id, structuredMentionTarget]))
    .max(64)
    .optional(),
  replyToMessageId: Id.optional(),
  replyQuote: z.string().trim().min(1).max(REPLY_QUOTE_MAX_LENGTH).optional(),
  /** Sent from the open page: a reply to its card that quotes nothing. */
  fromPage: z.literal(true).optional(),
  clientNonce: z.string().min(1).max(200).optional(),
});

export const threadSendInput = threadSendFields.superRefine((input, ctx) => {
  const text = input.text?.trim() ?? "";
  const artifactIds = input.artifactIds ?? [];
  if (!text && artifactIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "Provide text or at least one attachment",
      path: ["text"],
    });
  }
  if (input.replyQuote && !input.replyToMessageId) {
    ctx.addIssue({
      code: "custom",
      message: "replyQuote requires replyToMessageId",
      path: ["replyQuote"],
    });
  }
});

export const threadSendOutput = z.object({
  taskId: Id,
  runId: Id,
  seq: z.number().int(),
  runIds: z.array(Id).optional(),
});

/** Without text or attachments, only the routines run and no message is saved. */
export const threadSendWithRoutinesInput = threadSendFields.safeExtend({
  clientNonce: z.string().min(1).max(200),
  routineIds: z.array(Id).min(1).max(64),
});
