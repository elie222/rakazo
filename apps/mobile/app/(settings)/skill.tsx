import type { AgentSkill } from "@rakazo/contracts";
import type { NativeStackNavigationOptions } from "expo-router";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

Steps the agent should follow.
`;

/** One skill's SKILL.md: your own skills are edited here, built-in and plugin skills only read. */
export default function SkillScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const navigation = useNavigation();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const [skill, setSkill] = useState<AgentSkill | null>(null);
  const [draft, setDraft] = useState(params.id ? "" : NEW_SKILL_TEMPLATE);
  const [loading, setLoading] = useState(Boolean(params.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    live.current = true;
    if (params.id) {
      setLoading(true);
      setError(null);
      rpc("agentSkills/get", { skillId: params.id })
        .then((found) => {
          if (!live.current) return;
          setSkill(found);
          setDraft(found.content);
        })
        .catch((reason) => {
          if (live.current) setError(errorText(reason, t("Could not load skill")));
        })
        .finally(() => {
          if (live.current) setLoading(false);
        });
    }
    return () => {
      live.current = false;
    };
  }, [params.id, t, attempt]);

  // An existing skill that failed to load must not be saved as a new one.
  const unloaded = Boolean(params.id) && !skill;
  const readOnly = Boolean(skill?.readOnly);
  const canSave =
    !readOnly && !unloaded && !busy && Boolean(draft.trim()) && draft !== (skill?.content ?? "");

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (skill) setSkill(await rpc("agentSkills/update", { skillId: skill.id, content: draft }));
      else {
        await rpc("agentSkills/create", { content: draft });
        router.back();
      }
    } catch (reason) {
      if (live.current) setError(errorText(reason, t("Could not save skill")));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const saveRef = useRef(save);
  saveRef.current = save;

  function confirmDelete() {
    if (!skill) return;
    Alert.alert(t("Delete {name}?", { name: skill.name }), undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          setError(null);
          rpc("agentSkills/remove", { skillId: skill.id })
            .then(() => router.back())
            .catch((reason) => {
              if (!live.current) return;
              setError(errorText(reason, t("Could not delete skill")));
              setBusy(false);
            });
        },
      },
    ]);
  }

  useLayoutEffect(() => {
    const title = skill?.name ?? (params.id ? "" : t("New skill"));
    navigation.setOptions({
      title,
      ...(readOnly
        ? { headerRight: undefined, unstable_headerRightItems: undefined }
        : iosAtLeast(26)
          ? {
              unstable_headerRightItems: () => [
                {
                  type: "button" as const,
                  label: t("Save"),
                  variant: "prominent" as const,
                  tintColor: mobileTokens().primary,
                  disabled: !canSave,
                  onPress: () => void saveRef.current(),
                },
              ],
            }
          : {
              headerRight: () => (
                <NativeActionButton
                  disabled={!canSave}
                  fill={false}
                  label={t("Save")}
                  onPress={() => void saveRef.current()}
                />
              ),
            }),
    } satisfies NativeStackNavigationOptions);
  }, [navigation, skill?.name, params.id, readOnly, canSave, t]);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t("Loading…")} />
        ) : unloaded ? null : (
          <TextInput
            value={draft}
            onChangeText={setDraft}
            accessibilityLabel="SKILL.md"
            editable={!readOnly && !busy}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            style={styles.editor}
          />
        )}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {unloaded && !loading ? (
          <NativeActionButton
            fill={false}
            label={t("Retry")}
            onPress={() => setAttempt((count) => count + 1)}
            prominence="secondary"
          />
        ) : null}
        {skill && !readOnly ? (
          <NativeActionButton
            disabled={busy}
            fill={false}
            label={t("Delete")}
            onPress={confirmDelete}
            prominence="destructive"
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 14 },
    editor: {
      minHeight: 320,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      padding: 14,
      fontSize: 14,
      lineHeight: 20,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    error: { color: mobileTokens().destructive, fontSize: 13 },
  });
}
