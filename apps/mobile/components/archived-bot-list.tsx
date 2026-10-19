import { MenuView } from "@expo/ui/community/menu";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { MobileBot } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useResolvedAppearance } from "../lib/native";
import { Chevron } from "./row-accessories";

export type ArchivedBotListProps = {
  bots: MobileBot[];
  pending: boolean;
  onOpen: (bot: MobileBot) => void;
  onRestore: (bot: MobileBot) => void;
  onDelete: (bot: MobileBot) => void;
};

export function ArchivedBotList({
  bots,
  pending,
  onOpen,
  onRestore,
  onDelete,
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
      </View>
    </ScrollView>
  );
}
