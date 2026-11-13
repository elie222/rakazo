import { useNavigationContainerRef, useRouter } from "expo-router";
import { useCallback } from "react";

export function useLeaveDeletedChat() {
  const navigation = useNavigationContainerRef();
  const router = useRouter();
  return useCallback(
    (botId: string, removedGroupIds: readonly string[]) => {
      const route = navigation.getCurrentRoute() as
        | { name: string; params?: { botId?: string; groupId?: string } }
        | undefined;
      // Artifacts uses the bot ID as an optional filter, not as the route's owner.
      if (route?.name === "artifacts") return;
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
