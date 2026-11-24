import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { NativeStackNavigationOptions } from "expo-router";
import { useNavigation, useRouter } from "expo-router";
import { useRef } from "react";
import { Alert, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import {
  archiveBot,
  confirmClearConversation,
  confirmDeleteBot,
} from "../../lib/bots/bot-lifecycle";
import { notifyArchivedChatsChanged } from "../../lib/inbox/archived/archived-chats";
import { notifyInboxChanged, openChatFromInbox } from "../../lib/inbox/inbox-changes";
import { useResolvedAppearance } from "../../lib/native/native";
import { iosAtLeast } from "../../lib/native/native-controls";
import { useConfirmationGuard } from "../../lib/native/use-confirmation-guard";
import { useSave } from "../../lib/query/query";
import type { SearchInboxSession } from "../../lib/search/search-inbox";
import { addToSearchInbox, searchInboxSession } from "../../lib/search/search-inbox";
import { useLeaveDeletedChat } from "../../lib/thread/use-leave-deleted-chat";
import { NativeSymbol } from "../native/native-symbol";

export type BotProfileAction = {
  id: string;
  text: string;
  destructive?: boolean;
  onPress: () => void;
};

/** The bot's less common actions, in its profile's "…" menu. */
export function useBotProfileActions(botId: string, name: string): BotProfileAction[] {
  const { t } = useLingui();
  const router = useRouter();
  const navigation = useNavigation();
  const leaveDeletedChat = useLeaveDeletedChat();
  const beginDelete = useConfirmationGuard();
  function leave() {
    router.dismissAll();
    router.replace("/");
  }
  // Set once the copy's chat is opening, so a tap before this profile closes makes no second copy.
  const leaving = useRef(false);
  const duplicate = useSave({
    save: (_: { askedIn: SearchInboxSession }, send) => send("bots/duplicate", { botId }),
    // The copy's chat opens the way a new bot's does.
    onSaved: (copy, { askedIn }) => {
      notifyInboxChanged();
      addToSearchInbox({ kind: "bot", bot: copy }, askedIn);
      // Opened Edit meanwhile: leave that screen as it is.
      if (!navigation.isFocused()) return;
      leaving.current = true;
      router.dismissAll();
      const href = { pathname: "/thread" as const, params: { botId: copy.id, name: copy.name } };
      if (!openChatFromInbox(href)) router.push(href);
    },
    onFailed: (error) => {
      if (navigation.isFocused())
        Alert.alert(t`Could not duplicate bot`, errorText(error, t`Try again.`));
    },
    // Not `closesScreen`: a profile left open under Edit stays mounted and must be able to duplicate again.
  });
  return [
    {
      id: "duplicate",
      text: t`Duplicate`,
      onPress: () => {
        if (!leaving.current) duplicate.run({ askedIn: searchInboxSession() });
      },
    },
    {
      id: "clear",
      text: t`Clear conversation`,
      destructive: true,
      onPress: () => confirmClearConversation(botId),
    },
    {
      id: "archive",
      text: t`Archive`,
      onPress: () =>
        void archiveBot(botId)
          .then(leave)
          .catch((error) => Alert.alert(t`Could not archive bot`, errorText(error, t`Try again.`))),
    },
    {
      id: "delete",
      text: t`Delete…`,
      destructive: true,
      onPress: () => {
        const confirmation = beginDelete();
        if (!confirmation) return;
        void confirmDeleteBot(
          { id: botId, name },
          (removedGroupIds, recoveryContext) => {
            notifyArchivedChatsChanged();
            void leaveDeletedChat(botId, removedGroupIds, recoveryContext);
          },
          confirmation.current,
          undefined,
          confirmation.finish,
        );
      },
    },
  ];
}

/** The profile's "…" header menu: a native bar menu on iOS, a native popup menu elsewhere. */
export function botProfileMenuOptions(
  actions: readonly BotProfileAction[],
  label: string,
  color: string,
): NativeStackNavigationOptions {
  // Native header items exist from iOS 26; older iOS uses the same menu button as Android.
  if (iosAtLeast(26))
    return {
      unstable_headerRightItems: () => [
        {
          type: "menu" as const,
          label,
          accessibilityLabel: label,
          icon: { type: "sfSymbol" as const, name: "ellipsis" },
          menu: {
            items: actions.map((action) => ({
              type: "action" as const,
              label: action.text,
              destructive: action.destructive,
              onPress: action.onPress,
            })),
          },
        },
      ],
    };
  return {
    headerRight: () => <BotProfileMenu actions={actions} label={label} color={color} />,
  };
}

function BotProfileMenu({
  actions,
  label,
  color,
}: {
  actions: readonly BotProfileAction[];
  label: string;
  color: string;
}) {
  const colorScheme = useResolvedAppearance();
  return (
    <MenuView
      actions={actions.map((action) => ({
        id: action.id,
        title: action.text,
        ...(action.destructive ? { attributes: { destructive: true } } : {}),
      }))}
      colorScheme={colorScheme}
      onPressAction={({ nativeEvent }) =>
        actions.find((action) => action.id === nativeEvent.event)?.onPress()
      }
    >
      {/* A sized trigger: an unsized one can collapse to zero width on some Android builds. */}
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
      >
        <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={21} color={color} />
      </View>
    </MenuView>
  );
}
