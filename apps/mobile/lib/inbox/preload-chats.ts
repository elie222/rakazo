import { isRetryableError } from "@rakazo/core";
import { selectedSpaceId } from "../api/api";
import type { MobileSnapshot } from "../api/mobile-types";
import { isVerifiedScopeCurrent } from "../api/verified-scope";
import { onConversationCleared } from "../thread/conversation-cleared";
import { chatRpc } from "./chat-rpc";
import type { InboxItem } from "./inbox-spaces";
import type { SavedChatsScope } from "./saved-chats";
import {
  currentSavedChatsScope,
  readSavedThread,
  savedChatsScope,
  savedChatTarget,
  writeSavedThread,
} from "./saved-chats";

/** How many chats from the top of the inbox, in any Space, open from a saved copy on their first tap. */
export const PRELOADED_CHATS = 20;

type ChatTarget = { spaceId?: string } & (
  | { botId: string; groupId?: undefined }
  | { groupId: string; botId?: undefined }
);

/** Chats already saved or fetched in this session, by Space and chat; each is fetched once. */
const handled = new Set<string>();
let running: Promise<void> | null = null;

/** The chats the inbox lists, in every Space, in the order it shows them. */
export function inboxChats(items: readonly InboxItem[]): ChatTarget[] {
  const bot = ({ id, spaceId }: { id: string; spaceId?: string }) => ({ botId: id, spaceId });
  const group = ({ id, spaceId }: { id: string; spaceId?: string }) => ({ groupId: id, spaceId });
  return items.flatMap((item): ChatTarget[] => {
    if (item.type === "pinned")
      return item.chats.map((chat) => (chat.kind === "bot" ? bot(chat.bot) : group(chat.group)));
    if (item.type === "bot") return [bot(item.bot)];
    return item.type === "group" ? [group(item.group)] : [];
  });
}

/**
 * Saves a copy of the first chats the inbox lists that have none yet, one at a time, so opening
 * one shows its messages at once instead of waiting on the network. A chat with a saved copy is
 * left alone: opening it already shows that copy while it refreshes.
 */
export function preloadChats(chats: readonly ChatTarget[]): Promise<void> {
  const targets = chats.slice(0, PRELOADED_CHATS);
  // These chats belong to the Space selected now; a pass that starts after a switch skips them.
  const selection = selectedSpaceId();
  const pass = async () => {
    // The inbox changes often; a Space this session already read needs no keychain reads.
    const scope = currentSavedChatsScope() ?? (await savedChatsScope());
    if (scope && scope.selectionId === selection) await preloadInto(scope, targets);
  };
  running = (running ?? Promise.resolve()).then(pass, pass);
  return running;
}

async function preloadInto(scope: SavedChatsScope, targets: readonly ChatTarget[]) {
  for (const chat of targets) {
    // After a Space switch these chats belong to another Space; the new one gets its own pass.
    if (!isVerifiedScopeCurrent(scope)) return;
    // A copy saved under the chat's own Space is the one opening it there reads.
    const chatScope = { ...scope, spaceId: chat.spaceId ?? scope.spaceId };
    const target = savedChatTarget(chat);
    const key = JSON.stringify([scope.namespace, chatScope.spaceId, target]);
    if (handled.has(key)) continue;
    handled.add(key);
    if (readSavedThread(chatScope, target)) continue;
    let cleared = false;
    const stopWatching = onConversationCleared((botId) => {
      if (botId === chat.botId) cleared = true;
    });
    let snapshot: MobileSnapshot;
    try {
      snapshot = await chatRpc(
        chatScope.spaceId === scope.spaceId ? undefined : chatScope.spaceId,
        "threads/get",
        chat.groupId ? { groupId: chat.groupId } : { botId: chat.botId! },
      );
    } catch (error) {
      // A refusal is the server's answer: reported once and not asked again this launch.
      if (!isRetryableError(error)) throw error;
      // Offline or busy: the chat loads as usual when opened, and a later pass asks again.
      handled.delete(key);
      return;
    } finally {
      stopWatching();
    }
    // A chat cleared meanwhile, or opened meanwhile (its screen saved a fresher copy), keeps
    // what it has.
    if (!cleared && !readSavedThread(chatScope, target))
      writeSavedThread(chatScope, target, snapshot);
  }
}
