import type { BotSecretMetadata } from "@rakazo/contracts";
import { commandVariableName } from "@rakazo/contracts";
import { useRef, useState } from "react";
import { Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { secretFieldTraits } from "../lib/secret-field-traits";
import { useSecretSheetClose } from "../lib/secret-sheet-close";
import { errorText } from "../lib/user-error";
import type {
  CredentialAuth,
  CredentialDestination,
  CredentialDraft,
  CredentialType,
} from "../lib/vault";
import {
  credentialDestination,
  credentialDetail,
  credentialNameProblem,
  credentialValue,
  draftDestination,
  draftReady,
  EMPTY_DRAFT,
  secretReady,
} from "../lib/vault";
import type { LoginFieldRow } from "./login-fields-editor";
import { LoginFieldsEditor } from "./login-fields-editor";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";

/**
 * Adds a credential to a vault, or replaces a saved one's value. The value, or a website login's
 * fields, live only in this sheet's state and are cleared on save and before it closes.
 */
export function VaultCredentialSheet({
  replacing,
  onClose,
  onSave,
}: {
  /** The saved credential whose value is replaced; without one the sheet adds a credential. */
  replacing: (BotSecretMetadata & { auth: CredentialAuth }) | null;
  onClose: () => void;
  /** Rejects when the credential was not saved. */
  onSave: (destination: CredentialDestination, value: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const inputs = useRef<(TextInput | null)[]>([]);
  const [draft, setDraft] = useState<CredentialDraft>(EMPTY_DRAFT);
  const [secret, setSecret] = useState<{ value: string; fields: LoginFieldRow[] }>(() => ({
    value: "",
    fields: [
      { id: 0, label: t("Username"), value: "", hidden: false },
      { id: 1, label: t("Password"), value: "", hidden: true },
    ],
  }));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const clear = () =>
    setSecret((prev) => ({
      value: "",
      fields: prev.fields.map((field) => ({ ...field, value: "" })),
    }));
  const { close, closing, endEditing } = useSecretSheetClose(inputs, clear, onClose);

  const type: CredentialType = replacing?.auth.type ?? draft.type;
  const ready = replacing ? secretReady(type, secret) : draftReady(draft, secret);
  const editable = !submitting && !closing;
  const update = (change: Partial<CredentialDraft>) => setDraft((prev) => ({ ...prev, ...change }));
  const nameProblem = replacing ? undefined : credentialNameProblem(draft);
  // A save in flight keeps the sheet open, so its failure is still shown here.
  const cancel = () => {
    if (!submitting) close();
  };

  async function save() {
    if (submitting || !ready) return;
    const destination = replacing
      ? credentialDestination(replacing.name, replacing.origin, replacing.auth)
      : draftDestination(draft);
    const value = credentialValue(type, secret);
    clear();
    setSubmitting(true);
    setError(null);
    try {
      await onSave(destination, value);
      close();
    } catch (err) {
      setError(errorText(err, t("Could not save the credential")));
    } finally {
      setSubmitting(false);
    }
  }

  const field = (props: {
    label: string;
    value: string;
    onChange: (text: string) => void;
    placeholder?: string;
    url?: boolean;
  }) => (
    <TextInput
      accessibilityLabel={props.label}
      value={props.value}
      onChangeText={props.onChange}
      placeholder={props.placeholder ?? props.label}
      placeholderTextColor={styles.placeholder.color}
      autoCorrect={false}
      autoCapitalize="none"
      keyboardType={props.url ? "url" : "default"}
      textContentType="none"
      autoComplete="off"
      editable={editable}
      style={styles.field}
    />
  );

  const types: { key: CredentialType; label: string }[] = [
    { key: "bearer", label: t("Bearer token") },
    { key: "header", label: t("Custom header") },
    { key: "basic", label: t("Basic auth") },
    { key: "login", label: t("Website login") },
    { key: "command", label: t("Command variable") },
  ];

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={cancel}>
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
            disabled={submitting}
            label={t("Cancel")}
            onPress={cancel}
            prominence="plain"
          />
          <NativeActionButton
            disabled={!ready}
            busy={submitting}
            fill={false}
            label={t("Save")}
            onPress={() => void save()}
            prominence={ready ? "primary" : "plain"}
          />
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>
            {replacing?.name ?? t("Add credential")}
          </Text>
          {replacing ? <Text style={styles.detail}>{credentialDetail(replacing)}</Text> : null}
          {replacing ? null : (
            <>
              {field({
                label: t("Name"),
                value: draft.name,
                // Names are lowercase, so typed capitals are not a mistake to report.
                onChange: (name) => update({ name: name.toLowerCase() }),
              })}
              {nameProblem ? (
                <Text style={styles.error}>
                  {nameProblem === "reserved"
                    ? t("{variable} is reserved. Choose another name.", {
                        variable: `$${commandVariableName(draft.name.trim())}`,
                      })
                    : t("Use lowercase letters, numbers, - and _, starting with a letter.")}
                </Text>
              ) : null}
              <View style={styles.picker}>
                <MenuPicker
                  label={t("Type")}
                  choices={types}
                  value={draft.type}
                  onChange={(key) => update({ type: key as CredentialType })}
                />
              </View>
              {draft.type === "command"
                ? null
                : field({
                    label: t("Site"),
                    value: draft.origin,
                    onChange: (origin) => update({ origin }),
                    placeholder: "https://example.com",
                    url: true,
                  })}
              {draft.type === "header"
                ? field({
                    label: t("Header name"),
                    value: draft.headerName,
                    onChange: (headerName) => update({ headerName }),
                  })
                : null}
              {draft.type === "basic"
                ? field({
                    label: t("Username"),
                    value: draft.basicUsername,
                    onChange: (basicUsername) => update({ basicUsername }),
                  })
                : null}
            </>
          )}
          {type === "login" ? (
            <LoginFieldsEditor
              fields={secret.fields}
              onChange={(update) => setSecret((prev) => ({ ...prev, fields: update(prev.fields) }))}
              editable={editable}
              inputs={inputs}
              onEndEditing={endEditing}
              onSubmit={() => void save()}
            />
          ) : (
            <TextInput
              ref={(node) => {
                inputs.current[0] = node;
              }}
              accessibilityLabel={t("Value")}
              value={secret.value}
              onChangeText={(value) => setSecret((prev) => ({ ...prev, value }))}
              placeholder={t("Value")}
              placeholderTextColor={styles.placeholder.color}
              secureTextEntry
              {...secretFieldTraits(undefined, { auth: { type } })}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="done"
              onSubmitEditing={() => void save()}
              editable={editable}
              onEndEditing={(event) => endEditing(event.nativeEvent.text)}
              style={styles.field}
            />
          )}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
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
      paddingHorizontal: 20,
      paddingBottom: 12,
    },
    content: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
    title: { color: tokens.foreground, fontSize: 20, fontWeight: "600" },
    detail: { color: tokens.mutedForeground, fontSize: 15, marginBottom: 8 },
    field: {
      backgroundColor: tokens.muted,
      borderRadius: 13,
      padding: 16,
      color: tokens.foreground,
    },
    picker: { backgroundColor: tokens.muted, borderRadius: 13, overflow: "hidden" },
    placeholder: { color: tokens.faintForeground },
    error: { color: tokens.destructive, fontSize: 13 },
  });
}
