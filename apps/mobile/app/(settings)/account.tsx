import { MenuView } from "@expo/ui/community/menu";
import type { AccountSecurity, UsageSummary } from "@rakazo/contracts";
import { accountDisplay, displayName } from "@rakazo/core";
import * as Notifications from "expo-notifications";
import type { Href } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
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
import { ApprovalModeRow, ApprovalRulesRow } from "../../components/approval-settings-rows";
import { NameDialog } from "../../components/name-dialog";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import {
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsSwitch,
  useStackedSettings,
} from "../../components/settings-group";
import { createAccountNameEditor } from "../../lib/account-name-editor";
import type { MobileMe } from "../../lib/api";
import {
  currentApiBase,
  deleteAccount,
  fetchAccountSecurity,
  loadSessionToken,
  passwordResetCapabilities,
  requestAccountDeletionCode,
  rpc,
  selectedSpaceId,
  signOut,
  updateAccountName,
} from "../../lib/api";
import { formatUpdateLabel, getAppVersionInfo } from "../../lib/app-version";
import {
  getCachedAppearancePreference,
  mobileTokens,
  setAppearancePreference,
} from "../../lib/appearance";
import { useApprovalSettings } from "../../lib/approval-settings";
import { archivedChatCounts, loadArchivedChats } from "../../lib/archived-chats";
import { replaceWithSignIn } from "../../lib/auth-routing";
import { promptAccountDeletion } from "../../lib/delete-account-prompt";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import type { LiveNotificationSettings } from "../../lib/live-notifications";
import {
  canPostPromotedNotifications,
  DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  getLiveNotificationSettings,
  hasLiveUpdateSettings,
  openLiveNotificationSettings,
  openPromotedNotificationSettings,
  setLiveNotificationSettings,
} from "../../lib/live-notifications";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import type { MobilePasskey } from "../../lib/passkey";
import {
  addPasskey,
  deletePasskey,
  listPasskeys,
  passkeysAvailable,
  renamePasskey,
} from "../../lib/passkey";
import { registerPushToken } from "../../lib/push";
import { createQueuedSave } from "../../lib/queued-save";
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
import { promptSectionName } from "../../lib/section-name-prompt";
import { isSettingsLink, openFromSettingsSheet } from "../../lib/settings-sheet";
import { ACCOUNT_SETTINGS } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { continueWithSso } from "../../lib/sso";
import {
  loadTrustedLinkSites,
  removeTrustedLinkSite,
  useTrustedLinkSites,
} from "../../lib/trusted-link-sites";
import { UI_LOCALE_LABELS } from "../../lib/ui-locale";
import { errorText } from "../../lib/user-error";

