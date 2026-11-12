import { useLingui } from "@lingui/react/macro";
import { useNavigation, useRoute, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { notifyArchivedChatsChanged } from "../../lib/archived-chats";
import { restoreArchivedBot } from "../../lib/bot-lifecycle";
import { chatTitleRoute } from "../../lib/chat-settings-route";
import { onConversationCleared } from "../../lib/conversation-cleared";
import type { MobileBot } from "../../lib/mobile-types";
import { useResolvedAppearance } from "../../lib/native";
import { useReferral } from "../../lib/referral";
import { threadEdgeOptions } from "../../lib/thread-edges";
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
  working,
  composingBots,
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
  /** Whether the chat's thread has a run at work; the title's working dot follows it. */
  working?: boolean;
  /** Bots writing reply text right now, comma-separated. */
  composingBots: string;
  /** Runs once the server has cleared the conversation, from the bot's profile. */
  onCleared: () => void;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const { t } = useLingui();
  const navigation = useNavigation();
  // This screen's own route: its header title reads what this screen publishes, by key.
  const route = useRoute();
  const router = useRouter();
  const [restoring, setRestoring] = useState(false);
  const canInvite = Boolean(useReferral());

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
        working,
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
      working,
      titleComposing,
      titleName,
      groupMembers,
    ],
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: displayName || t`Thread`,
      headerTitleAlign: "center",
      ...threadEdgeOptions(),
      ...threadHeaderRight({
        inGroup,
        readOnly,
        color: tokens.foreground,
        onGroupSettings: () =>
          router.push({ pathname: "/group-settings", params: { groupId: groupId ?? "" } }),
        onInvite: canInvite && botId ? openInvite : undefined,
      }),
      ...(readOnly
        ? trailingHeaderOptions(t`Restore`, () => void restoreConversation(), restoring)
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
  ]);

  async function restoreConversation() {
    if (!botId || restoring) return;
    setRestoring(true);
    try {
      await restoreArchivedBot(botId);
      notifyArchivedChatsChanged();
      router.setParams({ readOnly: "0" });
    } catch (cause) {
      Alert.alert(t`Could not restore bot`, errorText(cause, t`Try again.`));
    } finally {
      setRestoring(false);
    }
  }
}
