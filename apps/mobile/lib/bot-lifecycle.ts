import { Alert } from "react-native";
import type { ApiRequestContext } from "./api";
import { rpc } from "./api";
import { t } from "./i18n";
import { removeFromSearchInbox } from "./search-inbox";
import { errorText } from "./user-error";

export function confirmDeleteBot(
  bot: { id: string; name: string },
  onDeleted: () => void,
  // False once the screen that asked has gone, so a late failure doesn't alert elsewhere.
  current: () => boolean = () => true,
  requestContext?: ApiRequestContext,
) {
  const remove = async (deleteMemories: boolean) => {
    try {
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
      if (current()) Alert.alert(t("Could not delete bot"), errorText(error, t("Try again.")));
    }
  };

  Alert.alert(
    t("Delete {name}?", { name: bot.name }),
    t(
      "Its conversation, files, and routines will be permanently deleted. What should happen to its memories?",
    ),
    [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Keep memories"), style: "destructive", onPress: () => void remove(false) },
      {
        text: t("Delete memories too"),
        style: "destructive",
        onPress: () => void remove(true),
      },
    ],
  );
}

export function confirmDeleteGroup(group: { id: string; name: string }, onDeleted: () => void) {
  Alert.alert(t("Delete {name}?", { name: group.name }), t("Bots and their own chats stay."), [
    { text: t("Cancel"), style: "cancel" },
    {
      text: t("Delete"),
      style: "destructive",
      onPress: () =>
        void rpc("groups/remove", { groupId: group.id })
          .then(() => {
            removeFromSearchInbox(group.id);
            onDeleted();
          })
          .catch((err) =>
            Alert.alert(t("Could not delete group"), errorText(err, t("Try again."))),
          ),
    },
  ]);
}

export async function restoreArchivedBot(botId: string): Promise<void> {
  await rpc("bots/restore", { botId });
}
