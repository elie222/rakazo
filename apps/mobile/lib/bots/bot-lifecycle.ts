import { ph, t } from "@lingui/core/macro";
import { botRemovalWarning } from "@rakazo/i18n/bot-removal";
import { Alert } from "react-native";
import type { ApiRequestContext } from "../api/api";
import { captureApiRequestContext, rpc } from "../api/api";
import { currentSessionGeneration } from "../api/session";
import { errorText } from "../api/user-error";
import { notifyArchivedChatsChanged } from "../inbox/archived/archived-chats";
import type { SaveSend } from "../query/query";
import { removeFromSearchInbox } from "../search/search-inbox";
import { notifyConversationCleared } from "../thread/conversation-cleared";

export async function confirmDeleteBot(
  bot: { id: string; name: string },
  onDeleted: (removedGroupIds: readonly string[], recoveryContext?: ApiRequestContext) => void,
  // False once the screen that asked has gone, so a late failure doesn't alert elsewhere.
  current: () => boolean = () => true,
  requestContext?: ApiRequestContext,
  finished: () => void = () => {},
) {
  try {
    requestContext ??= await captureApiRequestContext();
  } catch (error) {
    if (current()) Alert.alert(t`Could not delete bot`, errorText(error, t`Try again.`));
    finished();
    return;
  }
  const contextCurrent = () =>
    requestContext.sessionGeneration === undefined ||
    requestContext.sessionGeneration === currentSessionGeneration();
  // Native alerts cannot update their message: resolve the preview before opening one.
  let groupWarning = "";
  try {
    const groups = await rpc(
      "bots/removePreview",
      { botId: bot.id },
      { requestContext, skipSpaceAuthRecovery: true },
    );
    groupWarning = botRemovalWarning(groups);
  } catch {
    groupWarning = botRemovalWarning(null);
  }

  if (!current() || !contextCurrent()) {
    finished();
    return;
  }

  const remove = async (deleteMemories: boolean) => {
    try {
      if (!current() || !contextCurrent()) return;
      const result = await rpc(
        "bots/remove",
        { botId: bot.id, deleteMemories },
        { requestContext, skipSpaceAuthRecovery: true },
      );
      if (!contextCurrent()) return;
      removeFromSearchInbox(bot.id);
      if (result.alreadyRemoved) onDeleted(result.removedGroupIds ?? [], requestContext);
      else onDeleted(result.removedGroupIds ?? []);
    } catch (error) {
      if (current() && contextCurrent())
        Alert.alert(t`Could not delete bot`, errorText(error, t`Try again.`));
    } finally {
      finished();
    }
  };

  Alert.alert(
    t`Delete ${ph({ name: bot.name })}?`,
    [
      groupWarning,
      t`Its conversation, files, and routines will be permanently deleted. What should happen to its memories?`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    [
      { text: t`Cancel`, style: "cancel", onPress: finished },
      { text: t`Keep memories`, style: "destructive", onPress: () => void remove(false) },
      {
        text: t`Delete memories too`,
        style: "destructive",
        onPress: () => void remove(true),
      },
    ],
    { onDismiss: finished },
  );
}

/** Asks before deleting a group; `onConfirm` deletes it, with `deleteGroup`. */
export function confirmDeleteGroup(group: { name: string }, onConfirm: () => void) {
  Alert.alert(t`Delete ${ph({ name: group.name })}?`, t`Bots and their own chats stay.`, [
    { text: t`Cancel`, style: "cancel" },
    { text: t`Delete`, style: "destructive", onPress: onConfirm },
  ]);
}

/** Deletes a group through the caller's client, then takes it out of search. */
export async function deleteGroup(groupId: string, send: SaveSend): Promise<void> {
  await send("groups/remove", { groupId });
  removeFromSearchInbox(groupId);
}

/** Says a group could not be deleted. */
export function alertGroupNotDeleted(error: unknown) {
  Alert.alert(t`Could not delete group`, errorText(error, t`Try again.`));
}

export async function restoreArchivedBot(botId: string): Promise<void> {
  await rpc("bots/restore", { botId });
}

export async function archiveBot(botId: string): Promise<void> {
  await rpc("bots/archive", { botId });
  removeFromSearchInbox(botId);
  notifyArchivedChatsChanged();
}

export function confirmClearConversation(botId: string) {
  Alert.alert(
    t`Clear conversation?`,
    t`This removes every message and stops current work. The bot, computer, memory, and routines are kept.`,
    [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Clear`,
        style: "destructive",
        onPress: () =>
          void rpc("threads/clear", { botId })
            .then(() => notifyConversationCleared(botId))
            .catch((error: unknown) =>
              Alert.alert(t`Could not clear conversation`, errorText(error, t`Try again.`)),
            ),
      },
    ],
  );
}
