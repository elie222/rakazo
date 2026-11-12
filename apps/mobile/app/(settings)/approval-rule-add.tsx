import { useLingui } from "@lingui/react/macro";
import type { ApprovalRuleChoice } from "@rakazo/core";
import { approvalRuleChoices, listSearch } from "@rakazo/core";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { native, useThemedStyles } from "../../lib/native";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/**
 * Picks the built-in tool a new rule names, searchable from the header, so nobody types a tool's
 * name. The rule starts as Always ask; the rules screen moves it.
 */
export default function AddApprovalRule() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useLingui();
  const router = useRouter();
  const navigation = useNavigation();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [choices, setChoices] = useState<ApprovalRuleChoice[] | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Set synchronously, so a second tap before the re-render can't save twice and go back twice.
  const saving = useRef(false);

  useEffect(() => {
    let current = true;
    void rpc("approvalRules/list", { scope })
      .then((rules) => {
        if (current) setChoices(approvalRuleChoices(rules));
      })
      .catch((err: unknown) => {
        if (current) setError(errorText(err, t`Something went wrong. Try again.`));
      });
    return () => {
      current = false;
    };
  }, [attempt, rpc, scope, t]);

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

  const add = useCallback(
    async (choice: ApprovalRuleChoice) => {
      if (saving.current) return;
      saving.current = true;
      setPending(true);
      setError(null);
      try {
        await rpc("approvalRules/set", {
          scope,
          effect: "require_approval",
          matchKind: choice.matchKind,
          matchValue: choice.matchValue,
        });
        // Opened by a link as the first screen, there is nothing to go back to.
        if (router.canGoBack()) router.back();
        else router.replace({ pathname: "/approvals", params: spaceId ? { spaceId } : {} });
      } catch (err) {
        setError(errorText(err, t`Could not save that preference`));
      } finally {
        saving.current = false;
        setPending(false);
      }
    },
    [router, rpc, scope, spaceId, t],
  );

  const { visible } = listSearch(choices ?? [], query, {
    text: (choice) => [choice.label, choice.matchValue],
  });
  const row = (choice: ApprovalRuleChoice) => (
    <SettingsRow
      key={`${choice.matchKind}:${choice.matchValue}`}
      accessibilityRole="button"
      disabled={pending}
      onPress={() => void add(choice)}
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
            onRetry={() => {
              setError(null);
              setAttempt((count) => count + 1);
            }}
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
