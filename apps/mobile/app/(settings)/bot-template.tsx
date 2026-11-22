import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { Bot, BotTemplateListing } from "@rakazo/contracts";
import { isBotTemplateChanged } from "@rakazo/contracts";
import { botTemplateApps, formatCron } from "@rakazo/core";
import { cronLabels } from "@rakazo/i18n/cron";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { BotTemplateIcon } from "../../components/bots/bot-template-icon";
import { ConnectorIcon } from "../../components/integrations/connector-icon";
import { SkillSymbol } from "../../components/integrations/skill-symbol";
import { NativeActionButton } from "../../components/native/native-action-button";
import { NativeSymbol } from "../../components/native/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { errorText } from "../../lib/api/user-error";
import { botTemplateCopy } from "../../lib/bots/bot-template-copy";
import { useUiLocale } from "../../lib/i18n/i18n";
import { useSideInsets } from "../../lib/layout/side-insets";
import {
  native,
  useMobileTokens,
  useResolvedAppearance,
  useThemedStyles,
} from "../../lib/native/native";
import { queryClient, rpcQuery, useSave } from "../../lib/query/query";
import type { SearchInboxSession } from "../../lib/search/search-inbox";
import { addToSearchInbox, searchInboxSession } from "../../lib/search/search-inbox";
import { openFromSettingsSheet } from "../../lib/settings/settings-sheet";

/** One template: what it sends, what it adds, and the apps it works with. */
export default function BotTemplateScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const { t } = useLingui();
  const templates = useQuery(rpcQuery("bots/templates"), queryClient);
  const template = templates.data?.find((item) => item.id === id);

  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      {template ? (
        <TemplateDetail template={template} onChanged={() => void templates.refetch()} />
      ) : templates.isPending ? (
        <ActivityIndicator color={tokens.mutedForeground} accessibilityLabel={t`Loading…`} />
      ) : templates.isError ? (
        <View style={styles.failure}>
          <Text style={styles.secondary}>
            {errorText(templates.error, t`Could not load templates`)}
          </Text>
          <NativeActionButton
            fill={false}
            label={t`Retry`}
            onPress={() => void templates.refetch()}
            prominence="secondary"
          />
        </View>
      ) : (
        <Text style={styles.secondary}>{t`This template is no longer available.`}</Text>
      )}
    </ScrollView>
  );
}

type AddedRow = { key: string; title: string; detail: string; body: string; icon: ReactNode };

function TemplateDetail({
  template,
  onChanged,
}: {
  template: BotTemplateListing;
  onChanged: () => void;
}) {
  const router = useRouter();
  const navigation = useNavigation();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useLingui();
  const locale = useUiLocale();
  const { name, summary, sample } = botTemplateCopy(template);
  const { botId } = template;
  const [expanded, setExpanded] = useState<string | null>(null);
  const catalog = useQuery(
    { ...rpcQuery("connections/catalog", {}), enabled: template.apps.length > 0 },
    queryClient,
  );
  const apps = botTemplateApps(template, catalog.data ?? []);
  const labels = cronLabels(locale);
  const rows: AddedRow[] = [
    {
      key: "bot",
      title: name,
      detail: t`Instructions`,
      body: template.instructions,
      icon: <NativeSymbol ios="text.alignleft" android="reader-outline" size={16} />,
    },
    ...template.skills.map((skill) => ({
      key: `skill:${skill.name}`,
      title: skill.name,
      detail: t`Skill`,
      body: skill.body,
      icon: <SkillSymbol size={16} />,
    })),
    ...template.routines.map((routine, index) => ({
      key: `routine:${index}`,
      title: routine.name,
      detail: t`${ph({ schedule: routine.crons.map((cron) => formatCron(cron, labels)).join(", ") })}, paused until you turn it on`,
      body: routine.prompt,
      icon: <NativeSymbol ios="clock" android="time-outline" size={16} />,
    })),
  ];

  function openBot(bot: Pick<Bot, "id" | "name">) {
    // The chat is not a settings page, so it opens on the root stack once the sheet closes.
    openFromSettingsSheet(router, {
      pathname: "/thread",
      params: { botId: bot.id, name: bot.name },
    });
  }

  const open = useSave({
    save: async (
      { existingId }: { existingId: string | null; askedIn: SearchInboxSession },
      send,
    ) =>
      existingId
        ? queryClient.fetchQuery({ ...rpcQuery("bots/get", { botId: existingId }), staleTime: 0 })
        : (
            await send("bots/createFromTemplate", {
              templateId: template.id,
              version: template.version,
              name,
            })
          ).bot,
    onSaved: (bot, { askedIn }) => {
      // An answer that lands once the screen is covered doesn't open its bot from elsewhere.
      if (!navigation.isFocused()) return;
      addToSearchInbox({ kind: "bot", bot }, askedIn);
      openBot(bot);
    },
    onFailed: (cause, { existingId }) => {
      if (!navigation.isFocused()) return;
      if (existingId) Alert.alert(t`Could not load bot`, errorText(cause, t`Try again.`));
      else if (isBotTemplateChanged(cause)) {
        Alert.alert(t`This template was just updated. Check it again.`);
        onChanged();
      } else Alert.alert(t`Could not create the bot`, errorText(cause, t`Try again.`));
    },
  });

  return (
    <>
      <View style={styles.header}>
        <BotTemplateIcon id={template.id} size={56} />
        <View style={styles.grow}>
          <Text accessibilityRole="header" style={styles.name}>
            {name}
          </Text>
          <Text style={styles.secondary}>{summary}</Text>
        </View>
      </View>
      <NativeActionButton
        label={botId ? t`Open` : t`Create bot`}
        busy={open.pending}
        onPress={() => open.run({ existingId: botId, askedIn: searchInboxSession() })}
      />
      <View style={styles.sample}>
        <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
          {sample}
        </ChatMarkdown>
      </View>
      <SettingsGroup label={t`Adds`}>
        {rows.flatMap((row) => {
          const open = expanded === row.key;
          return [
            <SettingsRow
              key={row.key}
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              title={row.title}
              detail={row.detail}
              leading={row.icon}
              chevron={open ? "down" : "right"}
              onPress={() => setExpanded(open ? null : row.key)}
            />,
            ...(open
              ? [
                  <View key={`${row.key}:body`} style={styles.body}>
                    <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
                      {row.body}
                    </ChatMarkdown>
                  </View>,
                ]
              : []),
          ];
        })}
      </SettingsGroup>
      {apps.length ? (
        <SettingsGroup label={t`Works with`}>
          {apps.map((app) => (
            <SettingsRow
              key={app.slug}
              title={app.name}
              leading={<ConnectorIcon name={app.name} logo={app.logo} size={28} />}
              trailing={
                app.connected ? (
                  <View accessible accessibilityLabel={t`Connected`}>
                    <NativeSymbol
                      ios="checkmark.circle.fill"
                      android="checkmark-circle"
                      size={18}
                      color={tokens.success}
                    />
                  </View>
                ) : null
              }
            />
          ))}
        </SettingsGroup>
      ) : null}
    </>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 20, gap: 20 },
    failure: { gap: 10 },
    header: { flexDirection: "row", alignItems: "center", gap: 14 },
    grow: { flex: 1, gap: 2, minWidth: 0 },
    name: { color: native.label, fontSize: 22, fontWeight: "600" },
    secondary: { color: native.secondaryLabel, fontSize: 15 },
    sample: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 16,
      borderCurve: "continuous",
      backgroundColor: native.groupedCell,
    },
    body: { paddingHorizontal: 16, paddingBottom: 14, paddingTop: 10 },
  });
}
