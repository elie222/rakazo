import type { IntegrationSetupState } from "@rakazo/contracts";
import { credentialIssue } from "@rakazo/core";
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../components/native-action-button";
import {
  currentApiBase,
  displayApiHost,
  loadSessionToken,
  type PasswordResetCapabilities,
  passwordResetCapabilities,
  requestPasswordReset,
  rpc,
  signIn,
  signUp,
  usesCustomApiBase,
} from "../lib/api";
import { type AuthMode, initialAuthMode } from "../lib/auth-routing";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { credentialIssueText, errorText } from "../lib/user-error";

export default function SignIn() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { mode: requestedMode } = useLocalSearchParams<{ mode?: string | string[] }>();
  const [mode, setMode] = useState<AuthMode>(() => initialAuthMode(requestedMode));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [apiBase, setApiBase] = useState(() => currentApiBase());
  const [reset, setReset] = useState<PasswordResetCapabilities | null>(null);
  const [resetSent, setResetSent] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setApiBase(currentApiBase());
    }, []),
  );

  useEffect(() => {
    void loadSessionToken().then((token) => {
      setHasSession(Boolean(token));
      setReady(true);
    });
  }, []);

  useEffect(() => {
    let active = true;
    setReset(null);
    void passwordResetCapabilities()
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [apiBase]);

  useEffect(() => {
    if (resetSent) AccessibilityInfo.announceForAccessibility(t("Check your email"));
  }, [resetSent, t]);

  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          justifyContent: "center",
          padding: 24,
        }}
      >
        <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>{t("Loading…")}</Text>
      </View>
    );
  }
  if (hasSession) return <Redirect href="/" />;

  async function submit() {
    if (pending) return;
    const issue = credentialIssue({ email, password: mode === "forgot" ? undefined : password });
    if (issue) {
      setError(credentialIssueText(issue));
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (mode === "forgot") {
        if (!reset?.passwordReset || !reset.resetUrl) {
          throw new Error(t("Password recovery is not configured for this server"));
        }
        await requestPasswordReset(email.trim(), reset.resetUrl);
        setResetSent(true);
        return;
      }
      if (mode === "up") {
        const trimmedEmail = email.trim();
        const result = await signUp(
          trimmedEmail,
          password,
          name.trim() || trimmedEmail.split("@")[0] || "User",
        );
        if (result.verificationRequired) {
          setResetSent(true);
          return;
        }
      } else {
        await signIn(email.trim(), password);
      }
      const setup =
        mode === "up"
          ? await rpc<IntegrationSetupState>("integrationSetup/get").catch(() => null)
          : null;
      router.replace(setup?.needsSetup ? "/integration-setup" : "/");
    } catch (err) {
      setError(errorText(err, t("Could not continue")));
    } finally {
      setPending(false);
    }
  }

  const custom = usesCustomApiBase(apiBase);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
          <View style={{ flex: 1 }}>
            <ScrollView
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: "center",
                paddingHorizontal: 24,
                paddingVertical: 24,
              }}
              keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
              keyboardShouldPersistTaps="handled"
            >
              <Text
                accessibilityRole="header"
                style={{
                  color: tokens.foreground,
                  fontSize: 32,
                  fontWeight: "500",
                  textAlign: "center",
                }}
              >
                {resetSent
                  ? t("Check your email")
                  : mode === "in"
                    ? t("Sign in to Rakazo")
                    : mode === "up"
                      ? t("Sign up for Rakazo")
                      : t("Reset your password")}
              </Text>
              {resetSent ? (
                <View style={{ alignItems: "center", marginTop: 28 }}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setMode("in");
                      setResetSent(false);
                    }}
                  >
                    <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
                      {t("Back to sign in")}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  {mode === "up" ? (
                    <TextInput
                      autoComplete="name"
                      placeholder={t("Name")}
                      placeholderTextColor={tokens.mutedForeground}
                      value={name}
                      onChangeText={setName}
                      style={{
                        marginTop: 28,
                        backgroundColor: tokens.muted,
                        borderRadius: 13,
                        padding: 16,
                        color: tokens.foreground,
                      }}
                    />
                  ) : null}
                  <TextInput
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    placeholder={t("Email")}
                    placeholderTextColor={tokens.mutedForeground}
                    value={email}
                    onChangeText={setEmail}
                    style={{
                      marginTop: mode === "up" ? 12 : 28,
                      backgroundColor: tokens.muted,
                      borderRadius: 13,
                      padding: 16,
                      color: tokens.foreground,
                    }}
                  />
                  {mode !== "forgot" ? (
                    <TextInput
                      autoComplete={mode === "in" ? "current-password" : "new-password"}
                      placeholder={t("Password")}
                      placeholderTextColor={tokens.mutedForeground}
                      returnKeyType="go"
                      secureTextEntry
                      value={password}
                      onChangeText={setPassword}
                      onSubmitEditing={() => void submit()}
                      style={{
                        marginTop: 12,
                        backgroundColor: tokens.muted,
                        borderRadius: 13,
                        padding: 16,
                        color: tokens.foreground,
                      }}
                    />
                  ) : null}
                  {error ? (
                    <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text>
                  ) : null}
                  <NativeActionButton
                    disabled={pending}
                    label={
                      pending
                        ? t("Working…")
                        : mode === "in"
                          ? t("Sign in")
                          : mode === "up"
                            ? t("Sign up")
                            : t("Send reset link")
                    }
                    onPress={() => void submit()}
                    style={{ marginTop: 16 }}
                  />
                  {mode === "in" && reset?.passwordReset && reset.resetUrl ? (
                    <Pressable
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => {
                        setMode("forgot");
                        setError(null);
                      }}
                      style={{ alignSelf: "center", marginTop: 16 }}
                    >
                      <Text style={{ color: tokens.foreground, fontSize: 14, fontWeight: "600" }}>
                        {t("Forgot password?")}
                      </Text>
                    </Pressable>
                  ) : null}
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "center",
                      alignItems: "center",
                      marginTop: 24,
                    }}
                  >
                    <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
                      {mode === "in"
                        ? t("Don’t have an account?")
                        : mode === "up"
                          ? t("Already have an account?")
                          : ""}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => {
                        setMode((current) => (current === "in" ? "up" : "in"));
                        setError(null);
                      }}
                      style={{ marginLeft: 5 }}
                    >
                      <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
                        {mode === "in"
                          ? t("Sign up")
                          : mode === "up"
                            ? t("Sign in")
                            : t("Back to sign in")}
                      </Text>
                    </Pressable>
                  </View>
                </>
              )}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                custom
                  ? t("Custom server {host}", { host: displayApiHost(apiBase) })
                  : t("Use a custom server")
              }
              hitSlop={12}
              onPress={() => router.push("/server")}
              style={{
                alignItems: "center",
                paddingHorizontal: 24,
                paddingBottom: 12,
                paddingTop: 8,
              }}
            >
              {custom ? (
                <>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                    {t("Custom server")}
                  </Text>
                  <Text style={{ color: tokens.mutedForeground, fontSize: 13, marginTop: 2 }}>
                    {displayApiHost(apiBase)}
                  </Text>
                </>
              ) : (
                <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                  {t("Use a custom server")}
                </Text>
              )}
            </Pressable>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
