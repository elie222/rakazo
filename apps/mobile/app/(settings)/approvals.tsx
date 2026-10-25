import { MenuView } from "@expo/ui/community/menu";
import type { ActionApprovalRule, ActionAutoReviewSettings, ApprovalMode } from "@rakazo/contracts";
import { humanizeToolName } from "@rakazo/core";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { SettingsFooter, SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

type RuleAction = "always_allow" | "deny" | "remove";

/**
 * How bots ask before acting, and the tools and sites always allowed or blocked. Rules come from
 * approval cards, so this screen only switches or removes them. Opened with a Space, it edits that
 * Space's override instead of the account's.
 */
export default function Approvals() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [settings, setSettings] = useState<ActionAutoReviewSettings | null>(null);
  const [rules, setRules] = useState<ActionApprovalRule[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counts saves, so a read that started before one never shows what it replaced.
  const saves = useRef(0);

  useFocusEffect(
    useCallback(() => {
      let current = true;
      const savesAtRead = saves.current;
      void Promise.all([
        rpc<ActionAutoReviewSettings>("autoReview/get", { scope }),
        rpc<ActionApprovalRule[]>("approvalRules/list", { scope }),
      ])
        .then(([nextSettings, nextRules]) => {
          if (!current || saves.current !== savesAtRead) return;
          setSettings(nextSettings);
          setRules(nextRules);
        })
        .catch((err: unknown) => {
          if (current) setError(errorText(err, t("Something went wrong. Try again.")));
        });
      return () => {
        current = false;
      };
    }, [rpc, scope, t]),
  );

  async function save(change: () => Promise<void>) {
    saves.current += 1;
    setPending(true);
    setError(null);
    try {
      await change();
    } catch (err) {
      setError(errorText(err, t("Could not save that preference")));
    } finally {
      setPending(false);
    }
  }

  const setMode = (mode: ApprovalMode) =>
    save(async () =>
      setSettings(await rpc<ActionAutoReviewSettings>("autoReview/set", { scope, mode })),
    );

  const applyRuleAction = (rule: ActionApprovalRule, action: RuleAction) =>
    save(async () => {
      if (action === "remove") {
        await rpc("approvalRules/remove", { scope, id: rule.id });
        setRules((current) => current.filter((entry) => entry.id !== rule.id));
        return;
      }
      if (action === rule.effect || rule.matchKind === "category") return;
      const saved = await rpc<ActionApprovalRule>("approvalRules/set", {
        scope,
        effect: action,
        matchKind: rule.matchKind,
        matchValue: rule.matchValue,
      });
      // Saving replaces any other effect on the same match.
      setRules((current) =>
        current.flatMap((entry) => {
          if (entry.id === rule.id) return [saved];
          const sameMatch =
            entry.matchKind === rule.matchKind && entry.matchValue === rule.matchValue;
          return sameMatch ? [] : [entry];
        }),
      );
    });

  const effectLabel = (effect: ActionApprovalRule["effect"]) =>
    effect === "always_allow" ? t("Allow") : effect === "deny" ? t("Block") : t("Ask");

  const modes: { value: ApprovalMode; label: string }[] = [
    { value: "never", label: t("Never ask") },
    ...(settings?.checkerAvailable || settings?.mode === "auto"
      ? [{ value: "auto" as const, label: t("Auto") }]
      : []),
    { value: "ask", label: t("Ask") },
  ];

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
        <View style={styles.section}>
          <NativeSegmentedControl
            accessibilityLabel={t("Approvals")}
            disabled={!settings || pending}
            onChange={(mode) => void setMode(mode)}
            options={modes}
            value={settings?.mode}
          />
          {settings?.mode === "auto" && !settings.checkerAvailable ? (
            <SettingsFooter>{t("Add a model in Settings to use this.")}</SettingsFooter>
          ) : null}
        </View>
        <SettingsGroup>
          {rules.map((rule) => {
            const title =
              rule.matchKind === "tool" ? humanizeToolName(rule.matchValue) : rule.matchValue;
            const switchable = rule.matchKind !== "category";
            return (
              <MenuView
                key={rule.id}
                actions={[
                  ...(switchable
                    ? (["always_allow", "deny"] as const).map((effect) => ({
                        id: effect,
                        title: effectLabel(effect),
                        state: rule.effect === effect ? ("on" as const) : ("off" as const),
                      }))
                    : []),
                  { id: "remove", title: t("Remove"), attributes: { destructive: true } },
                ]}
                colorScheme={colorScheme}
                onPressAction={(event) => {
                  const action = event.nativeEvent.event;
                  if (!pending && isRuleAction(action)) void applyRuleAction(rule, action);
                }}
                title={title}
              >
                <SettingsRow
                  accessible
                  accessibilityRole="button"
                  dimmed={pending}
                  title={title}
                  value={effectLabel(rule.effect)}
                />
              </MenuView>
            );
          })}
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

function isRuleAction(action: string): action is RuleAction {
  return action === "always_allow" || action === "deny" || action === "remove";
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    section: { gap: 7 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
