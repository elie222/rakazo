import { useLingui } from "@lingui/react/macro";
import type { UserDeviceSummary } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { native, useThemedStyles } from "../../lib/native";
import { useSideInsets } from "../../lib/side-insets";
import { listUserDevices, removeUserDevice } from "../../lib/user-devices";
import { errorText } from "../../lib/user-error";

export default function ComputersSettings() {
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const loadGeneration = useRef(0);
  const [devices, setDevices] = useState<UserDeviceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    loadGeneration.current += 1;
    const generation = loadGeneration.current;
    try {
      const listed = await listUserDevices();
      if (generation !== loadGeneration.current) return;
      setDevices(listed);
      setError(null);
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setError(errorText(cause, t`Could not load`));
    }
  }, [t]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        loadGeneration.current += 1;
        setPending(false);
      };
    }, [load]),
  );

  function confirmRemove(device: UserDeviceSummary) {
    if (pending) return;
    Alert.alert(
      t`Remove ${device.name}?`,
      t`This computer will stop running bots for your account`,
      [
        { text: t`Cancel`, style: "cancel" },
        {
          text: t`Remove`,
          style: "destructive",
          onPress: () => void revoke(device),
        },
      ],
    );
  }

  async function revoke(device: UserDeviceSummary) {
    if (pending) return;
    setPending(true);
    setError(null);
    setDevices((current) => current?.filter((item) => item.deviceId !== device.deviceId) ?? null);
    try {
      await removeUserDevice(device.deviceId);
    } catch (cause) {
      setDevices((current) => {
        if (!current) return [device];
        if (current.some((item) => item.deviceId === device.deviceId)) return current;
        return [...current, device];
      });
      setError(errorText(cause, t`Could not remove`));
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        {!devices && !error ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        ) : null}
        {devices?.length === 0 ? (
          <Text style={styles.secondary}>{t`No paired computers`}</Text>
        ) : null}
        {devices?.length ? (
          <SettingsGroup>
            {devices.map((device) => (
              <SettingsRow
                key={device.deviceId}
                accessibilityRole="button"
                accessibilityLabel={t`Remove ${device.name}`}
                disabled={pending}
                onPress={() => confirmRemove(device)}
                title={device.name}
                value={device.connected ? t`Connected` : t`Offline`}
              />
            ))}
          </SettingsGroup>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {error && !devices ? (
          <NativeActionButton
            fill={false}
            label={t`Retry`}
            onPress={() => {
              setError(null);
              void load();
            }}
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
    secondary: { color: native.secondaryLabel, fontSize: 15 },
    error: { color: tokens.destructive, fontSize: 15 },
  });
}
