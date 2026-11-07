import { requireOptionalNativeModule } from "expo-modules-core";
import { AppState, Platform } from "react-native";
import { rpc } from "./api";
import { loadSessionToken, subscribeSessionGeneration } from "./session";

type NativeWorkActivities = {
  startWorkActivity(
    title: string,
    spaceId: string,
    botId: string | null,
    groupId: string | null,
  ): Promise<void>;
  refreshWorkActivity(): Promise<void>;
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

/**
 * Keeps the card in step for the app's lifetime: hands its token to the server, re-checks it on
 * launch and whenever the app opens, and ends it on sign-out.
 */
export function startWorkActivities(): () => void {
  if (!activities) return () => undefined;
  const card = activities;
  // The token arrives after the card starts, again whenever iOS changes it, and on each refresh,
  // so the server can say the work the card shows has ended.
  const tokens = card.addListener("onWorkActivityToken", ({ token }) => {
    rpc("notifications/followWorkActivity", { token })
      .then(({ following }) => {
        // Nothing would update it: no bot is at work or this server cannot reach the phone.
        if (!following) return card.endWorkActivity();
      })
      // An unanswered request proves nothing; the next open asks again.
      .catch(() => undefined);
  });
  const refresh = () => void card.refreshWorkActivity().catch(() => undefined);
  const opens = AppState.addEventListener("change", (state) => {
    if (state === "active") refresh();
  });
  // Signed out: the card shows the last account's bots.
  const sessions = subscribeSessionGeneration(() => {
    void loadSessionToken().then((token) => {
      if (!token) return card.endWorkActivity();
    });
  });
  refresh();
  return () => {
    tokens.remove();
    opens.remove();
    sessions();
  };
}

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
