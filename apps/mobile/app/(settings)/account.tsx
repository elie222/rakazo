import { MenuView } from "@expo/ui/community/menu";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { AccountSecurity, QuietHours, UsageSummary } from "@rakazo/contracts";
import {
  APP_LOCALE_LABELS,
  accountDisplay,
  DEFAULT_QUIET_HOURS,
  displayName,
  localizedClock,
} from "@rakazo/core";
import * as Notifications from "expo-notifications";
import type { Href } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAccountDeletion } from "../../components/account-deletion";
import { AppMark } from "../../components/app-mark";
import { ApprovalModeRow, ApprovalRulesRow } from "../../components/approval-settings-rows";
import { MenuPicker } from "../../components/menu-picker";
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
import { SpendingLimitRow, useSpendingStatus } from "../../components/spending-limit-row";
import { createAccountNameEditor } from "../../lib/account-name-editor";
import { currentApiBase, rpc, selectedSpaceId } from "../../lib/api";
import {
  fetchAccountSecurity,
  passwordResetCapabilities,
  signOut,
  updateAccountName,
} from "../../lib/api-auth";
import { formatUpdateLabel, getAppVersionInfo } from "../../lib/app-version";
import {
  getCachedAppearancePreference,
  mobileTokens,
  setAppearancePreference,
} from "../../lib/appearance";
import { useApprovalSettings } from "../../lib/approval-settings";
import { archivedChatCounts, loadArchivedChats } from "../../lib/archived-chats";
import { replaceWithSignIn } from "../../lib/auth-routing";
import { endCallBeforeSessionEnd } from "../../lib/call-session";
import {
  getHapticsEnabled,
  loadHapticsPreference,
  setHapticsEnabled,
  subscribeHaptics,
} from "../../lib/haptics";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n";
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
import type { MobileMe } from "../../lib/mobile-types";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { activeOrganization, useOrganizations } from "../../lib/organizations";
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
import { deviceTimeZone } from "../../lib/routine";
import { promptSectionName } from "../../lib/section-name-prompt";
import { loadSessionToken } from "../../lib/session";
import { isSettingsLink, openFromSettingsSheet } from "../../lib/settings-sheet";
import { ACCOUNT_SETTINGS } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { continueWithSso } from "../../lib/sso";
import { openStoreListing, useStoreUpdateAvailable } from "../../lib/store-update";
import {
  loadTrustedLinkSites,
  removeTrustedLinkSite,
  useTrustedLinkSites,
} from "../../lib/trusted-link-sites";
import { confirmUnsentSendLoss } from "../../lib/unsent-send-warning";
import { errorText } from "../../lib/user-error";

let hapticsSaveVersion = 0;

