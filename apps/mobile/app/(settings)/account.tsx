import type { AccountSecurity, AvatarStyle } from "@rakazo/contracts";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
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
import { AppMark } from "../../components/app-mark";
import { useAvatarStyle } from "../../components/avatar-style";
import { BotAvatar } from "../../components/bot-avatar";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { NativeSymbol } from "../../components/native-symbol";
import {
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsSwitch,
  useStackedSettings,
} from "../../components/settings-group";
import type { MobileBot, MobileMe } from "../../lib/api";
import {
  currentApiBase,
  deleteAccount,
  fetchAccountSecurity,
  loadSessionToken,
  requestAccountDeletionCode,
  rpc,
  selectedSpaceId,
  signOut,
} from "../../lib/api";
import { formatUpdateLabel, getAppVersionInfo } from "../../lib/app-version";
import {
  getCachedAppearancePreference,
  mobileTokens,
  setAppearancePreference,
} from "../../lib/appearance";
import { replaceWithSignIn } from "../../lib/auth-routing";
import { promptAccountDeletion } from "../../lib/delete-account-prompt";
import { setUiLocale, useI18n } from "../../lib/i18n";
import type { LiveNotificationSettings } from "../../lib/live-notifications";
import {
  canPostPromotedNotifications,
  DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  getLiveNotificationSettings,
  openLiveNotificationSettings,
  openPromotedNotificationSettings,
  setLiveNotificationSettings,
} from "../../lib/live-notifications";
import { presentMessageActionSheet } from "../../lib/message-action-sheet";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { registerPushToken } from "../../lib/push";
import {
  getCachedRemoteImagesEnabled,
  setRemoteImagesPreference,
  subscribeRemoteImages,
} from "../../lib/remote-images-preference";
import {
  getCachedResponseStreamingEnabled,
  setResponseStreamingPreference,
  subscribeResponseStreaming,
} from "../../lib/response-streaming";
import { continueWithSso } from "../../lib/sso";
import type { AccountUiLocale } from "../../lib/ui-locale";
import { ACCOUNT_UI_LOCALES, UI_LOCALE_LABELS } from "../../lib/ui-locale";
import { errorText } from "../../lib/user-error";

