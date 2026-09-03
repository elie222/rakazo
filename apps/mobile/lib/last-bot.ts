import * as SecureStore from "expo-secure-store";

const LAST_BOT_KEY = "rakazo.last_bot_id";

export async function saveLastBotId(botId: string) {
  if (!botId.trim()) return;
  await SecureStore.setItemAsync(LAST_BOT_KEY, botId);
}

export async function loadLastBotId() {
  try {
    return (await SecureStore.getItemAsync(LAST_BOT_KEY)) ?? "";
  } catch {
    return "";
  }
}
