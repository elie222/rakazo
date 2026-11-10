import type { EventSubscription } from "expo-modules-core";
import { requireOptionalNativeModule } from "expo-modules-core";

/** The "Start Voice Chat" Shortcuts action, which opens a bot's chat and asks it to call. */
const native = requireOptionalNativeModule<{
  takePendingVoiceChat(botId: string): boolean;
  addListener(event: "onPendingVoiceChat", listener: () => void): EventSubscription;
}>("RakazoVoiceChat");

/** True once, when the action asked to call this bot. */
export function takeShortcutVoiceChat(botId: string): boolean {
  return native?.takePendingVoiceChat(botId) ?? false;
}

/** Covers a chat that was already open when the action ran. */
export function onShortcutVoiceChat(listener: () => void): () => void {
  const subscription = native?.addListener("onPendingVoiceChat", listener);
  return () => subscription?.remove();
}
