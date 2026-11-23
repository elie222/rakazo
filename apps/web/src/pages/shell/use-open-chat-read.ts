import { chatWoke } from "@rakazo/core";
import { useEffect } from "react";

type SnoozableChat = Parameters<typeof chatWoke>[0];

type IdentifiedChat = SnoozableChat & { id: string };

/** A chat that wakes while it is open is already seen: read it, which ends the snooze. */
export function useOpenChatRead(input: {
  active: IdentifiedChat | undefined;
  activeGroup: SnoozableChat | undefined;
  groupId: string | undefined;
  now: number;
  markGroupReadOnReply: (groupId: string) => void;
  markBotReadIfVisible: (botId: string) => void;
}) {
  const { active, activeGroup, groupId, now, markGroupReadOnReply, markBotReadIfVisible } = input;
  const activeId = active?.id;
  const woke = active ? chatWoke(active, now) : activeGroup ? chatWoke(activeGroup, now) : false;
  useEffect(() => {
    if (!woke) return;
    if (groupId) markGroupReadOnReply(groupId);
    // Only the id: a roster refresh replaces the bot object while the chat stays awake, and the
    // read request must not repeat for the same chat.
    else if (activeId) markBotReadIfVisible(activeId);
  }, [woke, activeId, groupId, markGroupReadOnReply, markBotReadIfVisible]);
}
