import { MenuView } from "@expo/ui/community/menu";
import type { ActionApprovalRule } from "@rakazo/contracts";
import { humanizeToolName, toolNameFromLabel } from "@rakazo/core";
import { useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { TextFieldDialog } from "../../components/name-dialog";
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
 * The tools and sites allowed, asked about or blocked. Rules come from approval cards or are
 * added here by tool name; the approval mode itself is a row in settings. Opened with a Space,
 * it edits that Space's override instead of the account's.
 */
export default function ApprovalRules() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useI18n();
  const navigation = useNavigation();
  const colorScheme = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  // Null until the first load lands.
  const [rules, setRules] = useState<ActionApprovalRule[] | null>(null);
  // The Android field's text while it is open; iOS uses the system prompt.
  const [draft, setDraft] = useState<string | null>(null);
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

  const addTool = (entered: string) =>
    save(async () => {
      const name = toolNameFromLabel(entered);
      // An existing rule keeps its effect; changing it stays an explicit choice in the list.
      const exists = rules?.some(
        (rule) => rule.matchKind === "tool" && rule.matchValue.toLowerCase() === name.toLowerCase(),
      );
      if (exists) {
        setDraft(null);
        return;
      }
      const saved = await rpc("approvalRules/set", {
        scope,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: name,
      });
      const value = saved.matchValue.toLowerCase();
      setRules((current) => [
        ...(current ?? []).filter(
          (entry) => entry.matchKind !== "tool" || entry.matchValue.toLowerCase() !== value,
        ),
        saved,
      ]);
      setDraft(null);
    });
  const addToolRef = useRef(addTool);
  addToolRef.current = addTool;

  const canAdd = rules !== null && !loadError;
  useLayoutEffect(() => {
    if (!canAdd) {
      navigation.setOptions(
        iosAtLeast(26) ? { unstable_headerRightItems: () => [] } : { headerRight: () => null },
      );
      return;
    }
    const open = () => {
      if (Platform.OS !== "ios") {
        setError(null);
        setDraft("");
        return;
      }
      Alert.prompt(t("Add rule"), undefined, [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Save"),
          onPress: (entered?: string) => {
            if (entered?.trim()) void addToolRef.current(entered);
          },
        },
      ]);
    };
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
  }, [canAdd, navigation, t]);

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
      {draft !== null ? (
        <TextFieldDialog
          title={t("Add rule")}
          label={t("Tool name")}
          submitLabel={t("Save")}
          value={draft}
          error={error}
          saving={pending}
          input={{ autoCapitalize: "none", autoCorrect: false, maxLength: 253 }}
          onChange={setDraft}
          onSubmit={(name) => void addTool(name)}
          onClose={() => setDraft(null)}
        />
      ) : null}
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
