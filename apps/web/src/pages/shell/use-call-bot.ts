import type { Bot } from "@rakazo/contracts";
import { fetchFresh } from "@rakazo/core/query";
import { toast } from "@rakazo/ui-web";
import type { RefObject } from "react";
import { useCallback, useRef } from "react";
import { prepareCallAudio, startCall } from "../../lib/call-session";
import type { SpaceQueries } from "../../lib/query";
import { queryClient } from "../../lib/query";
import { selectedSpaceId } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** A click waits for this bot's readiness instead of treating an unfinished read as missing setup. */
export function useCallBot({
  enabled,
  activeBotId,
  queries,
  onConfigure,
}: {
  enabled: boolean;
  activeBotId: RefObject<string | undefined>;
  queries: SpaceQueries;
  onConfigure: () => void;
}) {
  const pending = useRef<{ botId: string } | null>(null);
  return useCallback(
    async (bot: Bot) => {
      if (!enabled || pending.current?.botId === bot.id) return;
      const request = { botId: bot.id };
      pending.current = request;
      const spaceId = selectedSpaceId();
      try {
        prepareCallAudio();
        const status = await fetchFresh(
          queryClient,
          queries.voice.status.queryOptions({ input: { botId: bot.id } }),
          { reuse: true },
        );
        if (
          pending.current !== request ||
          activeBotId.current !== bot.id ||
          selectedSpaceId() !== spaceId
        )
          return;
        if (!status.ready) {
          onConfigure();
          return;
        }
        startCall({
          botId: bot.id,
          botName: bot.name,
          botColor: bot.color,
          botAvatarSet: bot.avatarSet,
          transcribe: status.transcribe,
        });
      } catch (error) {
        if (
          pending.current === request &&
          activeBotId.current === bot.id &&
          selectedSpaceId() === spaceId
        )
          toast.error(errorText(error));
      } finally {
        if (pending.current === request) pending.current = null;
      }
    },
    [enabled, activeBotId, queries, onConfigure],
  );
}
