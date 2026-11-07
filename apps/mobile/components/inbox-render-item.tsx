import { MenuView } from "@expo/ui/community/menu";
import type { SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { useRouter } from "expo-router";
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
import { createHomeStyles } from "./home-styles";
import { ArchivedChatsRow, BotRow, GroupRow, PinnedTiles, SectionToggle } from "./inbox-rows";
import { NativeSymbol } from "./native-symbol";

// Swipe actions and the context menu are iOS list behaviour; other platforms keep the long-press
// sheet.
export const SWIPE_ROWS = Platform.OS === "ios";

type ChatActions = ReturnType<typeof useInboxChatActions>;

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

/** The inbox list's row renderer: pinned tiles, space and section headings, and chat rows. */
export function useInboxRenderItem({
  appearance,
  botAction,
  botSections,
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
  botSections: MobileBotSection[];
  chooseInboxSpace: (spaceId: string) => void;
  confirmDeleteSpace: (space: InboxSpace) => void;
  createBotInSpace: (spaceId: string) => void;
  day: number;
  /** The snooze clock, so rows redraw when a chat wakes. */
  now: number;
  /** The selected space: only its chats get swipe actions and the row menu. */
  spaceId: string | undefined;
  openBot: (bot: MobileBot | SpaceBot) => void;
  openGroup: (group: MobileGroup | SpaceGroup) => void;
  organizeBot: (bot: MobileBot | SpaceBot) => void;
  organizeGroup: (group: MobileGroup | SpaceGroup) => void;
  /** Picking a chat for an incoming share: rows only open, without menus or swipe actions. */
  sharing: boolean;
  spaceBusy: boolean;
  spaceRecoveryId: string | null;
  toggleCollapsed: (key: string) => void;
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const router = useRouter();
  return useCallback(
    ({ item }: { item: InboxItem }) =>
      item.type === "pinned" ? (
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
          <View style={styles.spaceHeading}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.title}
              accessibilityState={{
                selected: item.space.id === spaceId,
                disabled: spaceBusy,
              }}
              disabled={spaceBusy}
              onPress={() => {
                if (item.space) void chooseInboxSpace(item.space.id);
              }}
              style={({ pressed }) => [styles.spaceSelect, pressed && styles.rowPressed]}
            >
              <Text style={styles.spaceTitle}>{item.title}</Text>
            </Pressable>
            {sharing ? null : (
              <MenuView
                actions={[
                  {
                    id: "new-bot",
                    title: t("New bot"),
                    image: "person.crop.circle.badge.plus",
                    attributes: { disabled: spaceBusy || !!spaceRecoveryId },
                  },
                  { id: "members", title: t("Members"), image: "person.2" },
                  { id: "settings", title: t("Settings"), image: "gearshape" },
                  ...(canDeleteInboxSpace(item.space)
                    ? [
                        {
                          id: "delete",
                          title: t("Delete space"),
                          image: "trash" as const,
                          attributes: {
                            destructive: true,
                            disabled: spaceBusy || !!spaceRecoveryId,
                          },
                        },
                      ]
                    : []),
                ]}
                colorScheme={appearance}
                onPressAction={({ nativeEvent }) => {
                  if (!item.space) return;
                  if (nativeEvent.event === "new-bot") createBotInSpace(item.space.id);
                  else if (nativeEvent.event === "delete") confirmDeleteSpace(item.space);
                  else
                    router.push({
                      pathname: nativeEvent.event === "members" ? "/space-members" : "/space",
                      params: { spaceId: item.space.id, name: item.space.name },
                    });
                }}
              >
                <View
                  accessibilityLabel={t("Space actions for {name}", { name: item.title })}
                  accessibilityRole="button"
                  style={styles.spaceActions}
                >
                  <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
                </View>
              </MenuView>
            )}
          </View>
        ) : (
          <View style={styles.sectionHeadingRow}>
            <SectionToggle
              title={item.title}
              count={item.collapsed ? (item.count ?? 0) : undefined}
              collapsed={item.collapsed === true}
              onPress={() => toggleCollapsed(item.key)}
            />
            {sharing || !item.sectionId ? null : Platform.OS === "android" ? (
              // A plain button, like the create control: the Android menu trigger can collapse to
              // zero width on an older binary, which would hide the only way to delete an empty section.
              <Pressable
                accessibilityLabel={t("Delete section")}
                accessibilityRole="button"
                onPress={() => {
                  if (item.sectionId) deleteSection({ id: item.sectionId, name: item.title });
                }}
                style={styles.spaceActions}
              >
                <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
              </Pressable>
            ) : (
              <MenuView
                actions={[
                  {
                    id: "delete",
                    title: t("Delete section"),
                    image: "trash",
                    attributes: { destructive: true },
                  },
                ]}
                colorScheme={appearance}
                onPressAction={() => {
                  if (item.sectionId) deleteSection({ id: item.sectionId, name: item.title });
                }}
              >
                <View
                  accessibilityLabel={t("Section actions for {name}", { name: item.title })}
                  accessibilityRole="button"
                  style={styles.spaceActions}
                >
                  <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
                </View>
              </MenuView>
            )}
          </View>
        )
      ) : item.type === "group" ? (
        <GroupRow
          group={item.group}
          day={day}
          now={now}
          onPress={openGroup}
          onLongPress={!SWIPE_ROWS ? organizeGroup : undefined}
          onAction={SWIPE_ROWS && item.group.spaceId === spaceId ? groupAction : undefined}
          sections={botSections}
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
          onAction={!sharing && SWIPE_ROWS && item.bot.spaceId === spaceId ? botAction : undefined}
          sections={botSections}
          onOrganize={organizeFromMenu}
          onEditSection={editSectionFromMenu}
          onSnooze={snoozeChat}
        />
      ),
    [
      appearance,
      botAction,
      botSections,
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
      spaceBusy,
      spaceRecoveryId,
      styles,
      t,
      toggleCollapsed,
    ],
  );
}
