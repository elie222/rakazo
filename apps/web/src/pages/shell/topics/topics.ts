import type { TopicSummary } from "@rakazo/contracts";

/** Topics with replies, by the chat message they reply to, for the footer under that message. */
export function topicsByRootMessage(topics: readonly TopicSummary[]): Map<string, TopicSummary> {
  return new Map(
    topics.filter((topic) => topic.replyCount > 0).map((topic) => [topic.rootMessageId, topic]),
  );
}

/** The Threads list: open topics first, then the settled ones, each in the server's order. */
export function splitTopics(topics: readonly TopicSummary[]) {
  return {
    open: topics.filter((topic) => topic.settledBy === null),
    done: topics.filter((topic) => topic.settledBy !== null),
  };
}

/** What the chat header's Threads button counts. */
export function unreadOpenTopicCount(topics: readonly TopicSummary[]): number {
  return topics.filter((topic) => topic.unread && topic.settledBy === null).length;
}
