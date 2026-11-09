import { useNavigation, useRoute, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { notifyArchivedChatsChanged } from "../../lib/archived-chats";
import { restoreArchivedBot } from "../../lib/bot-lifecycle";
import { chatTitleRoute } from "../../lib/chat-settings-route";
import { onConversationCleared } from "../../lib/conversation-cleared";
import { useI18n } from "../../lib/i18n";
import type { MobileBot } from "../../lib/mobile-types";
import { useResolvedAppearance } from "../../lib/native";
import { useReferral } from "../../lib/referral";
import { threadEdgeOptions } from "../../lib/thread-edges";
import { useComputerRunning } from "../../lib/use-computer-running";
import { errorText } from "../../lib/user-error";
import type { ChatTitle } from "../chat-header-title";
import { publishChatTitle } from "../chat-header-title";
import { trailingHeaderOptions } from "../sheet-header";
import { openInvite, threadHeaderRight } from "../thread-header-right";

/**
 * The chat's navigation header: its title (which opens the bot's profile), the invite gift (or
 * group settings), the split-view inbox toggle, and Restore for an archived bot.
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
  onCleared,
  autoSpeak,
  onToggleAutoSpeak,
  computerFloatEnabled,
  onOpenComputerFloat,
  onOpenSearch,
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
  /** Runs once the server has cleared the conversation, from the bot's profile. */
  onCleared: () => void;
  /** Whether the current bot reads its replies aloud; absent outside a one-to-one bot chat. */
  autoSpeak?: boolean;
  /** Toggles the current bot's auto-read; absent outside a one-to-one bot chat. */
  onToggleAutoSpeak?: () => void;
  /** Whether this bot's computer float is switched on in its settings; absent means on. */
  computerFloatEnabled?: boolean;
  /** Opens the computer screen float; absent when there is no computer to watch. */
  onOpenComputerFloat?: () => void;
  /** Opens the conversation search bar. */
  onOpenSearch?: () => void;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const { t } = useI18n();
  const navigation = useNavigation();
  // This screen's own route: its header title reads what this screen publishes, by key.
  const route = useRoute();
  const router = useRouter();
  const [restoring, setRestoring] = useState(false);
  const canInvite = Boolean(useReferral());
  // The float entry shows only while this bot's computer runs; groups and archived chats
  // have no computer to watch, and a switched-off float is never polled for.
  const computerRunning = useComputerRunning(
    !inGroup && !readOnly && computerFloatEnabled !== false ? botId : undefined,
  );

  const cleared = useRef(onCleared);
  cleared.current = onCleared;
  useEffect(
    () =>
      onConversationCleared((clearedBotId) => {
        if (clearedBotId === botId) cleared.current();
      }),
    [botId],
  );

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
        t,
        color: tokens.foreground,
        accentColor: tokens.accent,
        onGroupSettings: () =>
          router.push({ pathname: "/group-settings", params: { groupId: groupId ?? "" } }),
        onInvite: canInvite && botId ? openInvite : undefined,
        autoSpeak,
        onToggleAutoSpeak,
        computerRunning,
        onOpenComputerFloat,
        onOpenSearch,
        onOpenVoiceChat:
          !inGroup && !readOnly && botId
            ? () =>
                router.push({
                  pathname: "/voice-chat",
                  params: { botId, name: displayName ?? "" },
                })
            : undefined,
        botId,
      }),
      ...(readOnly
        ? trailingHeaderOptions(t("Restore"), () => void restoreConversation(), restoring)
        : {}),
    });
  }, [
    readOnly,
    restoring,
    botId,
    canInvite,
    displayName,
    groupId,
    inGroup,
    navigation,
    router,
    t,
    tokens,
    colorScheme,
    autoSpeak,
    onToggleAutoSpeak,
    computerRunning,
    onOpenComputerFloat,
    onOpenSearch,
    botId,
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
}
