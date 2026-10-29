import { truncateReplyQuote } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useMemo, useState } from "react";
import { Modal, Platform, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileMessage } from "../../lib/api";
import { t } from "../../lib/i18n";
import { quotableMessageSegments } from "../../lib/message-presentation";
import { useMobileTokens } from "../../lib/native";
import { NativeActionButton } from "../native-action-button";

export function QuoteSheet({
  message,
  onCancel,
  onQuote,
}: {
  message: MobileMessage;
  onCancel: () => void;
  onQuote: (excerpt: string) => void;
}) {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const segments = useMemo(() => quotableMessageSegments(message.role, message.blocks), [message]);
  const [selection, setSelection] = useState<{
    segment: number;
    start: number;
    end: number;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const selectedText = selection === null ? undefined : segments[selection.segment];
  const start = selection ? Math.min(selection.start, selection.end) : 0;
  const end = selection ? Math.max(selection.start, selection.end) : 0;
  const excerpt =
    selectedText === undefined ? "" : truncateReplyQuote(selectedText.slice(start, end).trim());

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View
        accessibilityViewIsModal
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          // Page sheets clear the notch on iOS; Android modals are full-screen.
          paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
          paddingBottom: insets.bottom,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            paddingHorizontal: 20,
            paddingBottom: 12,
          }}
        >
          <NativeActionButton label={t("Cancel")} onPress={onCancel} prominence="plain" />
          <NativeActionButton
            disabled={!excerpt}
            fill={false}
            label={t("Quote")}
            onPress={() => onQuote(excerpt)}
            prominence={excerpt ? "primary" : "plain"}
          />
        </View>
        <ScrollView style={{ flex: 1, paddingHorizontal: 20 }}>
          {segments.map((text, index) => (
            <TextInput
              key={`${index}:${revision}`}
              multiline
              scrollEnabled={false}
              showSoftInputOnFocus={false}
              value={text}
              // Any edit (paste, hardware keyboard, dictation) remounts the
              // field with the source text — the excerpt slices the original,
              // so the displayed text must never diverge from it.
              onChangeText={() => setRevision((value) => value + 1)}
              style={{
                color: tokens.foreground,
                ...typeScale.body,
                padding: 0,
                marginTop: index === 0 ? 0 : 12,
                textAlignVertical: "top",
              }}
              onSelectionChange={(event) => {
                const range = event.nativeEvent.selection;
                // A collapsed caret (tap, focus change, the Quote press
                // itself) keeps the last real span armed.
                if (range.start === range.end) return;
                setSelection({ segment: index, ...range });
              }}
            />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}
