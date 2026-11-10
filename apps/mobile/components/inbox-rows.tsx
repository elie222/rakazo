import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { chatSnoozed, chatWoke, isRunWorking } from "@rakazo/core";
import { botColors } from "@rakazo/ui-tokens";
import type { ReactElement, ReactNode } from "react";
import { createContext, memo, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { PressableProps } from "react-native";
import { Platform, Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { AvatarRow } from "../lib/avatar-life";
import { formatSnoozeWake, formatThreadTime } from "../lib/inbox";
import type { PinnedChat } from "../lib/inbox-spaces";
import { botNeedsAttention } from "../lib/inbox-spaces";
import type { InboxChatKind, InboxRowAction } from "../lib/inbox-swipe";
import { INBOX_ROW_ACTIONS, inboxRowActionList } from "../lib/inbox-swipe";
import { mobileLogoAvatarActivity } from "../lib/logo-avatar-activity";
import type { MobileBot, MobileBotSection, MobileGroup } from "../lib/mobile-types";
import { native, useThemedStyles } from "../lib/native";
import { previewSnippet } from "../lib/preview";
import { androidRipple } from "../lib/ripple";
import { BotAvatar, MutedBadge } from "./bot-avatar";
import type { BotOrganizationUpdate } from "./bot-organize-modal";
import { DragSafePressable } from "./drag-safe-pressable";
import { GroupAvatar } from "./group-avatar";
import { createHomeStyles, INBOX_ROW } from "./home-styles";
import { InboxSwipeRow } from "./inbox-swipe-row";
import { NativeSymbol } from "./native-symbol";

export const FALLBACK_COLOR = botColors[3];

/** A bot waiting on you, which marks its row like an unread chat. */
function useWaitingOnYou(bot: MobileBot | SpaceBot | undefined): boolean {
  return useSyncExternalStore(mobileLogoAvatarActivity.subscribe, () =>
    bot ? botNeedsAttention(bot) : false,
  );
}
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
  const { i18n } = useLingui();
  const compact = useContext(CompactRowsContext);
  const openChatId = useContext(SelectedChatContext);
  const selected = chatId !== undefined && openChatId === chatId;
  const rowActions = actions.map((action) => ({
    name: action,
    label: i18n._(INBOX_ROW_ACTIONS[action].label),
  }));
  return (
    <DragSafePressable
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
    </DragSafePressable>
  );
}

/** The way back to archived chats, at the very end of the list in the section heading style. */
export function ArchivedChatsRow({ count, onPress }: { count: number; onPress: () => void }) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useLingui();
  if (count < 1) return null;
  return (
    <DragSafePressable
      accessibilityRole="button"
      accessibilityLabel={`${t`Archived`}, ${count}`}
      onPress={onPress}
      style={({ pressed }) => [
        // Laid out like a section header, so it lines up with them whatever sits above it.
        styles.sectionToggle,
        styles.archivedRow,
        pressed && styles.rowPressed,
      ]}
    >
      <Text style={styles.sectionTitle}>{t`Archived`}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
      <NativeSymbol
        ios="chevron.right"
        android="chevron-forward"
        size={12}
        color={native.tertiaryLabel}
      />
    </DragSafePressable>
  );
}

