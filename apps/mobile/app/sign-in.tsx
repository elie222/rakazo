import { credentialIssue, MAX_PASSWORD_LENGTH, PASSWORD_RULES } from "@rakazo/core";
import { Redirect, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
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
import type { MobileMe, PasswordResetCapabilities } from "../lib/api";
import {
  currentApiBase,
  displayApiHost,
  loadSessionToken,
  passwordResetCapabilities,
  requestPasswordReset,
  rpc,
  sendSignInCode,
  signIn,
  signInWithCode,
  signUp,
  usesCustomApiBase,
} from "../lib/api";
import type { AuthMode } from "../lib/auth-routing";
import { initialAuthMode } from "../lib/auth-routing";
import { useI18n } from "../lib/i18n";
import { hasIncomingShare } from "../lib/incoming-share";
import { useMobileTokens } from "../lib/native";
import { passkeysAvailable, signInWithPasskey } from "../lib/passkey";
import { continueWithSso } from "../lib/sso";
import { credentialIssueText, errorText } from "../lib/user-error";

const CODE_LENGTH = 6;

export default function SignIn() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { mode: requestedMode } = useLocalSearchParams<{ mode?: string | string[] }>();
  const [mode, setMode] = useState<AuthMode>(() => initialAuthMode(requestedMode));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [apiBase, setApiBase] = useState(() => currentApiBase());
  const [reset, setReset] = useState<PasswordResetCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [resetSent, setResetSent] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [passkeys, setPasskeys] = useState(false);

  useEffect(() => {
    setPasswordVisible(false);
  }, [mode, apiBase, usePassword]);

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
    setCapabilityError(false);
    // A code belongs to the server that sent it.
    setCodeSent(false);
    setCode("");
    void passwordResetCapabilities()
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => {
        if (active) setCapabilityError(true);
      });
    return () => {
      active = false;
    };
  }, [apiBase, capabilityAttempt]);

  useEffect(() => {
    let active = true;
    setPasskeys(false);
    void passkeysAvailable(reset).then((available) => {
      if (active) setPasskeys(available);
    });
    return () => {
      active = false;
    };
  }, [reset]);

  useEffect(() => {
    if (resetSent || codeSent) AccessibilityInfo.announceForAccessibility(t("Check your email"));
  }, [resetSent, codeSent, t]);

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
        <ActivityIndicator color={tokens.mutedForeground} accessibilityLabel={t("Loading…")} />
      </View>
    );
  }
  if (hasSession) return <Redirect href={hasIncomingShare() ? "/share" : "/"} />;

  const codeFlow = Boolean(reset?.passwordAuth && reset.emailCode && mode !== "forgot");
  const usingCode = codeFlow && !usePassword;
  const codeStep = usingCode && codeSent;

  async function submit(enteredCode = code) {
    if (pending || !reset?.passwordAuth) return;
    const issue = credentialIssue({
      email,
      password: mode === "forgot" || usingCode ? undefined : password,
    });
    if (issue) {
      setError(credentialIssueText(issue));
      return;
    }
    // An unfinished code would spend one of the code's three attempts.
    if (codeStep && enteredCode.length !== CODE_LENGTH) return;
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
      if (usingCode && !codeSent) {
        const sentFrom = apiBase;
        await sendSignInCode(email.trim());
        if (currentApiBase() !== sentFrom) return;
        setCode("");
        setCodeSent(true);
        return;
      }
      if (usingCode) {
        const trimmedEmail = email.trim();
        await signInWithCode(
          trimmedEmail,
          enteredCode,
          // Only used when this creates the account.
          mode === "up" ? name.trim() || trimmedEmail.split("@")[0] || "User" : undefined,
        );
      } else if (mode === "up") {
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
      if (hasIncomingShare()) router.replace("/share");
      else await openApp();
    } catch (err) {
      setError(errorText(err, t("Could not continue")));
    } finally {
      setPending(false);
    }
  }

  // Any sign-in can create the account (a code, SSO), so ask the server rather than the form.
  async function openApp() {
    const me = await rpc<MobileMe>("me").catch(() => null);
    router.replace(me?.needsSignupSurvey ? "/signup-survey" : "/");
  }

  async function externalSignIn(run: () => Promise<boolean>) {
    setPending(true);
    setError(null);
    try {
      if (await run()) {
        if (hasIncomingShare()) router.replace("/share");
        else await openApp();
      }
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
                {resetSent || codeStep
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
                      setCodeSent(false);
                    }}
                  >
                    <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
                      {t("Back to sign in")}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  {capabilityError ? (
                    <View accessibilityRole="alert">
                      <Text style={{ color: tokens.destructive }}>
                        {t("Could not load sign-in options")}
                      </Text>
                      <NativeActionButton
                        label={t("Retry")}
                        onPress={() => setCapabilityAttempt((value) => value + 1)}
                      />
                    </View>
                  ) : !reset ? (
                    <ActivityIndicator
                      color={tokens.mutedForeground}
                      accessibilityLabel={t("Loading…")}
                      style={{ marginTop: 16 }}
                    />
                  ) : null}
                  {reset?.sso && !reset.passwordAuth && mode !== "forgot" ? (
                    <NativeActionButton
                      label={t("Continue with {name}", { name: reset.sso.name })}
                      disabled={pending}
                      onPress={() => void externalSignIn(continueWithSso)}
                      style={{ marginTop: 16 }}
                    />
                  ) : null}
                  {error && !reset?.passwordAuth ? (
                    <Text
                      accessibilityRole="alert"
                      style={{ color: tokens.destructive, marginTop: 12 }}
                    >
                      {error}
                    </Text>
                  ) : null}
                  {reset?.passwordAuth && codeStep ? (
                    <>
                      <TextInput
                        accessibilityLabel={t("Code")}
                        autoComplete="one-time-code"
                        autoFocus
                        keyboardType="number-pad"
                        maxLength={CODE_LENGTH}
                        placeholder={t("Code")}
                        placeholderTextColor={tokens.mutedForeground}
                        textContentType="oneTimeCode"
                        value={code}
                        onChangeText={(value) => {
                          const digits = value.replace(/\D/g, "").slice(0, CODE_LENGTH);
                          setCode(digits);
                          // iOS offers the code from Mail; a complete code signs in at once.
                          if (digits.length === CODE_LENGTH) void submit(digits);
                        }}
                        onSubmitEditing={() => void submit()}
                        style={{
                          marginTop: 28,
                          backgroundColor: tokens.muted,
                          borderRadius: 13,
                          padding: 16,
                          color: tokens.foreground,
                        }}
                      />
                      {error ? (
                        <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text>
                      ) : null}
                      <NativeActionButton
                        disabled={pending || code.length < CODE_LENGTH}
                        label={pending ? t("Working…") : t("Continue")}
                        onPress={() => void submit()}
                        style={{ marginTop: 16 }}
                      />
                      <NativeActionButton
                        label={t("Back")}
                        prominence="quiet"
                        disabled={pending}
                        onPress={() => {
                          setCodeSent(false);
                          setCode("");
                          setError(null);
                        }}
                        style={{ alignSelf: "center", marginTop: 16 }}
                      />
                    </>
                  ) : reset?.passwordAuth ? (
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
                      {mode !== "forgot" && !usingCode ? (
                        <View
                          style={{
                            marginTop: 12,
                            flexDirection: "row",
                            alignItems: "center",
                            backgroundColor: tokens.muted,
                            borderRadius: 13,
                          }}
                        >
                          <TextInput
                            autoComplete={mode === "in" ? "current-password" : "new-password"}
                            textContentType={mode === "in" ? "password" : "newPassword"}
                            passwordRules={mode === "in" ? undefined : PASSWORD_RULES}
                            maxLength={MAX_PASSWORD_LENGTH}
                            placeholder={t("Password")}
                            placeholderTextColor={tokens.mutedForeground}
                            returnKeyType="go"
                            autoCapitalize="none"
                            autoCorrect={false}
                            secureTextEntry={!passwordVisible}
                            value={password}
                            onChangeText={setPassword}
                            onSubmitEditing={() => void submit()}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              padding: 16,
                              color: tokens.foreground,
                            }}
                          />
                          <NativeActionButton
                            accessibilityLabel={
                              passwordVisible ? t("Hide password") : t("Show password")
                            }
                            icon={{
                              ios: passwordVisible ? "eye.slash" : "eye",
                              android: passwordVisible ? "eye-off-outline" : "eye-outline",
                            }}
                            prominence="quiet"
                            onPress={() => setPasswordVisible((visible) => !visible)}
                            style={{
                              alignSelf: "center",
                              minWidth: 44,
                              minHeight: 44,
                              marginRight: 4,
                            }}
                          />
                        </View>
                      ) : null}
                      {error ? (
                        <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text>
                      ) : null}
                      <NativeActionButton
                        disabled={pending}
                        label={
                          pending
                            ? t("Working…")
                            : usingCode
                              ? t("Continue")
                              : mode === "in"
                                ? t("Sign in")
                                : mode === "up"
                                  ? t("Sign up")
                                  : t("Send reset link")
                        }
                        onPress={() => void submit()}
                        style={{ marginTop: 16 }}
                      />
                      {passkeys && mode === "in" && !codeSent ? (
                        <NativeActionButton
                          label={t("Sign in with passkey")}
                          prominence="quiet"
                          disabled={pending}
                          onPress={() => void externalSignIn(signInWithPasskey)}
                          style={{ alignSelf: "center", marginTop: 16 }}
                        />
                      ) : null}
                      {codeFlow ? (
                        <NativeActionButton
                          label={usingCode ? t("Use password") : t("Use email code")}
                          prominence="quiet"
                          disabled={pending}
                          onPress={() => {
                            setUsePassword(usingCode);
                            setError(null);
                          }}
                          style={{ alignSelf: "center", marginTop: 16 }}
                        />
                      ) : null}
                      {reset.sso && mode !== "forgot" ? (
                        <NativeActionButton
                          label={t("Continue with {name}", { name: reset.sso.name })}
                          prominence="quiet"
                          disabled={pending}
                          onPress={() => void externalSignIn(continueWithSso)}
                          style={{ alignSelf: "center", marginTop: 16 }}
                        />
                      ) : null}
                      {mode === "in" && !usingCode && reset?.passwordReset && reset.resetUrl ? (
                        <Pressable
                          accessibilityRole="button"
                          hitSlop={8}
                          onPress={() => {
                            setMode("forgot");
                            setError(null);
                          }}
                          style={{ alignSelf: "center", marginTop: 16 }}
                        >
                          <Text
                            style={{ color: tokens.foreground, fontSize: 14, fontWeight: "600" }}
                          >
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
                          <Text
                            style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}
                          >
                            {mode === "in"
                              ? t("Sign up")
                              : mode === "up"
                                ? t("Sign in")
                                : t("Back to sign in")}
                          </Text>
                        </Pressable>
                      </View>
                    </>
                  ) : null}
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
