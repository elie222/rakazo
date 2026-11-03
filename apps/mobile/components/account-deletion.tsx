import type { AccountSecurity } from "@rakazo/contracts";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { deleteAccount, fetchAccountSecurity, requestAccountDeletionCode } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { replaceWithSignIn } from "../lib/auth-routing";
import { promptAccountDeletion } from "../lib/delete-account-prompt";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { forgetSignedIn } from "../lib/returning-user";
import { continueWithSso } from "../lib/sso";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";

/**
 * Deleting the account: confirms it's the owner (password, a fresh SSO sign-in, or an emailed
 * code), deletes, and returns to sign-in. Render `dialog`; `error` is for the screen while the
 * dialog is closed.
 */
export function useAccountDeletion({
  onSecurity,
}: {
  onSecurity?: (security: AccountSecurity) => void;
} = {}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [security, setSecurityState] = useState<AccountSecurity | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [ssoReauthenticated, setSsoReauthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled =
    pending ||
    (security?.hasPassword ? !password : !ssoReauthenticated && (!codeSent || !password.trim()));

  function setSecurity(value: AccountSecurity) {
    setSecurityState(value);
    onSecurity?.(value);
  }

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, t("Could not continue")));
    } finally {
      setPending(false);
    }
  }

  // Cancelling dismisses the dialog's error too, so it does not reappear behind it.
  function close() {
    if (pending) return;
    setOpen(false);
    setPassword("");
    setError(null);
  }

  async function request() {
    if (pending) return;
    setError(null);
    try {
      const value = await fetchAccountSecurity();
      setSecurity(value);
      if (!value.hasPassword) {
        setPassword("");
        setCodeSent(false);
        setSsoReauthenticated(value.freshOidcAuth);
        setOpen(true);
        return;
      }
    } catch (err) {
      setError(errorText(err, t("Could not continue")));
      return;
    }

    const prompted = promptAccountDeletion({
      title: t("Delete your account?"),
      message: t(
        "This permanently deletes your account, bots, conversations, memories, files, and saved connections. This cannot be undone.",
      ),
      cancelLabel: t("Cancel"),
      deleteLabel: t("Delete"),
      onSubmit: (value) => void submit(value, true),
    });
    if (!prompted) {
      setPassword("");
      setOpen(true);
    }
  }

  async function submit(value: string, hasPassword = security?.hasPassword === true) {
    if ((!value && !ssoReauthenticated) || pending) return;
    setPending(true);
    setError(null);
    try {
      if (hasPassword) await deleteAccount(value);
      else {
        const current = await fetchAccountSecurity();
        setSecurity(current);
        setSsoReauthenticated(current.freshOidcAuth);
        const token = codeSent ? value.trim() : undefined;
        if (current.hasPassword || (!current.freshOidcAuth && !token)) return;
        await deleteAccount(undefined, token);
      }
      setOpen(false);
      await forgetSignedIn();
      replaceWithSignIn("/sign-in");
    } catch (err) {
      setError(errorText(err, t("Could not delete account")));
    } finally {
      setPending(false);
    }
  }

  const dialog = open ? (
    <Modal transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.dialogOverlay}
      >
        <Pressable
          accessibilityLabel={t("Cancel")}
          style={StyleSheet.absoluteFill}
          onPress={close}
        />
        <ScrollView
          bounces={false}
          contentContainerStyle={styles.dialog}
          keyboardShouldPersistTaps="handled"
          style={styles.dialogScroll}
        >
          <Text style={styles.dialogTitle}>{t("Delete your account?")}</Text>
          <Text style={styles.dialogBody}>
            {t(
              "This permanently deletes your account, bots, conversations, memories, files, and saved connections. This cannot be undone.",
            )}
          </Text>
          {!security?.hasPassword ? (
            <>
              {security?.sso ? (
                <NativeActionButton
                  label={t("Sign in again")}
                  disabled={pending}
                  onPress={() =>
                    void run(async () => {
                      setSsoReauthenticated(await continueWithSso("reauthenticate"));
                    })
                  }
                />
              ) : null}
              {security?.emailDeletion ? (
                <NativeActionButton
                  label={t("Send deletion code")}
                  disabled={pending}
                  onPress={() =>
                    void run(async () => {
                      await requestAccountDeletionCode();
                      setCodeSent(true);
                    })
                  }
                />
              ) : null}
            </>
          ) : null}
          {security?.hasPassword || codeSent ? (
            <TextInput
              accessibilityLabel={
                security?.hasPassword ? t("Current password") : t("Deletion code")
              }
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              editable={!pending}
              onChangeText={(next) => {
                setPassword(next);
                setError(null);
              }}
              placeholder={security?.hasPassword ? t("Current password") : t("Deletion code")}
              placeholderTextColor={native.tertiaryLabel}
              secureTextEntry={security?.hasPassword}
              style={styles.dialogInput}
              textContentType={security?.hasPassword ? "password" : "oneTimeCode"}
              value={password}
            />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.dialogError}>
              {error}
            </Text>
          ) : null}
          <View style={styles.dialogActions}>
            <Pressable accessibilityRole="button" onPress={close} style={styles.dialogAction}>
              <Text style={styles.dialogCancel}>{t("Cancel")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => void submit(password)}
              style={styles.dialogAction}
            >
              <Text style={[styles.dialogDelete, disabled && styles.disabled]}>{t("Delete")}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  ) : null;

  return { request, run, pending, error: open ? null : error, dialog };
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    dialogOverlay: {
      flex: 1,
      justifyContent: "center",
      padding: 24,
      backgroundColor: "rgba(0, 0, 0, 0.62)",
    },
    dialogScroll: {
      flexGrow: 0,
      flexShrink: 1,
      maxHeight: "100%",
      borderRadius: 14,
      backgroundColor: native.page,
    },
    dialog: {
      padding: 18,
      gap: 12,
    },
    dialogTitle: {
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
    },
    dialogBody: {
      color: native.secondaryLabel,
      fontSize: 14,
      lineHeight: 20,
    },
    dialogInput: {
      height: 48,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      fontSize: 16,
    },
    dialogError: {
      color: tokens.destructive,
      fontSize: 14,
    },
    dialogActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      alignItems: "center",
      gap: 12,
    },
    dialogAction: {
      minHeight: 48,
      justifyContent: "center",
      paddingHorizontal: 8,
    },
    dialogCancel: {
      color: native.label,
      fontSize: 16,
      fontWeight: "600",
    },
    dialogDelete: {
      color: tokens.destructive,
      fontSize: 16,
      fontWeight: "600",
    },
    disabled: {
      opacity: 0.45,
    },
  });
}
