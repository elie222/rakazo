import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { typeScale } from "@rakazo/ui-tokens";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { MobileBot, MobileGroup } from "../lib/mobile-types";
import { native, useResolvedAppearance } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { LongPressMenu } from "./long-press-menu";
import { NativeSymbol } from "./native-symbol";
import { Chevron } from "./row-accessories";

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
  const divider = { borderTopWidth: 1, borderTopColor: native.separator };
  return (
    <ScrollView
      style={sideInsets}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 20 }}
    >
      <View
        style={{
          borderRadius: 22,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: native.separator,
          backgroundColor: native.groupedCell,
          overflow: "hidden",
        }}
      >
        {bots.map((bot, index) => (
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
                style={[row, index > 0 && divider]}
              >
                <Text style={{ flex: 1, color: native.label, ...typeScale.cardTitle }}>
                  {bot.name}
                </Text>
                <Chevron />
              </Pressable>
            )}
          </LongPressMenu>
        ))}
        {groups.map((group, index) => (
          <MenuView
            key={`group-${group.id}`}
            colorScheme={scheme}
            actions={[{ id: "restore", title: t`Restore`, attributes: { disabled: pending } }]}
            onPressAction={() => onRestoreGroup(group)}
          >
            <View
              accessible
              accessibilityLabel={`${group.name}, ${t`Group`}`}
              style={[row, (bots.length > 0 || index > 0) && divider]}
            >
              <NativeSymbol ios="person.2" android="people-outline" color={native.secondaryLabel} />
              <Text style={{ flex: 1, color: native.label, ...typeScale.cardTitle }}>
                {group.name}
              </Text>
            </View>
          </MenuView>
        ))}
      </View>
    </ScrollView>
  );
}

const row = {
  minHeight: 60,
  paddingStart: 20,
  paddingEnd: 16,
  flexDirection: "row",
  alignItems: "center",
  gap: 14,
} as const;
