import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  archivedChatCounts,
  loadAllArchivedChats as loadArchivedChats,
  onArchivedChatsChanged,
} from "./archived-chats";

/** How many chats this space has archived, for the row at the end of the inbox. */
export function useArchivedCount(spaceId: string | undefined, hasSession: boolean) {
  const [archived, setArchived] = useState({ spaceId: "", count: 0 });
  // All spaces’ archived chats; a list that fails to load keeps its last count.
  const archivedCounts = useRef({ spaceId: "", bots: 0, groups: 0 });
  const archivedRequestId = useRef(0);
  // Another space's count never shows while this space's is loading.
  const archivedCount = archived.spaceId === spaceId ? archived.count : 0;
  const loadArchivedCount = useCallback(async () => {
    if (!spaceId) return;
    const requestId = ++archivedRequestId.current;
    const loaded = await loadArchivedChats();
    if (requestId !== archivedRequestId.current) return;
    const previous =
      archivedCounts.current.spaceId === spaceId ? archivedCounts.current : { bots: 0, groups: 0 };
    archivedCounts.current = { spaceId, ...archivedChatCounts(previous, loaded) };
    setArchived({ spaceId, count: archivedCounts.current.bots + archivedCounts.current.groups });
  }, [spaceId]);
  // Not part of the poll: the count changes only through archive and restore, which signal it.
  useFocusEffect(
    useCallback(() => {
      if (!hasSession) return;
      void loadArchivedCount();
      return onArchivedChatsChanged(() => void loadArchivedCount());
    }, [hasSession, loadArchivedCount]),
  );
  return archivedCount;
}
