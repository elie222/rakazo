import { plural } from "@lingui/core/macro";
import type { TopicSummary } from "@rakazo/contracts";
import { useIsFocused } from "expo-router";
import { useMemo } from "react";
import { useSpaceChanges } from "../api/roster-signals";
import { rpcQuery } from "../query/query";
import { useScreenQuery } from "../query/screen-query";

/** The read of a bot chat's topics, for screens that read it or mark it out of date. */
export function topicsRead(botId: string) {
  return rpcQuery("threads/topics", { botId });
}

/**
 * A bot chat's topics, keyed by the message each replies to. Read on focus, and again whenever
 * the Space's runs change, since a reply in a topic is a run. No bot reads nothing.
 */
export function useBotTopics(botId: string | undefined) {
  const query = useScreenQuery(topicsRead(botId ?? ""), { enabled: Boolean(botId) });
  useSpaceChanges("runs", query.refetch, useIsFocused() && Boolean(botId));
  const topics = botId ? query.data?.topics : undefined;
  const byRoot = useMemo(
    () => new Map((topics ?? []).map((topic) => [topic.rootMessageId, topic])),
    [topics],
  );
  return { topics, byRoot, read: query };
}

/** Open topics first, then settled ones, each in the server's order (newest activity first). */
export function splitTopics(topics: readonly TopicSummary[]) {
  return {
    open: topics.filter((topic) => topic.settledBy === null),
    done: topics.filter((topic) => topic.settledBy !== null),
  };
}

export function replyCountLabel(count: number): string {
  return plural(count, { one: "# reply", other: "# replies" });
}

/** The pushed screen that shows one topic. */
export function topicRoute(botId: string, topicId: string) {
  return { pathname: "/topic" as const, params: { botId, topicId } };
}
