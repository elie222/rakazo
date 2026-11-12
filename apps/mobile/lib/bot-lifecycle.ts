import { ph, t } from "@lingui/core/macro";
import { Alert } from "react-native";
import type { ApiRequestContext } from "./api";
import { rpc } from "./api";
import { notifyArchivedChatsChanged } from "./archived-chats";
import { notifyConversationCleared } from "./conversation-cleared";
import { removeFromSearchInbox } from "./search-inbox";
import { errorText } from "./user-error";

export async function confirmDeleteBot(
  bot: { id: string; name: string },
  onDeleted: () => void,
  // False once the screen that asked has gone, so a late failure doesn't alert elsewhere.
  current: () => boolean = () => true,
  requestContext?: ApiRequestContext,
  finished: () => void = () => {},
) {
  // Native alerts cannot update their message: resolve the preview before opening one.
  let groupWarning = "";
  try {
    const groups = requestContext
      ? await rpc(
          "bots/removePreview",
          { botId: bot.id },
          { requestContext, skipSpaceAuthRecovery: true },
        )
      : await rpc("bots/removePreview", { botId: bot.id });
    const names = groups.map((group) => group.name).join(", ");
    if (groups.length === 1) {
      groupWarning = t`The group ${ph({ names })} will be deleted too, including its messages, files, and pages.`;
    } else if (groups.length > 1) {
      groupWarning = t`The groups ${ph({ names })} will be deleted too, including their messages, files, and pages.`;
    }
  } catch {
    // Match the web dialog: a failed preview warns generally rather than hiding the risk.
    groupWarning = t`Groups left with fewer than two bots are deleted too, including their messages, files, and pages.`;
  }
  if (!current()) {
    finished();
    return;
  }

  const remove = async (deleteMemories: boolean) => {
    try {
      if (!current()) return;
      if (requestContext) {
        await rpc(
          "bots/remove",
          { botId: bot.id, deleteMemories },
          { requestContext, skipSpaceAuthRecovery: true },
        );
      } else {
        await rpc("bots/remove", { botId: bot.id, deleteMemories });
      }
      removeFromSearchInbox(bot.id);
      onDeleted();
    } catch (error) {
      if (current()) Alert.alert(t`Could not delete bot`, errorText(error, t`Try again.`));
    } finally {
      finished();
    }
  };

  Alert.alert(
    t`Delete ${ph({ name: bot.name })}?`,
    [
      t`Its conversation, files, and routines will be permanently deleted. What should happen to its memories?`,
      groupWarning,
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
