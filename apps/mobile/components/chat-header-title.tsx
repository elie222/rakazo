import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { SpaceBot } from "@rakazo/contracts";
import { displayName as safeDisplayName } from "@rakazo/core";
import { useNavigation, useRouter } from "expo-router";
import { useSyncExternalStore } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { ChatTitleRoute } from "../lib/chat-settings-route";
import { chatTitleRoute } from "../lib/chat-settings-route";
import { groupTitleSeats, groupTitleStatus, groupTitleWidth } from "../lib/group-seats";
import type { MobileBot, MobileGroup } from "../lib/mobile-types";
import { useThemedStyles } from "../lib/native";
import { useInboxBot, useInboxGroup } from "../lib/search-inbox";
import { useSplitView } from "../lib/split-view";
import { ChatTitleAvatar } from "./chat-title-avatar";
import { ChatTitleLabel } from "./chat-title-label";
import { GlassSurface } from "./glass-surface";
import { GroupSeats } from "./group-seats";
import { createThreadHeaderStyles } from "./thread-header-styles";

/** Stands in for the bot's name in a translated status line, which is split around it. */
const NAME_SLOT = "\u0001";

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
  const { t } = useLingui();
  const router = useRouter();
  const navigation = useNavigation();
  const { split, contentWidth } = useSplitView();
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
  const members = inGroup ? (title.members ?? inboxGroup?.members ?? []) : [];
  const label = safeDisplayName(title.name, inGroup ? t`Group` : t`Bot`) || t`Thread`;
  const opens = title.opens;
  const readOnly = params.readOnly === "1";
  // The pill fills the header between its circles on Android; iOS centres it in its own bar.
  const width = groupTitleWidth(contentWidth, {
    leading: split || navigation.canGoBack(),
    // A group's gear, or a bot chat's invite gift; an archived chat has neither.
    trailing: !readOnly,
  });
  if (inGroup) {
    const { seats, more } = groupTitleSeats(members);
    const status = groupTitleStatus(members);
    // The whole sentence is translated, then split where the name goes, so only the name
    // gives way to a narrow pill and "needs you" or "is working" always shows.
    const statusParts = status
      ? (status.kind === "needsYou"
          ? t`${ph({ name: NAME_SLOT })} needs you`
          : t`${ph({ name: NAME_SLOT })} is working`
        ).split(NAME_SLOT)
      : null;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={opens ? t`Group settings` : label}
        disabled={!opens}
        onPress={() => {
          if (opens) router.push(opens);
        }}
      >
        <GlassSurface
          style={[
            styles.titleCapsule,
            styles.groupCapsule,
            Platform.OS === "android" ? { width } : { maxWidth: width },
          ]}
        >
          <View style={styles.stack}>
            <GroupSeats seats={seats} />
            {more ? (
              <Text allowFontScaling={false} style={styles.more}>
                +{more}
              </Text>
            ) : null}
          </View>
          <View style={styles.titleColumn}>
            <ChatTitleLabel
              label={label}
              placeholder={!title.name}
              style={statusParts ? styles.groupTitle : styles.title}
            />
            {status && statusParts ? (
              <View accessible style={styles.statusRow}>
                {statusParts[0] ? <Text style={styles.status}>{statusParts[0]}</Text> : null}
                <Text numberOfLines={1} style={[styles.status, styles.statusName]}>
                  {status.name}
                </Text>
                {statusParts[1] ? (
                  <Text numberOfLines={1} style={styles.status}>
                    {statusParts[1]}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        </GlassSurface>
      </Pressable>
    );
  }
  return (
    // In a row, the title takes its content's width: the pill hugs the bot's name, and the
    // space beside it is not a hidden tap target.
    <View style={styles.hug}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={opens ? t`Profile` : label}
        disabled={!opens}
        onPress={() => {
          if (opens) router.push(opens);
        }}
        style={styles.hugged}
      >
        <GlassSurface style={[styles.titleCapsule, { maxWidth: width }]}>
          {params.botId ? (
            <ChatTitleAvatar bot={title.bot} status={title.status} composing={title.composing} />
          ) : null}
          <ChatTitleLabel label={label} placeholder={!title.name} style={styles.title} />
        </GlassSurface>
      </Pressable>
    </View>
  );
}
