import { NativeTabs } from "expo-router/native-tabs";
import { useCallMinimized } from "../../lib/calls/call-view";
import { CallReturnBar } from "../calls/call-return-bar";
import { VoicePlayerBar } from "../calls/voice-player-bar";

/**
 * What the tab bar's accessory shows: a minimized call, or else the voice player; compact beside a
 * minimized tab bar.
 */
export function TabBarAccessoryContent() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const callMinimized = useCallMinimized();
  return callMinimized ? (
    <CallReturnBar inTabBar={placement} />
  ) : (
    <VoicePlayerBar inTabBar={placement} />
  );
}
