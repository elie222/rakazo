import { useNavigationContainerRef, useRouter } from "expo-router";
import { useCallback } from "react";

export function useLeaveDeletedChat() {
  const navigation = useNavigationContainerRef();
  const router = useRouter();
  return useCallback(
    (botId: string, removedGroupIds: readonly string[]) => {
      const route = navigation.getCurrentRoute() as
        | { params?: { botId?: string; groupId?: string } }
        | undefined;
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
