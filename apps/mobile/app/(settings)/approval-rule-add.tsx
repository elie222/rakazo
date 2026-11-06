import type { ApprovalRuleChoice } from "@rakazo/core";
import { approvalRuleChoices, listSearch } from "@rakazo/core";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/**
 * Picks the app or tool a new rule names, searchable from the header, so nobody types a tool's
 * name. The rule starts as Always ask; the rules screen moves it.
 */
export default function AddApprovalRule() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useI18n();
  const router = useRouter();
  const navigation = useNavigation();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [choices, setChoices] = useState<ApprovalRuleChoice[] | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void Promise.all([
      rpc("approvalRules/list", { scope }),
      // Only offers apps, so a failed read just leaves them out.
      rpc("connections/list").catch(() => []),
    ])
      .then(([rules, connections]) => {
        if (current) setChoices(approvalRuleChoices({ connections, rules }));
      })
      .catch((err: unknown) => {
        if (current) setError(errorText(err, t("Something went wrong. Try again.")));
      });
    return () => {
      current = false;
    };
  }, [attempt, rpc, scope, t]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t("Search apps and tools"),
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
      if (pending) return;
      setPending(true);
      setError(null);
      try {
        await rpc("approvalRules/set", {
          scope,
          effect: "require_approval",
          matchKind: choice.matchKind,
          matchValue: choice.matchValue,
        });
        router.back();
      } catch (err) {
        setError(errorText(err, t("Could not save that preference")));
      } finally {
        setPending(false);
      }
    },
    [pending, router, rpc, scope, t],
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
        <SettingsGroup label={t("Apps")}>
          {visible.filter((choice) => choice.matchKind === "connector").map(row)}
        </SettingsGroup>
        <SettingsGroup label={t("Tools")}>
          {visible.filter((choice) => choice.matchKind === "tool").map(row)}
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
