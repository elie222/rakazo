import * as SecureStore from "expo-secure-store";

const LAST_BOT_KEY = "rakazo.last_bot_id";
const LAST_BOT_SPACE_KEY = "rakazo.last_bot_space_id";

/** Kept with its Space, so a Shortcuts action still reaches the bot after a Space switch. */
export async function saveLastBotId(botId: string, spaceId: string | null) {
  if (!botId.trim()) return;
  await SecureStore.setItemAsync(LAST_BOT_KEY, botId);
  if (spaceId) await SecureStore.setItemAsync(LAST_BOT_SPACE_KEY, spaceId);
  else await SecureStore.deleteItemAsync(LAST_BOT_SPACE_KEY);
}

export async function loadLastBotId() {
  try {
    return (await SecureStore.getItemAsync(LAST_BOT_KEY)) ?? "";
  } catch {
    return "";
  }
}

/** The last bot belongs to one account and server; a new session starts without one. */
export async function clearLastBot() {
  await SecureStore.deleteItemAsync(LAST_BOT_KEY).catch(() => undefined);
  await SecureStore.deleteItemAsync(LAST_BOT_SPACE_KEY).catch(() => undefined);
}
