import { useNavigationContainerRef, useRouter } from "expo-router";
import { useCallback } from "react";

import type { ApiRequestContext } from "./api";
import { rpc } from "./api";
import { currentSessionGeneration } from "./session";

export function useLeaveDeletedChat() {
  const navigation = useNavigationContainerRef();
  const router = useRouter();
  return useCallback(
    async (
      botId: string,
      removedGroupIds: readonly string[],
      recoveryContext?: ApiRequestContext,
    ) => {
      const route = navigation.getCurrentRoute() as
        | { key?: string; name: string; params?: { botId?: string; groupId?: string } }
        | undefined;
      // Artifacts uses the bot ID as an optional filter, not as the route's owner.
      if (route?.name === "artifacts") return;
      if (
        recoveryContext &&
        route?.params?.groupId &&
        !removedGroupIds.includes(route.params.groupId)
      ) {
        const groupId = route.params.groupId;
        try {
          const groups = await rpc(
            "groups/list",
            {},
            { requestContext: recoveryContext, skipSpaceAuthRecovery: true },
          );
          if (groups.some((group) => group.id === groupId)) return;
          if (
            recoveryContext.sessionGeneration !== undefined &&
            recoveryContext.sessionGeneration !== currentSessionGeneration()
          )
            return;
          const live = navigation.getCurrentRoute() as unknown as typeof route | undefined;
          if (live?.key !== route.key || live?.params?.groupId !== groupId) return;
          removedGroupIds = [groupId];
        } catch {
          return;
        }
      }
      if (
        route?.params?.botId === botId ||
        (route?.params?.groupId && removedGroupIds.includes(route.params.groupId))
      ) {
        router.dismissAll();
        router.replace("/");
      }
    },
    [navigation, router],
  );
}
