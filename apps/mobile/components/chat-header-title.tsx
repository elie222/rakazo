import type { SpaceBot } from "@rakazo/contracts";
import { displayName as safeDisplayName } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useSyncExternalStore } from "react";
import { Pressable } from "react-native";
import type { MobileBot, MobileGroup } from "../lib/api";
import type { ChatTitleRoute } from "../lib/chat-settings-route";
import { chatTitleRoute } from "../lib/chat-settings-route";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { useInboxBot, useInboxGroup } from "../lib/search-inbox";
import { CHAT_TITLE_AVATAR_SIZE, ChatTitleAvatar } from "./chat-title-avatar";
import { ChatTitleLabel } from "./chat-title-label";
import { GlassSurface } from "./glass-surface";
import { GroupSeats } from "./group-seats";
import { createThreadHeaderStyles } from "./thread-header-styles";

/** What an open chat shows in its title, once it has loaded its own data. */
export type ChatTitle = {
  bot: MobileBot | SpaceBot | undefined;
  status: string | undefined;
  composing: boolean;
  /** The chat's name, or undefined while only a placeholder is known. */
  name: string | undefined;
  /** Where tapping the title goes, or null when it opens nothing. */
  opens: ChatTitleRoute | null;
  /** A group's members, in order, for its title. */
  members?: MobileGroup["members"];
};

/** The route params a chat screen opens with. */
export type ChatTitleParams = {
  botId?: string;
  groupId?: string;
  name?: string;
  readOnly?: string;
};

// The open chat screens' titles, by screen (route key): two screens of the same chat, as during
// a push, a pop or a cancelled swipe back, each keep their own. A chat publishes its title here
// instead of replacing its header title, so the native title view is set once, when the screen
// is created.
const titles = new Map<string, ChatTitle>();
const listeners = new Set<() => void>();

/** Publishes a chat screen's title; returns the call that withdraws it when the screen goes. */
export function publishChatTitle(routeKey: string, title: ChatTitle): () => void {
  titles.set(routeKey, title);
  for (const listener of listeners) listener();
  return () => {
    if (titles.get(routeKey) !== title) return;
    titles.delete(routeKey);
    for (const listener of listeners) listener();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A chat's title capsule: its avatar (or the avatar's reserved place) and name, opening the
 * bot's profile in a one-to-one chat and the group's settings in a group. The chat route renders
 * it from the screen's first native header, from the route params and the inbox's copy of the
 * bot, until the open chat publishes its own data.
 */
export function ChatHeaderTitle({
  routeKey,
  params,
}: {
  routeKey: string;
  params: ChatTitleParams;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createThreadHeaderStyles);
  const published = useSyncExternalStore(subscribe, () => titles.get(routeKey));
  const inboxBot = useInboxBot(params.botId);
  const inboxGroup = useInboxGroup(params.groupId);
  const inGroup = Boolean(params.groupId);
  const title: ChatTitle = published ?? {
    bot: inboxBot,
    status: inboxBot?.status,
    composing: false,
    name: params.name || inboxBot?.name,
    opens: chatTitleRoute({
      groupId: params.groupId,
      botId: params.botId,
      name: params.name || inboxBot?.name,
      readOnly: params.readOnly === "1",
    }),
  };
  // A group seats its members from the inbox's copy until the chat has loaded its own.
  const members = inGroup ? (title.members ?? inboxGroup?.members) : undefined;
  const label = safeDisplayName(title.name, inGroup ? t("Group") : t("Bot")) || t("Thread");
  const opens = title.opens;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={opens ? t(inGroup ? "Group settings" : "Profile") : label}
      disabled={!opens}
      onPress={() => {
        if (opens) router.push(opens);
      }}
    >
      <GlassSurface style={styles.titleCapsule} fallbackStyle={styles.titleCapsuleFill}>
        {!inGroup && params.botId ? (
          <ChatTitleAvatar bot={title.bot} status={title.status} composing={title.composing} />
        ) : null}
        {inGroup ? <GroupSeats members={members ?? []} size={CHAT_TITLE_AVATAR_SIZE} /> : null}
        <ChatTitleLabel label={label} placeholder={!title.name} style={styles.title} />
      </GlassSurface>
    </Pressable>
  );
}
