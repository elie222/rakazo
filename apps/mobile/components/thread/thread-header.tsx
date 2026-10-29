import { useNavigation, useRoute, useRouter } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { Alert, Modal, Pressable, Text, View } from "react-native";
import type { MobileBot } from "../../lib/api";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { notifyArchivedChatsChanged } from "../../lib/archived-chats";
import { confirmDeleteBot, restoreArchivedBot } from "../../lib/bot-lifecycle";
import { chatTitleRoute } from "../../lib/chat-settings-route";
import { useI18n } from "../../lib/i18n";
import { useResolvedAppearance } from "../../lib/native";
import { removeFromSearchInbox } from "../../lib/search-inbox";
import { threadEdgeOptions } from "../../lib/thread-edges";
import { errorText } from "../../lib/user-error";
import type { ChatTitle } from "../chat-header-title";
import { publishChatTitle } from "../chat-header-title";
import { trailingHeaderOptions } from "../sheet-header";
import { threadHeaderRight } from "../thread-header-right";
import type { createThreadHeaderStyles } from "../thread-header-styles";

type BotAction = { text: string; destructive?: boolean; onPress: () => void };

/**
 * The chat's navigation header: its title, the bot's actions menu (or group settings), the
 * split-view inbox toggle, and Restore for an archived bot.
 */
export function useThreadHeader({
  botId,
  groupId,
  inGroup,
  readOnly,
  displayName,
  titleBot,
  titleName,
  groupMembers,
  currentBotStatus,
  composingBots,
  styles,
  onCleared,
}: {
  botId?: string;
  groupId?: string;
  inGroup: boolean;
  readOnly: boolean;
  displayName?: string;
  /** The chat's bot, or the inbox's copy of it until the chat's roster arrives. */
  titleBot?: ChatTitle["bot"];
  titleName?: string;
  groupMembers?: ChatTitle["members"];
  currentBotStatus?: MobileBot["status"];
  /** Bots writing reply text right now, comma-separated. */
  composingBots: string;
  styles: ReturnType<typeof createThreadHeaderStyles>;
  /** Runs once the server has cleared the conversation. */
  onCleared: () => void;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const { t } = useI18n();
  const navigation = useNavigation();
  // This screen's own route: its header title reads what this screen publishes, by key.
  const route = useRoute();
  const router = useRouter();
  const [botActionsOpen, setBotActionsOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // The route draws the title from the screen's first frame; the chat feeds it its own data.
  const titleComposing = Boolean(botId) && composingBots.split(",").includes(botId ?? "");
  useLayoutEffect(
    () =>
      publishChatTitle(route.key, {
        bot: titleBot,
        status: currentBotStatus,
        composing: titleComposing,
        name: titleName,
        members: groupMembers,
        // The title opens the bot's profile in a one-to-one chat, the group's settings in a group.
        opens: chatTitleRoute({ groupId, botId, name: titleName, readOnly }),
      }),
    [
      route.key,
      botId,
      groupId,
      readOnly,
      titleBot,
      currentBotStatus,
      titleComposing,
      titleName,
      groupMembers,
    ],
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: displayName || t("Thread"),
      headerTitleAlign: "center",
      ...threadEdgeOptions(),
      ...threadHeaderRight({
        inGroup,
        readOnly,
        hasBot: Boolean(botId),
        t,
        color: tokens.foreground,
        rowStyle: styles.headerActions,
        onGroupSettings: () =>
          router.push({ pathname: "/group-settings", params: { groupId: groupId ?? "" } }),
        onBotActions: showBotActions,
        menuActions: botActions,
        computerLabel: t("Open computer"),
      }),
      ...(readOnly
        ? trailingHeaderOptions(t("Restore"), () => void restoreConversation(), restoring)
        : {}),
    });
  }, [
    readOnly,
    restoring,
    botId,
    titleBot,
    currentBotStatus,
    composingBots,
    displayName,
    groupId,
    inGroup,
    navigation,
    router,
    t,
    tokens,
    colorScheme,
    styles,
  ]);

  async function restoreConversation() {
    if (!botId || restoring) return;
    setRestoring(true);
    try {
      await restoreArchivedBot(botId);
      notifyArchivedChatsChanged();
      router.setParams({ readOnly: "0" });
    } catch (cause) {
      Alert.alert(t("Could not restore bot"), errorText(cause, t("Try again.")));
    } finally {
      setRestoring(false);
    }
  }

  function leaveBot() {
    router.dismissAll();
    router.replace("/");
  }

  function clearConversation() {
    if (!botId) return;
    void rpc("threads/clear", { botId })
      .then(onCleared)
      .catch((err: unknown) =>
        Alert.alert(t("Could not clear conversation"), errorText(err, t("Try again."))),
      );
  }

  function openBotComputer() {
    router.push({
      pathname: "/computer",
      params: { botId: botId ?? "", name: displayName ?? t("Bot") },
    });
  }

  const botActions = [
    ...(!readOnly && botId ? [{ text: t("Open computer"), onPress: openBotComputer }] : []),
    {
      text: t("Profile"),
      onPress: () =>
        router.push({
          pathname: "/bot-profile",
          params: { botId: botId ?? "", name: displayName ?? t("Bot") },
        }),
    },
    {
      text: t("Chat settings"),
      onPress: () =>
        router.push({
          pathname: "/bot-settings",
          params: { botId: botId ?? "" },
        }),
    },
    {
      text: t("Clear conversation"),
      destructive: true,
      onPress: () =>
        Alert.alert(
          t("Clear conversation?"),
          t(
            "This removes every message and stops current work. The bot, computer, memory, and routines are kept.",
          ),
          [
            { text: t("Cancel"), style: "cancel" },
            { text: t("Clear"), style: "destructive", onPress: clearConversation },
          ],
        ),
    },
    {
      text: t("Archive"),
      onPress: () =>
        void rpc("bots/archive", { botId: botId ?? "" })
          .then(() => {
            removeFromSearchInbox(botId);
            notifyArchivedChatsChanged();
            leaveBot();
          })
          .catch((error) =>
            Alert.alert(t("Could not archive bot"), errorText(error, t("Try again."))),
          ),
    },
    {
      text: t("Delete…"),
      destructive: true,
      onPress: () =>
        confirmDeleteBot({ id: botId ?? "", name: displayName || t("Bot") }, () => {
          notifyArchivedChatsChanged();
          leaveBot();
        }),
    },
  ];

  function showBotActions() {
    if (!botId) return;
    setBotActionsOpen(true);
  }

  return { botActions, botActionsOpen, closeBotActions: () => setBotActionsOpen(false) };
}

/** The bot's actions as a dialog, where the header has no native menu. */
export function BotActionsModal({
  actions,
  onClose,
}: {
  actions: readonly BotAction[];
  onClose: () => void;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          padding: 24,
          backgroundColor: tokens.overlay,
        }}
      >
        <Pressable
          accessibilityLabel={t("Cancel")}
          onPress={onClose}
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
        />
        <View
          accessibilityViewIsModal
          style={{ backgroundColor: tokens.popover, borderRadius: 24, paddingVertical: 12 }}
        >
          {actions.map((action) => (
            <Pressable
              key={action.text}
              accessibilityRole="button"
              onPress={() => {
                onClose();
                action.onPress();
              }}
              style={{ minHeight: 56, justifyContent: "center", paddingHorizontal: 24 }}
            >
              <Text
                style={{
                  color: action.destructive ? tokens.destructive : tokens.popoverForeground,
                  fontSize: 16,
                }}
              >
                {action.text}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}
