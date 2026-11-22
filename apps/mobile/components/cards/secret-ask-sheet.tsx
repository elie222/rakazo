import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { LoginFieldInput } from "@rakazo/contracts";
import { LoginSecretValue, loginCardFields } from "@rakazo/contracts";
import { secretAnswerErrorText } from "@rakazo/i18n/vault";
import { useEffect, useRef, useState } from "react";
import type { TextInputInstance } from "react-native";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useSheetPadding } from "../../lib/layout/side-insets";
import { useThemedStyles } from "../../lib/native/native";
import { useSecretSheetClose } from "../../lib/vault/secret-sheet-close";
import { NativeActionButton } from "../native/native-action-button";
import { NativeSwitch } from "../native/native-switch";
import { SheetCloseButton } from "../native/sheet-close-button";
import type { LoginFieldRow } from "../vault/login-fields-editor";
import { LoginFieldsEditor } from "../vault/login-fields-editor";

/**
 * A website sign-in, typed or filled from saved passwords. The values live only in this sheet's
 * state and are cleared whether saving succeeds or fails, and before the sheet closes.
 */
export function SecretAskSheet({
  title,
  destination,
  replacedSite,
  loginFields,
  pending,
  onClose,
  onSave,
  onDismiss,
}: {
  title: string;
  destination: string;
  /** The site of the saved login this answer replaces. */
  replacedSite?: string;
  /** The labels the card asks for; absent means the default username and password. */
  loginFields: readonly string[] | undefined;
  /** False once the card is answered or can no longer be answered; the sheet then closes. */
  pending: boolean;
  onClose: () => void;
  /** `remember` is false when "Save to Vault" was turned off: the login is for this run only. */
  onSave: (fields: LoginFieldInput[], remember: boolean) => Promise<void>;
  /** Turns the request down without a value; absent when this viewer can't. */
  onDismiss?: () => Promise<void>;
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const sheetPadding = useSheetPadding();
  const inputs = useRef<(TextInputInstance | null)[]>([]);
  const [fields, setFields] = useState<LoginFieldRow[]>(() =>
    loginCardFields(loginFields).map((field, id) => ({ ...field, id })),
  );
  const labels = loginFields ?? [t`Username`, t`Password`];
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const incomplete = !LoginSecretValue.safeParse({ fields }).success;

  function clear() {
    setFields((current) => current.map((field) => ({ ...field, value: "" })));
  }

  const { close, closing, endEditing } = useSecretSheetClose(inputs, clear, onClose);
  // A save or dismissal in flight keeps the sheet open, so its failure is still shown here.
  const cancel = () => {
    if (!submitting) close();
  };

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
    } catch (err) {
      setError(secretAnswerErrorText(err, t`Could not send answer`));
    } finally {
      setSubmitting(false);
    }
  }

  async function dismiss() {
    if (submitting || !onDismiss) return;
    clear();
    setSubmitting(true);
    setError(null);
    try {
      await onDismiss();
    } catch (err) {
      setError(secretAnswerErrorText(err, t`Could not send answer`));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={cancel}
      // Focus once the sheet is up: a field focused while the sheet is still being laid out
      // clips its placeholder at large text sizes.
      onShow={() => inputs.current[0]?.focus()}
    >
      <View accessibilityViewIsModal style={[styles.sheet, sheetPadding]}>
        <View style={styles.header}>
          <SheetCloseButton onPress={cancel} />
          <NativeActionButton
            disabled={incomplete}
            busy={submitting}
            fill={false}
            label={remember ? t`Save` : t`Continue`}
            onPress={() => void save()}
            prominence={incomplete ? "plain" : "primary"}
            // The button pins itself to the top of a row; this one centers with the close button.
            style={styles.headerAction}
          />
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          // A long title and site at large text sizes can leave the fields under the keyboard.
          automaticallyAdjustKeyboardInsets
        >
          <Text accessibilityRole="header" numberOfLines={2} style={styles.title}>
            {title}
          </Text>
          <Text style={styles.destination}>{destination}</Text>
          {replacedSite ? (
            <Text style={styles.replaced}>
              {t`Replaces the login saved for ${ph({ site: replacedSite })}`}
            </Text>
          ) : null}
          <LoginFieldsEditor
            fields={fields}
            // Username and Password are always right; fields the bot names may need switching, as
            // a hidden value is typed only into a password field.
            hiddenFixed={!loginFields}
            onChange={setFields}
            labels={labels}
            editable={!submitting && !closing}
            inputs={inputs}
            onEndEditing={endEditing}
            onSubmit={() => void save()}
          />
          <View style={[styles.group, styles.row]}>
            <Text style={styles.switchLabel}>{t`Save to Vault`}</Text>
            <NativeSwitch
              accessibilityLabel={t`Save to Vault`}
              disabled={submitting || closing}
              value={remember}
              onValueChange={setRemember}
            />
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {onDismiss ? (
            <NativeActionButton
              label={t`Dismiss request`}
              disabled={submitting || closing}
              fill={false}
              prominence="plain"
              onPress={() => void dismiss()}
            />
          ) : null}
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
      minHeight: 44,
      paddingHorizontal: 20,
      paddingBottom: 12,
    },
    headerAction: { alignSelf: "center" },
    content: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
    title: { color: tokens.foreground, fontSize: 20, fontWeight: "600" },
    destination: { color: tokens.mutedForeground, fontSize: 15, marginTop: -4, marginBottom: 8 },
    replaced: { color: tokens.mutedForeground, fontSize: 13, marginTop: -8, marginBottom: 8 },
    group: { backgroundColor: tokens.muted, borderRadius: 13, overflow: "hidden" },
    row: { flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: 16 },
    switchLabel: { flex: 1, color: tokens.foreground, fontSize: 17 },
    error: { color: tokens.destructive, fontSize: 13 },
  });
}
