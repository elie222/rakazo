import { MenuView } from "@expo/ui/community/menu";
import type { NativeStackNavigationOptions } from "expo-router";
import { useRouter } from "expo-router";
import { Alert, View } from "react-native";
import { notifyArchivedChatsChanged } from "../lib/archived-chats";
import { archiveBot, confirmClearConversation, confirmDeleteBot } from "../lib/bot-lifecycle";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { errorText } from "../lib/user-error";
import { NativeSymbol } from "./native-symbol";

export type BotProfileAction = {
  id: string;
  text: string;
  destructive?: boolean;
  onPress: () => void;
};

/** The bot's less common actions, in its profile's "…" menu. */
export function useBotProfileActions(botId: string, name: string): BotProfileAction[] {
  const { t } = useI18n();
  const router = useRouter();
  function leave() {
    router.dismissAll();
    router.replace("/");
  }
  return [
    {
      id: "clear",
      text: t("Clear conversation"),
      destructive: true,
      onPress: () => confirmClearConversation(botId),
    },
    {
      id: "archive",
      text: t("Archive"),
      onPress: () =>
        void archiveBot(botId)
          .then(leave)
          .catch((error) =>
            Alert.alert(t("Could not archive bot"), errorText(error, t("Try again."))),
          ),
    },
    {
      id: "delete",
      text: t("Delete…"),
      destructive: true,
      onPress: () =>
        confirmDeleteBot({ id: botId, name }, () => {
          notifyArchivedChatsChanged();
          leave();
        }),
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
