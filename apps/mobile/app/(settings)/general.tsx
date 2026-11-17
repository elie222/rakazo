import { useLingui } from "@lingui/react/macro";
import type { QuietHours } from "@rakazo/contracts";
import {
  APP_LOCALE_LABELS,
  DEFAULT_QUIET_HOURS,
  quietHourChoices,
  quietHoursSave,
} from "@rakazo/core";
import * as Notifications from "expo-notifications";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, Platform, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MenuPicker } from "../../components/menu-picker";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import {
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsSwitch,
  useStackedSettings,
} from "../../components/settings-group";
import { currentApiBase, selectedSpaceId } from "../../lib/api";
import { getCachedAppearancePreference, setAppearancePreference } from "../../lib/appearance";
import {
  getHapticsEnabled,
  loadHapticsPreference,
  setHapticsEnabled,
  subscribeHaptics,
} from "../../lib/haptics";
import { useUiLocale } from "../../lib/i18n";
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
import { useThemedStyles } from "../../lib/native";
import { registerPushToken } from "../../lib/push";
import { accountRpcQuery, queryClient, useSave } from "../../lib/query";
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
import { useScreenQuery } from "../../lib/screen-query";
import { loadSessionToken } from "../../lib/session";
import { createSettingsPageStyles } from "../../lib/settings-page-styles";
import { ACCOUNT_SETTINGS } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

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
  const me = useScreenQuery(meRead).data;
  const botStyle = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (botAvatarSet: NonNullable<MobileMe["botAvatarSet"]>, send) => {
      // The answer is the account as saved, so the picker keeps it if the read after it fails.
      queryClient.setQueryData(meRead.queryKey, await send("preferences/update", { botAvatarSet }));
    },
    stale: [meRead.queryKey],
    onFailed: () => Alert.alert(t`Couldn't update bot style`),
  });
  const quietHoursUpdate = useSave({
    target: ACCOUNT_SETTINGS,
    save: async (next: QuietHours | null, send) => {
      // Turning them on for an account without a timezone keeps this device's in the same save.
      const save = quietHoursSave(next, me?.timezone, deviceTimeZone());
      if (!save) throw new Error("No timezone to read quiet hours in");
      queryClient.setQueryData(meRead.queryKey, await send("preferences/update", save));
    },
    stale: [meRead.queryKey],
    onFailed: () => Alert.alert(t`Couldn't update quiet hours`),
  });
  // The choice being saved shows until the server answers.
  const quietHours = quietHoursUpdate.pending ? quietHoursUpdate.input : me?.quietHours;
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

  function updateQuietHours(next: QuietHours | null) {
    if (me && me.quietHours !== undefined) quietHoursUpdate.run(next);
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

        {quietHours !== undefined ? (
          <SettingsGroup>
            <SettingsSwitch
              label={t`Quiet hours`}
              detail={quietHours ? t`Only what needs you comes through.` : undefined}
              value={quietHours !== null}
              disabled={quietHoursUpdate.pending}
              onChange={(on) => updateQuietHours(on ? DEFAULT_QUIET_HOURS : null)}
            />
            {quietHours ? (
              <>
                <QuietHourPicker
                  label={t`Starts`}
                  value={quietHours.start}
                  other={quietHours.end}
                  locale={locale}
                  disabled={quietHoursUpdate.pending}
                  onChange={(start) => updateQuietHours({ ...quietHours, start })}
                />
                <QuietHourPicker
                  label={t`Ends`}
                  value={quietHours.end}
                  other={quietHours.start}
                  locale={locale}
                  disabled={quietHoursUpdate.pending}
                  onChange={(end) => updateQuietHours({ ...quietHours, end })}
                />
              </>
            ) : null}
          </SettingsGroup>
        ) : null}

        <SettingsGroup>
          <SettingsSwitch
            label={t`Stream replies`}
            value={streamReplies}
            onChange={(checked) => void setResponseStreamingPreference(checked ? "on" : "off")}
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

/** One end of the quiet hours, on the hour; the other end's hour isn't offered. */
function QuietHourPicker({
  label,
  value,
  other,
  locale,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  other: number;
  locale: string;
  disabled: boolean;
  onChange: (hour: number) => void;
}) {
  return (
    <MenuPicker
      label={label}
      value={String(value)}
      disabled={disabled}
      choices={quietHourChoices(other, locale).map(({ hour, label }) => ({
        key: String(hour),
        label,
      }))}
      onChange={(key) => onChange(Number(key))}
    />
  );
}