export default function Account() {
  const sideInsets = useSideInsets();
  const { t, locale } = useI18n();
  const router = useRouter();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const [me, setMe] = useState<MobileMe | null>(null);
  const account = accountDisplay(me ?? {}, t("Your account"));
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [namePending, setNamePending] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const currentName = account.label === me?.email ? "" : displayName(me?.name, "");

  const nameSaving = useRef(false);
  const nameSaveVersion = useRef(0);
  const { saveName, editName, closeNameDialog } = createAccountNameEditor({
    currentName,
    pending: nameSaving,
    saveVersion: nameSaveVersion,
    Platform,
    Alert,
    t,
    errorText,
    updateAccountName,
    refresh: () => rpc("me"),
    onSaved: (name) => setMe((current) => (current ? { ...current, name } : current)),
    onRefreshed: setMe,
    setNameDraft,
    setNamePending,
    setNameError,
    setNameDialogOpen,
  });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const canChangePassword = security?.hasPassword && security.passwordChangeEnabled !== false;
  const [deletionCodeSent, setDeletionCodeSent] = useState(false);
  const [ssoReauthenticated, setSsoReauthenticated] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [pending, setPending] = useState(false);
  const deletionDisabled =
    pending ||
    (security?.hasPassword
      ? !deletePassword
      : !ssoReauthenticated && (!deletionCodeSent || !deletePassword.trim()));
  const [notifications, setNotifications] = useState<LiveNotificationSettings>(
    DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  );
  const [notificationsReady, setNotificationsReady] = useState(Platform.OS !== "android");
  const notificationQueue = useRef<ReturnType<
    typeof createQueuedSave<LiveNotificationSettings>
  > | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<MobilePasskey[] | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyLoadError, setPasskeyLoadError] = useState<string | null>(null);
  // A failed load keeps the section, with Add and a retry, instead of hiding it.
  const loadPasskeys = useCallback(async () => {
    setPasskeyLoadError(null);
    try {
      setPasskeys(await listPasskeys());
    } catch (err) {
      setPasskeys((current) => current ?? []);
      setPasskeyLoadError(errorText(err, t("Could not continue")));
    }
  }, [t]);
  const colorScheme = useResolvedAppearance();
  const trustedSites = useTrustedLinkSites();
  const [archivedCount, setArchivedCount] = useState(0);
  // A list that fails to refresh keeps its last count, so a passing error doesn't hide the row.
  const archivedCounts = useRef({ bots: 0, groups: 0 });
  const [usage, setUsage] = useState<UsageSummary | null>(null);
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
  const approvals = useApprovalSettings(ACCOUNT_SETTINGS);
  const settingsLink = ({ title, href }: { title: string; href: Extract<Href, string> }) => (
    <SettingsRow
      key={href}
      accessibilityRole="button"
      chevron="right"
      disabled={pending}
      // Artifacts lives on the root stack, so it closes the sheet before opening.
      onPress={() =>
        isSettingsLink(href) ? router.push(href) : openFromSettingsSheet(router, href)
      }
      title={title}
    />
  );

  useEffect(() => {
    void rpc("me")
      .then(setMe)
      .catch(() => undefined);
    void rpc("usage/summary")
      .then(setUsage)
      .catch(() => undefined);
    if (Platform.OS === "android") {
      void getLiveNotificationSettings()
        .then(setNotifications)
        .catch(() => undefined)
        .finally(() => setNotificationsReady(true));
    }
  }, []);

  const count = new Intl.NumberFormat(dateLocaleForUi(locale));
  const usd = new Intl.NumberFormat(dateLocaleForUi(locale), {
    style: "currency",
    currency: "USD",
  });
  const tokens = (value: number | null | undefined) => (value == null ? "—" : count.format(value));
  const cost = (value: number | null | undefined) =>
    value == null
      ? undefined
      : value > 0 && value < 0.01
        ? `<${usd.format(0.01)}`
        : usd.format(value);
  const usageBlock = (
    <SettingsRow
      accessible
      title={t("Usage")}
      detail={
        usage
          ? t("{runs} runs, {tokens} tokens", {
              runs: count.format(usage.runs),
              tokens: tokens(usage.totalTokens),
            })
          : undefined
      }
      value={cost(usage?.costUsd)}
    />
  );
  const usageModels = usage?.models?.length ? (
    <SettingsGroup>
      {usage.models.map((row) => (
        <SettingsRow
          key={`${row.provider}:${row.model}`}
          accessible
          title={row.model}
          detail={`${row.provider}, ${t("{calls} calls, {tokens} tokens", {
            calls: count.format(row.modelCalls),
            tokens: tokens(row.totalTokens),
          })}`}
          value={cost(row.costUsd)}
        />
      ))}
    </SettingsGroup>
  ) : null;

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadArchivedChats().then((loaded) => {
        if (!active) return;
        archivedCounts.current = archivedChatCounts(archivedCounts.current, loaded);
        setArchivedCount(archivedCounts.current.bots + archivedCounts.current.groups);
      });
      return () => {
        active = false;
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      void loadTrustedLinkSites().catch(() => undefined);
    }, []),
  );

  // Granting notifications in system settings leaves this screen mounted, so the
  // row would keep saying blocked until the app comes back to the foreground.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      let active = true;
      const read = () => {
        void Notifications.getPermissionsAsync()
          .then((permission) => {
            if (active) setNotificationPermission(permission.status);
          })
          .catch(() => undefined);
      };
      read();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") read();
      });
      return () => {
        active = false;
        subscription.remove();
      };
    }, []),
  );

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

  function updateNotifications(next: LiveNotificationSettings) {
    notificationQueue.current ??= createQueuedSave(notifications, {
      onChange: setNotifications,
      equals: (a, b) =>
        a.liveConnection === b.liveConnection &&
        a.messages === b.messages &&
        a.scheduledTasks === b.scheduledTasks &&
        a.needsAttention === b.needsAttention,
      save: async (settings) => {
        await setLiveNotificationSettings(
          settings,
          currentApiBase(),
          await loadSessionToken(),
          selectedSpaceId() ?? "",
        );
      },
      onSaved: async (settings) => {
        if (settings.liveConnection && !(await canPostPromotedNotifications())) {
          await openPromotedNotificationSettings();
        }
        await registerPushToken();
      },
      onError: (cause) =>
        setNotificationError(errorText(cause, t("Could not update notifications"))),
    });
    setNotificationError(null);
    notificationQueue.current.update(next);
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
    void passwordResetCapabilities()
      .then(async (capabilities) => {
        if (await passkeysAvailable(capabilities)) await loadPasskeys();
      })
      .catch(() => undefined);
  }, [loadPasskeys]);

  async function passkeyAction(run: () => Promise<unknown>) {
    setPasskeyPending(true);
    setPasskeyError(null);
    try {
      await run();
      await loadPasskeys();
    } catch (err) {
      setPasskeyError(errorText(err, t("Could not continue")));
    } finally {
      setPasskeyPending(false);
    }
  }

  function passkeyMenuAction(passkey: MobilePasskey, name: string, action: string) {
    if (action === "rename") {
      promptSectionName({
        title: t("Rename"),
        cancelLabel: t("Cancel"),
        submitLabel: t("Save"),
        defaultValue: passkey.name ?? undefined,
        onSubmit: (next) => void passkeyAction(() => renamePasskey(passkey.id, next)),
      });
    } else if (action === "delete") {
      Alert.alert(t("Delete {name}?", { name }), undefined, [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: () => void passkeyAction(() => deletePasskey(passkey.id)),
        },
      ]);
    }
  }

  function removeTrustedSite(site: string) {
    void removeTrustedLinkSite(site).catch((cause: unknown) =>
      Alert.alert(t("Could not continue"), errorText(cause, t("Try again."))),
    );
  }

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
        style={sideInsets}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, stackOptions && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        {focus === "usage" ? (
          <>
            <SettingsGroup>{usageBlock}</SettingsGroup>
            {usageModels}
          </>
        ) : null}
        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t("Edit name")}
            accessibilityValue={{
              text:
                me?.email && account.label !== me.email
                  ? `${account.label}, ${me.email}`
                  : account.label,
            }}
            chevron="right"
            disabled={!me}
            detail={me?.email && account.label !== me.email ? me.email : undefined}
            prominent
            title={account.label}
            dimmed={namePending}
            onPress={editName}
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

        {passkeys ? (
          <SettingsGroup accessibilityLabel={t("Passkeys")} label={t("Passkeys")}>
            {passkeys.map((passkey) => {
              const name = passkey.name ?? t("Passkey");
              const created = passkey.createdAt ? new Date(passkey.createdAt) : null;
              return (
                <MenuView
                  key={passkey.id}
                  actions={[
                    // Alert.prompt, which renames, exists only on iOS.
                    ...(Platform.OS === "ios" ? [{ id: "rename", title: t("Rename") }] : []),
                    { id: "delete", title: t("Delete"), attributes: { destructive: true } },
                  ]}
                  colorScheme={colorScheme}
                  onPressAction={(event) =>
                    passkeyMenuAction(passkey, name, event.nativeEvent.event)
                  }
                  title={name}
                >
                  <SettingsRow
                    accessible
                    accessibilityRole="button"
                    detail={
                      created && !Number.isNaN(created.getTime())
                        ? created.toLocaleDateString(dateLocaleForUi(locale), {
                            dateStyle: "medium",
                          })
                        : undefined
                    }
                    dimmed={passkeyPending}
                    title={name}
                  />
                </MenuView>
              );
            })}
            <SettingsRow
              accessibilityRole="button"
              disabled={passkeyPending}
              dimmed={passkeyPending}
              onPress={() => void passkeyAction(addPasskey)}
              title={t("Add passkey")}
            />
            {passkeyLoadError ? (
              <>
                <Text accessibilityRole="alert" style={styles.error}>
                  {passkeyLoadError}
                </Text>
                <SettingsRow
                  accessibilityRole="button"
                  onPress={() => void loadPasskeys()}
                  title={t("Retry")}
                />
              </>
            ) : null}
            {passkeyError ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {passkeyError}
              </Text>
            ) : null}
          </SettingsGroup>
        ) : null}

        {trustedSites.length > 0 ? (
          <SettingsGroup accessibilityLabel={t("Trusted sites")} label={t("Trusted sites")}>
            {trustedSites.map((site) => (
              <MenuView
                key={site}
                actions={[{ id: "remove", title: t("Remove"), attributes: { destructive: true } }]}
                colorScheme={colorScheme}
                onPressAction={() => removeTrustedSite(site)}
                title={site}
              >
                <SettingsRow accessible accessibilityRole="button" title={site} />
              </MenuView>
            ))}
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

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t("Language")}
            accessibilityValue={{ text: UI_LOCALE_LABELS[locale] }}
            chevron="right"
            onPress={() => router.push("/language")}
            title={t("Language")}
            value={UI_LOCALE_LABELS[locale]}
          />
        </SettingsGroup>

        {Platform.OS === "android" ? (
          <SettingsGroup accessibilityLabel={t("Notifications")} label={t("Notifications")}>
            {notificationPermission === "denied" ? (
              <SettingsRow
                accessibilityRole="button"
                detail={t("Android blocked notifications.")}
                onPress={() => void openLiveNotificationSettings()}
                title={t("Notifications")}
              />
            ) : null}
            <SettingsSwitch
              label={t("Live working status")}
              value={notifications.liveConnection}
              disabled={!notificationsReady}
              onChange={(liveConnection) =>
                void updateNotifications({ ...notifications, liveConnection })
              }
            />
            <SettingsSwitch
              label={t("Agent messages")}
              detail={t("Replies and completed work")}
              value={notifications.messages}
              disabled={!notificationsReady}
              onChange={(messages) => void updateNotifications({ ...notifications, messages })}
            />
            <SettingsSwitch
              label={t("Scheduled tasks")}
              value={notifications.scheduledTasks}
              disabled={!notificationsReady}
              onChange={(scheduledTasks) =>
                void updateNotifications({ ...notifications, scheduledTasks })
              }
            />
            <SettingsSwitch
              label={t("Needs attention")}
              detail={t("Questions, approvals, takeover")}
              value={notifications.needsAttention}
              disabled={!notificationsReady}
              onChange={(needsAttention) =>
                void updateNotifications({ ...notifications, needsAttention })
              }
            />
            {hasLiveUpdateSettings() ? (
              <SettingsRow
                accessibilityRole="button"
                onPress={() => void openPromotedNotificationSettings()}
                title={t("Live update settings")}
              />
            ) : null}
            <SettingsRow
              accessibilityRole="button"
              onPress={() => void openLiveNotificationSettings()}
              title={t("Notification settings")}
            />
            {notificationError ? <Text style={styles.error}>{notificationError}</Text> : null}
          </SettingsGroup>
        ) : null}

        <SettingsGroup>
          {me?.billingEnabled ? (
            <SettingsRow
              title={t("Billing")}
              chevron="right"
              onPress={() => router.push("/billing")}
            />
          ) : null}
          {(
            [
              { title: t("Artifacts"), href: "/artifacts" },
              { title: t("Models"), href: "/models" },
              { title: t("Voice"), href: "/voice" },
            ] as const
          ).map(settingsLink)}
          <ApprovalModeRow key="approvals" approvals={approvals} disabled={pending} />
          {approvals.ruleCount ? (
            <ApprovalRulesRow
              key="approval-rules"
              count={approvals.ruleCount}
              disabled={pending}
              onPress={() => router.push("/approvals")}
            />
          ) : null}
          {(
            [
              { title: t("Vault"), href: "/vault" },
              ...(me?.paymentWalletProvider
                ? [{ title: t("Wallet"), href: "/wallet" } as const]
                : []),
              { title: t("Integrations"), href: "/integrations" },
              { title: t("Skills"), href: "/skills" },
              { title: t("Messaging"), href: "/messaging" },
              { title: t("AI data sharing"), href: "/ai-data-sharing" },
            ] as const
          ).map(settingsLink)}
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

        {archivedCount > 0 ? (
          <SettingsGroup>
            <SettingsRow
              accessibilityRole="button"
              chevron="right"
              onPress={() => router.push("/archived-bots")}
              title={t("Archived")}
              value={String(archivedCount)}
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
      {nameDialogOpen ? (
        <NameDialog
          draft={nameDraft}
          error={nameError}
          saving={namePending}
          onChange={(value) => {
            setNameDraft(value);
            setNameError(null);
          }}
          onSave={(value) => void saveName(value)}
          onClose={closeNameDialog}
        />
      ) : null}
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
  });
}
