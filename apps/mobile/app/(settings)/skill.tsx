import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
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
import { mobileTokens } from "../../lib/appearance";
import { native, useThemedStyles } from "../../lib/native";
import { formRead, queryClient, rpcQuery, useSave } from "../../lib/query";
import { useScreenHeader } from "../../lib/screen-header";
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
  const { id } = useLocalSearchParams<{ id?: string }>();
  // A different skill in the same screen starts from its own content, never the previous one's.
  return <SkillEditor key={id ?? ""} id={id} />;
}

function SkillEditor({ id }: { id?: string }) {
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const skillRead = formRead(rpcQuery("agentSkills/get", { skillId: id ?? "" }));
  const skillQuery = useQuery({ ...skillRead, enabled: Boolean(id) }, queryClient);
  const skill = skillQuery.data ?? null;
  const loading = skillQuery.isFetching && !skill;
  const [edited, setDraft] = useState<string | null>(null);
  const draft = edited ?? skill?.content ?? (id ? "" : NEW_SKILL_TEMPLATE);

  const save = useSave({
    save: async (content: string, send) => {
      if (skill) return send("agentSkills/update", { skillId: skill.id, content });
      await send("agentSkills/create", { content });
      return null;
    },
    onSaved: (saved) => {
      if (saved) queryClient.setQueryData(skillRead.queryKey, saved);
      else router.back();
    },
  });
  const remove = useSave({
    save: (skillId: string, send) => send("agentSkills/remove", { skillId }),
    onSaved: () => router.back(),
    closesScreen: true,
  });
  const busy = save.pending || remove.pending;
  const error = save.error
    ? errorText(save.error, t`Could not save skill`)
    : remove.error
      ? errorText(remove.error, t`Could not delete skill`)
      : skillQuery.error
        ? errorText(skillQuery.error, t`Could not load skill`)
        : null;

  // An existing skill that failed to load must not be saved as a new one.
  const unloaded = Boolean(id) && !skill;
  const readOnly = Boolean(skill?.readOnly);
  const canSave = !unloaded && Boolean(draft.trim()) && draft !== (skill?.content ?? "");

  function confirmDelete() {
    if (!skill) return;
    Alert.alert(t`Delete ${ph({ name: skill.name })}?`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      {
        text: t`Delete`,
        style: "destructive",
        onPress: () => {
          save.reset();
          remove.run(skill.id);
        },
      },
    ]);
  }

  useScreenHeader({
    title: skill?.name ?? (id ? "" : t`New skill`),
    action: readOnly
      ? null
      : {
          label: t`Save`,
          disabled: !canSave,
          busy,
          onPress: () => {
            remove.reset();
            save.run(draft);
          },
        },
  });

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
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
            label={t`Retry`}
            onPress={() => void skillQuery.refetch()}
            prominence="secondary"
          />
        ) : null}
        {skill && !readOnly ? (
          <NativeActionButton
            disabled={busy}
            fill={false}
            label={t`Delete`}
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
