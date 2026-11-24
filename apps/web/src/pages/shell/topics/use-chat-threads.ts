import type { Bot } from "@rakazo/contracts";
import { useCallback, useMemo } from "react";
import type { SpaceQueries } from "../../../lib/query/query";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import type { useRightPanel } from "../use-right-panel";
import type { ThreadMessageContext } from "./thread-panel";
import { useBotTopics } from "./use-bot-topics";

/**
 * The open bot chat's threads, wired for the header's Threads button, the footers under its
 * messages and the side panel. A group has none.
 */
export function useChatThreads({
  rpc,
  queries,
  active: bot,
  rightPanel,
  userId,
  messageContext,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  queries: SpaceQueries;
  /** The open bot chat; undefined in a group. */
  active: Bot | undefined;
  rightPanel: ReturnType<typeof useRightPanel>;
  userId: string | undefined;
  messageContext: ThreadMessageContext;
}) {
  const { openTopic, panel, setPanel, topic } = rightPanel;
  const botId = bot?.id;
  const topics = useBotTopics({ rpc, queries, botId, openTopic });
  const onOpenTopic = useCallback(
    (topicId: string) => {
      if (botId) openTopic(botId, topicId);
    },
    [botId, openTopic],
  );
  const transcriptTopics = useMemo(
    () =>
      bot
        ? {
            byMessage: topics.byMessage,
            bot: { id: bot.id, color: bot.color, avatarSet: bot.avatarSet },
          }
        : undefined,
    [topics.byMessage, bot?.id, bot?.color, bot?.avatarSet],
  );
  return {
    header:
      botId && topics.topics.length
        ? {
            unread: topics.unreadOpen,
            onOpen: () => setPanel(panel === "threads" ? null : "threads"),
          }
        : undefined,
    transcriptProps: {
      onReplyInThread: botId ? topics.replyInThread : undefined,
      topics: transcriptTopics,
      onOpenTopic,
    },
    sidePanel: botId
      ? {
          queries,
          topics: topics.topics,
          topicId: topic?.botId === botId ? topic.topicId : undefined,
          onOpen: onOpenTopic,
          meId: userId,
          messageContext,
        }
      : undefined,
  };
}
