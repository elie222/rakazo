import { NativeTabs } from "expo-router/native-tabs";
import { VoicePlayerBar } from "../calls/voice-player-bar";

/** What the tab bar's accessory shows: the voice player, compact beside a minimized tab bar. */
export function TabBarAccessoryContent() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  return <VoicePlayerBar inTabBar={placement} />;
}
