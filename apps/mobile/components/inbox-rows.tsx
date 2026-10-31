import type { SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { isRunWorking } from "@rakazo/core";
import { botColors } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { createContext, memo, useContext, useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { MobileBot, MobileBotSection, MobileGroup } from "../lib/api";
import { AvatarRow } from "../lib/avatar-life";
import { useI18n } from "../lib/i18n";
import { formatThreadTime } from "../lib/inbox";
import type { PinnedChat } from "../lib/inbox-spaces";
import type { InboxChatKind, InboxRowAction } from "../lib/inbox-swipe";
import { INBOX_ROW_ACTIONS, inboxRowActionList } from "../lib/inbox-swipe";
import { native, useThemedStyles } from "../lib/native";
import { previewSnippet } from "../lib/preview";
import { androidRipple } from "../lib/ripple";
import { BotAvatar } from "./bot-avatar";
import type { BotOrganizationUpdate } from "./bot-organize-modal";
import { GroupAvatar } from "./group-avatar";
import { createHomeStyles, INBOX_ROW } from "./home-styles";
import { InboxSwipeRow } from "./inbox-swipe-row";
import { NativeSymbol } from "./native-symbol";

export const FALLBACK_COLOR = botColors[3];
export const CompactRowsContext = createContext(false);
// The chat open beside the list, so its row can show as selected.
export const SelectedChatContext = createContext<string | null>(null);

export function ConversationRow({
  chatId,
  title,
  preview,
  time,
  avatar,
  unread,
  onPress,
  onLongPress,
  actions = [],
  onAction,
  accessibilityLabel,
  accessibilityHint,
}: {
  chatId?: string;
  title: string;
  preview: string;
  time: string;
  avatar: ReactNode;
  unread?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  actions?: InboxRowAction[];
  onAction?: (action: InboxRowAction) => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const compact = useContext(CompactRowsContext);
  const openChatId = useContext(SelectedChatContext);
  const selected = chatId !== undefined && openChatId === chatId;
  const rowActions = actions.map((action) => ({
    name: action,
    label: t(INBOX_ROW_ACTIONS[action].label),
  }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      // Screen readers access swipe actions through the row.
      accessibilityActions={rowActions.length > 0 ? rowActions : undefined}
      onAccessibilityAction={(event) => {
        const name = event.nativeEvent.actionName;
        const action = actions.find((item) => item === name);
        if (action) onAction?.(action);
      }}
      android_ripple={androidRipple()}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        compact ? styles.compactRow : null,
        selected ? styles.rowSelected : null,
        selected && Platform.OS === "android" && { overflow: "hidden" },
        pressed && Platform.OS !== "android" && styles.rowPressed,
      ]}
    >
      {avatar}
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <View style={styles.titleRow}>
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
              {title}
            </Text>
          </View>
          <View style={styles.rowMeta}>
            {time ? <Text style={styles.time}>{time}</Text> : null}
            {unread ? <View accessibilityElementsHidden style={styles.unreadDot} /> : null}
          </View>
        </View>
        <Text style={[styles.preview, unread && styles.unreadPreview]} numberOfLines={1}>
          {preview}
        </Text>
      </View>
    </Pressable>
  );
}

/** The way back to archived chats, at the very end of the list in the section heading style. */
export function ArchivedChatsRow({ count, onPress }: { count: number; onPress: () => void }) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  if (count < 1) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("Archived")}, ${count}`}
      onPress={onPress}
      style={({ pressed }) => [
        // Laid out like a section header, so it lines up with them whatever sits above it.
        styles.sectionToggle,
        styles.archivedRow,
        pressed && styles.rowPressed,
      ]}
    >
      <Text style={styles.sectionTitle}>{t("Archived")}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
      <NativeSymbol
        ios="chevron.right"
        android="chevron-forward"
        size={12}
        color={native.tertiaryLabel}
      />
    </Pressable>
  );
}

/** Points right while a section is collapsed and turns down as it opens. */
export function SectionChevron({ collapsed }: { collapsed: boolean }) {
  const rotation = useSharedValue(collapsed ? 0 : 90);
  useEffect(() => {
    rotation.value = withTiming(collapsed ? 0 : 90, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [collapsed, rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <NativeSymbol
        ios="chevron.right"
        android="chevron-forward"
        size={12}
        color={native.tertiaryLabel}
      />
    </Animated.View>
  );
}

/** Android pinned chats open with a tap and organize with a long press. */
export const PinnedTiles = memo(function PinnedTiles({
  chats,
  onOpenBot,
  onOpenGroup,
  onLongPressBot,
  onLongPressGroup,
  onBotAction,
  onGroupAction,
}: {
  chats: PinnedChat[];
  onOpenBot: (bot: MobileBot | SpaceBot) => void;
  onOpenGroup: (group: MobileGroup | SpaceGroup) => void;
  onLongPressBot: (bot: MobileBot | SpaceBot) => void;
  onLongPressGroup: (group: MobileGroup | SpaceGroup) => void;
  onBotAction: (action: InboxRowAction, bot: MobileBot | SpaceBot) => void;
  onGroupAction: (action: InboxRowAction, group: MobileGroup | SpaceGroup) => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createHomeStyles);
  const selectedId = useContext(SelectedChatContext);
  // Three tiles share the row, so a narrow pane shrinks the avatars instead of overlapping them.
  const [rowWidth, setRowWidth] = useState(0);
  const avatarSize = rowWidth > 0 ? Math.min(84, Math.floor((rowWidth - 16) / 3 - 8)) : 84;
  return (
    <View
      style={styles.pinnedTiles}
      onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
    >
      {chats.map((chat) => {
        const id = chat.kind === "bot" ? chat.bot.id : chat.group.id;
        const name = chat.kind === "bot" ? chat.bot.name : chat.group.name;
        const unread = chat.kind === "bot" ? chat.bot.unread : chat.group.unread;
        const actions = inboxRowActionList(chat.kind === "bot" ? chat.bot : chat.group);
        const runAction = (action: InboxRowAction) =>
          chat.kind === "bot" ? onBotAction(action, chat.bot) : onGroupAction(action, chat.group);
        const organize = () =>
          chat.kind === "bot" ? onLongPressBot(chat.bot) : onLongPressGroup(chat.group);
        return (
          <Pressable
            key={`${chat.kind}-${id}`}
            accessibilityRole="button"
            accessibilityLabel={name}
            accessibilityState={{ selected: selectedId === id }}
            accessibilityActions={actions.map((action) => ({
              name: action,
              label: t(INBOX_ROW_ACTIONS[action].label),
            }))}
            onAccessibilityAction={(event) => {
              const action = actions.find((item) => item === event.nativeEvent.actionName);
              if (action) runAction(action);
            }}
            onPress={() => (chat.kind === "bot" ? onOpenBot(chat.bot) : onOpenGroup(chat.group))}
            onLongPress={organize}
            style={({ pressed }) => [
              styles.pinnedTile,
              selectedId === id ? { backgroundColor: native.fillPressed } : null,
              pressed && styles.rowPressed,
            ]}
          >
            {chat.kind === "bot" ? (
              <BotAvatar
                color={chat.bot.color || FALLBACK_COLOR}
                avatarSet={chat.bot.avatarSet}
                identity={chat.bot.id}
                size={avatarSize}
                status={chat.bot.status}
                muted={chat.bot.notifyOnFinish === false}
                motion="lazy"
              />
            ) : (
              <GroupAvatar members={chat.group.members} size={avatarSize} />
            )}
            <Text style={[styles.pinnedName, unread && styles.pinnedUnread]} numberOfLines={1}>
              {name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
});
/** What the iOS row menu needs to organize a chat in place. */
type RowMenuProps = {
  sections: readonly MobileBotSection[];
  onOrganize: (
    kind: InboxChatKind,
    chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
    update: BotOrganizationUpdate,
  ) => void;
  onEditSection: (
    kind: InboxChatKind,
    chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
    mode: "create" | "rename",
  ) => void;
};

export const BotRow = memo(function BotRow({
  bot,
  day,
  onPress,
  onLongPress,
  onAction,
  sections,
  onOrganize,
  onEditSection,
}: {
  bot: MobileBot | SpaceBot;
  day: number;
  onPress: (bot: MobileBot | SpaceBot) => void;
  onLongPress?: (bot: MobileBot | SpaceBot) => void;
  onAction?: (action: InboxRowAction, bot: MobileBot | SpaceBot) => void;
} & RowMenuProps) {
  const { t } = useI18n();
  const preview = previewSnippet(bot.preview, 40) || t("No messages yet");
  const time = bot.updatedAt ? formatThreadTime(bot.updatedAt, new Date(day)) : "";
  const working = isRunWorking(bot.status);
  // Spelled out because an explicit label replaces the one built from the row's children.
  const label = [
    bot.name,
    working ? t("Working…") : null,
    bot.notifyOnFinish === false ? t("notifications silenced") : null,
    bot.unread ? t("unread") : null,
    time,
    preview,
  ]
    .filter(Boolean)
    .join(", ");
  const runAction = (action: InboxRowAction) => onAction?.(action, bot);
  const row = (
    <ConversationRow
      chatId={bot.id}
      title={bot.name}
      preview={preview}
      time={time}
      unread={bot.unread}
      accessibilityLabel={label}
      accessibilityHint={
        onLongPress || onAction ? t("Long press to pin, move, or silence notifications") : undefined
      }
      onPress={() => onPress(bot)}
      onLongPress={onLongPress ? () => onLongPress(bot) : undefined}
      actions={onAction ? inboxRowActionList(bot) : undefined}
      onAction={runAction}
      avatar={
        <AvatarRow id={bot.id}>
          <BotAvatar
            color={bot.color || FALLBACK_COLOR}
            avatarSet={bot.avatarSet}
            identity={bot.id}
            size={INBOX_ROW.avatarSize}
            status={bot.status}
            muted={bot.notifyOnFinish === false}
            motion="lazy"
          />
        </AvatarRow>
      }
    />
  );
  return onAction ? (
    <InboxSwipeRow
      rowKey={`bot:${bot.id}`}
      unread={bot.unread}
      pinned={bot.pinned}
      notifyOnFinish={bot.notifyOnFinish}
      sectionId={bot.sectionId}
      sections={sections}
      preview={{
        title: bot.name,
        message: bot.preview,
        avatar: (
          <BotAvatar
            color={bot.color || FALLBACK_COLOR}
            avatarSet={bot.avatarSet}
            identity={bot.id}
            size={32}
          />
        ),
      }}
      onAction={runAction}
      onOrganize={(update) => onOrganize("bot", bot, update)}
      onEditSection={(mode) => onEditSection("bot", bot, mode)}
    >
      {row}
    </InboxSwipeRow>
  ) : (
    row
  );
});

export const GroupRow = memo(function GroupRow({
  group,
  day,
  onPress,
  onLongPress,
  onAction,
  sections,
  onOrganize,
  onEditSection,
}: {
  group: MobileGroup | SpaceGroup;
  day: number;
  onPress: (group: MobileGroup | SpaceGroup) => void;
  onLongPress?: (group: MobileGroup | SpaceGroup) => void;
  onAction?: (action: InboxRowAction, group: MobileGroup | SpaceGroup) => void;
} & RowMenuProps) {
  const { t } = useI18n();
  const preview =
    previewSnippet(group.preview, 40) || group.members.map((member) => member.name).join(", ");
  const time = group.updatedAt ? formatThreadTime(group.updatedAt, new Date(day)) : "";
  const runAction = (action: InboxRowAction) => onAction?.(action, group);
  const row = (
    <ConversationRow
      chatId={group.id}
      title={group.name}
      preview={preview}
      time={time}
      unread={group.unread}
      accessibilityLabel={[group.name, group.unread ? t("unread") : null, time, preview]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={
        onLongPress || onAction ? t("Long press to pin or move to a section") : undefined
      }
      onPress={() => onPress(group)}
      onLongPress={onLongPress ? () => onLongPress(group) : undefined}
      actions={onAction ? inboxRowActionList(group) : undefined}
      onAction={runAction}
      avatar={<GroupAvatar members={group.members} size={INBOX_ROW.avatarSize} />}
    />
  );
  return onAction ? (
    <InboxSwipeRow
      rowKey={`group:${group.id}`}
      unread={group.unread}
      pinned={group.pinned}
      sectionId={group.sectionId}
      sections={sections}
      preview={{
        title: group.name,
        message: group.preview,
        avatar: <GroupAvatar members={group.members} size={32} />,
      }}
      onAction={runAction}
      onOrganize={(update) => onOrganize("group", group, update)}
      onEditSection={(mode) => onEditSection("group", group, mode)}
    >
      {row}
    </InboxSwipeRow>
  ) : (
    row
  );
});
