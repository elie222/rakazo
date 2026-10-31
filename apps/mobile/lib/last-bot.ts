import * as SecureStore from "expo-secure-store";

const LAST_BOT_KEY = "rakazo.last_bot_id";
const LAST_BOT_TARGET_KEY = "rakazo.last_bot";

/** Kept with its Space in one item, so a Shortcuts action never pairs a bot with another's Space. */
export async function saveLastBotId(botId: string, spaceId: string | null) {
  if (!botId.trim()) return;
  await SecureStore.setItemAsync(LAST_BOT_TARGET_KEY, JSON.stringify({ botId, spaceId }));
  await SecureStore.setItemAsync(LAST_BOT_KEY, botId);
}

export async function loadLastBotId() {
  try {
    return (await SecureStore.getItemAsync(LAST_BOT_KEY)) ?? "";
  } catch {
    return "";
  }
}
