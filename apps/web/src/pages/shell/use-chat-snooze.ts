import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, Space } from "@rakazo/contracts";
import { createChatQueues } from "@rakazo/core";
import { toast } from "@rakazo/ui-web";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useRef, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { rpcForSpace } from "../../lib/rpc";

export type SnoozeTarget = {
  kind: "bot" | "group";
  id: string;
  spaceId: string;
  snoozedUntil?: string | null;
};
export type SnoozeChat = (chat: SnoozeTarget, until: string | null) => void;

/** Snoozes or unsnoozes a chat in any listed space; the roster moves it at once. */
export function useChatSnooze({
  rpc,
  openSpaceId,
  setBots,
  setGroups,
  setSpaces,
  refreshBots,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  openSpaceId: string | undefined;
  setBots: Dispatch<SetStateAction<Bot[]>>;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  setSpaces: Dispatch<SetStateAction<Space[]>>;
  refreshBots: () => Promise<void>;
}): SnoozeChat {
  const { t } = useLingui();
  // One chat's changes reach the server in the order chosen, and only the latest one rolls back.
  const [inOrder] = useState(createChatQueues);
  const latest = useRef(new Map<string, string | null>());
  return useCallback(
    (chat, until) => {
      const apply = (value: string | null) => {
        const set = <T extends { id: string; snoozedUntil?: string | null }>(chats: T[]) =>
          chats.map((item) => (item.id === chat.id ? { ...item, snoozedUntil: value } : item));
        if (chat.spaceId === openSpaceId) {
          if (chat.kind === "bot") setBots(set);
          else setGroups(set);
        }
        setSpaces((spaces) =>
          spaces.map((space) =>
            space.id !== chat.spaceId
              ? space
              : chat.kind === "bot"
                ? { ...space, bots: set(space.bots) }
                : { ...space, groups: set(space.groups) },
          ),
        );
      };
      const key = `${chat.kind}:${chat.id}`;
      latest.current.set(key, until);
      apply(until);
      const client = chat.spaceId === openSpaceId ? rpc : rpcForSpace(chat.spaceId);
      const target = chat.kind === "bot" ? { botId: chat.id } : { groupId: chat.id };
      void inOrder(key, () => client.threads.snooze({ ...target, until })).then(
        () => refreshBots().catch(() => undefined),
        () => {
          if (latest.current.get(key) !== until) return;
          // Put the chat back where it was, even if the refresh after it fails too.
          apply(chat.snoozedUntil ?? null);
          toast.error(t`Could not save`);
        },
      );
    },
    [rpc, openSpaceId, setBots, setGroups, setSpaces, refreshBots, t, inOrder],
  );
}
