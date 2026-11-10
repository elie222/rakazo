import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, Space } from "@rakazo/contracts";
import { createChatChoiceQueue } from "@rakazo/core";
import { toast } from "@rakazo/ui-web";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useState } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { rpcForSpace } from "../../lib/rpc";

/** The viewer's own settings on a chat, which only change their list and their alerts. */
type ChatChoices = { snoozedUntil: string | null; muted: boolean; hidden: boolean };

export type SnoozeTarget = {
  kind: "bot" | "group";
  id: string;
  spaceId: string;
} & Partial<ChatChoices>;
export type SnoozeChat = (chat: SnoozeTarget, until: string | null) => void;
/** Mutes or hides a chat (true), or undoes it (false). */
export type ToggleChat = (chat: SnoozeTarget, on: boolean) => void;

type ChatChoiceDeps = {
  rpc: ReturnType<typeof createSpaceRpc>;
  openSpaceId: string | undefined;
  setBots: Dispatch<SetStateAction<Bot[]>>;
  setGroups: Dispatch<SetStateAction<Group[]>>;
  setSpaces: Dispatch<SetStateAction<Space[]>>;
  refreshBots: () => Promise<void>;
};

type Client = ReturnType<typeof createSpaceRpc>;
type Target = { botId: string } | { groupId: string };

/** Sets one of the viewer's own settings on a chat in any listed space; the roster shows it at once. */
function useChatChoice<K extends keyof ChatChoices>(
  { rpc, openSpaceId, setBots, setGroups, setSpaces, refreshBots }: ChatChoiceDeps,
  key: K,
  send: (client: Client, target: Target, value: ChatChoices[K]) => Promise<unknown>,
  unset: ChatChoices[K],
) {
  const { t } = useLingui();
  const [queue] = useState(createChatChoiceQueue<ChatChoices[K]>);
  return useCallback(
    (chat: SnoozeTarget, value: ChatChoices[K]) => {
      const apply = (next: ChatChoices[K]) => {
        // A bot's own notification setting is the viewer's mute, so its settings show it too.
        const change =
          key === "muted" && chat.kind === "bot"
            ? { muted: next, notifyOnFinish: !next }
            : { [key]: next };
        const set = <T extends { id: string }>(chats: T[]) =>
          chats.map((item) => (item.id === chat.id ? { ...item, ...change } : item));
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
      const client = chat.spaceId === openSpaceId ? rpc : rpcForSpace(chat.spaceId);
      const target = chat.kind === "bot" ? { botId: chat.id } : { groupId: chat.id };
      queue(`${chat.kind}:${chat.id}`, value, (chat[key] ?? unset) as ChatChoices[K], {
        send: (next) => send(client, target, next),
        apply,
        settled: (failed) => {
          if (failed) toast.error(t`Could not save`);
          void refreshBots().catch(() => undefined);
        },
      });
    },
    [rpc, openSpaceId, setBots, setGroups, setSpaces, refreshBots, t, queue, key, send, unset],
  );
}

const sendSnooze = (client: Client, target: Target, until: string | null) =>
  client.threads.snooze({ ...target, until });
const sendMute = (client: Client, target: Target, muted: boolean) =>
  client.threads.mute({ ...target, muted });
const sendHide = (client: Client, target: Target, hidden: boolean) =>
  client.threads.hide({ ...target, hidden });

/** Snoozes or unsnoozes a chat in any listed space; the roster moves it at once. */
export function useChatSnooze(deps: ChatChoiceDeps): SnoozeChat {
  return useChatChoice(deps, "snoozedUntil", sendSnooze, null);
}

/** Mutes or unmutes a chat for the viewer alone. */
export function useChatMute(deps: ChatChoiceDeps): ToggleChat {
  return useChatChoice(deps, "muted", sendMute, false);
}

/** Hides a chat from the viewer's list, or brings it back. */
export function useChatHide(deps: ChatChoiceDeps): ToggleChat {
  return useChatChoice(deps, "hidden", sendHide, false);
}
