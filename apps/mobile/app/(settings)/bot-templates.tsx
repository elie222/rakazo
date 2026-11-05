import { ChatMarkdown } from "@rakazo/chat-ui/native";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotTemplateIcon } from "../../components/bot-template-icon";
import { NativeActionButton } from "../../components/native-action-button";
import { Chevron } from "../../components/row-accessories";
import { botTemplateCopy } from "../../lib/bot-template-copy";
import { useI18n } from "../../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery } from "../../lib/query";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/** Ready-made bots: the featured one with an example of what it sends, then the rest. */
export default function BotTemplatesScreen() {
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const templates = useQuery(rpcQuery("bots/templates"), queryClient);
  const { refetch } = templates;
  const [featured, ...others] = templates.data ?? [];
  const featuredCopy = featured ? botTemplateCopy(featured) : null;
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
        {templates.error && !featured ? (
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
        {featured && featuredCopy ? (
          <Pressable
            testID="bot-template-featured"
            accessibilityRole="button"
            accessibilityLabel={featuredCopy.name}
            onPress={() => open(featured.id)}
            style={({ pressed }) => [styles.featured, pressed && styles.pressed]}
          >
            <View style={styles.rowContent}>
              <BotTemplateIcon id={featured.id} size={40} />
              <View style={styles.grow}>
                <Text numberOfLines={1} style={styles.title}>
                  {featuredCopy.name}
                </Text>
                <Text numberOfLines={1} style={styles.secondary}>
                  {featuredCopy.summary}
                </Text>
              </View>
              <Chevron />
            </View>
            <View style={styles.sample}>
              <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
                {featuredCopy.sample}
              </ChatMarkdown>
            </View>
          </Pressable>
        ) : null}
        {others.length ? (
          <View style={styles.list}>
            {others.map((template) => {
              const { name, summary } = botTemplateCopy(template);
              return (
                <Pressable
                  key={template.id}
                  testID="bot-template-row"
                  accessibilityRole="button"
                  accessibilityLabel={name}
                  onPress={() => open(template.id)}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                >
                  <BotTemplateIcon id={template.id} />
                  <View style={styles.grow}>
                    <Text numberOfLines={1} style={styles.title}>
                      {name}
                    </Text>
                    <Text numberOfLines={1} style={styles.secondary}>
                      {summary}
                    </Text>
                  </View>
                  <Chevron />
                </Pressable>
              );
            })}
          </View>
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
    featured: {
      padding: 14,
      borderRadius: 18,
      borderCurve: "continuous",
      backgroundColor: native.fill,
      gap: 12,
    },
    rowContent: { flexDirection: "row", alignItems: "center", gap: 10 },
    sample: {
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 12,
      borderCurve: "continuous",
      backgroundColor: native.page,
    },
    row: {
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 14,
      backgroundColor: native.fill,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    pressed: { backgroundColor: native.fillPressed },
    grow: { flex: 1, gap: 2, minWidth: 0 },
    title: { color: native.label, fontSize: 15, fontWeight: "500" },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    error: { color: native.secondaryLabel, fontSize: 14 },
  });
}
