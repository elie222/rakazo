import { typeScale } from "@rakazo/ui-tokens";
import { Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

/** A message as one block of plain text, so a selection can span paragraphs. */
export function SelectTextSheet({ text, onClose }: { text: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={text !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          // Page sheets clear the notch on iOS; Android modals are full-screen.
          {
            paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <View style={styles.header}>
          <NativeActionButton
            fill={false}
            label={t("Done")}
            onPress={onClose}
            prominence="primary"
          />
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          {Platform.OS === "ios" ? (
            // iOS selectable Text only copies the whole message; a read-only text
            // view gets the native handles and edit menu. The sheet scrolls, not
            // the text view, which would open scrolled toward its caret.
            <TextInput
              value={text ?? ""}
              editable={false}
              multiline
              scrollEnabled={false}
              style={[styles.text, styles.iosTextInput]}
            />
          ) : (
            <Text selectable style={styles.text}>
              {text}
            </Text>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    sheet: { flex: 1, backgroundColor: tokens.background },
    header: { flexDirection: "row", justifyContent: "flex-end", padding: 16 },
    content: { paddingHorizontal: 20, paddingBottom: 40 },
    text: { color: tokens.foreground, ...typeScale.body },
    iosTextInput: { paddingTop: 0, paddingBottom: 0 },
  });
}
