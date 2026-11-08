import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { ResolvedAppearance } from "../lib/appearance";
import { AvatarRow } from "../lib/avatar-life";
import { useI18n } from "../lib/i18n";
import type { InboxItem, InboxSpace } from "../lib/inbox-spaces";
import { canDeleteInboxSpace, inboxItemKey } from "../lib/inbox-spaces";
import type { MobileBot, MobileBotSection, MobileGroup } from "../lib/mobile-types";
import { useThemedStyles } from "../lib/native";
import type { useInboxChatActions } from "../lib/use-inbox-chat-actions";
import { DragSafePressable } from "./drag-safe-pressable";
import { createHomeStyles } from "./home-styles";
import { ArchivedChatsRow, BotRow, GroupRow, PinnedTiles, SectionToggle } from "./inbox-rows";
import type { NativeRowMenu } from "./native-row";
import { NativeRow } from "./native-row";
import { NativeSymbol } from "./native-symbol";

// Swipe actions and the context menu are iOS list behaviour; other platforms keep the long-press
// sheet.
export const SWIPE_ROWS = Platform.OS === "ios";

type ChatActions = ReturnType<typeof useInboxChatActions>;
// One empty list, so a row with no sections keeps its memoized render.
const NO_SECTIONS: MobileBotSection[] = [];

/** The end of the inbox list: the create hint while it is needed, then the archived chats. */
export function InboxListFooter({
  createHint,
  archivedCount,
}: {
  createHint: boolean;
  archivedCount: number;
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const router = useRouter();
  return (
    <>
      {createHint ? <Text style={styles.empty}>{t("Tap + to create a bot")}</Text> : null}
      <ArchivedChatsRow count={archivedCount} onPress={() => router.push("/archived-bots")} />
    </>
  );
}

type HeadingMenu = NativeRowMenu & {
  /** The Android "…" button's accessible name. */
  label: string;
};

/**
 * A heading's menu: a long press on the heading on iOS, as with the chat rows, and a "…" button
 * on Android, where a menu trigger on an older binary can collapse to zero width.
 */
function HeadingWithMenu({
  space,
  menu,
  appearance,
  children,
}: {
  /** A space heading, which has its own row style. */
  space?: boolean;
  menu?: HeadingMenu;
  appearance: ResolvedAppearance;
  children: (onLongPress: (() => void) | undefined) => ReactNode;
}) {
  const styles = useThemedStyles(createHomeStyles);
  const row = space ? styles.spaceHeading : styles.sectionHeadingRow;
  const plain = <View style={row}>{children(undefined)}</View>;
  if (!menu) return Platform.OS === "ios" ? <NativeRow>{plain}</NativeRow> : plain;
  if (Platform.OS === "ios")
    return (
      <NativeRow menu={menu}>
        {/* Holding for the menu must not also count as a tap when the finger lifts. */}
        <View style={row}>{children(holdForMenu)}</View>
      </NativeRow>
    );
  const actions: MenuAction[] = menu.actions.map((action) => ({
    id: action.id,
    title: action.title,
    image: action.image,
    attributes: { destructive: action.destructive, disabled: action.disabled },
  }));
  return (
    <View style={row}>
      {children(undefined)}
      {actions.length === 1 ? (
        <Pressable
          accessibilityLabel={menu.actions[0]!.title}
          accessibilityRole="button"
          onPress={() => menu.onAction(menu.actions[0]!.id)}
          style={styles.spaceActions}
        >
          <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
        </Pressable>
      ) : (
        <MenuView
          actions={actions}
          colorScheme={appearance}
          onPressAction={({ nativeEvent }) => menu.onAction(nativeEvent.event)}
        >
          <View
            accessibilityLabel={menu.label}
            accessibilityRole="button"
            style={styles.spaceActions}
          >
            <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
          </View>
        </MenuView>
      )}
    </View>
  );
}

const holdForMenu = () => undefined;

function SpaceHeading({
  title,
  selected,
  busy,
  onPress,
  menu,
  appearance,
}: {
  title: string;
  selected: boolean;
  busy: boolean;
  onPress: () => void;
  menu?: HeadingMenu;
  appearance: ResolvedAppearance;
}) {
  const styles = useThemedStyles(createHomeStyles);
  return (
    <HeadingWithMenu space menu={menu} appearance={appearance}>
      {(onLongPress) => (
        <DragSafePressable
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ selected, disabled: busy }}
          disabled={busy}
          onPress={onPress}
          onLongPress={onLongPress}
          style={({ pressed }) => [styles.spaceSelect, pressed && styles.rowPressed]}
        >
          <Text style={styles.spaceTitle}>{title}</Text>
        </DragSafePressable>
      )}
    </HeadingWithMenu>
  );
}

