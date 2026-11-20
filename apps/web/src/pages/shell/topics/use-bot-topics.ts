import type { ThreadMessage, TopicSummary } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import type { SpaceQueries } from "../../../lib/query/query";
import { useSave } from "../../../lib/query/query";
import { topicsByRootMessage, unreadOpenTopicCount } from "./topics";

const NO_TOPICS: TopicSummary[] = [];

/**
 * The open bot chat's topics, for the footers under its messages, the header's Threads button
 * and the Threads panel. `botId` is undefined in a group, which has no topics.
 */
export function useBotTopics({
  queries,
  botId,
  openTopic,
}: {
  queries: SpaceQueries;
  botId: string | undefined;
  openTopic: (botId: string, topicId: string) => void;
}) {
  const query = useQuery({
    ...queries.threads.topics.queryOptions({ input: { botId: botId ?? "" } }),
    enabled: Boolean(botId),
  });
  const topics = (botId && query.data?.topics) || NO_TOPICS;
  const byMessage = useMemo(() => topicsByRootMessage(topics), [topics]);
  const unreadOpen = useMemo(() => unreadOpenTopicCount(topics), [topics]);
  const start = useSave({
    save: (input: { botId: string; messageId: string }, rpc) => rpc.threads.openTopic(input),
    stale: ({ botId }) => [queries.threads.topics.queryKey({ input: { botId } })],
    onSaved: ({ topicId }, { botId }) => openTopic(botId, topicId),
  });
  // Memoized messages take this, so it stays the same function while the chat is open.
  const run = useRef(start.run);
  run.current = start.run;
  const replyInThread = useCallback(
    (message: ThreadMessage) => {
      if (botId) run.current({ botId, messageId: message.id });
    },
    [botId],
  );
  return { topics, byMessage, unreadOpen, replyInThread };
}
