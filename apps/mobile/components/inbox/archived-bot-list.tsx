import type { MenuComponentRef } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { typeScale } from "@rakazo/ui-tokens";
import { useRef } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { MobileBot, MobileGroup } from "../../lib/api/mobile-types";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useResolvedAppearance } from "../../lib/native/native";
import { NativeSymbol } from "../native/native-symbol";
import { LongPressMenu } from "../ui/long-press-menu";
import { Chevron } from "../ui/row-accessories";

export type ArchivedBotListProps = {
  bots: MobileBot[];
  groups: MobileGroup[];
  pending: boolean;
  onOpen: (bot: MobileBot) => void;
  onRestore: (bot: MobileBot) => void;
  onDelete: (bot: MobileBot) => void;
  onRestoreGroup: (group: MobileGroup) => void;
};

export function ArchivedBotList({
  bots,
  groups,
  pending,
  onOpen,
  onRestore,
  onDelete,
  onRestoreGroup,
}: ArchivedBotListProps) {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const scheme = useResolvedAppearance();
  return (
    <ScrollView
      style={sideInsets}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20 }}
    >
      <View style={{ borderRadius: 14, backgroundColor: native.fill, overflow: "hidden" }}>
        {bots.map((bot) => (
          <LongPressMenu
            key={bot.id}
            colorScheme={scheme}
            actions={[
              { id: "restore", title: t`Restore`, attributes: { disabled: pending } },
              {
                id: "delete",
                title: t`Delete`,
                attributes: { destructive: true, disabled: pending },
              },
            ]}
            onPressAction={({ nativeEvent }) =>
              nativeEvent.event === "restore" ? onRestore(bot) : onDelete(bot)
            }
          >
            {(onLongPress) => (
              <Pressable
                disabled={pending}
                onPress={() => onOpen(bot)}
                onLongPress={onLongPress}
                accessibilityRole="button"
                style={{
                  minHeight: 54,
                  paddingHorizontal: 16,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <Text style={{ flex: 1, color: native.label, ...typeScale.cardTitle }}>
                  {bot.name}
                </Text>
                <Chevron />
              </Pressable>
            )}
          </LongPressMenu>
        ))}
        {groups.map((group) => (
          <ArchivedGroupRow
            key={`group-${group.id}`}
            colorScheme={scheme}
            group={group}
            pending={pending}
            onRestoreGroup={onRestoreGroup}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function ArchivedGroupRow({
  colorScheme,
  group,
  pending,
  onRestoreGroup,
}: Pick<ArchivedBotListProps, "pending" | "onRestoreGroup"> & {
  colorScheme: ReturnType<typeof useResolvedAppearance>;
  group: MobileGroup;
}) {
  const { t } = useLingui();
  const menu = useRef<MenuComponentRef>(null);
  const android = Platform.OS === "android";
  return (
    <MenuView
      ref={menu}
      colorScheme={colorScheme}
      actions={[{ id: "restore", title: t`Restore`, attributes: { disabled: pending } }]}
      onPressAction={() => onRestoreGroup(group)}
    >
      <View
        accessible
        accessibilityLabel={`${group.name}, ${t`Group`}`}
        accessibilityRole={android ? "button" : undefined}
        accessibilityActions={android ? [{ name: "activate" }] : undefined}
        // TalkBack activation does not reach the menu's touch handler, so open it here.
        onAccessibilityAction={android ? () => menu.current?.show() : undefined}
        style={{
          minHeight: 54,
          paddingHorizontal: 16,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <NativeSymbol ios="person.2" android="people-outline" color={native.secondaryLabel} />
        <Text style={{ flex: 1, color: native.label, ...typeScale.cardTitle }}>{group.name}</Text>
      </View>
    </MenuView>
  );
}
