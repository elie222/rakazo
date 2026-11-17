import { useLingui } from "@lingui/react/macro";
import type { ApprovalRuleChoice } from "@rakazo/core";
import { approvalRuleChoices, listSearch } from "@rakazo/core";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useLayoutEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { native, useThemedStyles } from "../../lib/native";
import { queryClient, targetRpcQuery, useSave } from "../../lib/query";
import { useScreenQuery } from "../../lib/screen-query";
import { settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/**
 * Picks the built-in tool a new rule names, searchable from the header, so nobody types a tool's
 * name. The rule starts as Always ask; the rules screen moves it.
 */
export default function AddApprovalRule() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const scope = target.scope;
  const { t } = useLingui();
  const router = useRouter();
  const navigation = useNavigation();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const rulesRead = targetRpcQuery(target, "approvalRules/list", { scope });
  // Shows the list the rules screen holds, and reads it again as the picker opens.
  const rulesQuery = useScreenQuery(rulesRead);
  const choices = useMemo(
    () => (rulesQuery.data ? approvalRuleChoices(rulesQuery.data) : null),
    [rulesQuery.data],
  );
  const [query, setQuery] = useState("");
  const add = useSave({
    target,
    save: (choice: ApprovalRuleChoice, send) =>
      send("approvalRules/set", {
        scope,
        effect: "require_approval",
        matchKind: choice.matchKind,
        matchValue: choice.matchValue,
      }),
    // The picker leaves out tools that have a rule, so its list is read again with the save.
    stale: [rulesRead.queryKey],
    onSaved: () => {
      // Opened by a link as the first screen, there is nothing to go back to.
      if (router.canGoBack()) router.back();
      else router.replace({ pathname: "/approvals", params: spaceId ? { spaceId } : {} });
    },
    closesScreen: true,
  });
  const pending = add.pending;
  const loadError = rulesQuery.error
    ? errorText(rulesQuery.error, t`Something went wrong. Try again.`)
    : null;
  const error = add.error ? errorText(add.error, t`Could not save that preference`) : loadError;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t`Search tools`,
        hideWhenScrolling: false,
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        onClose: () => setQuery(""),
      },
    });
  }, [navigation, t]);

  const { visible } = listSearch(choices ?? [], query, {
    text: (choice) => [choice.label, choice.matchValue],
  });
  const row = (choice: ApprovalRuleChoice) => (
    <SettingsRow
      key={`${choice.matchKind}:${choice.matchValue}`}
      accessibilityRole="button"
      disabled={pending}
      onPress={() => add.run(choice)}
      title={choice.label}
    />
  );

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {error && !choices ? (
          <LoadFailure
            message={error}
            onRetry={() => void queryClient.resetQueries({ queryKey: rulesRead.queryKey })}
          />
        ) : error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {choices && visible.length === 0 ? (
          <Text style={styles.empty}>{t`No matches`}</Text>
        ) : (
          <SettingsGroup>{visible.map(row)}</SettingsGroup>
        )}
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
    empty: { color: tokens.mutedForeground, fontSize: 15, textAlign: "center", paddingTop: 24 },
  });
}
