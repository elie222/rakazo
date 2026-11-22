import type { Bot, RpcInput, RpcOutput } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import { useRef, useState } from "react";
import { currentApiBase, selectedSpaceId } from "../api/api";
import { loadSessionToken } from "../api/session";
import { afterChatNotifyChange } from "../notifications/live-notifications";
import { queryClient, rpcQuery, useSave } from "../query/query";

type BotSettingKey =
  | "name"
  | "notifyOnFinish"
  | "dailyCheckIns"
  | "crossSpaceCommunication"
  | "fleetManagement";

/** Writes saved fields into every cached read of the bot, its settings form's among them. */
export function patchBotReads(botId: string, patch: Partial<Bot>) {
  queryClient.setQueriesData<Bot>(
    { queryKey: rpcQuery("bots/get", { botId }).queryKey },
    (current) => current && { ...current, ...patch },
  );
}

/**
 * A bot setting saved the moment it changes, as a switch is. The control shows the change at
 * once and stays enabled: a change made while one saves is written after it, only the latest.
 * A failure a newer change replaced is not reported; when the last write fails, the control goes
 * back to what was saved.
 */
export function useBotSetting<K extends BotSettingKey>(
  botId: string,
  key: K,
  saved: NonNullable<Bot[K]>,
  options: {
    onSaved?: (value: NonNullable<Bot[K]>, updated: RpcOutput<"bots/update">) => Promise<void>;
    onFailed: (error: Error) => void;
  },
) {
  type Value = NonNullable<Bot[K]>;
  const latest = useRef(saved);
  // Counts changes, so a failed write can tell a newer change replaced it.
  const changes = useRef(0);
  const [, showChange] = useState(saved);
  const save = useSave({
    save: async ({ from }: { from: Value }, send) => {
      let confirmed = from;
      while (latest.current !== confirmed) {
        while (latest.current !== confirmed) {
          const value = latest.current;
          const change = changes.current;
          try {
            const updated = await send("bots/update", {
              botId,
              [key]: value,
            } as RpcInput<"bots/update">);
            confirmed = value;
            patchBotReads(botId, { [key]: value });
            await options.onSaved?.(value, updated);
          } catch (error) {
            if (change === changes.current) throw error;
          }
        }
        // The control shows the change until the bot is read again; a change made meanwhile is
        // written next.
        await queryClient.invalidateQueries({ queryKey: rpcQuery("bots/get", { botId }).queryKey });
      }
    },
    onFailed: (error) => options.onFailed(error),
  });
  return {
    value: save.pending ? latest.current : saved,
    pending: save.pending,
    set(value: Value) {
      latest.current = value;
      changes.current += 1;
      showChange(value);
      save.run({ from: saved });
    },
  };
}

/** Whether a bot's chat notifies when it finishes or needs input; this device follows a save. */
export function useNotifyOnFinish(botId: string, saved: boolean, onFailed: (error: Error) => void) {
  return useBotSetting(botId, "notifyOnFinish", saved, {
    onSaved: async (notify, updated) => {
      // The server save succeeded; device reconciliation can retry later.
      await bestEffort(
        "bring notifications in line with a chat's setting",
        (async () =>
          afterChatNotifyChange(
            currentApiBase(),
            await loadSessionToken(),
            selectedSpaceId() ?? "",
            {
              botId,
              threadId: updated.threadId,
              notify,
            },
          ))(),
      );
    },
    onFailed,
  });
}
