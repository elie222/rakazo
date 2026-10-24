import { lazy, Suspense } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { isNameDialogAvailable } from "../lib/name-dialog-available";
import { useThemedStyles } from "../lib/native";

const ComposeNameDialog = lazy(() => import("./name-dialog-compose"));

export type NameDialogProps = {
  draft: string;
  error: string | null;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: (value: string) => void;
  onClose: () => void;
};

export function NameDialog(props: NameDialogProps) {
  const fallback = <FallbackNameDialog {...props} />;
  if (Platform.OS !== "android" || !isNameDialogAvailable()) return fallback;
  return (
    <Suspense fallback={null}>
      <ComposeNameDialog {...props} />
    </Suspense>
  );
}

function FallbackNameDialog({ draft, error, saving, onChange, onSave, onClose }: NameDialogProps) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const disabled = saving || !draft.trim();
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.overlay}>
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <View accessibilityViewIsModal style={styles.dialog}>
          <Text accessibilityRole="header" style={styles.title}>
            {t("Edit name")}
          </Text>
          <View style={[styles.field, !!error && styles.fieldError]}>
            <Text style={styles.label}>{t("Name")}</Text>
            <TextInput
              accessibilityLabel={t("Name")}
              autoComplete="name"
              autoFocus
              editable={!saving}
              maxLength={80}
              onChangeText={onChange}
              onSubmitEditing={() => {
                if (!disabled) onSave(draft);
              }}
              returnKeyType="done"
              selectTextOnFocus
              style={styles.input}
              value={draft}
            />
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={saving}
              onPress={onClose}
              style={styles.action}
            >
              <Text style={[styles.actionText, saving && styles.disabled]}>{t("Cancel")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => onSave(draft)}
              style={styles.action}
            >
              <Text style={[styles.actionText, disabled && styles.disabled]}>{t("Save")}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      padding: 24,
      backgroundColor: tokens.overlay,
    },
    dialog: {
      width: "100%",
      maxWidth: 560,
      borderRadius: 28,
      padding: 24,
      gap: 16,
      backgroundColor: tokens.card,
    },
    title: { fontSize: 24, lineHeight: 32, color: tokens.foreground },
    field: {
      borderWidth: 1,
      borderRadius: 4,
      borderColor: tokens.mutedForeground,
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    fieldError: { borderColor: tokens.destructive },
    label: { fontSize: 12, color: tokens.mutedForeground },
    input: { minHeight: 40, fontSize: 16, color: tokens.foreground, paddingVertical: 8 },
    error: { fontSize: 12, color: tokens.destructive },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
    action: { minHeight: 48, justifyContent: "center", paddingHorizontal: 12 },
    actionText: { fontSize: 14, fontWeight: "600", color: tokens.primary },
    disabled: { opacity: 0.38 },
  });
}
