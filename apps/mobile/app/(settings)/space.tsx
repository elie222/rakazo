import type { SpaceSetting } from "@rakazo/contracts";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeSwitch } from "../../components/native-switch";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { SkipApprovalsSwitch } from "../../components/skip-approvals-switch";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/**
 * A Space follows the account's models, voice and confirmations until one is customized for it.
 * Customizing opens the same screen the account uses, editing the Space's own copy.
 */
export default function SpaceSettings() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const router = useRouter();
  const { t } = useI18n();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [overrides, setOverrides] = useState<SpaceSetting[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (target.scope !== "space") return;
      let current = true;
      void rpc<SpaceSetting[]>("spaceSettings/overrides")
        .then((next) => {
          if (current) setOverrides(next);
        })
        .catch((err: unknown) => {
          if (current) setError(errorText(err, t("Something went wrong. Try again.")));
        });
      return () => {
        current = false;
      };
    }, [rpc, t, target.scope]),
  );

  if (target.scope !== "space") return null;
  const space = target.spaceId;
  const open = (setting: "models" | "voice") =>
    router.push({ pathname: `/${setting}`, params: { spaceId: space } });

  async function customize(setting: SpaceSetting, enabled: boolean) {
    setPending(true);
    setError(null);
    try {
      setOverrides(await rpc<SpaceSetting[]>("spaceSettings/setOverride", { setting, enabled }));
      if (enabled && setting !== "confirmations") open(setting);
    } catch (err) {
      setError(errorText(err, t("Could not save that preference")));
    } finally {
      setPending(false);
    }
  }

  const row = (setting: SpaceSetting, title: string) => {
    const customized = overrides?.includes(setting) ?? false;
    const opens = customized && setting !== "confirmations";
    return (
      <SettingsRow
        key={setting}
        accessibilityRole={opens ? "button" : undefined}
        title={title}
        chevron={opens ? "right" : undefined}
        onPress={opens ? () => open(setting) : undefined}
        trailing={
          <NativeSwitch
            accessibilityLabel={t("Customize {setting}", { setting: title })}
            value={customized}
            disabled={!overrides || pending}
            onValueChange={(next) => void customize(setting, next)}
          />
        }
      />
    );
  };

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        <SettingsGroup accessibilityLabel={t("Customize")} label={t("Customize")}>
          {row("models", t("Models"))}
          {row("voice", t("Voice"))}
          {row("confirmations", t("Confirmations"))}
          {overrides?.includes("confirmations") ? <SkipApprovalsSwitch target={target} /> : null}
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