/** Points right while a section is collapsed and turns down as it opens. */
/** A folding section header's title, count, and chevron; `count` shows when given. */
export function SectionToggle({
  title,
  count,
  collapsed,
  onPress,
  onLongPress,
  accessibilityActions,
  onAccessibilityAction,
}: {
  title: string;
  count?: number;
  collapsed: boolean;
  onPress: () => void;
} & Pick<PressableProps, "onLongPress" | "accessibilityActions" | "onAccessibilityAction">) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useLingui();
  return (
    <DragSafePressable
      accessibilityRole="button"
      accessibilityLabel={
        collapsed ? t`Expand ${ph({ name: title })}` : t`Collapse ${ph({ name: title })}`
      }
      accessibilityState={{ expanded: !collapsed }}
      accessibilityValue={count === undefined ? undefined : { text: String(count) }}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      style={({ pressed }) => [styles.sectionToggle, pressed && styles.rowPressed]}
    >
      <Text style={styles.sectionTitle}>{title}</Text>
      {count === undefined ? null : <Text style={styles.sectionCount}>{count}</Text>}
      <SectionChevron collapsed={collapsed} />
    </DragSafePressable>
  );
}

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
  const { i18n, t } = useLingui();
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
        const muted = chat.kind === "bot" ? chat.bot.notifyOnFinish === false : chat.group.muted;
        const actions = inboxRowActionList(chat.kind === "bot" ? chat.bot : chat.group);
        const runAction = (action: InboxRowAction) =>
          chat.kind === "bot" ? onBotAction(action, chat.bot) : onGroupAction(action, chat.group);
        const organize = () =>
          chat.kind === "bot" ? onLongPressBot(chat.bot) : onLongPressGroup(chat.group);
        return (
          <Pressable
            key={`${chat.kind}-${id}`}
            accessibilityRole="button"
            accessibilityLabel={muted ? `${name}, ${t`notifications silenced`}` : name}
            accessibilityState={{ selected: selectedId === id }}
            accessibilityActions={actions.map((action) => ({
              name: action,
              label: i18n._(INBOX_ROW_ACTIONS[action].label),
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
                muted={muted}
                motion="lazy"
              />
            ) : (
              <MutableGroupAvatar group={chat.group} size={avatarSize} />
            )}
            <PinnedName chat={chat} name={name} />
          </Pressable>
        );
      })}
    </View>
  );
});
function PinnedName({ chat, name }: { chat: PinnedChat; name: string }) {
  const styles = useThemedStyles(createHomeStyles);
  const waiting = useWaitingOnYou(chat.kind === "bot" ? chat.bot : undefined);
  const marked = (chat.kind === "bot" ? chat.bot.unread : chat.group.unread) || waiting;
  return (
    <Text style={[styles.pinnedName, marked && styles.pinnedUnread]} numberOfLines={1}>
      {name}
    </Text>
  );
}

// The iOS row menu opens on a long press; a press handler without onLongPress would still open the
// chat when the finger lifts.
const holdForMenu = () => undefined;

/** What the iOS row menu needs to organize a chat in place. */
export type RowMenuProps = {
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
    sections: readonly MobileBotSection[],
  ) => void;
  /** Without it the menu offers no snooze. */
  onSnooze?: (
    kind: InboxChatKind,
    chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
    until: string | null,
  ) => void;
};

/** The row's time slot: when a snoozed chat wakes, that it woke, or its last activity. */
function chatTime(
  chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
  day: number,
  now: number,
  woke: string,
) {
  if (chat.snoozedUntil && chatSnoozed(chat, now)) return formatSnoozeWake(chat.snoozedUntil);
  if (chatWoke(chat, now)) return woke;
  return chat.updatedAt ? formatThreadTime(chat.updatedAt, new Date(day)) : "";
}

/**
 * Whether the viewer muted the chat, as the server says. A server from before chat mutes sends a
 * bot's own notification setting instead, which is that viewer's mute there, and cannot mute a
 * group: unknown.
 */
export function chatMuted(
  chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
): boolean | undefined {
  if (typeof chat.muted === "boolean") return chat.muted;
  return "notifyOnFinish" in chat && typeof chat.notifyOnFinish === "boolean"
    ? !chat.notifyOnFinish
    : undefined;
}

/** A group's avatar, with the bell while the viewer has it muted. */
function MutableGroupAvatar({ group, size }: { group: MobileGroup | SpaceGroup; size: number }) {
  return (
    <View>
      <GroupAvatar members={group.members} size={size} />
      {group.muted ? <MutedBadge size={size} /> : null}
    </View>
  );
}

/** A chat row with the iOS swipe actions and context menu; other platforms get the row as is. */
export function ChatSwipe({
  target,
  rowKey = `${target.kind}:${target.chat.id}`,
  onAction,
  sections,
  onOrganize,
  onEditSection,
  snoozed,
  onSnooze,
  children,
}: {
  /** Snoozed until a time still ahead. */
  snoozed?: boolean;
  onSnooze?: (until: string | null) => void;
  target:
    | { kind: "bot"; chat: MobileBot | SpaceBot }
    | { kind: "group"; chat: MobileGroup | SpaceGroup };
  /** Height cache key, for rows of a different layout than the inbox's. */
  rowKey?: string;
  onAction: (action: InboxRowAction) => void;
  children: ReactElement;
} & RowMenuProps) {
  const { kind, chat } = target;
  return (
    <InboxSwipeRow
      rowKey={rowKey}
      unread={chat.unread}
      pinned={chat.pinned}
      muted={chatMuted(chat)}
      hidden={chat.hidden}
      sectionId={chat.sectionId}
      sections={sections}
      preview={{
        title: chat.name,
        message: chat.preview,
        avatar:
          target.kind === "bot" ? (
            <BotAvatar
              color={target.chat.color || FALLBACK_COLOR}
              avatarSet={target.chat.avatarSet}
              identity={target.chat.id}
              size={32}
            />
          ) : (
            <GroupAvatar members={target.chat.members} size={32} />
          ),
      }}
      onAction={onAction}
      onOrganize={(update) => onOrganize(kind, chat, update)}
      onEditSection={(mode) => onEditSection(kind, chat, mode, sections)}
      snoozed={snoozed}
      onSnooze={onSnooze}
    >
      {children}
    </InboxSwipeRow>
  );
}

