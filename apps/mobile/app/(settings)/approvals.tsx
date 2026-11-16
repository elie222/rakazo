import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { ActionApprovalRule } from "@rakazo/contracts";
import {
  APPROVAL_RULE_EFFECTS,
  approvalRuleApplies,
  approvalRuleEffectChoices,
  approvalRuleLabel,
} from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { queryClient, targetRpcQuery, useSave } from "../../lib/query";
import { useScreenHeader } from "../../lib/screen-header";
import { settingsTarget } from "../../lib/settings-target";
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
  const scope = target.scope;
  const { t } = useLingui();
  const router = useRouter();
  const colorScheme = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const rulesRead = targetRpcQuery(target, "approvalRules/list", { scope });
  const rulesQuery = useQuery(rulesRead, queryClient);
  const modeQuery = useQuery(targetRpcQuery(target, "autoReview/get", { scope }), queryClient);
  // Null until the first load lands.
  const rules = rulesQuery.data ?? null;
  // The approval mode, which decides which rules apply. Dims only once a fresh read confirms it,
  // so a failed one never leaves stale dimming.
  const mode = modeQuery.isFetching || modeQuery.isError ? null : (modeQuery.data?.mode ?? null);
  const loadError = rulesQuery.error
    ? errorText(rulesQuery.error, t`Something went wrong. Try again.`)
    : null;
  const { refetch: refetchRules } = rulesQuery;
  const { refetch: refetchMode } = modeQuery;

  useFocusEffect(
    useCallback(() => {
      void refetchRules();
      void refetchMode();
    }, [refetchRules, refetchMode]),
  );

  const setRules = (update: (current: ActionApprovalRule[]) => ActionApprovalRule[]) =>
    queryClient.setQueryData(rulesRead.queryKey, (current) => current && update(current));

  const change = useSave({
    target,
    save: async ({ rule, action }: { rule: ActionApprovalRule; action: RuleAction }, send) => {
      // A read that started before a save never shows what it replaced.
      await queryClient.cancelQueries({ queryKey: rulesRead.queryKey });
      // Keeping the rules shown also clears a failed refresh's error.
      setRules((current) => current);
      if (action === "remove") {
        await send("approvalRules/remove", { scope, id: rule.id });
        setRules((current) => current.filter((entry) => entry.id !== rule.id));
        return;
      }
      if (
        action === rule.effect ||
        rule.matchKind === "category" ||
        !approvalRuleEffectChoices(rule).includes(action)
      )
        return;
      const saved = await send("approvalRules/set", {
        scope,
        effect: action,
        matchKind: rule.matchKind,
        matchValue: rule.matchValue,
      });
      // Saving replaces every other rule on the same match, whatever its case.
      const value = rule.matchValue.toLowerCase();
      setRules((current) =>
        current.flatMap((entry) => {
          if (entry.id === rule.id) return [saved];
          const sameMatch =
            entry.matchKind === rule.matchKind && entry.matchValue.toLowerCase() === value;
          return sameMatch ? [] : [entry];
        }),
      );
    },
  });
  const pending = change.pending;
  const error = change.error ? errorText(change.error, t`Could not save that preference`) : null;

  const canAdd = rules !== null && !loadError;
  useScreenHeader({
    action: canAdd
      ? {
          label: t`Add rule`,
          prominence: "secondary",
          onPress: () =>
            router.push({
              pathname: "/approval-rule-add",
              params: target.scope === "space" ? { spaceId: target.spaceId } : {},
            }),
        }
      : null,
  });

  const groupTitles: Record<ActionApprovalRule["effect"], string> = {
    always_allow: t`Always allow`,
    require_approval: t`Always ask`,
    deny: t`Blocked`,
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
              if (change.error) change.reset();
              void queryClient.resetQueries({ queryKey: rulesRead.queryKey });
              void refetchMode();
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
                      { id: "remove", title: t`Remove`, attributes: { destructive: true } },
                    ]}
                    colorScheme={colorScheme}
                    onPressAction={(event) => {
                      const action = event.nativeEvent.event;
                      if (isRuleAction(action)) change.run({ rule, action });
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
