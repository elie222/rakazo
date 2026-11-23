import { useRouter } from "expo-router";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../api/api";
import type { MobileBot, MobileGroup } from "../api/mobile-types";
import { retainUnchangedBotRoster } from "../bots/bot-roster";
import { loadSavedInbox } from "../inbox/saved-chats";
import { queryClient, rpcQuery } from "../query/query";

/** The bots and groups a chat can mention, refreshed on demand; also keeps the chat's title current. */
export function useThreadBots({
  botId,
  groupId,
  name,
  activeBotId,
}: {
  botId?: string;
  groupId?: string;
  name?: string;
  /** The bot whose chat is open now, read when a refresh answers. */
  activeBotId: RefObject<string | undefined>;
}) {
  const router = useRouter();
  const routeName = useRef(name);
  routeName.current = name;
  const activeTarget = useRef({ botId, groupId });
  activeTarget.current = { botId, groupId };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mentionGroupsRefreshGeneration = useRef(0);
  const mentionGroupsAppliedGeneration = useRef(0);
  const mentionBotsRefreshGeneration = useRef(0);
  const mentionBotsAppliedGeneration = useRef(0);
  // The roster the last chat in this Space loaded, so rows draw with their bot colours at once
  // and the refresh only redraws them when the roster changed. It may predate a rename, so the
  // chat names its bot from it only once this chat's own read has arrived.
  const [mentionBots, setMentionBots] = useState<MobileBot[]>(
    () => queryClient.getQueryData(rpcQuery("bots/list").queryKey) ?? [],
  );
  const [rosterLoaded, setRosterLoaded] = useState(false);
  // The call outlives renders, so its switch check reads the newest bot list from here.
  const mentionBotsRef = useRef<MobileBot[]>([]);
  mentionBotsRef.current = mentionBots;
  const [mentionGroups, setMentionGroups] = useState<MobileGroup[]>([]);

  const refreshMentionBots = useCallback(async () => {
    if (!botId && !groupId) return;
    const generation = ++mentionBotsRefreshGeneration.current;
    const targetBotId = botId;
    const isCurrent = () =>
      mounted.current &&
      activeTarget.current.botId === botId &&
      activeTarget.current.groupId === groupId;
    const read = rpcQuery("bots/list");
    try {
      const bots = await rpc("bots/list");
      // Apply any successful response that is still the newest applied so far.
      // A later failed refresh must not discard an earlier success.
      if (generation < mentionBotsAppliedGeneration.current) return;
      queryClient.setQueryData(read.queryKey, bots);
      if (!isCurrent() || targetBotId !== activeBotId.current) return;
      mentionBotsAppliedGeneration.current = generation;
      setMentionBots((current) => retainUnchangedBotRoster(current, bots));
      setRosterLoaded(true);
      if (targetBotId) {
        const next = bots.find((bot) => bot.id === targetBotId);
        // Read the route name from a ref so renaming does not recreate this
        // callback (and restart the SSE subscription that depends on it).
        if (next?.name && next.name !== routeName.current) {
          router.setParams({ name: next.name });
        }
      }
    } catch {
      // Keep the last known roster if refresh fails. Before any, use the bots saved with the
      // inbox, so a saved chat offline keeps its bot's colour and avatar.
      if (mentionBotsAppliedGeneration.current !== 0) return;
      const saved = await loadSavedInbox();
      if (!saved || mentionBotsAppliedGeneration.current !== 0) return;
      if (!isCurrent() || targetBotId !== activeBotId.current) return;
      // Nothing from this chat has applied yet, so the saved inbox replaces the cached roster.
      setMentionBots(saved.bots);
      setRosterLoaded(true);
    }
  }, [botId, groupId, router]);

  const refreshMentionGroups = useCallback(async () => {
    if (!botId && !groupId) return;
    const generation = ++mentionGroupsRefreshGeneration.current;
    try {
      const groups = await rpc("groups/list");
      if (
        !mounted.current ||
        activeTarget.current.botId !== botId ||
        activeTarget.current.groupId !== groupId ||
        generation < mentionGroupsAppliedGeneration.current
      )
        return;
      mentionGroupsAppliedGeneration.current = generation;
      setMentionGroups(groups);
      const next = groups.find((group) => group.id === groupId);
      if (next?.name && next.name !== routeName.current) {
        router.setParams({ name: next.name });
      }
    } catch {
      // Retain the last known groups when a refresh fails.
    }
  }, [botId, groupId, router]);

  // Focus refreshes both rosters; live bot events only need refreshMentionBots.
  const refreshMentionRoster = useCallback(async () => {
    await Promise.all([refreshMentionBots(), refreshMentionGroups()]);
  }, [refreshMentionBots, refreshMentionGroups]);

  return {
    mentionBots,
    mentionBotsRef,
    mentionGroups,
    rosterLoaded,
    refreshMentionBots,
    refreshMentionRoster,
  };
}
