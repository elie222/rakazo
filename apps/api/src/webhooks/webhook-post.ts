import { notifyBotPost } from "@rakazo/adapters";
import type { MessageBlock } from "@rakazo/contracts";
import { LinkButton, MAX_LINK_BUTTONS } from "@rakazo/contracts";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  loadSpaceContentKeys,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import * as z from "zod";
import type { WebhookDeps, WebhookTarget } from "./webhook-inbound.js";

/** `{ post: { text, buttons? } }`: a message the bot posts as itself, with no model run. */
export function webhookPostSchema(linkSchemes: readonly string[]) {
  const button = LinkButton.refine(
    ({ url }) => URL.canParse(url) && linkSchemes.includes(new URL(url).protocol.slice(0, -1)),
    { message: "Unsupported button URL" },
  ).transform((parsed) => ({ ...parsed, url: new URL(parsed.url).href }));
  return z.object({
    // Kept as written: trimming would change Markdown such as an indented code block.
    text: z.string().refine((text) => text.trim().length > 0),
    buttons: z.array(button).max(MAX_LINK_BUTTONS).optional(),
  });
}

export type WebhookPost = z.infer<ReturnType<typeof webhookPostSchema>>;

/** Posts into the bot's chat and tells its Space as a reply would. */
export async function postWebhookMessage(
  deps: Pick<WebhookDeps, "prisma" | "events" | "notifications">,
  target: WebhookTarget,
  post: WebhookPost,
) {
  const { spaceId, id: botId } = target.bot;
  const { threadId } = target;
  const blocks: MessageBlock[] = [
    { kind: "post", markdown: post.text },
    ...(post.buttons?.length ? [{ kind: "buttons" as const, buttons: post.buttons }] : []),
  ];
  // Keys load before the thread lock is taken, as a send's do.
  await loadSpaceContentKeys(deps.prisma, spaceId);
  const committed = await deps.prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId,
      botId,
      role: "bot",
      blocks,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId,
      threadId,
      botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { messageId: message.id, seq: event.seq };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  await bestEffort("webhook post notify", deps.events.notify(threadId, committed.seq));
  // Not awaited, as for a member's message: the sender's answer does not wait on push retries.
  void bestEffort(
    "webhook post notification",
    notifyBotPost(deps, { spaceId, botId, threadId, text: post.text }),
  );
  return { ok: true as const, messageId: committed.messageId };
}
