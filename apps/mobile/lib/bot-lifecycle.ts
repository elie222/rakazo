import { ph, t } from "@lingui/core/macro";
import { botRemovalWarning } from "@rakazo/i18n/bot-removal";
import { Alert } from "react-native";
import type { ApiRequestContext } from "./api";
import { captureApiRequestContext, rpc } from "./api";
import { notifyArchivedChatsChanged } from "./archived-chats";
import { notifyConversationCleared } from "./conversation-cleared";
import { removeFromSearchInbox } from "./search-inbox";
import { currentSessionGeneration } from "./session";
import { errorText } from "./user-error";

export async function confirmDeleteBot(
  bot: { id: string; name: string },
  onDeleted: (removedGroupIds: readonly string[]) => void,
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
      removeFromSearchInbox(bot.id);
      onDeleted(result.removedGroupIds ?? []);
    } catch (error) {
      if (current()) Alert.alert(t`Could not delete bot`, errorText(error, t`Try again.`));
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

export function confirmDeleteGroup(
  group: { id: string; name: string },
  onDeleted: () => void,
  requestContext?: ApiRequestContext,
) {
  Alert.alert(t`Delete ${ph({ name: group.name })}?`, t`Bots and their own chats stay.`, [
    { text: t`Cancel`, style: "cancel" },
    {
      text: t`Delete`,
      style: "destructive",
      onPress: () =>
        void (
          requestContext
            ? rpc(
                "groups/remove",
                { groupId: group.id },
                { requestContext, skipSpaceAuthRecovery: true },
              )
            : rpc("groups/remove", { groupId: group.id })
        )
          .then(() => {
            removeFromSearchInbox(group.id);
            onDeleted();
          })
          .catch((err) => Alert.alert(t`Could not delete group`, errorText(err, t`Try again.`))),
    },
  ]);
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
