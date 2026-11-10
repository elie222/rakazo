import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { Bot, BotTemplateListing } from "@rakazo/contracts";
import { isBotTemplateChanged } from "@rakazo/contracts";
import { botTemplateApps, formatCron } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { BotTemplateIcon } from "../../components/bot-template-icon";
import { ConnectorIcon } from "../../components/connector-icon";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { SkillSymbol } from "../../components/skill-symbol";
import { rpc } from "../../lib/api";
import { botTemplateCopy } from "../../lib/bot-template-copy";
import { cronLabels } from "../../lib/cron";
import { useUiLocale } from "../../lib/i18n";
import { native, useMobileTokens, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery } from "../../lib/query";
import { addToSearchInbox, searchInboxSession } from "../../lib/search-inbox";
import { openFromSettingsSheet } from "../../lib/settings-sheet";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

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
      ) : (
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
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useLingui();
  const locale = useUiLocale();
  const { name, summary, sample } = botTemplateCopy(template);
  const { botId } = template;
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Bumped on leaving, so a request that finishes later doesn't open its bot from elsewhere.
  const focusGeneration = useRef(0);
  useFocusEffect(
    useCallback(
      () => () => {
        focusGeneration.current += 1;
        setPending(false);
      },
      [],
    ),
  );
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

  async function create() {
    if (pending) return;
    setPending(true);
    const generation = focusGeneration.current;
    const askedIn = searchInboxSession();
    try {
      const { bot } = await rpc("bots/createFromTemplate", {
        templateId: template.id,
        version: template.version,
        name,
      });
      if (generation !== focusGeneration.current) return;
      addToSearchInbox({ kind: "bot", bot }, askedIn);
      openBot(bot);
    } catch (cause) {
      if (generation !== focusGeneration.current) return;
      if (isBotTemplateChanged(cause)) {
        Alert.alert(t`This template was just updated. Check it again.`);
        onChanged();
      } else {
        Alert.alert(t`Could not create the bot`, errorText(cause, t`Try again.`));
      }
    } finally {
      if (generation === focusGeneration.current) setPending(false);
    }
  }

  async function openExisting(existingId: string) {
    if (pending) return;
    setPending(true);
    const generation = focusGeneration.current;
    const askedIn = searchInboxSession();
    try {
      const bot = await rpc("bots/get", { botId: existingId });
      if (generation !== focusGeneration.current) return;
      addToSearchInbox({ kind: "bot", bot }, askedIn);
      openBot(bot);
    } catch (cause) {
      if (generation !== focusGeneration.current) return;
      Alert.alert(t`Could not load bot`, errorText(cause, t`Try again.`));
    } finally {
      if (generation === focusGeneration.current) setPending(false);
    }
  }

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
        busy={pending}
        onPress={() => void (botId ? openExisting(botId) : create())}
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
