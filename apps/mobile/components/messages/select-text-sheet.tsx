import { useLingui } from "@lingui/react/macro";
import { typeScale } from "@rakazo/ui-tokens";
import { Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useSheetPadding } from "../../lib/layout/side-insets";
import { useThemedStyles } from "../../lib/native/native";
import { NativeActionButton } from "../native/native-action-button";

/** A message as one block of plain text, so a selection can span paragraphs. */
export function SelectTextSheet({ text, onClose }: { text: string | null; onClose: () => void }) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const sheetPadding = useSheetPadding();
  return (
    <Modal
      visible={text !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View accessibilityViewIsModal style={[styles.sheet, sheetPadding]}>
        <View style={styles.header}>
          <NativeActionButton fill={false} label={t`Done`} onPress={onClose} prominence="primary" />
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