export default function Account() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const locale = useUiLocale();
  const router = useRouter();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const [me, setMe] = useState<MobileMe | null>(null);
  const botStyleRequest = useRef(0);
  const account = accountDisplay(me ?? {}, t`Your account`);
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

  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const canChangePassword = security?.hasPassword && security.passwordChangeEnabled !== false;
  const deletion = useAccountDeletion({ onSecurity: setSecurity });
  const { run: securityAction } = deletion;
  const [signingOut, setSigningOut] = useState(false);
  // Held from the tap, so a second tap while the unsent-message check runs starts nothing.
  const signOutStarted = useRef(false);
  const pending = deletion.pending || signingOut;
  const [notifications, setNotifications] = useState<LiveNotificationSettings>(
    DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  );
  const [notificationsReady, setNotificationsReady] = useState(Platform.OS !== "android");
  const notificationQueue = useRef<ReturnType<
    typeof createQueuedSave<LiveNotificationSettings>
  > | null>(null);
  const quietHoursQueue = useRef<ReturnType<typeof createQueuedSave<QuietHours | null>> | null>(
    null,
  );
  const [notificationPermission, setNotificationPermission] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
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
      setPasskeyLoadError(errorText(err, t`Could not continue`));
    }
  }, [t]);
  const colorScheme = useResolvedAppearance();
  const trustedSites = useTrustedLinkSites();
  const [archivedCount, setArchivedCount] = useState(0);
  // A list that fails to refresh keeps its last count, so a passing error doesn't hide the row.
  const archivedCounts = useRef({ bots: 0, groups: 0 });
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  // Messaging appears only on servers that have a chat app connected, as on web.
  const [messagingEnabled, setMessagingEnabled] = useState(false);
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
  const hapticsEnabled = useSyncExternalStore(
    subscribeHaptics,
    getHapticsEnabled,
    getHapticsEnabled,
  );
  function updateHaptics(value: boolean) {
    const version = ++hapticsSaveVersion;
    const isCurrent = () => version === hapticsSaveVersion && getHapticsEnabled() === value;
    void setHapticsEnabled(value).catch(() => {
      if (!isCurrent()) return;
      Alert.alert(t`Haptics`, t`Could not save`, [
        { text: t`Cancel`, style: "cancel" },
        {
          text: t`Retry`,
          onPress: () => {
            if (isCurrent()) updateHaptics(value);
          },
        },
      ]);
    });
  }

  const loadRemoteImagesLabel = t`Load web images automatically`;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const stackOptions = useStackedSettings();
  const styles = useThemedStyles(createAccountStyles);
  const versionInfo = getAppVersionInfo();
  const updateLabel = formatUpdateLabel(versionInfo.update);
  const versionAccessibility = [versionInfo.nativeLabel, updateLabel].filter(Boolean).join(". ");
  const storeUpdateAvailable = useStoreUpdateAvailable();
  const approvals = useApprovalSettings(ACCOUNT_SETTINGS);
  const spending = useSpendingStatus();
  const organizations = useOrganizations().data;
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
      title={t`Usage`}
      detail={
        usage
          ? t`${ph({ runs: count.format(usage.runs) })} runs, ${ph({ tokens: tokens(usage.totalTokens) })} tokens`
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
          detail={`${row.provider}, ${t`${ph({ calls: count.format(row.modelCalls) })} calls, ${ph({ tokens: tokens(row.totalTokens) })} tokens`}`}
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
      void loadHapticsPreference();
      void loadTrustedLinkSites().catch(() => undefined);
    }, []),
  );

  // Checked on every visit, so a failed check never hides Messaging for good.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void rpc("messaging/status")
        .then((status) => {
          if (active) setMessagingEnabled(status.enabled);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
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
    if (signOutStarted.current) return;
    signOutStarted.current = true;
    if (!(await confirmUnsentSendLoss("sign-out"))) {
      signOutStarted.current = false;
      return;
    }
    setSigningOut(true);
    setSignOutError(null);
    try {
      // Hang up while the session still exists, so the server records the call's end.
      await endCallBeforeSessionEnd();
      await signOut();
      replaceWithSignIn();
    } catch (err) {
      setSignOutError(errorText(err, t`Could not sign out`));
      setSigningOut(false);
      signOutStarted.current = false;
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
      onError: (cause) => setNotificationError(errorText(cause, t`Could not update notifications`)),
    });
    setNotificationError(null);
    notificationQueue.current.update(next);
  }

  function updateQuietHours(next: QuietHours | null) {
    if (!me || me.quietHours === undefined) return;
    const savedTimezone = me.timezone;
    quietHoursQueue.current ??= createQueuedSave(me.quietHours, {
      onChange: (quietHours) =>
        setMe((current) => (current ? { ...current, quietHours } : current)),
      equals: (a, b) => a?.start === b?.start && a?.end === b?.end,
      save: async (quietHours) => {
        // The hours are read in the account's timezone; an account without one takes this
        // device's first.
        const timezone = deviceTimeZone();
        if (!savedTimezone && timezone) await rpc("preferences/adoptTimezone", { timezone });
        await rpc("preferences/update", { quietHours });
      },
      onError: () => Alert.alert(t`Couldn't update quiet hours`),
    });
    quietHoursQueue.current.update(next);
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
      setPasskeyError(errorText(err, t`Could not continue`));
    } finally {
      setPasskeyPending(false);
    }
  }

  function passkeyMenuAction(passkey: MobilePasskey, name: string, action: string) {
    if (action === "rename") {
      promptSectionName({
        title: t`Rename`,
        cancelLabel: t`Cancel`,
        submitLabel: t`Save`,
        defaultValue: passkey.name ?? undefined,
        onSubmit: (next) => void passkeyAction(() => renamePasskey(passkey.id, next)),
      });
    } else if (action === "delete") {
      Alert.alert(t`Delete ${name}?`, undefined, [
        { text: t`Cancel`, style: "cancel" },
        {
          text: t`Delete`,
          style: "destructive",
          onPress: () => void passkeyAction(() => deletePasskey(passkey.id)),
        },
      ]);
    }
  }

  function removeTrustedSite(site: string) {
    void removeTrustedLinkSite(site).catch((cause: unknown) =>
      Alert.alert(t`Could not continue`, errorText(cause, t`Try again.`)),
    );
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
            accessibilityLabel={t`Edit name`}
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

        {organizations ? (
          <SettingsGroup>
            <SettingsRow
              key="organization"
              accessibilityRole="button"
              chevron="right"
              onPress={() => router.push("/organization")}
              title={t`Organization`}
              value={activeOrganization(organizations)?.name}
            />
          </SettingsGroup>
        ) : null}

        {(security?.sso && !security.ssoLinked) || canChangePassword ? (
          <SettingsGroup>
            {security?.sso && !security.ssoLinked ? (
              <SettingsRow
                accessibilityRole="button"
                chevron="right"
                disabled={pending}
                dimmed={pending}
                title={t`Link SSO`}
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
                title={t`Change password`}
              />
            ) : null}
          </SettingsGroup>
        ) : null}

        {passkeys ? (
          <SettingsGroup accessibilityLabel={t`Passkeys`} label={t`Passkeys`}>
            {passkeys.map((passkey) => {
              const name = passkey.name ?? t`Passkey`;
              const created = passkey.createdAt ? new Date(passkey.createdAt) : null;
              return (
                <MenuView
                  key={passkey.id}
                  actions={[
                    // Alert.prompt, which renames, exists only on iOS.
                    ...(Platform.OS === "ios" ? [{ id: "rename", title: t`Rename` }] : []),
                    { id: "delete", title: t`Delete`, attributes: { destructive: true } },
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
              title={t`Add passkey`}
            />
            {passkeyLoadError ? (
              <>
                <Text accessibilityRole="alert" style={styles.error}>
                  {passkeyLoadError}
                </Text>
                <SettingsRow
                  accessibilityRole="button"
                  onPress={() => void loadPasskeys()}
                  title={t`Retry`}
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
          <SettingsGroup accessibilityLabel={t`Trusted sites`} label={t`Trusted sites`}>
            {trustedSites.map((site) => (
              <MenuView
                key={site}
                actions={[{ id: "remove", title: t`Remove`, attributes: { destructive: true } }]}
                colorScheme={colorScheme}
                onPressAction={() => removeTrustedSite(site)}
                title={site}
              >
                <SettingsRow accessible accessibilityRole="button" title={site} />
              </MenuView>
            ))}
          </SettingsGroup>
        ) : null}

        <View accessibilityLabel={t`Appearance`} style={styles.section}>
          <SettingsLabel>{t`Appearance`}</SettingsLabel>
          <NativeSegmentedControl
            accessibilityLabel={t`Appearance`}
            onChange={(value) => void setAppearancePreference(value)}
            options={[
              { value: "system", label: t`System` },
              { value: "light", label: t`Light` },
              { value: "dark", label: t`Dark` },
            ]}
            value={appearance}
          />
        </View>

        {me?.botAvatarSet ? (
          <View accessibilityLabel={t`Bot style`} style={styles.section}>
            <SettingsLabel>{t`Bot style`}</SettingsLabel>
            <NativeSegmentedControl
              accessibilityLabel={t`Bot style`}
              onChange={(botAvatarSet) => {
                const previous = me.botAvatarSet;
                // Only the latest tap's reply may land, so a slower earlier save can't undo it.
                const request = ++botStyleRequest.current;
                setMe((current) => (current ? { ...current, botAvatarSet } : current));
                rpc("preferences/update", { botAvatarSet })
                  .then((next) => {
                    // Take only the style, so an older snapshot can't undo another edit.
                    if (request !== botStyleRequest.current) return;
                    setMe((current) =>
                      current ? { ...current, botAvatarSet: next.botAvatarSet } : next,
                    );
                  })
                  .catch(() => {
                    if (request !== botStyleRequest.current) return;
                    setMe((current) =>
                      current ? { ...current, botAvatarSet: previous } : current,
                    );
                    Alert.alert(t`Couldn't update bot style`);
                  });
              }}
              options={[
                { value: "organic", label: t`Original` },
                { value: "rakazo", label: t`Rakazo` },
              ]}
              value={me.botAvatarSet}
            />
          </View>
        ) : null}

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t`Language`}
            accessibilityValue={{ text: APP_LOCALE_LABELS[locale] }}
            chevron="right"
            onPress={() => router.push("/language")}
            title={t`Language`}
            value={APP_LOCALE_LABELS[locale]}
          />
          <SettingsSwitch label={t`Haptics`} value={hapticsEnabled} onChange={updateHaptics} />
        </SettingsGroup>

        {Platform.OS === "android" ? (
          <SettingsGroup accessibilityLabel={t`Notifications`} label={t`Notifications`}>
            {notificationPermission === "denied" ? (
              <SettingsRow
                accessibilityRole="button"
                detail={t`Android blocked notifications.`}
                onPress={() => void openLiveNotificationSettings()}
                title={t`Notifications`}
              />
            ) : null}
            <SettingsSwitch
              label={t`Live working status`}
              value={notifications.liveConnection}
              disabled={!notificationsReady}
              onChange={(liveConnection) =>
                void updateNotifications({ ...notifications, liveConnection })
              }
            />
            <SettingsSwitch
              label={t`Agent messages`}
              detail={t`Replies and completed work`}
              value={notifications.messages}
              disabled={!notificationsReady}
              onChange={(messages) => void updateNotifications({ ...notifications, messages })}
            />
            <SettingsSwitch
              label={t`Scheduled tasks`}
              value={notifications.scheduledTasks}
              disabled={!notificationsReady}
              onChange={(scheduledTasks) =>
                void updateNotifications({ ...notifications, scheduledTasks })
              }
            />
            <SettingsSwitch
              label={t`Needs attention`}
              detail={t`Questions, approvals, takeover`}
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
                title={t`Live update settings`}
              />
            ) : null}
            <SettingsRow
              accessibilityRole="button"
              onPress={() => void openLiveNotificationSettings()}
              title={t`Notification settings`}
            />
            {notificationError ? <Text style={styles.error}>{notificationError}</Text> : null}
          </SettingsGroup>
        ) : null}

        {me && me.quietHours !== undefined ? (
          <SettingsGroup>
            <SettingsSwitch
              label={t`Quiet hours`}
              detail={me.quietHours ? t`Only what needs you comes through.` : undefined}
              value={me.quietHours !== null}
              onChange={(on) => updateQuietHours(on ? DEFAULT_QUIET_HOURS : null)}
            />
            {me.quietHours ? (
              <>
                <QuietHourPicker
                  label={t`Starts`}
                  value={me.quietHours.start}
                  other={me.quietHours.end}
                  locale={locale}
                  onChange={(start) =>
                    me.quietHours && updateQuietHours({ ...me.quietHours, start })
                  }
                />
                <QuietHourPicker
                  label={t`Ends`}
                  value={me.quietHours.end}
                  other={me.quietHours.start}
                  locale={locale}
                  onChange={(end) => me.quietHours && updateQuietHours({ ...me.quietHours, end })}
                />
              </>
            ) : null}
          </SettingsGroup>
        ) : null}

        <SettingsGroup>
          {me?.billingEnabled ? (
            <SettingsRow
              title={t`Billing`}
              chevron="right"
              onPress={() => router.push("/billing")}
            />
          ) : null}
          {me ? (
            <SettingsRow
              accessibilityRole="button"
              chevron="right"
              disabled={pending}
              // The space header holds Members too, but a single space has no header.
              onPress={() =>
                openFromSettingsSheet(router, {
                  pathname: "/space-members",
                  params: { spaceId: selectedSpaceId() ?? me.spaceId },
                })
              }
              title={t`Members`}
            />
          ) : null}
          {(
            [
              ...(me?.ticketBoardEnabled ? [{ title: t`Board`, href: "/board" } as const] : []),
              { title: t`Artifacts`, href: "/artifacts" },
              { title: t`Models`, href: "/models" },
              { title: t`Voice`, href: "/voice" },
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
          {spending?.shown ? (
            <SpendingLimitRow key="spending-limit" status={spending} disabled={pending} />
          ) : null}
          {(
            [
              { title: t`Vault`, href: "/vault" },
              ...(me?.paymentWalletProvider
                ? [{ title: t`Wallet`, href: "/wallet" } as const]
                : []),
              { title: t`Integrations`, href: "/integrations" },
              { title: t`Skills`, href: "/skills" },
              { title: t`Memory`, href: "/memory" },
              ...(messagingEnabled ? [{ title: t`Messaging`, href: "/messaging" } as const] : []),
              { title: t`AI data sharing`, href: "/ai-data-sharing" },
            ] as const
          ).map(settingsLink)}
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t`Advanced`}
            accessibilityState={{ expanded: advancedOpen }}
            chevron={advancedOpen ? "down" : "right"}
            onPress={() => setAdvancedOpen((open) => !open)}
            title={t`Advanced`}
          />
          {advancedOpen ? (
            <SettingsSwitch
              label={t`Stream replies`}
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
            label={t`Sign out`}
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
              title={t`Archived`}
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
          {storeUpdateAvailable ? (
            <NativeActionButton
              label={t`Update`}
              onPress={openStoreListing}
              prominence="secondary"
              size="compact"
              style={styles.updateButton}
            />
          ) : null}
        </View>

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            destructive
            dimmed={pending}
            disabled={pending}
            onPress={() => void deletion.request()}
            title={t`Delete account`}
            trailing={
              pending ? <ActivityIndicator color={mobileTokens().destructive} /> : undefined
            }
          />
          {deletion.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {deletion.error}
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
      {deletion.dialog}
    </SafeAreaView>
  );
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** One end of the quiet hours, on the hour; the other end's hour isn't offered. */
function QuietHourPicker({
  label,
  value,
  other,
  locale,
  onChange,
}: {
  label: string;
  value: number;
  other: number;
  locale: string;
  onChange: (hour: number) => void;
}) {
  return (
    <MenuPicker
      label={label}
      value={String(value)}
      choices={HOURS.filter((hour) => hour !== other).map((hour) => ({
        key: String(hour),
        label: localizedClock(`${hour}:00`, locale),
      }))}
      onChange={(key) => onChange(Number(key))}
    />
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
    updateButton: {
      alignSelf: "center",
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
  });
}
