import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import { useMobileDeviceRows } from "@rakazo/chat-ui/hooks";
import type { CloudComputers, ComputerSize, UserDeviceSummary } from "@rakazo/contracts";
import {
  applySavedCloudComputerSize,
  ComputerSizeSchema,
  computerSizeChoice,
} from "@rakazo/contracts";
import { refreshQueriesAfterSignal } from "@rakazo/core";
import { writeSaved } from "@rakazo/core/query";
import { computerName, computerSizeLabel, mobileDeviceName } from "@rakazo/i18n/computer-usage";
import { useIsFocused, useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { listUserDevices, removeUserDevice } from "../../lib/account/user-devices";
import { useSpaceChanges } from "../../lib/api/roster-signals";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import {
  accountQuery,
  queryClient,
  rpcQuery,
  targetRpcQuery,
  useSave,
} from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../../lib/query/settings-target";

type CloudComputer = CloudComputers["computers"][number];

export default function DevicesSettings() {
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const router = useRouter();
  const focused = useIsFocused();
  const devicesRead = accountQuery("userDevices", listUserDevices);
  const devicesQuery = useScreenQuery(devicesRead);
  const phonesRead = targetRpcQuery(ACCOUNT_SETTINGS, "mobileDevices/list");
  const phonesQuery = useScreenQuery(phonesRead);
  const phones = useMobileDeviceRows(phonesQuery.data, focused);
  useSpaceChanges(
    "mobileDevices",
    () => refreshQueriesAfterSignal(queryClient, { queryKey: phonesRead.queryKey, exact: true }),
    focused,
  );
  const cloudRead = rpcQuery("cloudComputers/list");
  const cloudQuery = useScreenQuery(cloudRead);
  const cloud = cloudQuery.data;
  const [refreshing, setRefreshing] = useState(false);
  const [resized, setResized] = useState<string | null>(null);

  // Paired devices are not an rpc, so this save writes through their own route.
  const removal = useSave({
    target: ACCOUNT_SETTINGS,
    stale: [devicesRead.queryKey],
    save: async (device: UserDeviceSummary) => {
      await removeUserDevice(device.deviceId);
      // Gone even if the read that follows fails.
      queryClient.setQueryData(devicesRead.queryKey, (listed) =>
        listed?.filter((kept) => kept.deviceId !== device.deviceId),
      );
    },
  });
  const resize = useSave({
    stale: [cloudRead.queryKey],
    save: async ({ computerId, size }: { computerId: string; size: ComputerSize }, send) => {
      const saved = await send("cloudComputers/setSize", { computerId, size });
      await writeSaved(queryClient, cloudRead.queryKey, (listed) =>
        applySavedCloudComputerSize(listed, computerId, size),
      );
      return saved;
    },
    onSaved: (_saved, { computerId }) => setResized(computerId),
    onFailed: () => Alert.alert(t`Could not change computer size`),
  });

  // A removal in flight already reads as gone.
  const devices = devicesQuery.data?.filter(
    (device) => !(removal.pending && removal.input?.deviceId === device.deviceId),
  );
  const loadFailure = devicesQuery.error ?? phonesQuery.error ?? cloudQuery.error;
  const loadError = loadFailure ? errorText(loadFailure, t`Could not load`) : null;
  const error = removal.error ? errorText(removal.error, t`Could not remove`) : loadError;
  const cloudComputers = cloud?.computers ?? [];

  async function refresh() {
    setRefreshing(true);
    removal.reset();
    await Promise.all([devicesQuery.refetch(), phonesQuery.refetch(), cloudQuery.refetch()]);
    setRefreshing(false);
  }

  function confirmRemove(device: UserDeviceSummary) {
    if (removal.pending) return;
    Alert.alert(
      t`Remove ${device.name}?`,
      t`This computer will stop running bots for your account`,
      [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Remove`, style: "destructive", onPress: () => removal.run(device) },
      ],
    );
  }

  function chooseSize(computer: CloudComputer, size: ComputerSize) {
    if (!cloud) return;
    const choice = computerSizeChoice(size, computer, cloud.available);
    if (choice === "unchanged") return;
    if (choice === "upgrade") {
      Alert.alert(t`Your plan does not include this size.`, undefined, [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Upgrade`, onPress: () => router.push("/billing") },
      ]);
      return;
    }
    setResized(null);
    resize.run({ computerId: computer.id, size });
  }

  function cloudRow(computer: CloudComputer) {
    const pendingSize =
      resize.pending && resize.input?.computerId === computer.id ? resize.input.size : null;
    const size = pendingSize ?? computer.size;
    const row = (
      <SettingsRow
        key={computer.id}
        title={computerName(computer)}
        value={computerSizeLabel(size)}
        detail={resized === computer.id ? t`Applies on its next start.` : undefined}
        chevron={cloud?.canManage ? "down" : undefined}
        disabled={resize.pending}
      />
    );
    if (!cloud?.canManage) return row;
    return (
      <MenuView
        key={computer.id}
        actions={ComputerSizeSchema.options.map((option) => ({
          id: option,
          title: computerSizeLabel(option),
          state: option === size ? ("on" as const) : ("off" as const),
          attributes: { disabled: resize.pending },
        }))}
        onPressAction={({ nativeEvent }) => {
          const chosen = ComputerSizeSchema.safeParse(nativeEvent.event);
          if (chosen.success) chooseSize(computer, chosen.data);
        }}
      >
        {row}
      </MenuView>
    );
  }

  function presence(connected: boolean) {
    return {
      value: connected ? t`Online` : t`Offline`,
      trailing: <View style={[styles.dot, connected ? styles.online : styles.offline]} />,
    };
  }

  function connectMore(title: string) {
    Alert.alert(title, t`Open Rakazo on that device and sign in to the same account.`);
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        {(!devices || !phones) && !error ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        ) : null}
        {cloudComputers.length ? (
          <SettingsGroup label={t`Cloud computers`}>{cloudComputers.map(cloudRow)}</SettingsGroup>
        ) : null}
        {phones?.length === 0 &&
        devices?.length === 0 &&
        cloud !== undefined &&
        cloudComputers.length === 0 ? (
          <SettingsGroup label={t`Your devices`}>
            <SettingsRow title={t`No connected devices`} />
          </SettingsGroup>
        ) : null}
        {devices?.length || phones?.length ? (
          <SettingsGroup label={t`Your devices`}>
            {devices?.map((device) => {
              const status = presence(device.connected);
              return (
                <SettingsRow
                  key={device.deviceId}
                  accessibilityRole="button"
                  accessibilityLabel={t`Remove ${device.name}, ${status.value}`}
                  disabled={removal.pending}
                  onPress={() => confirmRemove(device)}
                  title={device.name}
                  {...status}
                />
              );
            })}
            {phones?.map((phone) => {
              const name = mobileDeviceName(phone);
              const status = presence(phone.connected);
              return (
                <SettingsRow
                  key={phone.deviceId}
                  accessible
                  accessibilityLabel={t`${name}, ${status.value}`}
                  title={name}
                  {...status}
                />
              );
            })}
          </SettingsGroup>
        ) : null}
        <SettingsGroup label={t`This phone`}>
          <SettingsRow
            title={t`App permissions`}
            chevron="right"
            onPress={() => router.push("/app-permissions")}
          />
        </SettingsGroup>
        <SettingsGroup label={t`Connect more devices`}>
          <SettingsRow
            title={t`Connect your Mac`}
            chevron="right"
            onPress={() => connectMore(t`Connect your Mac`)}
          />
          <SettingsRow
            title={t`Connect your Android phone`}
            chevron="right"
            onPress={() => connectMore(t`Connect your Android phone`)}
          />
          <SettingsRow
            title={t`Connect your iPhone`}
            chevron="right"
            onPress={() => connectMore(t`Connect your iPhone`)}
          />
        </SettingsGroup>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {loadError ? (
          <NativeActionButton
            fill={false}
            label={t`Retry`}
            onPress={() =>
              void Promise.all([
                devicesQuery.refetch(),
                phonesQuery.refetch(),
                cloudQuery.refetch(),
              ])
            }
            prominence="secondary"
          />
        ) : null}
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
    dot: { width: 8, height: 8, borderRadius: 4 },
    online: { backgroundColor: tokens.success },
    offline: { backgroundColor: tokens.destructive },
  });
}