function SectionHeading({
  title,
  count,
  collapsed,
  onPress,
  onDelete,
  appearance,
}: {
  title: string;
  count?: number;
  collapsed: boolean;
  onPress: () => void;
  onDelete?: () => void;
  appearance: ResolvedAppearance;
}) {
  const { t } = useI18n();
  return (
    <HeadingWithMenu
      menu={
        onDelete
          ? {
              actions: [
                { id: "delete", title: t("Delete section"), image: "trash", destructive: true },
              ],
              label: t("Section actions for {name}", { name: title }),
              onAction: onDelete,
            }
          : undefined
      }
      appearance={appearance}
    >
      {(onLongPress) => (
        <SectionToggle
          title={title}
          count={count}
          collapsed={collapsed}
          onPress={onPress}
          onLongPress={onLongPress}
        />
      )}
    </HeadingWithMenu>
  );
}

/** The inbox list's row renderer: pinned tiles, space and section headings, and chat rows. */
export function useInboxRenderItem({
  appearance,
  botAction,
  chooseInboxSpace,
  confirmDeleteSpace,
  createBotInSpace,
  day,
  now,
  deleteSection,
  editSectionFromMenu,
  groupAction,
  spaceId,
  openBot,
  openGroup,
  organizeBot,
  organizeFromMenu,
  organizeGroup,
  sharing,
  snoozeChat,
  spaces,
  spaceBusy,
  spaceRecoveryId,
  toggleCollapsed,
}: Pick<
  ChatActions,
  | "botAction"
  | "groupAction"
  | "organizeFromMenu"
  | "editSectionFromMenu"
  | "deleteSection"
  | "snoozeChat"
> & {
  appearance: ResolvedAppearance;
  chooseInboxSpace: (spaceId: string) => void;
  confirmDeleteSpace: (space: InboxSpace) => void;
  createBotInSpace: (spaceId: string) => void;
  day: number;
  /** The snooze clock, so rows redraw when a chat wakes. */
  now: number;
  /** The selected space: only its section headings can be deleted. */
  spaceId: string | undefined;
  openBot: (bot: MobileBot | SpaceBot) => void;
  openGroup: (group: MobileGroup | SpaceGroup) => void;
  organizeBot: (bot: MobileBot | SpaceBot) => void;
  organizeGroup: (group: MobileGroup | SpaceGroup) => void;
  /** Picking a chat for an incoming share: rows only open, without menus or swipe actions. */
  sharing: boolean;
  /** The listed spaces, whose sections each chat's row menu can move it between. */
  spaces: readonly Pick<InboxSpace, "id" | "botSections">[];
  spaceBusy: boolean;
  spaceRecoveryId: string | null;
  toggleCollapsed: (key: string) => void;
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const router = useRouter();
  return useCallback(
    ({ item }: { item: InboxItem }) => {
      const sectionsOf = (chatSpaceId: string | undefined) =>
        spaces.find((space) => space.id === (chatSpaceId ?? spaceId))?.botSections ?? NO_SECTIONS;
      return item.type === "pinned" ? (
        // The pinned tiles' avatars freeze with their row when it scrolls away.
        <AvatarRow id={inboxItemKey(item)}>
          <PinnedTiles
            chats={item.chats}
            onOpenBot={openBot}
            onOpenGroup={openGroup}
            onLongPressBot={organizeBot}
            onLongPressGroup={organizeGroup}
            onBotAction={botAction}
            onGroupAction={groupAction}
          />
        </AvatarRow>
      ) : item.type === "heading" ? (
        item.space ? (
          <SpaceHeading
            title={item.title}
            selected={item.space.id === spaceId}
            busy={spaceBusy}
            onPress={() => {
              if (item.space) void chooseInboxSpace(item.space.id);
            }}
            menu={
              sharing
                ? undefined
                : {
                    actions: [
                      {
                        id: "new-bot",
                        title: t("New bot"),
                        image: "person.crop.circle.badge.plus",
                        disabled: spaceBusy || !!spaceRecoveryId,
                      },
                      { id: "members", title: t("Members"), image: "person.2" },
                      { id: "settings", title: t("Settings"), image: "gearshape" },
                      ...(canDeleteInboxSpace(item.space)
                        ? [
                            {
                              id: "delete",
                              title: t("Delete space"),
                              image: "trash" as const,
                              destructive: true,
                              disabled: spaceBusy || !!spaceRecoveryId,
                            },
                          ]
                        : []),
                    ],
                    label: t("Space actions for {name}", { name: item.title }),
                    onAction: (id) => {
                      if (!item.space) return;
                      if (id === "new-bot") createBotInSpace(item.space.id);
                      else if (id === "delete") confirmDeleteSpace(item.space);
                      else
                        router.push({
                          pathname: id === "members" ? "/space-members" : "/space",
                          params: { spaceId: item.space.id, name: item.space.name },
                        });
                    },
                  }
            }
            appearance={appearance}
          />
        ) : (
          <SectionHeading
            title={item.title}
            count={item.collapsed ? (item.count ?? 0) : undefined}
            collapsed={item.collapsed === true}
            onPress={() => toggleCollapsed(item.key)}
            onDelete={
              sharing || !item.sectionId
                ? undefined
                : () => {
                    if (item.sectionId) deleteSection({ id: item.sectionId, name: item.title });
                  }
            }
            appearance={appearance}
          />
        )
      ) : item.type === "group" ? (
        <GroupRow
          group={item.group}
          day={day}
          now={now}
          onPress={openGroup}
          onLongPress={!SWIPE_ROWS ? organizeGroup : undefined}
          onAction={SWIPE_ROWS ? groupAction : undefined}
          sections={sectionsOf(item.group.spaceId)}
          onOrganize={organizeFromMenu}
          onEditSection={editSectionFromMenu}
          onSnooze={snoozeChat}
        />
      ) : (
        <BotRow
          bot={item.bot}
          day={day}
          now={now}
          onPress={openBot}
          onLongPress={!sharing && !SWIPE_ROWS ? organizeBot : undefined}
          onAction={!sharing && SWIPE_ROWS ? botAction : undefined}
          sections={sectionsOf(item.bot.spaceId)}
          onOrganize={organizeFromMenu}
          onEditSection={editSectionFromMenu}
          onSnooze={snoozeChat}
        />
      );
    },
    [
      appearance,
      botAction,
      chooseInboxSpace,
      confirmDeleteSpace,
      createBotInSpace,
      deleteSection,
      day,
      now,
      editSectionFromMenu,
      groupAction,
      spaceId,
      openBot,
      openGroup,
      organizeBot,
      organizeFromMenu,
      organizeGroup,
      router,
      sharing,
      snoozeChat,
      spaces,
      spaceBusy,
      spaceRecoveryId,
      styles,
      t,
      toggleCollapsed,
    ],
  );
}
