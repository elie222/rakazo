import type { AvatarStyle } from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAvatarStyle } from "../components/avatar-style";
import { BotAvatar } from "../components/bot-avatar";
import type { MobileBot } from "../lib/api";
import {
  changePassword as changeAccountPassword,
  currentApiBase,
  deleteAccount,
  loadSessionToken,
  type MobileMe,
  rpc,
  selectedSpaceId,
  signOut,
} from "../lib/api";
import {
  getCachedAppearancePreference,
  setAppearancePreference,
  subscribeAppearance,
} from "../lib/appearance";
import { confirmDeleteBot } from "../lib/bot-lifecycle";
import {
  canPostPromotedNotifications,
  DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  getLiveNotificationSettings,
  type LiveNotificationSettings,
  openLiveNotificationSettings,
  openPromotedNotificationSettings,
  setLiveNotificationSettings,
} from "../lib/live-notifications";
import { native, useThemedStyles } from "../lib/native";
import { registerPushToken } from "../lib/push";

export default function Account() {
  const router = useRouter();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const [me, setMe] = useState<MobileMe | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<LiveNotificationSettings>(
    DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  );
  const [notificationsReady, setNotificationsReady] = useState(Platform.OS !== "android");
  const [notificationPending, setNotificationPending] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [archivedBots, setArchivedBots] = useState<MobileBot[]>([]);
  const [usage, setUsage] = useState<{
    runs: number;
    inputTokens: number;
    outputTokens: number;
  } | null>(null);
  const { avatarStyle, updateAvatarStyle } = useAvatarStyle();
  const appearance = useSyncExternalStore(
    subscribeAppearance,
    getCachedAppearancePreference,
    () => "system" as const,
  );
  const styles = useThemedStyles(createAccountStyles);

  useEffect(() => {
    void rpc<MobileMe>("me")
      .then(setMe)
      .catch(() => undefined);
    void rpc<MobileBot[]>("bots/listArchived")
      .then(setArchivedBots)
      .catch(() => undefined);
    void rpc<{ runs: number; inputTokens: number; outputTokens: number }>("usage/summary")
      .then(setUsage)
      .catch(() => undefined);
    if (Platform.OS === "android") {
      void getLiveNotificationSettings()
        .then(setNotifications)
        .catch(() => undefined)
        .finally(() => setNotificationsReady(true));
    }
  }, []);

  const usageBlock = (
    <View accessibilityLabel="Usage" style={styles.profile}>
      <Text style={styles.settingsTitle}>Usage</Text>
      {usage ? (
        <Text style={styles.email}>
          {usage.runs} runs · {usage.inputTokens + usage.outputTokens} tokens
        </Text>
      ) : null}
      <Text style={styles.settingsExplanation}>Model spend uses your provider keys.</Text>
    </View>
  );

  async function restoreBot(botId: string) {
    try {
      await rpc("bots/restore", { botId });
      setArchivedBots((bots) => bots.filter((bot) => bot.id !== botId));
    } catch (restoreError) {
      Alert.alert(
        "Could not restore bot",
        restoreError instanceof Error ? restoreError.message : "Try again.",
      );
    }
  }

  async function selectAvatarStyle(next: AvatarStyle) {
    if (next === avatarStyle) return;
    setAvatarPending(true);
    setAvatarError(null);
    try {
      await updateAvatarStyle(next);
    } catch {
      setAvatarError("Couldn't update avatars");
    } finally {
      setAvatarPending(false);
    }
  }

  async function handleSignOut() {
    setPending(true);
    setError(null);
    try {
      await signOut();
      router.dismissAll();
      router.replace("/sign-in");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out");
      setPending(false);
    }
  }

  async function handlePasswordChange() {
    if (newPassword !== passwordConfirmation) {
      setPasswordMessage("Passwords do not match");
      return;
    }
    setPasswordPending(true);
    setPasswordMessage(null);
    try {
      await changeAccountPassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordConfirmation("");
      setPasswordMessage("Password updated");
    } catch (cause) {
      setPasswordMessage(cause instanceof Error ? cause.message : "Could not change password");
    } finally {
      setPasswordPending(false);
    }
  }

  async function updateNotifications(next: LiveNotificationSettings) {
    const previous = notifications;
    setNotifications(next);
    setNotificationPending(true);
    setNotificationError(null);
    try {
      await setLiveNotificationSettings(
        next,
        currentApiBase(),
        await loadSessionToken(),
        selectedSpaceId() ?? "",
      );
      if (next.liveConnection && !(await canPostPromotedNotifications())) {
        await openPromotedNotificationSettings();
      }
      await registerPushToken();
    } catch (cause) {
      setNotifications(previous);
      setNotificationError(
        cause instanceof Error ? cause.message : "Could not update notifications",
      );
    } finally {
      setNotificationPending(false);
    }
  }

  function confirmDeletion() {
    setError(null);
    Alert.alert(
      "Delete your account?",
      "This permanently deletes your account, bots, conversations, memories, files, and saved connections. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () => void handleDeletion(),
        },
      ],
    );
  }

  async function handleDeletion() {
    setPending(true);
    setError(null);
    try {
      await deleteAccount(password);
      router.dismissAll();
      router.replace("/sign-in");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete account");
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {focus === "usage" ? usageBlock : null}
        <View style={styles.profile}>
          <Text style={styles.name}>{me?.name || "Your account"}</Text>
          {me?.email ? <Text style={styles.email}>{me.email}</Text> : null}
        </View>
        {focus !== "usage" ? usageBlock : null}

        <View accessibilityLabel="Password" style={styles.profile}>
          <Text style={styles.settingsTitle}>Password</Text>
          <AccountPasswordInput
            label="Current password"
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
          />
          <AccountPasswordInput
            label="New password"
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
          />
          <AccountPasswordInput
            label="Confirm password"
            value={passwordConfirmation}
            onChange={setPasswordConfirmation}
            autoComplete="new-password"
          />
          {passwordMessage ? <Text style={styles.passwordMessage}>{passwordMessage}</Text> : null}
          <Pressable
            accessibilityRole="button"
            disabled={passwordPending || !currentPassword || newPassword.length < 8}
            onPress={() => void handlePasswordChange()}
            style={({ pressed }) => [
              styles.changePasswordButton,
              (passwordPending || !currentPassword || newPassword.length < 8) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {passwordPending ? (
              <ActivityIndicator color={native.label} />
            ) : (
              <Text style={styles.changePasswordLabel}>Change password</Text>
            )}
          </Pressable>
        </View>

        <View accessibilityLabel="Appearance" style={styles.avatarSection}>
          <Text style={styles.settingsTitle}>Appearance</Text>
          <View style={styles.appearanceOptions}>
            {(
              [
                ["system", "System"],
                ["light", "Light"],
                ["dark", "Dark"],
              ] as const
            ).map(([value, label]) => {
              const selected = appearance === value;
              return (
                <Pressable
                  key={value}
                  accessibilityLabel={label}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => void setAppearancePreference(value)}
                  style={({ pressed }) => [
                    styles.appearanceOption,
                    selected && styles.appearanceOptionSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.appearanceLabel}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View accessibilityLabel="Avatar style" style={styles.avatarSection}>
          <Text style={styles.settingsTitle}>Avatars</Text>
          <View style={styles.avatarOptions}>
            {(["robot", "organic"] as const).map((style) => {
              const selected = avatarStyle === style;
              return (
                <Pressable
                  key={style}
                  accessibilityLabel={`${style === "robot" ? "Robot" : "Organic"} avatars`}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: avatarPending }}
                  disabled={avatarPending}
                  onPress={() => void selectAvatarStyle(style)}
                  style={({ pressed }) => [
                    styles.avatarOption,
                    selected && styles.avatarOptionSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <BotAvatar
                    color={style === "robot" ? "#8B5CF6" : "#D62F8B"}
                    identity="avatar-preview"
                    size={42}
                    variant={style}
                  />
                  <Text style={styles.avatarLabel}>{style === "robot" ? "Robot" : "Organic"}</Text>
                </Pressable>
              );
            })}
          </View>
          {avatarError ? <Text style={styles.error}>{avatarError}</Text> : null}
        </View>

        {Platform.OS === "android" ? (
          <View accessibilityLabel="Notifications" style={styles.profile}>
            <Text style={styles.settingsTitle}>Notifications</Text>
            <NotificationSwitch
              label="Live working status"
              detail="While agents are working"
              value={notifications.liveConnection}
              disabled={notificationPending || !notificationsReady}
              onChange={(liveConnection) =>
                void updateNotifications({ ...notifications, liveConnection })
              }
            />
            <NotificationSwitch
              label="Agent messages"
              detail="Replies and completed work"
              value={notifications.messages}
              disabled={notificationPending || !notificationsReady}
              onChange={(messages) => void updateNotifications({ ...notifications, messages })}
            />
            <NotificationSwitch
              label="Scheduled tasks"
              detail="Alerts from routines"
              value={notifications.scheduledTasks}
              disabled={notificationPending || !notificationsReady}
              onChange={(scheduledTasks) =>
                void updateNotifications({ ...notifications, scheduledTasks })
              }
            />
            <NotificationSwitch
              label="Needs attention"
              detail="Questions, approvals, takeover"
              value={notifications.needsAttention}
              disabled={notificationPending || !notificationsReady}
              onChange={(needsAttention) =>
                void updateNotifications({ ...notifications, needsAttention })
              }
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void openPromotedNotificationSettings()}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text style={{ color: "#4C8DFF", fontSize: 14 }}>Live update settings</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void openLiveNotificationSettings()}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text style={{ color: "#4C8DFF", fontSize: 14 }}>Notification settings</Text>
            </Pressable>
            {notificationError ? <Text style={styles.error}>{notificationError}</Text> : null}
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => router.push("/models")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <View>
            <Text style={styles.settingsTitle}>Models</Text>
            <Text style={styles.settingsExplanation}>Choose your provider and active model</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => router.push("/voice")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <View>
            <Text style={styles.settingsTitle}>Voice</Text>
            <Text style={styles.settingsExplanation}>
              Speak replies aloud with ElevenLabs, OpenAI, or Cartesia
            </Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => router.push("/integrations")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <View>
            <Text style={styles.settingsTitle}>Integrations</Text>
            <Text style={styles.settingsExplanation}>Connect apps.</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={pending}
          onPress={() => void handleSignOut()}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <Text style={styles.buttonLabel}>Sign out</Text>
        </Pressable>

        {archivedBots.length > 0 ? (
          <View style={styles.archivedSection}>
            <Text style={styles.sectionTitle}>Archived bots</Text>
            {archivedBots.map((bot) => (
              <View key={bot.id} style={styles.archivedRow}>
                <Text numberOfLines={1} style={styles.archivedName}>
                  {bot.name}
                </Text>
                <Pressable onPress={() => void restoreBot(bot.id)} hitSlop={8}>
                  <Text style={styles.restoreLabel}>Restore</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    confirmDeleteBot(bot, () =>
                      setArchivedBots((bots) => bots.filter((item) => item.id !== bot.id)),
                    )
                  }
                  hitSlop={8}
                >
                  <Text style={styles.archivedDeleteLabel}>Delete</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.dangerZone}>
          <Text style={styles.dangerTitle}>Delete account</Text>
          <Text style={styles.explanation}>
            Enter your current password, then confirm permanent deletion of your account and all
            associated data.
          </Text>
          <TextInput
            accessibilityLabel="Current password"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            onChangeText={(value) => {
              setPassword(value);
              setError(null);
            }}
            placeholder="Current password"
            placeholderTextColor={native.tertiaryLabel}
            secureTextEntry
            style={styles.password}
            textContentType="password"
            value={password}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            disabled={pending || !password}
            onPress={confirmDeletion}
            style={({ pressed }) => [
              styles.deleteButton,
              (pending || !password) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {pending ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.deleteLabel}>Delete account</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function NotificationSwitch({
  label,
  detail,
  value,
  disabled,
  onChange,
}: {
  label: string;
  detail: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View
      style={{
        minHeight: 54,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: native.label, fontSize: 15 }}>{label}</Text>
        <Text style={{ color: native.secondaryLabel, fontSize: 12.5, marginTop: 2 }}>{detail}</Text>
      </View>
      <Switch
        accessibilityLabel={label}
        accessibilityHint={detail}
        disabled={disabled}
        value={value}
        onValueChange={onChange}
      />
    </View>
  );
}

function AccountPasswordInput({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
}) {
  const styles = useThemedStyles(createAccountStyles);
  return (
    <TextInput
      accessibilityLabel={label}
      autoCapitalize="none"
      autoComplete={autoComplete}
      autoCorrect={false}
      onChangeText={onChange}
      placeholder={label}
      placeholderTextColor={native.tertiaryLabel}
      secureTextEntry
      style={styles.accountPassword}
      value={value}
    />
  );
}

function createAccountStyles() {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    content: {
      flexGrow: 1,
      padding: 20,
      gap: 20,
    },
    profile: {
      borderRadius: 16,
      backgroundColor: native.fill,
      padding: 18,
      gap: 4,
    },
    name: {
      color: native.label,
      fontSize: 20,
      fontWeight: "600",
    },
    email: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
    button: {
      minHeight: 50,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.fill,
    },
    buttonLabel: {
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
    },
    archivedSection: {
      borderRadius: 16,
      backgroundColor: native.fill,
      padding: 18,
      gap: 14,
    },
    sectionTitle: {
      color: native.secondaryLabel,
      fontSize: 14,
      fontWeight: "600",
    },
    archivedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
    },
    archivedName: {
      flex: 1,
      color: native.label,
      fontSize: 16,
    },
    restoreLabel: {
      color: native.label,
      fontSize: 14,
      fontWeight: "600",
    },
    archivedDeleteLabel: {
      color: "#FF6961",
      fontSize: 14,
    },
    settingsButton: {
      minHeight: 62,
      borderRadius: 14,
      backgroundColor: native.fill,
      paddingHorizontal: 16,
      paddingVertical: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    avatarSection: {
      borderRadius: 16,
      backgroundColor: native.fill,
      padding: 18,
      gap: 14,
    },
    appearanceOptions: {
      flexDirection: "row",
      gap: 8,
    },
    appearanceOption: {
      flex: 1,
      minHeight: 44,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: native.tertiaryLabel,
      alignItems: "center",
      justifyContent: "center",
    },
    appearanceOptionSelected: {
      borderColor: native.label,
      backgroundColor: native.fillPressed,
    },
    appearanceLabel: {
      color: native.label,
      fontSize: 14,
      fontWeight: "600",
    },
    avatarOptions: {
      flexDirection: "row",
      gap: 12,
    },
    avatarOption: {
      flex: 1,
      minHeight: 86,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: native.tertiaryLabel,
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    },
    avatarOptionSelected: {
      borderColor: native.label,
      backgroundColor: native.fillPressed,
    },
    avatarLabel: {
      color: native.label,
      fontSize: 14,
      fontWeight: "600",
    },
    settingsTitle: {
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
    },
    settingsExplanation: {
      color: native.secondaryLabel,
      fontSize: 13,
      marginTop: 3,
    },
    accountPassword: {
      minHeight: 46,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 14,
      marginTop: 8,
    },
    passwordMessage: {
      color: native.secondaryLabel,
      fontSize: 13,
      marginTop: 8,
    },
    changePasswordButton: {
      minHeight: 44,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.fillPressed,
      marginTop: 10,
    },
    changePasswordLabel: {
      color: native.label,
      fontSize: 15,
      fontWeight: "600",
    },
    chevron: {
      color: native.secondaryLabel,
      fontSize: 28,
      fontWeight: "300",
    },
    dangerZone: {
      marginTop: 12,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "#5A2426",
      padding: 18,
    },
    dangerTitle: {
      color: "#FF6961",
      fontSize: 17,
      fontWeight: "600",
    },
    explanation: {
      color: native.secondaryLabel,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 8,
    },
    password: {
      height: 48,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      marginTop: 16,
      fontSize: 16,
    },
    error: {
      color: "#FF6961",
      fontSize: 14,
      marginTop: 10,
    },
    deleteButton: {
      minHeight: 50,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "#C9363E",
      marginTop: 14,
    },
    deleteLabel: {
      color: "#FFFFFF",
      fontSize: 16,
      fontWeight: "700",
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.7,
    },
  });
}
