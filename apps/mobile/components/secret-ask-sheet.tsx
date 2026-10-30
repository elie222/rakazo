import type { LoginFieldInput } from "@rakazo/contracts";
import { LoginSecretValue, loginCardFields } from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { Modal, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { useSecretSheetClose } from "../lib/secret-sheet-close";
import type { LoginFieldRow } from "./login-fields-editor";
import { LoginFieldsEditor } from "./login-fields-editor";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

/**
 * A website sign-in, typed or filled from saved passwords. The values live only in this sheet's
 * state and are cleared whether saving succeeds or fails, and before the sheet closes.
 */
export function SecretAskSheet({
  title,
  destination,
  loginFields,
  pending,
  onClose,
  onSave,
}: {
  title: string;
  destination: string;
  /** The labels the card asks for; absent means the default username and password. */
  loginFields: readonly string[] | undefined;
  /** False once the card is answered or can no longer be answered; the sheet then closes. */
  pending: boolean;
  onClose: () => void;
  /** `remember` is false when "Save to Vault" was turned off: the login is for this run only. */
  onSave: (fields: LoginFieldInput[], remember: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const inputs = useRef<(TextInput | null)[]>([]);
  const [fields, setFields] = useState<LoginFieldRow[]>(() =>
    loginCardFields(loginFields).map((field, id) => ({ ...field, id })),
  );
  const labels = loginFields ?? [t("Username"), t("Password")];
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const incomplete = !LoginSecretValue.safeParse({ fields }).success;

  function clear() {
    setFields((current) => current.map((field) => ({ ...field, value: "" })));
  }

  const { close, closing, endEditing } = useSecretSheetClose(inputs, clear, onClose);

  useEffect(() => {
    if (!pending) close();
  }, [pending]);

  async function save() {
    if (submitting || incomplete) return;
    const answer = fields.map(({ label, value, hidden }) => ({ label, value, hidden }));
    clear();
    setSubmitting(true);
    setError(null);
    try {
      await onSave(answer, remember);
    } catch {
      setError(t("Could not send answer"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
      // Focus once the sheet is up: a field focused while the sheet is still being laid out
      // clips its placeholder at large text sizes.
      onShow={() => inputs.current[0]?.focus()}
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
          <NativeActionButton label={t("Cancel")} onPress={close} prominence="plain" />
          <NativeActionButton
            disabled={incomplete}
            busy={submitting}
            fill={false}
            label={remember ? t("Save") : t("Continue")}
            onPress={() => void save()}
            prominence={incomplete ? "plain" : "primary"}
          />
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          // A long title and site at large text sizes can leave the fields under the keyboard.
          automaticallyAdjustKeyboardInsets
        >
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          <Text style={styles.destination}>{destination}</Text>
          <LoginFieldsEditor
            fields={fields}
            onChange={setFields}
            labels={labels}
            editable={!submitting && !closing}
            inputs={inputs}
            onEndEditing={endEditing}
            onSubmit={() => void save()}
          />
          <View style={[styles.group, styles.row]}>
            <Text style={styles.switchLabel}>{t("Save to Vault")}</Text>
            <NativeSwitch
              accessibilityLabel={t("Save to Vault")}
              disabled={submitting || closing}
              value={remember}
              onValueChange={setRemember}
            />
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    sheet: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingBottom: 12,
    },
    content: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
    title: { color: tokens.foreground, fontSize: 20, fontWeight: "600" },
    destination: { color: tokens.foreground, fontSize: 15, marginBottom: 8 },
    group: { backgroundColor: tokens.muted, borderRadius: 13, overflow: "hidden" },
    row: { flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: 16 },
    switchLabel: { flex: 1, color: tokens.foreground, fontSize: 17 },
    error: { color: tokens.destructive, fontSize: 13 },
  });
}
