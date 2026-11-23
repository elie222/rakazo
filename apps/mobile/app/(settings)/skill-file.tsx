import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native/native-action-button";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { useScreenHeader } from "../../lib/navigation/screen-header";
import { queryClient, rpcQuery } from "../../lib/query/query";

/** One file kept beside a skill's SKILL.md, shown exactly as written. */
export default function SkillFileScreen() {
  const { id, path } = useLocalSearchParams<{ id?: string; path?: string }>();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const fileQuery = useQuery(
    {
      ...rpcQuery("agentSkills/getFile", { skillId: id ?? "", path: path ?? "" }),
      enabled: Boolean(id && path),
    },
    queryClient,
  );
  const file = fileQuery.data;

  useScreenHeader({ title: path?.split("/").at(-1) ?? "", action: null });

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {path?.includes("/") ? <Text style={styles.path}>{path}</Text> : null}
        {file ? (
          <Text selectable style={styles.text}>
            {file.content}
          </Text>
        ) : fileQuery.error ? (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {errorText(fileQuery.error, t`Could not load file`)}
            </Text>
            <NativeActionButton
              fill={false}
              label={t`Retry`}
              onPress={() => void fileQuery.refetch()}
              prominence="secondary"
            />
          </>
        ) : (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 12 },
    path: { color: native.secondaryLabel, fontSize: 13 },
    text: {
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
