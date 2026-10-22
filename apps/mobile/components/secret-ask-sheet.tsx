import { useEffect, useRef, useState } from "react";
import { Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { secretFieldTraits } from "../lib/secret-field-traits";
import { NativeActionButton } from "./native-action-button";

/**
 * A website sign-in, typed or filled from saved passwords. The values live only in this sheet's
 * state and are cleared whether saving succeeds or fails, and before the sheet closes.
 */
export function SecretAskSheet({
  title,
  destination,
  pending,
  onClose,
  onSave,
}: {
  title: string;
  destination: string;
  /** False once the card is answered or can no longer be answered; the sheet then closes. */
  pending: boolean;
  onClose: () => void;
  onSave: (password: string, username: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const usernameInput = useRef<TextInput>(null);
  const passwordInput = useRef<TextInput>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeState = useRef<"open" | "closing" | "closed">("open");
  const incomplete = !username.trim() || password.length === 0;

  function clear() {
    setUsername("");
    setPassword("");
  }

  // iOS offers to save the password when a sheet goes away while its username or password field
  // still holds text. Closing empties and locks both fields first. The native commands run in
  // order, so the field being edited ends editing only after both are empty and reports its
  // text; the sheet closes a frame after that report, or after a delay if no field was edited.
  function close() {
    if (closeState.current !== "open") return;
    closeState.current = "closing";
    clear();
    setClosing(true);
    for (const input of [usernameInput, passwordInput]) input.current?.clear();
    for (const input of [usernameInput, passwordInput]) input.current?.blur();
  }

  function finishClosing() {
    if (closeState.current !== "closing") return;
    closeState.current = "closed";
    requestAnimationFrame(() => onClose());
  }

  function endEditing(text: string) {
    if (text === "") finishClosing();
  }

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(finishClosing, 500);
    return () => clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    if (!pending) close();
  }, [pending]);

  async function save() {
    if (submitting || incomplete) return;
    const submitUsername = username.trim();
    const submitPassword = password;
    clear();
    setSubmitting(true);
    setError(null);
    try {
      await onSave(submitPassword, submitUsername);
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
      onShow={() => usernameInput.current?.focus()}
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
            label={t("Save")}
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
          <TextInput
            ref={usernameInput}
            accessibilityLabel={t("Username")}
            value={username}
            onChangeText={setUsername}
            placeholder={t("Username")}
            placeholderTextColor={styles.placeholder.color}
            textContentType="username"
            autoComplete="username"
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => passwordInput.current?.focus()}
            editable={!submitting && !closing}
            onEndEditing={(event) => endEditing(event.nativeEvent.text)}
            style={styles.field}
          />
          <TextInput
            ref={passwordInput}
            accessibilityLabel={t("Password")}
            value={password}
            onChangeText={setPassword}
            placeholder={t("Password")}
            placeholderTextColor={styles.placeholder.color}
            secureTextEntry
            {...secretFieldTraits("password", { auth: { type: "login" } })}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="go"
            onSubmitEditing={() => void save()}
            editable={!submitting && !closing}
            onEndEditing={(event) => endEditing(event.nativeEvent.text)}
            style={styles.field}
          />
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
    field: {
      backgroundColor: tokens.muted,
      borderRadius: 13,
      padding: 16,
      color: tokens.foreground,
    },
    placeholder: { color: tokens.faintForeground },
    error: { color: tokens.destructive, fontSize: 13 },
  });
}
