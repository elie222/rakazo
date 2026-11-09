import { Modal, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { removeThreadFavorite, useThreadFavorites } from "../../lib/thread-favorites";
import { NativeActionButton } from "../native-action-button";
import { NativeSheet, useNativeSheet } from "../native-sheet";
import { NativeSymbol } from "../native-symbol";

/**
 * The thread's favorited replies: tapping one closes the sheet and jumps
 * back to that reply in the conversation; each item can be unfavorited here.
 */
export function ThreadFavoritesSheet({
  visible,
  threadKey,
  onClose,
  onJump,
}: {
  visible: boolean;
  threadKey: string | undefined;
  onClose: () => void;
  onJump: (messageId: string) => void;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const Sheet = useNativeSheet();
  const favorites = useThreadFavorites(threadKey);

  if (!visible || Sheet === undefined) return null;

  const content = (
    <View style={{ backgroundColor: tokens.card, paddingBottom: 12 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 20,
          paddingTop: Sheet ? 4 : 12,
          paddingBottom: 8,
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>
          {t("My favorites")}
        </Text>
        <NativeActionButton label={t("Cancel")} prominence="plain" onPress={onClose} />
      </View>
      <Text
        style={{
          color: tokens.mutedForeground,
          fontSize: 13,
          paddingHorizontal: 20,
          paddingBottom: 12,
        }}
      >
        {t("Tap a favorite to jump back to it in the conversation.")}
      </Text>
      {favorites.length === 0 ? (
        <Text
          style={{
            color: tokens.mutedForeground,
            fontSize: 14,
            paddingHorizontal: 20,
            paddingVertical: 24,
            textAlign: "center",
          }}
        >
          {t("Nothing saved yet. Favorite a useful reply and it will show up here.")}
        </Text>
      ) : (
        <ScrollView style={{ maxHeight: 480 }}>
          {favorites.map((item) => (
            <View
              key={item.messageId}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 20,
                paddingVertical: 4,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Tap to jump back")}
                onPress={() => {
                  onClose();
                  onJump(item.messageId);
                }}
                style={({ pressed }) => ({
                  flex: 1,
                  paddingVertical: 8,
                  ...(pressed ? { opacity: 0.6 } : null),
                })}
              >
                <Text style={{ color: tokens.foreground, fontSize: 15 }} numberOfLines={2}>
                  {item.snippet}
                </Text>
                <Text style={{ color: tokens.mutedForeground, fontSize: 12, marginTop: 4 }}>
                  {new Date(item.createdAt).toLocaleString()}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Unfavorite")}
                onPress={() => {
                  if (threadKey) removeThreadFavorite(threadKey, item.messageId);
                }}
                hitSlop={8}
                style={{ padding: 6 }}
              >
                <NativeSymbol
                  ios="bookmark.fill"
                  android="bookmark"
                  size={20}
                  color={tokens.link}
                />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );

  if (Sheet) {
    return (
      <NativeSheet Sheet={Sheet} onClose={onClose} label={t("My favorites")}>
        {content}
      </NativeSheet>
    );
  }
  if (Platform.OS === "ios") {
    return (
      <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
        {content}
      </Modal>
    );
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" }}>
        {content}
      </View>
    </Modal>
  );
}
