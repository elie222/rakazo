import type { Bot, Group } from "@rakazo/contracts";
import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";
import type { createSpaceRpc } from "../../lib/rpc";

export type SnoozeChat = (kind: "bot" | "group", id: string, until: string | null) => void;

/** Snoozes or unsnoozes a chat in the open space; the roster moves it at once. */
export function useChatSnooze({
  rpc,
  setBots,
  setGroups,
  refreshBots,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  setBots: Dispatch<SetStateAction<Bot[]>>;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  refreshBots: () => Promise<void>;
}): SnoozeChat {
  return useCallback(
    (kind, id, until) => {
      const apply = <T extends { id: string; snoozedUntil?: string | null }>(chats: T[]) =>
        chats.map((chat) => (chat.id === id ? { ...chat, snoozedUntil: until } : chat));
      if (kind === "bot") setBots(apply);
      else setGroups(apply);
      const target = kind === "bot" ? { botId: id } : { groupId: id };
      // A failure puts the chat back as the server has it.
      void rpc.threads
        .snooze({ ...target, until })
        .catch(() => undefined)
        .then(() => refreshBots())
        .catch(() => undefined);
    },
    [rpc, setBots, setGroups, refreshBots],
  );
}
