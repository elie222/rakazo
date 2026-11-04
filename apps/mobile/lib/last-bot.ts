import * as SecureStore from "expo-secure-store";
import { currentSessionGeneration } from "./session";

const LAST_BOT_KEY = "rakazo.last_bot_id";
const LAST_BOT_SPACE_KEY = "rakazo.last_bot_space_id";
const READ_TIMEOUT_MS = 500;
let writes: Promise<unknown> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const next = writes.then(task, task);
  writes = next.catch(() => undefined);
  return next;
}

/** Kept with its Space, so a Shortcuts action still reaches the bot after a Space switch. */
export async function saveLastBotId(botId: string, spaceId: string | null) {
  if (!botId.trim()) return;
  const generation = currentSessionGeneration();
  return enqueueWrite(async () => {
    if (generation !== currentSessionGeneration()) return;
    await SecureStore.setItemAsync(LAST_BOT_KEY, botId);
    if (spaceId) await SecureStore.setItemAsync(LAST_BOT_SPACE_KEY, spaceId);
    else await SecureStore.deleteItemAsync(LAST_BOT_SPACE_KEY);
  });
}

export async function loadLastBotId() {
  const generation = currentSessionGeneration();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      writes.then(async () => {
        const botId = (await SecureStore.getItemAsync(LAST_BOT_KEY)) ?? "";
        return generation === currentSessionGeneration() ? botId : "";
      }),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve(""), READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return "";
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Delete both keys after any in-flight save; reads fail closed while cleanup is pending. */
export async function clearLastBot() {
  return enqueueWrite(async () => {
    await SecureStore.deleteItemAsync(LAST_BOT_KEY).catch(() => undefined);
    await SecureStore.deleteItemAsync(LAST_BOT_SPACE_KEY).catch(() => undefined);
  });
}
