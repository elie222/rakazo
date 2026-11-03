import { useState } from "react";
import { Alert, Modal, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";

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
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  function commit(next: string) {
    if (next.length > maxLength) return;
    setOpen(false);
    void onCommit(next.trim());
  }
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
        onPress={() => {
          if (Platform.OS === "ios")
            Alert.prompt(
              label,
              undefined,
              [
                { text: t("Cancel"), style: "cancel" },
                { text: t("Save"), onPress: (next?: string) => commit(next ?? value) },
              ],
              "plain-text",
              value,
            );
          else {
            setDraft(value);
            setOpen(true);
          }
        }}
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
      {Platform.OS !== "ios" && open ? (
        <Modal transparent animationType="fade" onRequestClose={() => setOpen(false)}>
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
                value={draft}
                onChangeText={setDraft}
                maxLength={maxLength}
                onSubmitEditing={() => commit(draft)}
                style={{ minHeight: 44, color: tokens.foreground }}
              />
              <NativeActionButton label={t("Save")} onPress={() => commit(draft)} />
              <NativeActionButton
                label={t("Cancel")}
                prominence="plain"
                onPress={() => setOpen(false)}
              />
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}
