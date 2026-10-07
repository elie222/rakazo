import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../components/native-action-button";
import { cancelHeaderOptions } from "../components/sheet-header";
import { changePassword } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { errorText } from "../lib/user-error";

export default function ChangePassword() {
  const router = useRouter();
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const ready = !!currentPassword && newPassword.length >= 8 && !!confirmation;

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace("/account");
  }

  async function save() {
    if (!ready || submitting.current) return;
    if (newPassword !== confirmation) {
      setError(t("Passwords do not match"));
      return;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await changePassword(currentPassword, newPassword);
      if (!mounted.current) return;
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      close();
      Alert.alert(t("Password updated"));
    } catch (cause) {
      setError(errorText(cause, t("Could not change password")));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <Stack.Screen options={cancelHeaderOptions(t("Cancel"), close)} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.screen}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {[
            {
              label: t("Current password"),
              value: currentPassword,
              onChange: setCurrentPassword,
              current: true,
            },
            {
              label: t("New password"),
              value: newPassword,
              onChange: setNewPassword,
              current: false,
            },
            {
              label: t("Confirm password"),
              value: confirmation,
              onChange: setConfirmation,
              current: false,
            },
          ].map((field) => (
            <TextInput
              key={field.label}
              accessibilityLabel={field.label}
              autoCapitalize="none"
              autoComplete={field.current ? "current-password" : "new-password"}
              autoCorrect={false}
              editable={!pending}
              onChangeText={field.onChange}
              placeholder={field.label}
              placeholderTextColor={native.tertiaryLabel}
              secureTextEntry
              style={styles.input}
              value={field.value}
            />
          ))}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          <NativeActionButton
            busy={pending}
            disabled={!ready}
            label={t("Change password")}
            onPress={() => void save()}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 12 },
    input: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
    },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
