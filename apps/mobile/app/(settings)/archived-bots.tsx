import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { ArchivedBotList } from "../../components/archived-bot-list";
import { NativeActionButton } from "../../components/native-action-button";
import type { MobileBot } from "../../lib/api";
import { rpc } from "../../lib/api";
import { confirmDeleteBot, restoreArchivedBot } from "../../lib/bot-lifecycle";
import { useFloatingHeaderInset } from "../../lib/floating-header";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { closeSettingsSheet } from "../../lib/settings-sheet";
import { errorText } from "../../lib/user-error";

export default function ArchivedBots() {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const headerInset = useFloatingHeaderInset();
  const listRequest = useRef<AbortController | null>(null);
  const focusGeneration = useRef(0);
  const [bots, setBots] = useState<MobileBot[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadBots = useCallback(async () => {
    listRequest.current?.abort();
    const request = new AbortController();
    listRequest.current = request;
    setError(null);
    try {
      const next = await rpc<MobileBot[]>("bots/listArchived", {}, { signal: request.signal });
      if (!request.signal.aborted) setBots(next);
    } catch (cause) {
      if (!request.signal.aborted) setError(errorText(cause, t("Could not load bots")));
    }
  }, [t]);
  useFocusEffect(
    useCallback(() => {
      void loadBots();
      return () => {
        focusGeneration.current += 1;
        setPending(false);
        listRequest.current?.abort();
      };
    }, [loadBots]),
  );

  function removed(botId: string) {
    listRequest.current?.abort();
    setError(null);
    setBots((current) => current?.filter((item) => item.id !== botId) ?? null);
  }

  async function restore(bot: MobileBot) {
    if (pending) return;
    setPending(true);
    try {
      await restoreArchivedBot(bot.id);
      removed(bot.id);
    } catch (cause) {
      Alert.alert(t("Could not restore bot"), errorText(cause, t("Try again.")));
    } finally {
      setPending(false);
    }
  }

  function remove(bot: MobileBot) {
    if (pending) return;
    confirmDeleteBot(bot, () => removed(bot.id));
  }

  async function open(bot: MobileBot) {
    if (pending) return;
    setPending(true);
    const generation = focusGeneration.current;
    try {
      await rpc("threads/get", { botId: bot.id });
      // Left or dismissed while loading, even if back since: a later sheet must not close for it.
      if (generation !== focusGeneration.current) return;
      // The thread is not a settings page, so it opens on the root stack once the sheet closes.
      closeSettingsSheet();
      router.push({
        pathname: "/thread",
        params: { botId: bot.id, name: bot.name, readOnly: "1" },
      });
    } catch (cause) {
      if (generation !== focusGeneration.current) return;
      Alert.alert(t("Could not load bot"), errorText(cause, t("Try again.")), [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Try again."),
          onPress: () => {
            if (generation === focusGeneration.current) void open(bot);
          },
        },
      ]);
    } finally {
      if (generation === focusGeneration.current) setPending(false);
    }
  }

  const failure = error ? (
    <>
      <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
        {error}
      </Text>
      <NativeActionButton label={t("Try again.")} onPress={() => void loadBots()} fill={false} />
    </>
  ) : null;
  if (!bots?.length)
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 24, gap: 12 }}
      >
        {failure ??
          (bots ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("No archived bots")}</Text>
          ) : (
            <ActivityIndicator color={tokens.foreground} />
          ))}
      </ScrollView>
    );
  return (
    <>
      {failure ? (
        <View style={{ paddingHorizontal: 24, paddingTop: headerInset + 24, gap: 12 }}>
          {failure}
        </View>
      ) : null}
      <ArchivedBotList
        bots={bots}
        pending={pending}
        onOpen={(bot) => void open(bot)}
        onRestore={(bot) => void restore(bot)}
        onDelete={remove}
      />
    </>
  );
}
