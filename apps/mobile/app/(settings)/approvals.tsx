import { MenuView } from "@expo/ui/community/menu";
import type { ActionApprovalRule } from "@rakazo/contracts";
import type { ApprovalMode } from "@rakazo/core";
import {
  APPROVAL_RULE_EFFECTS,
  approvalRuleApplies,
  approvalRuleEffectChoices,
  approvalRuleLabel,
} from "@rakazo/core";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

type RuleAction = ActionApprovalRule["effect"] | "remove";

/**
 * The apps, tools and sites allowed, asked about or blocked, grouped by which. Rules come from
 * approval cards or are picked from a list; the approval mode itself is a row in settings. Opened
 * with a Space, it edits that Space's override instead of the account's.
 */
export default function ApprovalRules() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useI18n();
  const navigation = useNavigation();
  const router = useRouter();
  const colorScheme = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  // Null until the first load lands.
  const [rules, setRules] = useState<ActionApprovalRule[] | null>(null);
  // The approval mode, which decides which rules apply; null until a fresh read lands.
  const [mode, setMode] = useState<ApprovalMode | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Counts saves, so a read that started before one never shows what it replaced.
  const saves = useRef(0);

  useFocusEffect(
    useCallback(() => {
      let current = true;
      const savesAtRead = saves.current;
      void rpc("approvalRules/list", { scope })
        .then((nextRules) => {
          if (!current || saves.current !== savesAtRead) return;
          setRules(nextRules);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (current) setLoadError(errorText(err, t("Something went wrong. Try again.")));
        });
      // Dims only once a fresh read confirms the mode, so a failed one never leaves stale dimming.
      setMode(null);
      void rpc("autoReview/get", { scope })
        .then((settings) => {
          if (current) setMode(settings.mode);
        })
        .catch(() => undefined);
      return () => {
        current = false;
      };
    }, [attempt, rpc, scope, t]),
  );

  async function save(change: () => Promise<void>) {
    saves.current += 1;
    setPending(true);
    setError(null);
    setLoadError(null);
    try {
      await change();
    } catch (err) {
      setError(errorText(err, t("Could not save that preference")));
    } finally {
      setPending(false);
    }
  }

  const applyRuleAction = (rule: ActionApprovalRule, action: RuleAction) =>
    save(async () => {
      if (action === "remove") {
        await rpc("approvalRules/remove", { scope, id: rule.id });
        setRules((current) => current?.filter((entry) => entry.id !== rule.id) ?? null);
        return;
      }
      if (
        action === rule.effect ||
        rule.matchKind === "category" ||
        !approvalRuleEffectChoices(rule).includes(action)
      )
        return;
      const saved = await rpc("approvalRules/set", {
        scope,
        effect: action,
        matchKind: rule.matchKind,
        matchValue: rule.matchValue,
      });
      // Saving replaces every other rule on the same match, whatever its case.
      const value = rule.matchValue.toLowerCase();
      setRules(
        (current) =>
          current?.flatMap((entry) => {
            if (entry.id === rule.id) return [saved];
            const sameMatch =
              entry.matchKind === rule.matchKind && entry.matchValue.toLowerCase() === value;
            return sameMatch ? [] : [entry];
          }) ?? null,
      );
    });

  const canAdd = rules !== null && !loadError;
  useLayoutEffect(() => {
    if (!canAdd) {
      navigation.setOptions(
        iosAtLeast(26) ? { unstable_headerRightItems: () => [] } : { headerRight: () => null },
      );
      return;
    }
    const open = () =>
      router.push({
        pathname: "/approval-rule-add",
        params: target.scope === "space" ? { spaceId: target.spaceId } : {},
      });
    navigation.setOptions(
      iosAtLeast(26)
        ? {
            unstable_headerRightItems: () => [
              { type: "button" as const, label: t("Add rule"), onPress: open },
            ],
          }
        : {
            headerRight: () => (
              <NativeActionButton
                fill={false}
                label={t("Add rule")}
                onPress={open}
                prominence="secondary"
              />
            ),
          },
    );
  }, [canAdd, navigation, router, t, target]);

  const groupTitles: Record<ActionApprovalRule["effect"], string> = {
    always_allow: t("Always allow"),
    require_approval: t("Always ask"),
    deny: t("Blocked"),
  };
  const groups = APPROVAL_RULE_EFFECTS.map((effect) => ({ effect, title: groupTitles[effect] }));

  const failure = error ?? loadError;
  const shownError = error ?? (rules ? loadError : null);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {failure && !rules ? (
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
        {groups.map(({ effect, title: groupTitle }) => (
          <SettingsGroup key={effect} label={groupTitle}>
            {rules
              ?.filter((rule) => rule.effect === effect)
              .map((rule) => {
                const title = approvalRuleLabel(rule);
                const effects = approvalRuleEffectChoices(rule);
                return (
                  <MenuView
                    key={rule.id}
                    actions={[
                      ...groups
                        .filter((group) => effects.includes(group.effect))
                        .map((group) => ({
                          id: group.effect,
                          title: group.title,
                          state: rule.effect === group.effect ? ("on" as const) : ("off" as const),
                        })),
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
                      dimmed={pending || !approvalRuleApplies(mode, effect)}
                      title={title}
                    />
                  </MenuView>
                );
              })}
          </SettingsGroup>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function isRuleAction(action: string): action is RuleAction {
  return (
    action === "always_allow" ||
    action === "require_approval" ||
    action === "deny" ||
    action === "remove"
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
