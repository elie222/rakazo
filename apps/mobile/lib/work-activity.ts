import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";
import { rpc } from "./api";

type NativeWorkActivities = {
  startWorkActivity(
    title: string,
    spaceId: string,
    botId: string | null,
    groupId: string | null,
  ): Promise<void>;
  endWorkActivity(): Promise<void>;
  addListener(
    name: "onWorkActivityToken",
    callback: (event: { token: string }) => void,
  ): { remove(): void };
};

const native =
  Platform.OS === "ios"
    ? requireOptionalNativeModule<NativeWorkActivities>("RakazoNotifications")
    : null;
const activities = native?.startWorkActivity ? native : null;

// The card's push token arrives after it starts, and again whenever iOS changes it.
activities?.addListener("onWorkActivityToken", ({ token }) => {
  rpc("notifications/followWorkActivity", { token })
    .then(({ following }) => {
      // Nothing would update it: no bot is at work or this server cannot reach the phone.
      if (!following) return activities.endWorkActivity();
    })
    .catch(() => activities.endWorkActivity());
});

/**
 * Shows the user's bots at work on the Lock Screen and in the Dynamic Island, starting with the
 * one just sent a message. iOS hides it while the app is open.
 */
export function startWorkActivity(input: {
  title: string;
  spaceId: string;
  target: { botId: string } | { groupId: string };
}): void {
  if (!activities) return;
  const { botId = null, groupId = null } = input.target as { botId?: string; groupId?: string };
  void activities
    .startWorkActivity(input.title, input.spaceId, botId, groupId)
    .catch(() => undefined);
}
