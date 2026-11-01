import { MenuView } from "@expo/ui/community/menu";
import type { ActionApprovalRule } from "@rakazo/contracts";
import { humanizeToolName } from "@rakazo/core";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

type RuleAction = "always_allow" | "require_approval" | "deny" | "remove";

/**
 * The tools and sites allowed, blocked or requiring approval. This screen
 * can add tool rules and switch or remove saved rules. The approval mode is in settings. With a
 * Space, it edits that Space's override instead of the account's.
 */
export default function ApprovalRules() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  // Null until the first load lands.
  const [rules, setRules] = useState<ActionApprovalRule[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [tool, setTool] = useState("");
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
      if (action === rule.effect || rule.matchKind === "category") return;
      const saved = await rpc("approvalRules/set", {
        scope,
        effect: action,
        matchKind: rule.matchKind,
        matchValue: rule.matchValue,
      });
      // Saving replaces any other effect on the same match.
      setRules(
        (current) =>
          current?.flatMap((entry) => {
            if (entry.id === rule.id) return [saved];
            const sameMatch =
              entry.matchKind === rule.matchKind && entry.matchValue === rule.matchValue;
            return sameMatch ? [] : [entry];
          }) ?? null,
      );
    });

  const effectLabel = (effect: ActionApprovalRule["effect"]) =>
    effect === "always_allow" ? t("Allow") : effect === "deny" ? t("Block") : t("Ask");

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
        {rules ? (
          <NativeActionButton
            label={t("Add rule")}
            disabled={pending}
            onPress={() => setAdding(!adding)}
          />
        ) : null}
        {adding ? (
          <View style={{ gap: 12 }}>
            <TextInput
              accessibilityLabel={t("Tool name")}
              placeholder={t("Tool name")}
              value={tool}
              onChangeText={setTool}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={200}
              editable={!pending}
              style={{ color: mobileTokens().foreground, padding: 12 }}
            />
            <NativeActionButton
              label={t("Save")}
              disabled={pending || !tool.trim()}
              onPress={() =>
                void save(async () => {
                  const saved = await rpc("approvalRules/set", {
                    scope,
                    matchKind: "tool",
                    matchValue: tool.trim(),
                    effect: "require_approval",
                  });
                  setRules((current) => [
                    ...(current ?? []).filter(
                      (rule) =>
                        rule.matchKind !== saved.matchKind ||
                        rule.matchValue.toLowerCase() !== saved.matchValue.toLowerCase(),
                    ),
                    saved,
                  ]);
                  setTool("");
                  setAdding(false);
                })
              }
            />
          </View>
        ) : null}
        <SettingsGroup>
          {rules?.map((rule) => {
            const title =
              rule.matchKind === "tool" ? humanizeToolName(rule.matchValue) : rule.matchValue;
            const switchable = rule.matchKind !== "category";
            return (
              <MenuView
                key={rule.id}
                actions={[
                  ...(switchable
                    ? (["always_allow", "require_approval", "deny"] as const).map((effect) => ({
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
