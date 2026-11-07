import type { ReactNode } from "react";
import { useState } from "react";
import { Alert, Modal, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";

/**
 * Edits one line of text: the system prompt on iOS (Alert.prompt is iOS-only), a small dialog
 * elsewhere. `ask` opens it on a value; Save hands back the trimmed text.
 */
export function useTextEditDialog(
  label: string,
  maxLength: number,
): {
  ask: (value: string, onCommit: (next: string) => void) => void;
  dialog: ReactNode;
} {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [asked, setAsked] = useState<{
    draft: string;
    onCommit: (next: string) => void;
  } | null>(null);
  function commit(next: string, onCommit: (next: string) => void) {
    if (next.length > maxLength) return;
    setAsked(null);
    onCommit(next.trim());
  }
  function ask(value: string, onCommit: (next: string) => void) {
    if (Platform.OS === "ios")
      Alert.prompt(
        label,
        undefined,
        [
          { text: t("Cancel"), style: "cancel" },
          { text: t("Save"), onPress: (next?: string) => commit(next ?? value, onCommit) },
        ],
        "plain-text",
        value,
      );
    else setAsked({ draft: value, onCommit });
  }
  const dialog =
    Platform.OS !== "ios" && asked ? (
      <Modal transparent animationType="fade" onRequestClose={() => setAsked(null)}>
        <View
          style={{ flex: 1, justifyContent: "center", padding: 24, backgroundColor: native.fill }}
        >
          <View
            accessibilityViewIsModal
            style={{ padding: 24, gap: 16, borderRadius: 16, backgroundColor: tokens.card }}
          >
            <Text style={{ color: tokens.foreground, fontSize: 18 }}>{label}</Text>
            <TextInput
              autoFocus
              accessibilityLabel={label}
              value={asked.draft}
              onChangeText={(draft) => setAsked({ ...asked, draft })}
              maxLength={maxLength}
              onSubmitEditing={() => commit(asked.draft, asked.onCommit)}
              style={{ minHeight: 44, color: tokens.foreground }}
            />
            <NativeActionButton
              label={t("Save")}
              onPress={() => commit(asked.draft, asked.onCommit)}
            />
            <NativeActionButton
              label={t("Cancel")}
              prominence="plain"
              onPress={() => setAsked(null)}
            />
          </View>
        </View>
      </Modal>
    ) : null;
  return { ask, dialog };
}

export function ProfileEditDialog({
  value,
  label,
  editLabel,
  maxLength,
  large = false,
  icon,
  onCommit,
}: {
  value: string;
  label: string;
  editLabel: string;
  maxLength: number;
  large?: boolean;
  icon?: "plus";
  onCommit: (value: string) => Promise<void>;
}) {
  const tokens = useMobileTokens();
  const edit = useTextEditDialog(label, maxLength);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={editLabel}
        style={{
          minHeight: 44,
          justifyContent: icon ? "center" : large ? "flex-end" : "flex-start",
          maxWidth: "100%",
          minWidth: icon ? 44 : undefined,
          alignItems: icon ? "flex-end" : undefined,
        }}
        onPress={() => edit.ask(value, (next) => void onCommit(next))}
      >
        {icon ? (
          <NativeSymbol ios="plus" android="add" size={18} color={tokens.mutedForeground} />
        ) : (
          <Text
            style={{
              textAlign: "center",
              fontSize: large ? 22 : 14,
              lineHeight: large ? 26 : 18,
              fontWeight: large ? "600" : "400",
              color: large ? tokens.foreground : tokens.mutedForeground,
            }}
          >
            {value}
          </Text>
        )}
      </Pressable>
      {edit.dialog}
    </>
  );
}
