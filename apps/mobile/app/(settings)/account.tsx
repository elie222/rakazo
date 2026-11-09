import { MenuView } from "@expo/ui/community/menu";
import type { AccountSecurity, UsageSummary } from "@rakazo/contracts";
import { APP_LOCALE_LABELS, accountDisplay, displayName } from "@rakazo/core";
import * as Notifications from "expo-notifications";
import type { Href } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAccountDeletion } from "../../components/account-deletion";
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
import { promptSectionName } from "../../lib/section-name-prompt";
import { loadSessionToken } from "../../lib/session";
import { isSettingsLink, openFromSettingsSheet } from "../../lib/settings-sheet";
import { ACCOUNT_SETTINGS } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { continueWithSso } from "../../lib/sso";
import {
  loadTrustedLinkSites,
  removeTrustedLinkSite,
  useTrustedLinkSites,
} from "../../lib/trusted-link-sites";
import { confirmUnsentSendLoss } from "../../lib/unsent-send-warning";
import { isUserAvatarImage, pickUserAvatarImage } from "../../lib/user-avatar";
import { errorText } from "../../lib/user-error";

let hapticsSaveVersion = 0;

export default function Account() {
  const sideInsets = useSideInsets();
  const { t, locale } = useI18n();
  const router = useRouter();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const [me, setMe] = useState<MobileMe | null>(null);
  const botStyleRequest = useRef(0);
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
      setPasskeyLoadError(errorText(err, t("Could not continue")));
    }
  }, [t]);
  const colorScheme = useResolvedAppearance();
  const trustedSites = useTrustedLinkSites();
  const [archivedCount, setArchivedCount] = useState(0);
  // A list that fails to refresh keeps its last count, so a passing error doesn't hide the row.
  const archivedCounts = useRef({ bots: 0, groups: 0 });
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageToday, setUsageToday] = useState<UsageSummary | null>(null);
  const [avatarPending, setAvatarPending] = useState(false);
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
      Alert.alert(t("Haptics"), t("Could not save"), [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Retry"),
          onPress: () => {
            if (isCurrent()) updateHaptics(value);
          },
        },
      ]);
    });
  }

  const loadRemoteImagesLabel = t("Load web images automatically");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const stackOptions = useStackedSettings();
  const styles = useThemedStyles(createAccountStyles);
  const versionInfo = getAppVersionInfo();
  const updateLabel = formatUpdateLabel(versionInfo.update, t);
  const versionAccessibility = [versionInfo.nativeLabel, updateLabel].filter(Boolean).join(". ");
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
    void rpc("usage/summary", { days: 1 })
      .then(setUsageToday)
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
      accessibilityRole="button"
      chevron="right"
      disabled={pending}
      onPress={() => router.push("/usage")}
      title={t("Usage")}
      detail={
        usage
          ? usageToday
            ? `${t("Today {runs} · {tokens} tokens", {
                runs: count.format(usageToday.runs),
                tokens: tokens(usageToday.totalTokens),
              })} / ${t("Total {runs} runs · {tokens} tokens", {
                runs: count.format(usage.runs),
                tokens: tokens(usage.totalTokens),
              })}`
            : t("{runs} runs, {tokens} tokens", {
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
      setSignOutError(errorText(err, t("Could not sign out")));
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
      onError: (cause) =>
        setNotificationError(errorText(cause, t("Could not update notifications"))),
    });
    setNotificationError(null);
    notificationQueue.current.update(next);
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

  const avatarImage = me?.image ?? null;

  async function changeProfilePhoto() {
    if (avatarPending || !me) return;
    setAvatarPending(true);
    try {
      const picked = await pickUserAvatarImage();
      if (picked.status === "canceled") return;
      if (picked.status === "error") {
        Alert.alert(
          t("Change profile photo"),
          t(
            picked.reason === "too-large"
              ? "The photo is too large. Choose a smaller photo."
              : picked.reason === "unavailable"
                ? "Could not open the photo library."
                : "Could not read that photo. Try another one.",
          ),
        );
        return;
      }
      setMe(await rpc("preferences/update", { image: picked.image }));
    } catch (err) {
      Alert.alert(t("Couldn't update profile photo"), errorText(err, t("Try again.")));
    } finally {
      setAvatarPending(false);
    }
  }

  const avatarLeading = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Change profile photo")}
      disabled={avatarPending || !me}
      onPress={() => void changeProfilePhoto()}
      style={styles.avatar}
    >
      {isUserAvatarImage(avatarImage) ? (
        <Image source={{ uri: avatarImage }} style={styles.avatarImage} />
      ) : (
        <Text style={styles.avatarInitials}>{account.initial ?? "?"}</Text>
      )}
    </Pressable>
  );

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
            leading={avatarLeading}
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
              title={t("Organization")}
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

        {me?.botAvatarSet ? (
          <View accessibilityLabel={t("Bot style")} style={styles.section}>
            <SettingsLabel>{t("Bot style")}</SettingsLabel>
            <NativeSegmentedControl
              accessibilityLabel={t("Bot style")}
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
                    Alert.alert(t("Couldn't update bot style"));
                  });
              }}
              options={[
                { value: "organic", label: t("Original") },
                { value: "rakazo", label: t("Rakazo") },
              ]}
              value={me.botAvatarSet}
            />
          </View>
        ) : null}

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t("Language")}
            accessibilityValue={{ text: APP_LOCALE_LABELS[locale] }}
            chevron="right"
            onPress={() => router.push("/language")}
            title={t("Language")}
            value={APP_LOCALE_LABELS[locale]}
          />
          <SettingsSwitch label={t("Haptics")} value={hapticsEnabled} onChange={updateHaptics} />
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
              title={t("Members")}
            />
          ) : null}
          {(
            [
              ...(me?.ticketBoardEnabled ? [{ title: t("Board"), href: "/board" } as const] : []),
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
          {spending?.shown ? (
            <SpendingLimitRow key="spending-limit" status={spending} disabled={pending} />
          ) : null}
          {(
            [
              { title: t("Vault"), href: "/vault" },
              ...(me?.paymentWalletProvider
                ? [{ title: t("Wallet"), href: "/wallet" } as const]
                : []),
              { title: t("Integrations"), href: "/integrations" },
              { title: t("Skills"), href: "/skills" },
              { title: t("Memory"), href: "/memory" },
              ...(messagingEnabled ? [{ title: t("Messaging"), href: "/messaging" } as const] : []),
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
            onPress={() => void deletion.request()}
            title={t("Delete account")}
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
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.muted,
      overflow: "hidden",
    },
    avatarImage: {
      width: 44,
      height: 44,
    },
    avatarInitials: {
      color: tokens.foreground,
      fontSize: 17,
      fontWeight: "600",
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
  });
}
