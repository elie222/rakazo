import { rpc } from "../api/api";
import type { MobileSnapshot } from "../api/mobile-types";
import type { InboxItem } from "./inbox-spaces";
import type { SavedChatsScope } from "./saved-chats";
import {
  currentSavedChatsScope,
  readSavedThread,
  savedChatsScope,
  savedChatTarget,
  writeSavedThread,
} from "./saved-chats";

/** How many chats from the top of the inbox open from a saved copy on their first tap. */
export const PRELOADED_CHATS = 5;

type ChatTarget = { botId: string; groupId?: undefined } | { groupId: string; botId?: undefined };

/** Chats already saved or fetched in this session, by Space and chat; each is fetched once. */
const handled = new Set<string>();
let running: Promise<void> | null = null;

/** The chats the inbox lists from the selected Space, in the order it shows them. */
export function inboxChats(
  items: readonly InboxItem[],
  current: { bots: readonly { id: string }[]; groups: readonly { id: string }[] },
): ChatTarget[] {
  const bots = new Set(current.bots.map((bot) => bot.id));
  const groups = new Set(current.groups.map((group) => group.id));
  const bot = (id: string): ChatTarget[] => (bots.has(id) ? [{ botId: id }] : []);
  const group = (id: string): ChatTarget[] => (groups.has(id) ? [{ groupId: id }] : []);
  return items.flatMap((item) => {
    if (item.type === "pinned")
      return item.chats.flatMap((chat) =>
        chat.kind === "bot" ? bot(chat.bot.id) : group(chat.group.id),
      );
    if (item.type === "bot") return bot(item.bot.id);
    return item.type === "group" ? group(item.group.id) : [];
  });
}

/**
 * Saves a copy of the first chats the inbox lists that have none yet, one at a time, so opening
 * one shows its messages at once instead of waiting on the network. A chat with a saved copy is
 * left alone: opening it already shows that copy while it refreshes.
 */
export function preloadChats(chats: readonly ChatTarget[]): Promise<void> {
  const targets = chats.slice(0, PRELOADED_CHATS);
  const pass = async () => {
    // The inbox changes often; a Space this session already read needs no keychain reads.
    const scope = currentSavedChatsScope() ?? (await savedChatsScope());
    if (scope) await preloadInto(scope, targets);
  };
  running = (running ?? Promise.resolve()).then(pass, pass);
  return running;
}

async function preloadInto(scope: SavedChatsScope, targets: readonly ChatTarget[]) {
  for (const chat of targets) {
    const target = savedChatTarget(chat);
    const key = JSON.stringify([scope.namespace, scope.selectionId, target]);
    if (handled.has(key)) continue;
    handled.add(key);
    if (readSavedThread(scope, target)) continue;
    let snapshot: MobileSnapshot;
    try {
      snapshot = await rpc(
        "threads/get",
        chat.groupId ? { groupId: chat.groupId } : { botId: chat.botId! },
      );
    } catch {
      // Offline or refused: the chat loads as usual when opened, and the next pass tries again.
      handled.delete(key);
      return;
    }
    // The chat screen saves a fresher copy when the chat was opened meanwhile.
    if (!readSavedThread(scope, target)) writeSavedThread(scope, target, snapshot);
  }
}
