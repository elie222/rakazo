import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotTemplateIcon } from "../../components/bot-template-icon";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { botTemplateCopy } from "../../lib/bot-template-copy";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery } from "../../lib/query";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/** Ready-made bots; each one's page shows an example of what it sends. */
export default function BotTemplatesScreen() {
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const templates = useQuery(rpcQuery("bots/templates"), queryClient);
  const { refetch } = templates;
  const open = (id: string) => router.push({ pathname: "/bot-template", params: { id } });

  // A bot made from a template, or deleted since, changes what each one opens.
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {templates.error && !templates.data ? (
          <View style={styles.list}>
            <Text style={styles.error}>
              {errorText(templates.error, t("Could not load templates"))}
            </Text>
            <NativeActionButton
              fill={false}
              label={t("Retry")}
              onPress={() => void refetch()}
              prominence="secondary"
            />
          </View>
        ) : null}
        {templates.isPending ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t("Loading…")} />
        ) : null}
        {templates.data?.length ? (
          <SettingsGroup>
            {templates.data.map((template) => {
              const { name, summary } = botTemplateCopy(template);
              return (
                <SettingsRow
                  key={template.id}
                  testID="bot-template-row"
                  accessibilityRole="button"
                  title={name}
                  detail={summary}
                  leading={<BotTemplateIcon id={template.id} />}
                  chevron="right"
                  onPress={() => open(template.id)}
                />
              );
            })}
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 14 },
    list: { gap: 8 },
    error: { color: native.secondaryLabel, fontSize: 14 },
  });
}
