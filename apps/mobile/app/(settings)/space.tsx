import type { SpaceSetting } from "@rakazo/contracts";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApprovalModeRow, ApprovalRulesRow } from "../../components/approval-settings-rows";
import { LoadFailure } from "../../components/load-failure";
import { NativeSwitch } from "../../components/native-switch";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { useApprovalSettings } from "../../lib/approval-settings";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/**
 * A Space follows the account's models, voice, approvals and vault until one is customized for it.
 * Customizing opens the same screen the account uses, editing the Space's own copy; customized
 * approvals show the same rows as the account's, right here.
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A native switch shows the flip it reported, so keeping a setting on remounts its switch.
  const [kept, setKept] = useState(0);
  const approvals = useApprovalSettings(target, overrides?.includes("confirmations") ?? false);

  useFocusEffect(
    useCallback(() => {
      if (target.scope !== "space") return;
      let current = true;
      void rpc("spaceSettings/overrides")
        .then((next) => {
          if (!current) return;
          setOverrides(next);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (current) setLoadError(errorText(err, t("Something went wrong. Try again.")));
        });
      return () => {
        current = false;
      };
    }, [attempt, rpc, t, target.scope]),
  );

  if (target.scope !== "space") return null;
  const space = target.spaceId;
  const open = (setting: SpaceSetting) =>
    router.push({ pathname: SETTING_SCREENS[setting], params: { spaceId: space } });

  async function customize(setting: SpaceSetting, enabled: boolean) {
    setPending(true);
    setError(null);
    setLoadError(null);
    try {
      setOverrides(await rpc("spaceSettings/setOverride", { setting, enabled }));
      if (enabled && setting !== "confirmations") open(setting);
    } catch (err) {
      setError(errorText(err, t("Could not save that preference")));
    } finally {
      setPending(false);
    }
  }

  const row = (setting: SpaceSetting, title: string) => {
    const customized = overrides?.includes(setting) ?? false;
    // Customized approvals are edited in the rows below rather than on a screen of their own.
    const opens = customized && setting !== "confirmations" ? setting : null;
    return (
      <SettingsRow
        key={setting}
        accessibilityRole={opens ? "button" : undefined}
        title={title}
        chevron={opens ? "right" : undefined}
        onPress={opens ? () => open(opens) : undefined}
        trailing={
          <NativeSwitch
            key={kept}
            accessibilityLabel={t("Customize {setting}", { setting: title })}
            value={customized}
            // A Space's mode save holds its Approvals switch, so it can't land after a reset.
            disabled={!overrides || pending || (setting === "confirmations" && approvals.pending)}
            onValueChange={(next) => {
              // A Space's own vault is deleted with its override, so turning it off asks first.
              if (setting !== "credentials" || next) return void customize(setting, next);
              Alert.alert(t("Delete this Space's credentials?"), undefined, [
                {
                  text: t("Cancel"),
                  style: "cancel",
                  onPress: () => setKept((count) => count + 1),
                },
                {
                  text: t("Delete"),
                  style: "destructive",
                  onPress: () => void customize(setting, false),
                },
              ]);
            }}
          />
        }
      />
    );
  };

  const failure = error ?? loadError;
  const shownError = error ?? (overrides ? loadError : null);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {failure && !overrides ? (
          <LoadFailure
            message={failure}
            onRetry={() => {
              setError(null);
              setLoadError(null);
              setAttempt((count) => count + 1);
            }}
          />
        ) : shownError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {shownError}
          </Text>
        ) : null}
        <SettingsGroup accessibilityLabel={t("Customize")} label={t("Customize")}>
          {row("models", t("Models"))}
          {row("voice", t("Voice"))}
          {row("confirmations", t("Approvals"))}
          {row("credentials", t("Vault"))}
        </SettingsGroup>
        {overrides?.includes("confirmations") ? (
          <SettingsGroup>
            <ApprovalModeRow key="approvals" approvals={approvals} disabled={pending} />
            {approvals.ruleCount ? (
              <ApprovalRulesRow
                key="approval-rules"
                count={approvals.ruleCount}
                disabled={pending}
                onPress={() => open("confirmations")}
              />
            ) : null}
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// Each setting opens the screen the account uses for it; approvals open their rules list.
const SETTING_SCREENS = {
  models: "/models",
  voice: "/voice",
  confirmations: "/approvals",
  credentials: "/vault",
} as const satisfies Record<SpaceSetting, string>;

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
