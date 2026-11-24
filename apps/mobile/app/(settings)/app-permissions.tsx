import { useLingui } from "@lingui/react/macro";
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import type { DeviceCalendarPermissionKind } from "../../lib/personal-calendar/device-calendar";
import {
  readAppleCalendarPermissions,
  requestAppleCalendarPermission,
} from "../../lib/personal-calendar/device-calendar";
import { useAppActive } from "../../lib/platform/app-foreground";
import { accountQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";

export default function AppPermissionsSettings() {
  const { t } = useLingui();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const read = accountQuery("appleCalendarPermissions", readAppleCalendarPermissions);
  // Wait for the OS transition to finish: a return from Settings can pass through "inactive".
  const permissions = useScreenQuery(read, { enabled: useAppActive(), onForeground: false });
  const change = useSave<DeviceCalendarPermissionKind | "settings">({
    target: ACCOUNT_SETTINGS,
    save: async (kind) => {
      if (kind === "settings" || (await requestAppleCalendarPermission(kind)) === "settings") {
        await Linking.openSettings();
        return;
      }
      await permissions.refetch();
    },
  });
  const apps = permissions.data ?? [];
  const catalog = [
    t`Alarm and timer`,
    t`Android app usage`,
    t`Android calendar`,
    t`Contacts`,
    t`Android file system`,
    t`Android location`,
    t`Notifications`,
    t`SMS`,
  ];

  function permissionRows(granted: boolean) {
    const group = apps.filter((app) => app.granted === granted);
    if (!group.length) return <SettingsRow title={t`None`} />;
    return group.map((app) => (
      <SettingsRow
        key={app.kind}
        title={app.kind === "calendar" ? t`Calendar` : t`Reminders`}
        value={granted ? t`Settings` : t`Connect`}
        chevron={granted ? "right" : undefined}
        disabled={change.pending}
        onPress={() => change.run(granted ? "settings" : app.kind)}
      />
    ));
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {permissions.data ? (
          <>
            <SettingsGroup label={t`Available`}>{permissionRows(false)}</SettingsGroup>
            <SettingsGroup label={t`Authorized`}>{permissionRows(true)}</SettingsGroup>
          </>
        ) : permissions.error ? (
          <SettingsGroup>
            <SettingsRow
              title={t`Retry`}
              chevron="right"
              onPress={() => void permissions.refetch()}
            />
          </SettingsGroup>
        ) : (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        )}
        {permissions.error || change.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {change.error
              ? errorText(change.error, t`Could not update permissions`)
              : errorText(permissions.error, t`Could not load permissions.`)}
          </Text>
        ) : null}
        <SettingsGroup label={t`In development`}>
          {catalog.map((title) => (
            <SettingsRow key={title} title={title} />
          ))}
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 16 },
    error: { color: tokens.destructive, fontSize: 15 },
  });
}
