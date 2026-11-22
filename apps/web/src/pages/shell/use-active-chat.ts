import type { Bot, Group } from "@rakazo/contracts";
import { chatSnoozed, chatUserBubbleColors } from "@rakazo/core";
import { useMemo, useRef } from "react";
import type { ChatTarget } from "../../lib/query/query";

/** The chat the shell shows: the one the route names, or one to stand in for it. */
export function useActiveChat({
  botId,
  groupId,
  startChat,
  bots,
  groups,
  now,
}: {
  botId: string | undefined;
  groupId: string | undefined;
  /** The chat reopened from cache when the shell started. */
  startChat: ChatTarget | undefined;
  bots: Bot[];
  groups: Group[];
  now: number;
}) {
  const inGroup = Boolean(groupId);
  // Until the route names the chat reopened from cache, that chat stands in for it.
  const routeChat = botId || groupId ? undefined : startChat;
  const active =
    inGroup || routeChat?.groupId
      ? undefined
      : (bots.find((b) => b.id === (botId ?? routeChat?.botId)) ??
        // With no chat named, open one that's in the list, not a snoozed one.
        bots.find((b) => !chatSnoozed(b, now)) ??
        bots[0]);
  const userBubble = useMemo(
    () => (active ? chatUserBubbleColors(active.color, active.id) : undefined),
    [active?.color, active?.id],
  );
  const activeGroup = groups.find((group) => group.id === groupId);
  const activeBotId = useRef<string | undefined>(inGroup ? undefined : active?.id);
  activeBotId.current = inGroup ? undefined : active?.id;
  const activeGroupId = useRef<string | undefined>(groupId);
  activeGroupId.current = groupId;
  return { inGroup, routeChat, active, activeGroup, activeBotId, activeGroupId, userBubble };
}
