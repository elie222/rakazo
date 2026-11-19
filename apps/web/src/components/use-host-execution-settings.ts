import { useQuery, useQueryClient } from "@tanstack/react-query";
import { desktopBridge } from "../lib/platform/desktop";
import { useQueryUserId, useSpaceQueries } from "../lib/query/query";

/** Device choices stay outside the bot's server configuration. */
export function useHostExecutionSettings(botId: string) {
  const bridge = desktopBridge()?.harness;
  const cache = useQueryClient();
  const queries = useSpaceQueries();
  const userId = useQueryUserId();
  const me = useQuery({ ...queries.me.queryOptions({}), enabled: Boolean(bridge) });
  const spaceId = me.data?.spaceId;
  const profiles = useQuery({
    queryKey: ["device-agents", userId, spaceId],
    queryFn: () => bridge!.profiles({ spaceId: spaceId! }),
    enabled: Boolean(bridge && spaceId),
    retry: false,
  });
  const selection = useQuery({
    queryKey: ["device-agent", userId, spaceId, botId],
    queryFn: () => bridge!.selection({ spaceId: spaceId!, botId }),
    enabled: Boolean(bridge && spaceId),
    retry: false,
  });
  return {
    profiles: profiles.data ?? [],
    selected: selection.data,
    loading: Boolean(bridge) && (me.isLoading || profiles.isLoading || selection.isLoading),
    error: me.error ?? profiles.error ?? selection.error,
    async retry() {
      await Promise.all([profiles.refetch(), selection.refetch()]);
    },
    async stop() {
      if (bridge && spaceId) await bridge.stop({ botId, spaceId });
    },
    async select(profileId: string | null, target?: "workspace" | "computer") {
      if (!bridge || !spaceId) return;
      const next = await bridge.configure({
        botId,
        spaceId,
        profileId,
        ...(target ? { target } : {}),
      });
      cache.setQueryData(["device-agent", userId, spaceId, botId], next);
    },
  };
}
