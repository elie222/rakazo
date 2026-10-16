import { MenuView } from "@expo/ui/community/menu";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { MobileBot, MobileGroup } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useResolvedAppearance } from "../lib/native";
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
  const { t } = useI18n();
  const scheme = useResolvedAppearance();
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 20 }}>
      <View style={{ borderRadius: 14, backgroundColor: native.fill, overflow: "hidden" }}>
        {bots.map((bot) => (
          <MenuView
            key={bot.id}
            shouldOpenOnLongPress
            colorScheme={scheme}
            actions={[
              { id: "restore", title: t("Restore"), attributes: { disabled: pending } },
              {
                id: "delete",
                title: t("Delete"),
                attributes: { destructive: true, disabled: pending },
              },
            ]}
            onPressAction={({ nativeEvent }) =>
              nativeEvent.event === "restore" ? onRestore(bot) : onDelete(bot)
            }
          >
            <Pressable
              disabled={pending}
              onPress={() => onOpen(bot)}
              accessibilityRole="button"
              style={{
                minHeight: 54,
                paddingHorizontal: 16,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
              }}
            >
              <Text style={{ flex: 1, color: native.label, fontSize: 16 }}>{bot.name}</Text>
              <Chevron />
            </Pressable>
          </MenuView>
        ))}
        {groups.map((group) => (
          <MenuView
            key={`group-${group.id}`}
            colorScheme={scheme}
            actions={[{ id: "restore", title: t("Restore"), attributes: { disabled: pending } }]}
            onPressAction={() => onRestoreGroup(group)}
          >
            <View
              accessible
              accessibilityLabel={`${group.name}, ${t("Group")}`}
              style={{
                minHeight: 54,
                paddingHorizontal: 16,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
              }}
            >
              <NativeSymbol ios="person.2" android="people-outline" color={native.secondaryLabel} />
              <Text style={{ flex: 1, color: native.label, fontSize: 16 }}>{group.name}</Text>
            </View>
          </MenuView>
        ))}
      </View>
    </ScrollView>
  );
}
