import { postTopicItem, settleTopic } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { runLeaseFor } from "../assembly/run-messages.js";
import type { ToolHandlers } from "./run-tool-gate.js";

/** Items the bot posts in its chat, and settling the thread a run replies in. */
export const topicTools: ToolHandlers = {
  async post_item(ctx, call) {
    const { deps, run, runId, bot, thread } = ctx;
    const text = String(call.args.text ?? "").trim();
    if (!text) return call.finish({ error: "text is required" });
    // Selection offers this only in the bot's own chat; anywhere else there is nowhere to post.
    if (thread.botId !== bot.id) return call.finish({ error: "post_item works only in your chat" });
    const posted = await postTopicItem(deps.prisma, {
      spaceId: run.spaceId,
      mainThreadId: thread.id,
      userId: run.userId,
      botId: bot.id,
      runId,
      lease: runLeaseFor(deps, runId),
      text,
      effectKey: call.effectKey,
    });
    if (posted.eventSeq !== null) {
      await deps.events.notify(thread.id, posted.eventSeq).catch((error: unknown) => {
        getLogger().error("posted item notification", error);
      });
      await deps.events.publishSpaceChange?.(run.spaceId, "runs");
    }
    return call.finish({ ok: true, threadId: posted.topicId });
  },
  async settle_thread(ctx, call) {
    const { deps, run, thread } = ctx;
    if (!thread.parentMessageId) return call.finish({ error: "This run is not in a thread" });
    await settleTopic(deps.prisma, { topicId: thread.id, by: "bot" });
    await deps.events.publishSpaceChange?.(run.spaceId, "runs");
    return call.finish({ ok: true });
  },
};
