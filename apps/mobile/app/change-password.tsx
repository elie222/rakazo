import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { changePassword } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

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
      setError(cause instanceof Error ? cause.message : t("Could not change password"));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable accessibilityRole="button" onPress={close} style={styles.cancel}>
              <Text style={styles.cancelLabel}>{t("Cancel")}</Text>
            </Pressable>
          ),
        }}
      />
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Change password")}
            disabled={pending || !ready}
            onPress={() => void save()}
            style={({ pressed }) => [
              styles.button,
              (pending || !ready) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {pending ? (
              <ActivityIndicator color={mobileTokens().primaryForeground} />
            ) : (
              <Text style={styles.buttonLabel}>{t("Change password")}</Text>
            )}
          </Pressable>
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
    cancel: { minHeight: 44, justifyContent: "center", paddingEnd: 16 },
    cancelLabel: { color: native.label, fontSize: 17 },
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
    button: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: tokens.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonLabel: { color: tokens.primaryForeground, fontSize: 16, fontWeight: "600" },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.7 },
  });
}