/** Render account settings, including the entry point for voice configuration. */
export default function Account() {
  const { t, locale } = useI18n();
  const colorScheme = useResolvedAppearance();
  const router = useRouter();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const [me, setMe] = useState<MobileMe | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const canChangePassword = security?.hasPassword && security.passwordChangeEnabled !== false;
  const [deletionCodeSent, setDeletionCodeSent] = useState(false);
  const [ssoReauthenticated, setSsoReauthenticated] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [localeSaving, setLocaleSaving] = useState(false);
  const [localeError, setLocaleError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const deletionDisabled =
    pending ||
    (security?.hasPassword
      ? !deletePassword
      : !ssoReauthenticated && (!deletionCodeSent || !deletePassword.trim()));
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
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens?: number | null;
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
  const stackOptions = useStackedSettings();
  const styles = useThemedStyles(createAccountStyles);
  const versionInfo = getAppVersionInfo();
  const updateLabel = formatUpdateLabel(versionInfo.update, t);
  const versionAccessibility = [versionInfo.nativeLabel, updateLabel].filter(Boolean).join(". ");

  useEffect(() => {
    void rpc<MobileMe>("me")
      .then(setMe)
      .catch(() => undefined);
    void rpc<{
      runs: number;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens?: number | null;
    }>("usage/summary")
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
    <SettingsRow
      accessible
      title={t("Usage")}
      detail={
        usage
          ? t("{runs} runs · {tokens} tokens", {
              runs: usage.runs,
              tokens: usage.totalTokens ?? "—",
            })
          : undefined
      }
    />
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void rpc<MobileBot[]>("bots/listArchived")
        .then((bots) => {
          if (active) setArchivedBots(bots);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, []),
  );

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
      replaceWithSignIn();
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

  async function securityAction(run: () => Promise<void>) {
    setPending(true);
    setDeleteError(null);
    try {
      await run();
    } catch (err) {
      setDeleteError(errorText(err, t("Could not continue")));
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    void fetchAccountSecurity()
      .then(setSecurity)
      .catch(() => undefined);
  }, []);

  function closeDeletePrompt() {
    if (pending) return;
    setDeleteOpen(false);
    setDeletePassword("");
  }

  async function requestDeletion() {
    if (pending) return;
    setDeleteError(null);
    try {
      const value = await fetchAccountSecurity();
      setSecurity(value);
      if (!value.hasPassword) {
        setDeletePassword("");
        setDeletionCodeSent(false);
        setSsoReauthenticated(value.freshOidcAuth);
        setDeleteOpen(true);
        return;
      }
    } catch (err) {
      setDeleteError(errorText(err, t("Could not continue")));
      return;
    }

    const prompted = promptAccountDeletion({
      title: t("Delete your account?"),
      message: t(
        "This permanently deletes your account, bots, conversations, memories, files, and saved connections. This cannot be undone.",
      ),
      cancelLabel: t("Cancel"),
      deleteLabel: t("Delete"),
      onSubmit: (password) => void handleDeletion(password, true),
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

  async function handleDeletion(password: string, hasPassword = security?.hasPassword === true) {
    if ((!password && !ssoReauthenticated) || pending) return;
    setPending(true);
    setDeleteError(null);
    try {
      if (hasPassword) await deleteAccount(password);
      else {
        const current = await fetchAccountSecurity();
        setSecurity(current);
        setSsoReauthenticated(current.freshOidcAuth);
        const token = deletionCodeSent ? password.trim() : undefined;
        if (current.hasPassword || (!current.freshOidcAuth && !token)) return;
        await deleteAccount(undefined, token);
      }
      setDeleteOpen(false);
      replaceWithSignIn("/sign-in");
    } catch (err) {
      setDeleteError(errorText(err, t("Could not delete account")));
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, stackOptions && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        {focus === "usage" ? <SettingsGroup>{usageBlock}</SettingsGroup> : null}
        <SettingsGroup>
          <SettingsRow
            accessible
            detail={me?.email || undefined}
            prominent
            title={me?.name || t("Your account")}
          />
          {focus !== "usage" ? usageBlock : null}
        </SettingsGroup>

        {(security?.sso && !security.ssoLinked) || canChangePassword ? (
          <SettingsGroup>
            {security?.sso && !security.ssoLinked ? (
              <SettingsRow
                accessibilityRole="button"
                chevron="right"
                disabled={pending}
                dimmed={pending}
                title={t("Link SSO")}
                onPress={() =>
                  void securityAction(async () => {
                    if (await continueWithSso("link")) setSecurity(await fetchAccountSecurity());
                  })
                }
              />
            ) : null}
            {canChangePassword ? (
              <SettingsRow
                accessibilityRole="button"
                chevron="right"
                onPress={() => router.push("/change-password")}
                title={t("Change password")}
              />
            ) : null}
          </SettingsGroup>
        ) : null}

        <View accessibilityLabel={t("Appearance")} style={styles.section}>
          <SettingsLabel>{t("Appearance")}</SettingsLabel>
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

        <View accessibilityLabel={t("Avatar style")} style={styles.section}>
          <SettingsLabel>{t("Avatars")}</SettingsLabel>
          <View style={[styles.options, stackOptions && styles.optionsStacked]}>
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
                  style={({ pressed }) => [
                    styles.option,
                    styles.avatarOption,
                    !stackOptions && styles.optionSideBySide,
                    pressed && styles.pressed,
                  ]}
                >
                  <BotAvatar
                    color={style === "robot" ? "#8B5CF6" : "#D62F8B"}
                    identity="avatar-preview"
                    size={42}
                    variant={style}
                  />
                  <Text style={styles.optionLabel}>{styleLabel}</Text>
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
          <SettingsGroup>
            {avatarError ? <Text style={styles.error}>{avatarError}</Text> : null}
          </SettingsGroup>
        </View>

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t("Language")}
            accessibilityValue={{ text: UI_LOCALE_LABELS[locale] }}
            accessibilityState={{ disabled: localeSaving }}
            chevron="right"
            dimmed={localeSaving}
            disabled={localeSaving}
            onPress={openLanguagePicker}
            title={t("Language")}
            value={UI_LOCALE_LABELS[locale]}
          />
          {localeError ? <Text style={styles.error}>{localeError}</Text> : null}
        </SettingsGroup>

        {Platform.OS === "android" ? (
          <SettingsGroup accessibilityLabel={t("Notifications")} label={t("Notifications")}>
            <SettingsSwitch
              label={t("Live working status")}
              detail={t("While agents are working")}
              value={notifications.liveConnection}
              disabled={notificationPending || !notificationsReady}
              onChange={(liveConnection) =>
                void updateNotifications({ ...notifications, liveConnection })
              }
            />
            <SettingsSwitch
              label={t("Agent messages")}
              detail={t("Replies and completed work")}
              value={notifications.messages}
              disabled={notificationPending || !notificationsReady}
              onChange={(messages) => void updateNotifications({ ...notifications, messages })}
            />
            <SettingsSwitch
              label={t("Scheduled tasks")}
              detail={t("Alerts from routines")}
              value={notifications.scheduledTasks}
              disabled={notificationPending || !notificationsReady}
              onChange={(scheduledTasks) =>
                void updateNotifications({ ...notifications, scheduledTasks })
              }
            />
            <SettingsSwitch
              label={t("Needs attention")}
              detail={t("Questions, approvals, takeover")}
              value={notifications.needsAttention}
              disabled={notificationPending || !notificationsReady}
              onChange={(needsAttention) =>
                void updateNotifications({ ...notifications, needsAttention })
              }
            />
            <SettingsRow
              accessibilityRole="button"
              onPress={() => void openPromotedNotificationSettings()}
              title={t("Live update settings")}
            />
            <SettingsRow
              accessibilityRole="button"
              onPress={() => void openLiveNotificationSettings()}
              title={t("Notification settings")}
            />
            {notificationError ? <Text style={styles.error}>{notificationError}</Text> : null}
          </SettingsGroup>
        ) : null}

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            chevron="right"
            disabled={pending}
            onPress={() => router.push("/models")}
            title={t("Models")}
          />
          <SettingsRow
            accessibilityRole="button"
            chevron="right"
            disabled={pending}
            onPress={() => router.push("/voice")}
            title={t("Voice")}
          />
          <SettingsRow
            accessibilityRole="button"
            chevron="right"
            disabled={pending}
            onPress={() => router.push("/integrations")}
            title={t("Integrations")}
          />
          <SettingsRow
            accessibilityRole="button"
            chevron="right"
            disabled={pending}
            onPress={() => router.push("/ai-data-sharing")}
            title={t("AI data sharing")}
          />
          {me?.isDeploymentOwner ? (
            <SettingsRow
              accessibilityRole="button"
              chevron="right"
              onPress={() => router.push("/integration-setup")}
              title={t("Server integrations")}
            />
          ) : null}
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t("Advanced")}
            accessibilityState={{ expanded: advancedOpen }}
            chevron={advancedOpen ? "down" : "right"}
            onPress={() => setAdvancedOpen((open) => !open)}
            title={t("Advanced")}
          />
          {advancedOpen ? (
            <SettingsSwitch
              label={t("Stream replies")}
              value={streamReplies}
              onChange={(checked) => void setResponseStreamingPreference(checked ? "on" : "off")}
            />
          ) : null}
          {advancedOpen ? (
            <SettingsSwitch
              label={loadRemoteImagesLabel}
              value={loadRemoteImages}
              onChange={(checked) => void setRemoteImagesPreference(checked ? "on" : "off")}
            />
          ) : null}
        </SettingsGroup>

        <View style={styles.section}>
          <NativeActionButton
            disabled={pending}
            fill
            label={t("Sign out")}
            onPress={() => void handleSignOut()}
            prominence="secondary"
          />
          <SettingsGroup>
            {signOutError ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {signOutError}
              </Text>
            ) : null}
          </SettingsGroup>
        </View>

        {archivedBots.length > 0 ? (
          <SettingsGroup>
            <SettingsRow
              accessibilityRole="button"
              chevron="right"
              onPress={() => router.push("/archived-bots")}
              title={t("Archived bots")}
              value={String(archivedBots.length)}
            />
          </SettingsGroup>
        ) : null}

        <View style={styles.about}>
          <AppMark />
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
        </View>

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            destructive
            dimmed={pending}
            disabled={pending}
            onPress={requestDeletion}
            title={t("Delete account")}
            trailing={
              pending ? <ActivityIndicator color={mobileTokens().destructive} /> : undefined
            }
          />
          {!deleteOpen && deleteError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {deleteError}
            </Text>
          ) : null}
        </SettingsGroup>
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
              {!security?.hasPassword ? (
                <>
                  {security?.sso ? (
                    <NativeActionButton
                      label={t("Sign in again")}
                      disabled={pending}
                      onPress={() =>
                        void securityAction(async () => {
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
                        void securityAction(async () => {
                          await requestAccountDeletionCode();
                          setDeletionCodeSent(true);
                        })
                      }
                    />
                  ) : null}
                </>
              ) : null}
              {security?.hasPassword || deletionCodeSent ? (
                <TextInput
                  accessibilityLabel={
                    security?.hasPassword ? t("Current password") : t("Deletion code")
                  }
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  editable={!pending}
                  onChangeText={(value) => {
                    setDeletePassword(value);
                    setDeleteError(null);
                  }}
                  placeholder={security?.hasPassword ? t("Current password") : t("Deletion code")}
                  placeholderTextColor={native.tertiaryLabel}
                  secureTextEntry={security?.hasPassword}
                  style={styles.dialogInput}
                  textContentType={security?.hasPassword ? "password" : "oneTimeCode"}
                  value={deletePassword}
                />
              ) : null}
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
                  disabled={deletionDisabled}
                  onPress={() => void handleDeletion(deletePassword)}
                  style={styles.dialogAction}
                >
                  <Text style={[styles.dialogDelete, deletionDisabled && styles.disabled]}>
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

function createAccountStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.groupedPage,
    },
    content: {
      flexGrow: 1,
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 32,
      gap: 28,
    },
    compactContent: {
      paddingHorizontal: 8,
    },
    section: {
      gap: 7,
    },
    options: {
      flexDirection: "row",
      gap: 8,
    },
    optionsStacked: {
      flexDirection: "column",
    },
    option: {
      minHeight: 48,
      borderRadius: 14,
      borderCurve: "continuous",
      borderWidth: 2,
      borderColor: "transparent",
      backgroundColor: native.groupedCell,
      paddingHorizontal: 12,
      paddingVertical: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    optionSideBySide: {
      flex: 1,
    },
    avatarOption: {
      minHeight: 96,
      gap: 8,
    },
    optionLabel: {
      color: native.label,
      fontSize: 15,
      fontWeight: "600",
      textAlign: "center",
    },
    about: {
      alignItems: "center",
      gap: 16,
      paddingTop: 8,
      paddingBottom: 22,
    },
    versionFooter: {
      alignItems: "center",
    },
    versionLine: {
      color: native.secondaryLabel,
      fontSize: 13,
      textAlign: "center",
    },
    error: {
      color: tokens.destructive,
      fontSize: 15,
      paddingHorizontal: 16,
      paddingVertical: 10,
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
      backgroundColor: native.fillPressed,
    },
  });
}
