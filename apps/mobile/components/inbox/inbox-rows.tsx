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
import type { MobileBot, MobileBotSection, MobileGroup } from "../../lib/api/mobile-types";
import { androidRipple } from "../../lib/appearance/ripple";
import { AvatarRow } from "../../lib/bots/avatar-life";
import { mobileLogoAvatarActivity } from "../../lib/bots/logo-avatar-activity";
import { useDateLocale } from "../../lib/i18n/i18n";
import { formatSnoozeWake, formatThreadTime } from "../../lib/inbox/inbox";
import type { PinnedChat } from "../../lib/inbox/inbox-spaces";
import { botNeedsAttention } from "../../lib/inbox/inbox-spaces";
import type { InboxChatKind, InboxRowAction } from "../../lib/inbox/inbox-swipe";
import { INBOX_ROW_ACTIONS, inboxRowActionList } from "../../lib/inbox/inbox-swipe";
import { previewSnippet } from "../../lib/messages/preview";
import { native, useThemedStyles } from "../../lib/native/native";
import { BotAvatar } from "../bots/bot-avatar";
import { GroupAvatar } from "../bots/group-avatar";
import { NativeSymbol } from "../native/native-symbol";
import { DragSafePressable } from "../ui/drag-safe-pressable";
import type { BotOrganizationUpdate } from "./bot-organize-modal";
import { ChatTileMenu } from "./chat-tile-menu";
import { createInboxStyles, INBOX_ROW } from "./inbox-styles";
import { InboxSwipeRow } from "./inbox-swipe-row";

export const FALLBACK_COLOR = botColors[3];

/** A bot waiting on you. Its question already marked the chat unread, so reading it clears the dot. */
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
  const styles = useThemedStyles(createInboxStyles);
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
  const styles = useThemedStyles(createInboxStyles);
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
  const styles = useThemedStyles(createInboxStyles);
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

/**
 * Pinned chats as avatar tiles above the list. A tap opens one; a long press organizes it, with
 * the row's context menu on iOS and the organize sheet elsewhere.
 */
export const PinnedTiles = memo(function PinnedTiles({
  chats,
  onOpenBot,
  onOpenGroup,
  onLongPressBot,
  onLongPressGroup,
  onBotAction,
  onGroupAction,
  sectionsOf,
  onOrganize,
  onEditSection,
  onSnooze,
}: {
  chats: PinnedChat[];
  onOpenBot: (bot: MobileBot | SpaceBot) => void;
  onOpenGroup: (group: MobileGroup | SpaceGroup) => void;
  /** Without them a long press opens the tile's context menu. */
  onLongPressBot?: (bot: MobileBot | SpaceBot) => void;
  onLongPressGroup?: (group: MobileGroup | SpaceGroup) => void;
  onBotAction: (action: InboxRowAction, bot: MobileBot | SpaceBot) => void;
  onGroupAction: (action: InboxRowAction, group: MobileGroup | SpaceGroup) => void;
  /** The sections of the chat's space, which its menu can move it between. */
  sectionsOf: (spaceId: string | undefined) => readonly MobileBotSection[];
} & Omit<RowMenuProps, "sections">) {
  const { i18n } = useLingui();
  const styles = useThemedStyles(createInboxStyles);
  const selectedId = useContext(SelectedChatContext);
  // Three tiles share the row, so a narrow pane shrinks the avatars instead of overlapping them.
  const [rowWidth, setRowWidth] = useState(0);
  const tileWidth = rowWidth > 0 ? Math.floor((rowWidth - 16) / 3) : undefined;
  const avatarSize = tileWidth ? Math.min(84, tileWidth - 8) : 84;
  return (
    <View
      style={styles.pinnedTiles}
      onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}
    >
      {chats.map((chat) => {
        const target =
          chat.kind === "bot"
            ? { kind: chat.kind, chat: chat.bot }
            : { kind: chat.kind, chat: chat.group };
        const { id, name } = target.chat;
        const actions = inboxRowActionList(target.chat);
        const runAction = (action: InboxRowAction) =>
          chat.kind === "bot" ? onBotAction(action, chat.bot) : onGroupAction(action, chat.group);
        const organize =
          chat.kind === "bot"
            ? onLongPressBot && (() => onLongPressBot(chat.bot))
            : onLongPressGroup && (() => onLongPressGroup(chat.group));
        const sections = sectionsOf(target.chat.spaceId);
        return (
          <ChatTileMenu
            key={`${chat.kind}-${id}`}
            width={tileWidth}
            unread={target.chat.unread}
            pinned
            notifyOnFinish={chat.kind === "bot" ? chat.bot.notifyOnFinish : undefined}
            sectionId={target.chat.sectionId}
            sections={sections}
            preview={{
              title: name,
              message: target.chat.preview,
              avatar:
                chat.kind === "bot" ? (
                  <BotAvatar
                    color={chat.bot.color || FALLBACK_COLOR}
                    avatarSet={chat.bot.avatarSet}
                    identity={chat.bot.id}
                    size={32}
                  />
                ) : (
                  <GroupAvatar members={chat.group.members} size={32} />
                ),
            }}
            onAction={runAction}
            onOrganize={(update) => onOrganize(target.kind, target.chat, update)}
            onEditSection={(mode) => onEditSection(target.kind, target.chat, mode, sections)}
            onSnooze={onSnooze && ((until) => onSnooze(target.kind, target.chat, until))}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={name}
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
              onLongPress={organize ?? holdForMenu}
              style={({ pressed }) => [
                styles.pinnedTile,
                { width: tileWidth ?? "33.33%" },
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
              <PinnedName chat={chat} name={name} />
            </Pressable>
          </ChatTileMenu>
        );
      })}
    </View>
  );
});
function PinnedName({ chat, name }: { chat: PinnedChat; name: string }) {
  const styles = useThemedStyles(createInboxStyles);
  const marked = chat.kind === "bot" ? chat.bot.unread : chat.group.unread;
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
function useChatTime(
  chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup,
  day: number,
  now: number,
  woke: string,
) {
  const locale = useDateLocale();
  if (chat.snoozedUntil && chatSnoozed(chat, now))
    return formatSnoozeWake(chat.snoozedUntil, new Date(), locale);
  if (chatWoke(chat, now)) return woke;
  return chat.updatedAt ? formatThreadTime(chat.updatedAt, new Date(day), locale) : "";
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
      notifyOnFinish={target.kind === "bot" ? target.chat.notifyOnFinish : undefined}
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
  const time = useChatTime(bot, day, now, t`Woke`);
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
      unread={bot.unread}
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
  const time = useChatTime(group, day, now, t`Woke`);
  const runAction = (action: InboxRowAction) => onAction?.(action, group);
  const row = (
    <ConversationRow
      chatId={group.id}
      title={group.name}
      preview={preview}
      time={time}
      unread={group.unread}
      accessibilityLabel={[group.name, group.unread ? t`unread` : null, time, preview]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={
        onLongPress || onAction ? t`Long press to pin or move to a section` : undefined
      }
      onPress={() => onPress(group)}
      onLongPress={onLongPress ? () => onLongPress(group) : onAction ? holdForMenu : undefined}
      actions={onAction ? inboxRowActionList(group) : undefined}
      onAction={runAction}
      avatar={<GroupAvatar members={group.members} size={INBOX_ROW.avatarSize} />}
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
