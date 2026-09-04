import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  apiBaseWarning,
  currentApiBase,
  defaultApiBase,
  displayApiHost,
  loadSessionToken,
  normalizeApiBase,
  type PasswordResetCapabilities,
  passwordResetCapabilities,
  probeApiBase,
  requestPasswordReset,
  resetApiBase,
  saveApiBase,
  signIn,
  signUp,
  usesCustomApiBase,
} from "../lib/api";
import { type AuthMode, initialAuthMode } from "../lib/auth-routing";
import { useI18n } from "../lib/i18n";

export default function SignIn() {
  const { t } = useI18n();
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
  const [serverOpen, setServerOpen] = useState(false);
  const [reset, setReset] = useState<PasswordResetCapabilities | null>(null);
  const [resetSent, setResetSent] = useState(false);

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
      <View style={{ flex: 1, backgroundColor: "#F7F7F4", justifyContent: "center", padding: 24 }}>
        <Text style={{ color: "#6E6E68", textAlign: "center" }}>{t("Loading…")}</Text>
      </View>
    );
  }
  if (hasSession) return <Redirect href="/" />;

  async function submit() {
    if (pending) return;
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
        await signUp(trimmedEmail, password, name.trim() || trimmedEmail.split("@")[0] || "User");
      } else {
        await signIn(email.trim(), password);
      }
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not continue"));
    } finally {
      setPending(false);
    }
  }

  const custom = usesCustomApiBase(apiBase);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#F7F7F4" }}>
      <StatusBar style="dark" />
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
                  color: "#1B1B1E",
                  fontSize: 32,
                  fontWeight: "500",
                  textAlign: "center",
                }}
              >
                {mode === "in"
                  ? t("Sign in to Rakazo")
                  : mode === "up"
                    ? t("Sign up for Rakazo")
                    : resetSent
                      ? t("Check your email")
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
                    <Text style={{ color: "#1B1B1E", fontSize: 15, fontWeight: "600" }}>
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
                      placeholderTextColor="#8C8C86"
                      value={name}
                      onChangeText={setName}
                      style={{
                        marginTop: 28,
                        backgroundColor: "#F1F1ED",
                        borderRadius: 13,
                        padding: 16,
                        color: "#1B1B1E",
                      }}
                    />
                  ) : null}
                  <TextInput
                    autoCapitalize="none"
                    autoComplete="email"
                    keyboardType="email-address"
                    placeholder={t("Email")}
                    placeholderTextColor="#8C8C86"
                    value={email}
                    onChangeText={setEmail}
                    style={{
                      marginTop: mode === "up" ? 12 : 28,
                      backgroundColor: "#F1F1ED",
                      borderRadius: 13,
                      padding: 16,
                      color: "#1B1B1E",
                    }}
                  />
                  {mode === "in" && reset?.passwordReset && reset.resetUrl ? (
                    <Pressable
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => {
                        setMode("forgot");
                        setError(null);
                      }}
                      style={{ alignSelf: "flex-end", marginTop: 10 }}
                    >
                      <Text style={{ color: "#1B1B1E", fontSize: 14, fontWeight: "600" }}>
                        {t("Forgot password?")}
                      </Text>
                    </Pressable>
                  ) : null}
                  {mode !== "forgot" ? (
                    <TextInput
                      autoComplete={mode === "in" ? "current-password" : "new-password"}
                      placeholder={t("Password")}
                      placeholderTextColor="#8C8C86"
                      returnKeyType="go"
                      secureTextEntry
                      value={password}
                      onChangeText={setPassword}
                      onSubmitEditing={() => void submit()}
                      style={{
                        marginTop: 12,
                        backgroundColor: "#F1F1ED",
                        borderRadius: 13,
                        padding: 16,
                        color: "#1B1B1E",
                      }}
                    />
                  ) : null}
                  {error ? <Text style={{ color: "#B91C1C", marginTop: 12 }}>{error}</Text> : null}
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void submit()}
                    disabled={pending}
                    style={{
                      marginTop: 16,
                      backgroundColor: "#121215",
                      borderRadius: 13,
                      padding: 18,
                      alignItems: "center",
                    }}
                  >
                    <Text style={{ color: "#FBFBF9", fontSize: 17 }}>
                      {pending
                        ? t("Working…")
                        : mode === "in"
                          ? t("Sign in")
                          : mode === "up"
                            ? t("Sign up")
                            : t("Send reset link")}
                    </Text>
                  </Pressable>
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "center",
                      alignItems: "center",
                      marginTop: 24,
                    }}
                  >
                    <Text style={{ color: "#8C8C86", fontSize: 15 }}>
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
                      <Text style={{ color: "#1B1B1E", fontSize: 15, fontWeight: "600" }}>
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
              onPress={() => setServerOpen(true)}
              style={{
                alignItems: "center",
                paddingHorizontal: 24,
                paddingBottom: 12,
                paddingTop: 8,
              }}
            >
              {custom ? (
                <>
                  <Text style={{ color: "#A8A8A2", fontSize: 12 }}>{t("Custom server")}</Text>
                  <Text style={{ color: "#6E6E68", fontSize: 13, marginTop: 2 }}>
                    {displayApiHost(apiBase)}
                  </Text>
                </>
              ) : (
                <Text style={{ color: "#A8A8A2", fontSize: 13 }}>{t("Use a custom server")}</Text>
              )}
            </Pressable>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
      <ServerSheet
        visible={serverOpen}
        current={apiBase}
        onClose={() => setServerOpen(false)}
        onSaved={(url) => {
          setApiBase(url);
          setServerOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

function ServerSheet({
  visible,
  current,
  onClose,
  onSaved,
}: {
  visible: boolean;
  current: string;
  onClose: () => void;
  onSaved: (url: string) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDraft(current);
    setError(null);
    setPending(false);
  }, [visible, current]);

  const parsedDraft = normalizeApiBase(draft);
  const warning = parsedDraft.ok ? apiBaseWarning(parsedDraft.url) : null;

  async function save() {
    setPending(true);
    setError(null);
    try {
      const probed = await probeApiBase(draft);
      if (!probed.ok) {
        setError(probed.error);
        return;
      }
      const saved = await saveApiBase(probed.url);
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      onSaved(saved.url);
    } finally {
      setPending(false);
    }
  }

  async function restoreDefault() {
    setPending(true);
    setError(null);
    try {
      const saved = await resetApiBase();
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      onSaved(saved.url);
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: "#F7F7F4" }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <SafeAreaView style={{ flex: 1, paddingHorizontal: 24, paddingTop: 12 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={{ color: "#6E6E68", fontSize: 17 }}>{t("Cancel")}</Text>
            </Pressable>
            <Text style={{ color: "#1B1B1E", fontSize: 17, fontWeight: "600" }}>{t("Server")}</Text>
            <Pressable onPress={() => void save()} disabled={pending} hitSlop={8}>
              <Text style={{ color: "#1B1B1E", fontSize: 17, fontWeight: "600" }}>
                {pending ? t("Checking…") : t("Save")}
              </Text>
            </Pressable>
          </View>
          <Text style={{ color: "#6E6E68", marginTop: 28, fontSize: 15, lineHeight: 22 }}>
            {t(
              "Point this app at your self-hosted Rakazo origin, the same HTTPS URL you open in a browser.",
            )}
          </Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            keyboardType="url"
            textContentType="URL"
            returnKeyType="go"
            onSubmitEditing={() => void save()}
            placeholder={defaultApiBase()}
            placeholderTextColor="#8C8C86"
            value={draft}
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            style={{
              marginTop: 20,
              backgroundColor: "#F1F1ED",
              borderRadius: 13,
              padding: 16,
              color: "#1B1B1E",
              fontSize: 16,
            }}
          />
          {warning ? (
            <Text style={{ color: "#8C8C86", marginTop: 12, fontSize: 13 }}>{warning}</Text>
          ) : null}
          {error ? <Text style={{ color: "#B91C1C", marginTop: 12 }}>{error}</Text> : null}
          {usesCustomApiBase(current) || draft.trim() !== current ? (
            <Pressable
              onPress={() => void restoreDefault()}
              disabled={pending}
              style={{ marginTop: 28, alignItems: "center" }}
            >
              <Text style={{ color: "#6E6E68", fontSize: 15 }}>{t("Use default server")}</Text>
            </Pressable>
          ) : null}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
