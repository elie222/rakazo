import { useLingui } from "@lingui/react/macro";
import { NativeTabs } from "expo-router/native-tabs";
import { useSyncExternalStore } from "react";
import { TabBarAccessoryContent } from "../../components/screens/tab-bar-accessory";
import { useCallActive } from "../../lib/calls/call-session";
import { useCallMinimized } from "../../lib/calls/call-view";
import { tabAccessorySupported } from "../../lib/layout/tab-accessory";
import { useMobileTokens } from "../../lib/native/native";
import { getVoicePlaybackState, subscribeVoicePlayback } from "../../lib/voice/voice";

/**
 * The app's sections as the platform tab bar (Liquid Glass on iOS 26). Each tab keeps its own
 * stack, so Pages and Routines stay under the bar; a chat or a settings screen opens over it
 * from the root stack. On iOS 26 a minimized call, or the voice player, rides in the bar's
 * accessory instead of stacking under it.
 */
export default function TabsLayout() {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const playing =
    useSyncExternalStore(subscribeVoicePlayback, getVoicePlaybackState).status !== "idle";
  const onCall = useCallActive();
  const callMinimized = useCallMinimized();
  // A call speaks through its own screen, so the voice player waits while one is on.
  const accessory = callMinimized || (playing && !onCall);
  return (
    <NativeTabs tintColor={tokens.primary} minimizeBehavior="onScrollDown">
      {tabAccessorySupported() && accessory ? (
        <NativeTabs.BottomAccessory>
          <TabBarAccessoryContent />
        </NativeTabs.BottomAccessory>
      ) : null}
      <NativeTabs.Trigger name="(chats)">
        <NativeTabs.Trigger.Icon
          sf={{
            default: "bubble.left.and.bubble.right",
            selected: "bubble.left.and.bubble.right.fill",
          }}
          md="chat"
        />
        <NativeTabs.Trigger.Label>{t`Chats`}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(activity)">
        <NativeTabs.Trigger.Icon sf={{ default: "tray", selected: "tray.fill" }} md="inbox" />
        <NativeTabs.Trigger.Label>{t`Activity`}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(pages)">
        <NativeTabs.Trigger.Icon
          sf={{ default: "doc.text", selected: "doc.text.fill" }}
          md="description"
        />
        <NativeTabs.Trigger.Label>{t`Pages`}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(routines)">
        <NativeTabs.Trigger.Icon sf="clock.arrow.circlepath" md="history" />
        <NativeTabs.Trigger.Label>{t`Routines`}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(search)" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
        <NativeTabs.Trigger.Label>{t`Search`}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
