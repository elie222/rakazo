import type { AvatarStyle } from "@rakazo/contracts";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { SafeAreaView } from "react-native-safe-area-context";
import { useAvatarStyle } from "../components/avatar-style";
import { BotAvatar } from "../components/bot-avatar";
import { NativeActionButton } from "../components/native-action-button";
import { NativeSegmentedControl } from "../components/native-segmented-control";
import { NativeSwitch } from "../components/native-switch";
import { NativeSymbol } from "../components/native-symbol";
import { Chevron } from "../components/row-accessories";
import type { MobileBot, MobileMe } from "../lib/api";
import {
  currentApiBase,
  deleteAccount,
  loadSessionToken,
  rpc,
  selectedSpaceId,
  signOut,
} from "../lib/api";
import { formatUpdateLabel, getAppVersionInfo } from "../lib/app-version";
import {
  getCachedAppearancePreference,
  mobileTokens,
  setAppearancePreference,
} from "../lib/appearance";
import { explicitSignInRoute } from "../lib/auth-routing";
import { confirmDeleteBot } from "../lib/bot-lifecycle";
import { promptAccountDeletion } from "../lib/delete-account-prompt";
import { setUiLocale, useI18n } from "../lib/i18n";
import type { LiveNotificationSettings } from "../lib/live-notifications";
import {
  canPostPromotedNotifications,
  DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  getLiveNotificationSettings,
  openLiveNotificationSettings,
  openPromotedNotificationSettings,
  setLiveNotificationSettings,
} from "../lib/live-notifications";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { native, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { registerPushToken } from "../lib/push";
import {
  getCachedRemoteImagesEnabled,
  setRemoteImagesPreference,
  subscribeRemoteImages,
} from "../lib/remote-images-preference";
import {
  getCachedResponseStreamingEnabled,
  setResponseStreamingPreference,
  subscribeResponseStreaming,
} from "../lib/response-streaming";
import type { AccountUiLocale } from "../lib/ui-locale";
import { ACCOUNT_UI_LOCALES, UI_LOCALE_LABELS } from "../lib/ui-locale";
import { errorText } from "../lib/user-error";

/** Render account settings, including the entry point for voice configuration. */
export default function Account() {
  const { t, locale } = useI18n();
  const colorScheme = useResolvedAppearance();
  const router = useRouter();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const [me, setMe] = useState<MobileMe | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [localeSaving, setLocaleSaving] = useState(false);
  const [localeError, setLocaleError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<LiveNotificationSettings>(
    DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  );
  const [notificationsReady, setNotificationsReady] = useState(Platform.OS !== "android");
  const [notificationPending, setNotificationPending] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [archivedBots, setArchivedBots] = useState<MobileBot[]>([]);
  const [usage, setUsage] = useState<{
    runs: number;
    inputTokens: number;
    outputTokens: number;
  } | null>(null);
  const { avatarStyle, updateAvatarStyle } = useAvatarStyle();
  const appearance = getCachedAppearancePreference();
  const streamReplies = useSyncExternalStore(
    subscribeResponseStreaming,
    getCachedResponseStreamingEnabled,
    () => false,
  );
  const loadRemoteImages = useSyncExternalStore(
    subscribeRemoteImages,
    getCachedRemoteImagesEnabled,
    () => false,
  );
  const loadRemoteImagesLabel = t("Load web images automatically");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const styles = useThemedStyles(createAccountStyles);
  const versionInfo = getAppVersionInfo();
  const updateLabel = formatUpdateLabel(versionInfo.update, t);
  const versionAccessibility = [versionInfo.nativeLabel, updateLabel].filter(Boolean).join(". ");

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
    <View accessibilityLabel={t("Usage")} style={styles.profile}>
      <Text style={styles.settingsTitle}>{t("Usage")}</Text>
      {usage ? (
        <Text style={styles.email}>
          {t("{runs} runs · {tokens} tokens", {
            runs: usage.runs,
            tokens: usage.inputTokens + usage.outputTokens,
          })}
        </Text>
      ) : null}
    </View>
  );

  async function restoreBot(botId: string) {
    try {
      await rpc("bots/restore", { botId });
      setArchivedBots((bots) => bots.filter((bot) => bot.id !== botId));
    } catch (restoreError) {
      Alert.alert(t("Could not restore bot"), errorText(restoreError, t("Try again.")));
    }
  }

  async function selectAvatarStyle(next: AvatarStyle) {
    if (next === avatarStyle) return;
    setAvatarPending(true);
    setAvatarError(null);
    try {
      await updateAvatarStyle(next);
    } catch {
      setAvatarError(t("Couldn't update avatars"));
    } finally {
      setAvatarPending(false);
    }
  }

  async function handleSignOut() {
    setPending(true);
    setSignOutError(null);
    try {
      await signOut();
      router.dismissAll();
      router.replace(explicitSignInRoute);
    } catch (err) {
      setSignOutError(errorText(err, t("Could not sign out")));
      setPending(false);
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
      setNotificationError(errorText(cause, t("Could not update notifications")));
    } finally {
      setNotificationPending(false);
    }
  }

  function closeDeletePrompt() {
    if (pending) return;
    setDeleteOpen(false);
    setDeletePassword("");
  }

  function requestDeletion() {
    if (pending) return;
    setDeleteError(null);
    const prompted = promptAccountDeletion({
      title: t("Delete your account?"),
      message: t(
        "This permanently deletes your account, bots, conversations, memories, files, and saved connections. This cannot be undone.",
      ),
      cancelLabel: t("Cancel"),
      deleteLabel: t("Delete"),
      onSubmit: (password) => void handleDeletion(password),
    });
    if (!prompted) {
      setDeletePassword("");
      setDeleteOpen(true);
    }
  }

  function applyLocale(code: AccountUiLocale) {
    if (code === locale || localeSaving) return;
    setLocaleSaving(true);
    setLocaleError(null);
    void setUiLocale(code)
      .catch(() => {
        setLocaleError(t("Could not change language"));
      })
      .finally(() => setLocaleSaving(false));
  }

  function openLanguagePicker() {
    if (localeSaving) return;
    presentMessageActionSheet({
      title: t("Language"),
      actions: ACCOUNT_UI_LOCALES.map((code) => ({
        text: UI_LOCALE_LABELS[code],
        onPress: () => applyLocale(code),
      })),
      colorScheme,
      cancel: t("Cancel"),
      more: t("More"),
    });
  }

  async function handleDeletion(password: string) {
    if (!password || pending) return;
    setPending(true);
    setDeleteError(null);
    try {
      await deleteAccount(password);
      setDeleteOpen(false);
      router.dismissAll();
      router.replace("/sign-in");
    } catch (err) {
      setDeleteError(errorText(err, t("Could not delete account")));
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {focus === "usage" ? usageBlock : null}
        <View style={styles.profile}>
          <Text style={styles.name}>{me?.name || t("Your account")}</Text>
          {me?.email ? <Text style={styles.email}>{me.email}</Text> : null}
        </View>
        {focus !== "usage" ? usageBlock : null}

        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/change-password")}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <Text style={styles.settingsTitle}>{t("Change password")}</Text>
          <Chevron />
        </Pressable>

        <View accessibilityLabel={t("Appearance")} style={styles.avatarSection}>
          <Text style={styles.settingsTitle}>{t("Appearance")}</Text>
          <NativeSegmentedControl
            accessibilityLabel={t("Appearance")}
            onChange={(value) => void setAppearancePreference(value)}
            options={[
              { value: "system", label: t("System") },
              { value: "light", label: t("Light") },
              { value: "dark", label: t("Dark") },
            ]}
            value={appearance}
          />
        </View>

        <View accessibilityLabel={t("Avatar style")} style={styles.avatarSection}>
          <Text style={styles.settingsTitle}>{t("Avatars")}</Text>
          <View style={styles.avatarOptions}>
            {(["robot", "organic"] as const).map((style) => {
              const selected = avatarStyle === style;
              const styleLabel = style === "robot" ? t("Robot") : t("Organic");
              return (
                <Pressable
                  key={style}
                  accessibilityLabel={t("{style} avatars", { style: styleLabel })}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: avatarPending }}
                  disabled={avatarPending}
                  onPress={() => void selectAvatarStyle(style)}
                  style={({ pressed }) => [styles.avatarOption, pressed && styles.pressed]}
                >
                  <BotAvatar
                    color={style === "robot" ? "#8B5CF6" : "#D62F8B"}
                    identity="avatar-preview"
                    size={42}
                    variant={style}
                  />
                  <Text style={styles.avatarLabel}>{styleLabel}</Text>
                  <NativeSymbol
                    android={selected ? "checkmark-circle" : "ellipse-outline"}
                    color={selected ? native.label : native.tertiaryLabel}
                    ios={selected ? "checkmark.circle.fill" : "circle"}
                    size={22}
                  />
                </Pressable>
              );
            })}
          </View>
          {avatarError ? <Text style={styles.error}>{avatarError}</Text> : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Language")}
          accessibilityValue={{ text: UI_LOCALE_LABELS[locale] }}
          accessibilityState={{ disabled: localeSaving }}
          disabled={localeSaving}
          onPress={openLanguagePicker}
          style={({ pressed }) => [
            styles.settingsButton,
            pressed && styles.pressed,
            localeSaving && { opacity: 0.6 },
          ]}
        >
          <Text style={styles.settingsTitle}>{t("Language")}</Text>
          <View style={styles.settingsTrailing}>
            <Text style={styles.settingsValue}>{UI_LOCALE_LABELS[locale]}</Text>
            <Chevron />
          </View>
        </Pressable>
        {localeError ? <Text style={styles.error}>{localeError}</Text> : null}

        {Platform.OS === "android" ? (
          <View accessibilityLabel={t("Notifications")} style={styles.profile}>
            <Text style={styles.settingsTitle}>{t("Notifications")}</Text>
            <NotificationSwitch
              label={t("Live working status")}
              detail={t("While agents are working")}
              value={notifications.liveConnection}
              disabled={notificationPending || !notificationsReady}
              onChange={(liveConnection) =>
                void updateNotifications({ ...notifications, liveConnection })
              }
            />
            <NotificationSwitch
              label={t("Agent messages")}
              detail={t("Replies and completed work")}
              value={notifications.messages}
              disabled={notificationPending || !notificationsReady}
              onChange={(messages) => void updateNotifications({ ...notifications, messages })}
            />
            <NotificationSwitch
              label={t("Scheduled tasks")}
              detail={t("Alerts from routines")}
              value={notifications.scheduledTasks}
              disabled={notificationPending || !notificationsReady}
              onChange={(scheduledTasks) =>
                void updateNotifications({ ...notifications, scheduledTasks })
              }
            />
            <NotificationSwitch
              label={t("Needs attention")}
              detail={t("Questions, approvals, takeover")}
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
              <Text style={{ color: native.label, fontSize: 14 }}>{t("Live update settings")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void openLiveNotificationSettings()}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text style={{ color: native.label, fontSize: 14 }}>
                {t("Notification settings")}
              </Text>
            </Pressable>
            {notificationError ? <Text style={styles.error}>{notificationError}</Text> : null}
          </View>
        ) : null}

        <View style={styles.group}>
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => router.push("/models")}
            style={({ pressed }) => [styles.groupRow, pressed && styles.pressed]}
          >
            <Text style={styles.settingsTitle}>{t("Models")}</Text>
            <Chevron />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => router.push("/voice")}
            style={({ pressed }) => [
              styles.groupRow,
              styles.groupDivider,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.settingsTitle}>{t("Voice")}</Text>
            <Chevron />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => router.push("/integrations")}
            style={({ pressed }) => [
              styles.groupRow,
              styles.groupDivider,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.settingsTitle}>{t("Integrations")}</Text>
            <Chevron />
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={() => router.push("/ai-data-sharing")}
            style={({ pressed }) => [
              styles.groupRow,
              styles.groupDivider,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.settingsTitle}>{t("AI data sharing")}</Text>
            <Chevron />
          </Pressable>

          {me?.isDeploymentOwner ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push("/integration-setup")}
              style={({ pressed }) => [
                styles.groupRow,
                styles.groupDivider,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.settingsTitle}>{t("Server integrations")}</Text>
              <Chevron />
            </Pressable>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Advanced")}
          accessibilityState={{ expanded: advancedOpen }}
          onPress={() => setAdvancedOpen((open) => !open)}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
        >
          <Text style={styles.settingsTitle}>{t("Advanced")}</Text>
          <Chevron expanded={advancedOpen} />
        </Pressable>
        {advancedOpen ? (
          <View style={styles.avatarSection}>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>{t("Stream replies")}</Text>
              <NativeSwitch
                accessibilityLabel={t("Stream replies")}
                onValueChange={(checked) =>
                  void setResponseStreamingPreference(checked ? "on" : "off")
                }
                value={streamReplies}
              />
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>{loadRemoteImagesLabel}</Text>
              <NativeSwitch
                accessibilityLabel={loadRemoteImagesLabel}
                onValueChange={(checked) => void setRemoteImagesPreference(checked ? "on" : "off")}
                value={loadRemoteImages}
              />
            </View>
          </View>
        ) : null}

        <View>
          <NativeActionButton
            disabled={pending}
            fill
            label={t("Sign out")}
            onPress={() => void handleSignOut()}
            prominence="secondary"
          />
          {signOutError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {signOutError}
            </Text>
          ) : null}
        </View>

        {archivedBots.length > 0 ? (
          <View style={styles.archivedSection}>
            <Text style={styles.sectionTitle}>{t("Archived bots")}</Text>
            {archivedBots.map((bot) => (
              <View key={bot.id} style={styles.archivedRow}>
                <Text numberOfLines={1} style={styles.archivedName}>
                  {bot.name}
                </Text>
                <Pressable onPress={() => void restoreBot(bot.id)} hitSlop={8}>
                  <Text style={styles.restoreLabel}>{t("Restore")}</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    confirmDeleteBot(bot, () =>
                      setArchivedBots((bots) => bots.filter((item) => item.id !== bot.id)),
                    )
                  }
                  hitSlop={8}
                >
                  <Text style={styles.archivedDeleteLabel}>{t("Delete")}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        {versionInfo.nativeLabel || updateLabel ? (
          <View
            accessibilityLabel={versionAccessibility}
            accessibilityRole="summary"
            style={styles.versionFooter}
          >
            {versionInfo.nativeLabel ? (
              <Text style={styles.versionLine}>{versionInfo.nativeLabel}</Text>
            ) : null}
            {updateLabel ? <Text style={styles.versionLine}>{updateLabel}</Text> : null}
          </View>
        ) : null}

        <View>
          <Pressable
            accessibilityRole="button"
            disabled={pending}
            onPress={requestDeletion}
            style={({ pressed }) => [
              styles.settingsButton,
              pressed && styles.pressed,
              pending && styles.disabled,
            ]}
          >
            <Text style={styles.destructiveTitle}>{t("Delete account")}</Text>
            {pending ? <ActivityIndicator color={mobileTokens().destructive} /> : null}
          </Pressable>
          {!deleteOpen && deleteError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {deleteError}
            </Text>
          ) : null}
        </View>
      </ScrollView>
      {deleteOpen ? (
        <Modal transparent animationType="fade" onRequestClose={closeDeletePrompt}>
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={styles.dialogOverlay}
          >
            <Pressable
              accessibilityLabel={t("Cancel")}
              style={StyleSheet.absoluteFill}
              onPress={closeDeletePrompt}
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
              <TextInput
                accessibilityLabel={t("Current password")}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!pending}
                onChangeText={(value) => {
                  setDeletePassword(value);
                  setDeleteError(null);
                }}
                placeholder={t("Current password")}
                placeholderTextColor={native.tertiaryLabel}
                secureTextEntry
                style={styles.dialogInput}
                textContentType="password"
                value={deletePassword}
              />
              {deleteError ? (
                <Text accessibilityRole="alert" style={styles.dialogError}>
                  {deleteError}
                </Text>
              ) : null}
              <View style={styles.dialogActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={closeDeletePrompt}
                  style={styles.dialogAction}
                >
                  <Text style={styles.dialogCancel}>{t("Cancel")}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={pending || !deletePassword}
                  onPress={() => void handleDeletion(deletePassword)}
                  style={styles.dialogAction}
                >
                  <Text
                    style={[styles.dialogDelete, (pending || !deletePassword) && styles.disabled]}
                  >
                    {t("Delete")}
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </Modal>
      ) : null}
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
      <NativeSwitch
        accessibilityHint={detail}
        accessibilityLabel={label}
        disabled={disabled}
        onValueChange={onChange}
        value={value}
      />
    </View>
  );
}

function createAccountStyles() {
  const tokens = mobileTokens();
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
      color: tokens.destructive,
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
    group: {
      borderRadius: 14,
      backgroundColor: native.fill,
      overflow: "hidden",
    },
    groupRow: {
      minHeight: 52,
      paddingHorizontal: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    groupDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.separator,
    },
    avatarSection: {
      borderRadius: 16,
      backgroundColor: native.fill,
      padding: 18,
      gap: 14,
    },
    avatarOptions: {
      flexDirection: "row",
      gap: 12,
    },
    avatarOption: {
      flex: 1,
      paddingVertical: 4,
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
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
    switchRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    switchLabel: {
      flex: 1,
      color: native.label,
      fontSize: 15,
    },
    settingsTrailing: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minWidth: 0,
    },
    settingsValue: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
    versionFooter: {
      marginTop: 4,
      alignItems: "center",
      gap: 2,
    },
    versionLine: {
      color: native.tertiaryLabel,
      fontSize: 12,
      textAlign: "center",
    },
    destructiveTitle: {
      color: tokens.destructive,
      fontSize: 17,
      fontWeight: "600",
    },
    error: {
      color: tokens.destructive,
      fontSize: 14,
      marginTop: 10,
    },
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
    pressed: {
      opacity: 0.7,
    },
  });
}
