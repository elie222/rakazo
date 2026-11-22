import { useLingui } from "@lingui/react/macro";
import type { ChatPreferencesPatch } from "@rakazo/contracts";
import { APP_LOCALE_LABELS } from "@rakazo/core";
import * as Notifications from "expo-notifications";
import { useFocusEffect, useIsFocused, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, Platform, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeSegmentedControl } from "../../components/native/native-segmented-control";
import {
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsSwitch,
  useStackedSettings,
} from "../../components/settings/settings-group";
import { currentApiBase, selectedSpaceId } from "../../lib/api/api";
import type { MobileMe } from "../../lib/api/mobile-types";
import { useLiveStream } from "../../lib/api/roster-signals";
import { loadSessionToken } from "../../lib/api/session";
import { errorText } from "../../lib/api/user-error";
import {
  getCachedAppearancePreference,
  setAppearancePreference,
} from "../../lib/appearance/appearance";
import {
  getCachedComposerModelPicker,
  setComposerModelPicker,
  subscribeComposerModelPicker,
} from "../../lib/composer/composer-model-picker-preference";
import { useUiLocale } from "../../lib/i18n/i18n";
import { useSideInsets } from "../../lib/layout/side-insets";
import {
  getHapticsEnabled,
  loadHapticsPreference,
  setHapticsEnabled,
  subscribeHaptics,
} from "../../lib/native/haptics";
import { useThemedStyles } from "../../lib/native/native";
import type { LiveNotificationSettings } from "../../lib/notifications/live-notifications";
import {
  canPostPromotedNotifications,
  DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  getLiveNotificationSettings,
  hasLiveUpdateSettings,
  openLiveNotificationSettings,
  openPromotedNotificationSettings,
  setLiveNotificationSettings,
} from "../../lib/notifications/live-notifications";
import { registerPushToken } from "../../lib/notifications/push";
import {
  getCachedRemoteImagesEnabled,
  setRemoteImagesPreference,
  subscribeRemoteImages,
} from "../../lib/preferences/remote-images-preference";
import {
  getCachedResponseStreamingEnabled,
  setResponseStreamingPreference,
  subscribeResponseStreaming,
} from "../../lib/preferences/response-streaming";
import { accountRpcQuery, queryClient, useSave } from "../../lib/query/query";
import { createQueuedSave } from "../../lib/query/queued-save";
import { useScreenQuery } from "../../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";
import { createSettingsPageStyles } from "../../lib/settings/settings-page-styles";

let hapticsSaveVersion = 0;

export default function General() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const locale = useUiLocale();
  const router = useRouter();
  const styles = useThemedStyles(createSettingsPageStyles);
  const stacked = useStackedSettings();
  // Read on every visit, so a failed read retries when the page is shown again.
  const meRead = accountRpcQuery("me");
  const { data: me, isLoading: loadingAccount } = useScreenQuery(meRead);
  useLiveStream(useIsFocused());
  const botStyle = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (botAvatarSet: NonNullable<MobileMe["botAvatarSet"]>, send) => {
      // The answer is the account as saved, so the picker keeps it if the read after it fails.
      queryClient.setQueryData(meRead.queryKey, await send("preferences/update", { botAvatarSet }));
    },
    stale: [meRead.queryKey],
    onFailed: () => Alert.alert(t`Couldn't update bot style`),
  });
  const chatSave = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (chatPreferences: ChatPreferencesPatch, send) => {
      queryClient.setQueryData(
        meRead.queryKey,
        await send("preferences/update", { chatPreferences }),
      );
    },
    stale: [meRead.queryKey],
    onFailed: () => Alert.alert(t`Could not save`),
  });
  const appearance = getCachedAppearancePreference();
  const chatSaveDisabled = loadingAccount || chatSave.pending;
  const deviceStreamReplies = useSyncExternalStore(
    subscribeResponseStreaming,
    getCachedResponseStreamingEnabled,
    () => false,
  );
  const loadRemoteImages = useSyncExternalStore(
    subscribeRemoteImages,
    getCachedRemoteImagesEnabled,
    () => false,
  );
  const deviceModelPicker = useSyncExternalStore(
    subscribeComposerModelPicker,
    getCachedComposerModelPicker,
    () => false,
  );
  const hapticsEnabled = useSyncExternalStore(
    subscribeHaptics,
    getHapticsEnabled,
    getHapticsEnabled,
  );
  const [notifications, setNotifications] = useState<LiveNotificationSettings>(
    DEFAULT_LIVE_NOTIFICATION_SETTINGS,
  );
  const [notificationsReady, setNotificationsReady] = useState(Platform.OS !== "android");
  const notificationQueue = useRef<ReturnType<
    typeof createQueuedSave<LiveNotificationSettings>
  > | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);

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

  useEffect(() => {
    if (Platform.OS === "android") {
      void getLiveNotificationSettings()
        .then(setNotifications)
        .catch(() => undefined)
        .finally(() => setNotificationsReady(true));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadHapticsPreference();
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

  function updateBotStyle(botAvatarSet: MobileMe["botAvatarSet"] | "") {
    if (me && botAvatarSet) botStyle.run(botAvatarSet);
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
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

        {me ? (
          <View accessibilityLabel={t`Bot style`} style={styles.section}>
            <SettingsLabel>{t`Bot style`}</SettingsLabel>
            <NativeSegmentedControl
              accessibilityLabel={t`Bot style`}
              disabled={botStyle.pending}
              onChange={updateBotStyle}
              options={[
                { value: "organic", label: t`Original` },
                { value: "rakazo", label: t`Rakazo` },
              ]}
              value={(botStyle.pending ? botStyle.input : me.botAvatarSet) ?? ""}
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

        <SettingsGroup>
          <SettingsSwitch
            label={t`Stream replies`}
            value={me?.chatPreferences?.streamReplies ?? deviceStreamReplies}
            disabled={chatSaveDisabled}
            onChange={(checked) => {
              if (me?.chatPreferences) chatSave.run({ streamReplies: checked });
              else void setResponseStreamingPreference(checked ? "on" : "off");
            }}
          />
          <SettingsSwitch
            label={t`Model picker in chat`}
            value={me?.chatPreferences?.composerModelPicker ?? deviceModelPicker}
            disabled={chatSaveDisabled}
            onChange={(checked) => {
              if (me?.chatPreferences) chatSave.run({ composerModelPicker: checked });
              else void setComposerModelPicker(checked);
            }}
          />
          <SettingsSwitch
            label={t`Load web images automatically`}
            value={loadRemoteImages}
            onChange={(checked) => void setRemoteImagesPreference(checked ? "on" : "off")}
          />
          <SettingsRow
            accessibilityRole="button"
            chevron="right"
            onPress={() => router.push("/ai-data-sharing")}
            title={t`AI data sharing`}
          />
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}
