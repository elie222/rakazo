import { lazy, Suspense } from "react";
import type { TextInputProps } from "react-native";
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
  return (
    <TextFieldDialog
      title={t("Edit name")}
      label={t("Name")}
      submitLabel={t("Save")}
      value={draft}
      error={error}
      saving={saving}
      input={{ autoComplete: "name", maxLength: 80, selectTextOnFocus: true }}
      onChange={onChange}
      onSubmit={onSave}
      onClose={onClose}
    />
  );
}

/** A single-field dialog for platforms without a system text prompt. */
export function TextFieldDialog({
  title,
  label,
  submitLabel,
  value,
  error,
  saving,
  input,
  extraAction,
  onChange,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  submitLabel: string;
  value: string;
  error: string | null;
  saving: boolean;
  input?: Omit<TextInputProps, "value" | "onChangeText">;
  /** One more button beside Cancel and submit. */
  extraAction?: { label: string; onPress: () => void };
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const disabled = saving || !value.trim();
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
            {title}
          </Text>
          <View style={[styles.field, !!error && styles.fieldError]}>
            <Text style={styles.label}>{label}</Text>
            <TextInput
              accessibilityLabel={label}
              autoFocus
              editable={!saving}
              returnKeyType="done"
              {...input}
              onChangeText={onChange}
              onSubmitEditing={() => {
                if (!disabled) onSubmit(value);
              }}
              style={styles.input}
              value={value}
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
            {extraAction ? (
              <Pressable
                accessibilityRole="button"
                disabled={saving}
                onPress={extraAction.onPress}
                style={styles.action}
              >
                <Text style={[styles.actionText, saving && styles.disabled]}>
                  {extraAction.label}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => onSubmit(value)}
              style={styles.action}
            >
              <Text style={[styles.actionText, disabled && styles.disabled]}>{submitLabel}</Text>
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
