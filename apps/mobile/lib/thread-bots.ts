import { useRouter } from "expo-router";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileBot, MobileGroup } from "./api";
import { rpc } from "./api";
import { retainUnchangedBotRoster } from "./bot-roster";
import { loadSavedInbox } from "./saved-chats";

/** The bots and groups a chat can mention, refreshed on demand; also keeps the bot's title current. */
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
  const mentionBotsRefreshGeneration = useRef(0);
  const mentionBotsAppliedGeneration = useRef(0);
  const [mentionBots, setMentionBots] = useState<MobileBot[]>([]);
  // The call outlives renders, so its switch check reads the newest bot list from here.
  const mentionBotsRef = useRef<MobileBot[]>([]);
  mentionBotsRef.current = mentionBots;
  const [mentionGroups, setMentionGroups] = useState<MobileGroup[]>([]);

  const refreshMentionBots = useCallback(async () => {
    if (!botId && !groupId) return;
    const generation = ++mentionBotsRefreshGeneration.current;
    const targetBotId = botId;
    try {
      const bots = await rpc("bots/list");
      // Apply any successful response that is still the newest applied so far.
      // A later failed refresh must not discard an earlier success.
      if (generation < mentionBotsAppliedGeneration.current) return;
      if (targetBotId !== activeBotId.current) return;
      mentionBotsAppliedGeneration.current = generation;
      setMentionBots((current) => retainUnchangedBotRoster(current, bots));
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
      if (targetBotId !== activeBotId.current) return;
      setMentionBots((current) => (current.length ? current : saved.bots));
    }
  }, [botId, groupId, router]);

  useEffect(() => {
    void rpc("groups/list")
      .then(setMentionGroups)
      .catch(() => setMentionGroups([]));
  }, [refreshMentionBots]);

  return { mentionBots, mentionBotsRef, mentionGroups, refreshMentionBots };
}