export const BotRow = memo(function BotRow({
  bot,
  day,
  now,
  onPress,
  onLongPress,
  onAction,
  sections,
  onOrganize,
  onEditSection,
  onSnooze,
}: {
  bot: MobileBot | SpaceBot;
  day: number;
  /** The snooze clock, so a row redraws when its chat wakes. */
  now: number;
  onPress: (bot: MobileBot | SpaceBot) => void;
  onLongPress?: (bot: MobileBot | SpaceBot) => void;
  onAction?: (action: InboxRowAction, bot: MobileBot | SpaceBot) => void;
} & RowMenuProps) {
  const { t } = useLingui();
  const preview = previewSnippet(bot.preview, 40) || t`No messages yet`;
  const time = chatTime(bot, day, now, t`Woke`);
  const working = isRunWorking(bot.status);
  const waiting = useWaitingOnYou(bot);
  // Spelled out because an explicit label replaces the one built from the row's children.
  const label = [
    bot.name,
    working ? t`Working…` : null,
    waiting ? t`Needs attention` : null,
    bot.notifyOnFinish === false ? t`notifications silenced` : null,
    bot.unread ? t`unread` : null,
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
      unread={bot.unread || waiting}
      accessibilityLabel={label}
      accessibilityHint={
        onLongPress || onAction ? t`Long press to pin, move, or silence notifications` : undefined
      }
      onPress={() => onPress(bot)}
      onLongPress={onLongPress ? () => onLongPress(bot) : onAction ? holdForMenu : undefined}
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
    <ChatSwipe
      target={{ kind: "bot", chat: bot }}
      onAction={runAction}
      sections={sections}
      onOrganize={onOrganize}
      onEditSection={onEditSection}
      snoozed={chatSnoozed(bot, now)}
      onSnooze={onSnooze && ((until) => onSnooze("bot", bot, until))}
    >
      {row}
    </ChatSwipe>
  ) : (
    row
  );
});

export const GroupRow = memo(function GroupRow({
  group,
  day,
  now,
  onPress,
  onLongPress,
  onAction,
  sections,
  onOrganize,
  onEditSection,
  onSnooze,
}: {
  group: MobileGroup | SpaceGroup;
  day: number;
  /** The snooze clock, so a row redraws when its chat wakes. */
  now: number;
  onPress: (group: MobileGroup | SpaceGroup) => void;
  onLongPress?: (group: MobileGroup | SpaceGroup) => void;
  onAction?: (action: InboxRowAction, group: MobileGroup | SpaceGroup) => void;
} & RowMenuProps) {
  const { t } = useLingui();
  const preview =
    previewSnippet(group.preview, 40) || group.members.map((member) => member.name).join(", ");
  const time = chatTime(group, day, now, t`Woke`);
  const runAction = (action: InboxRowAction) => onAction?.(action, group);
  const row = (
    <ConversationRow
      chatId={group.id}
      title={group.name}
      preview={preview}
      time={time}
      unread={group.unread}
      accessibilityLabel={[
        group.name,
        group.muted ? t`notifications silenced` : null,
        group.unread ? t`unread` : null,
        time,
        preview,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={
        onLongPress || onAction ? t`Long press to pin or move to a section` : undefined
      }
      onPress={() => onPress(group)}
      onLongPress={onLongPress ? () => onLongPress(group) : onAction ? holdForMenu : undefined}
      actions={onAction ? inboxRowActionList(group) : undefined}
      onAction={runAction}
      avatar={<MutableGroupAvatar group={group} size={INBOX_ROW.avatarSize} />}
    />
  );
  return onAction ? (
    <ChatSwipe
      target={{ kind: "group", chat: group }}
      onAction={runAction}
      sections={sections}
      onOrganize={onOrganize}
      onEditSection={onEditSection}
      snoozed={chatSnoozed(group, now)}
      onSnooze={onSnooze && ((until) => onSnooze("group", group, until))}
    >
      {row}
    </ChatSwipe>
  ) : (
    row
  );
});
