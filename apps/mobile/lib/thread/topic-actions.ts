import { useLingui } from "@lingui/react/macro";
import type { TopicSummary } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { Alert } from "react-native";
import type { MobileMessage } from "../api/mobile-types";
import { errorText } from "../api/user-error";
import { useScreenHeader } from "../navigation/screen-header";
import { useSave } from "../query/query";
import { topicRoute, topicsRead } from "./topics";

/**
 * Topics from the chat screen: Reply in Thread opens a message's topic, starting it on first use,
 * and a topic's own header marks it Done or reopens it. Without a bot, neither does anything.
 */
export function useTopicActions({
  botId,
  topicId,
  topic,
  byRoot,
}: {
  botId?: string;
  /** Set when the screen shows this topic. */
  topicId?: string;
  /** The shown topic as the bot's topic list last read it. */
  topic?: TopicSummary;
  byRoot: ReadonlyMap<string, TopicSummary>;
}) {
  const { t } = useLingui();
  const router = useRouter();
  const stale = botId ? [topicsRead(botId).queryKey] : [];
  const failed = (error: Error) =>
    Alert.alert(t`Could not update chat`, errorText(error, t`Try again.`));
  const opening = useSave({
    save: ({ botId, messageId }: { botId: string; messageId: string }, send) =>
      send("threads/openTopic", { botId, messageId }),
    stale,
    onSaved: (opened, { botId }) => router.push(topicRoute(botId, opened.topicId)),
    onFailed: failed,
  });
  const settling = useSave({
    save: (input: { botId: string; topicId: string; done: boolean }, send) =>
      send("threads/settleTopic", input),
    stale,
    onFailed: failed,
  });
  const done = Boolean(topic?.settledBy);
  useScreenHeader(
    botId && topicId
      ? {
          title: t`Thread`,
          action: {
            label: done ? t`Reopen` : t`Done`,
            onPress: () => settling.run({ botId, topicId, done: !done }),
            busy: settling.pending,
            prominence: "secondary",
          },
        }
      : {},
  );

  return {
    openTopic(message: MobileMessage) {
      if (!botId) return;
      const known = byRoot.get(message.id);
      if (known) router.push(topicRoute(botId, known.id));
      else opening.run({ botId, messageId: message.id });
    },
  };
}
