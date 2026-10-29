import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { ArchivedBotList } from "../../components/archived-bot-list";
import { NativeActionButton } from "../../components/native-action-button";
import type { MobileBot, MobileGroup } from "../../lib/api";
import { captureApiRequestContext, rpc, selectSpace } from "../../lib/api";
import {
  loadAllArchivedChats as loadArchivedChats,
  notifyArchivedChatsChanged,
} from "../../lib/archived-chats";
import { confirmDeleteBot } from "../../lib/bot-lifecycle";
import { useFloatingHeaderInset } from "../../lib/floating-header";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { addToSearchInbox, searchInboxSession } from "../../lib/search-inbox";
import { openFromSettingsSheet } from "../../lib/settings-sheet";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

export default function ArchivedBots() {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const headerInset = useFloatingHeaderInset();
  const listRequest = useRef<AbortController | null>(null);
  const focusGeneration = useRef(0);
  const focused = useRef(false);
  const [bots, setBots] = useState<MobileBot[] | null>(null);
  const [groups, setGroups] = useState<MobileGroup[]>([]);
  const [pending, setPending] = useState(false);
  // Each list's load error stays until that list loads; restoring or deleting doesn't clear it.
  const [loadErrors, setLoadErrors] = useState<{ bots?: string; groups?: string }>({});
  const error = loadErrors.bots ?? loadErrors.groups ?? null;
  const loadChats = useCallback(async () => {
    listRequest.current?.abort();
    const request = new AbortController();
    listRequest.current = request;
    const loaded = await loadArchivedChats(request.signal);
    if (request.signal.aborted) return;
    listRequest.current = null;
    if (loaded.bots) setBots(loaded.bots);
    if (loaded.groups) setGroups(loaded.groups);
    const message = errorText(loaded.error, t("Could not load chats"));
    setLoadErrors({
      bots: loaded.bots ? undefined : message,
      groups: loaded.groups ? undefined : message,
    });
  }, [t]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void loadChats();
      return () => {
        focused.current = false;
        focusGeneration.current += 1;
        setPending(false);
        listRequest.current?.abort();
      };
    }, [loadChats]),
  );

  // Every restore and delete settles here. In the visit it started in, the row goes and both
  // lists reload: a group restores with its bots, and a bot's restore or deletion can bring its
  // group back or remove it. A load still running may predate the change, so it's restarted.
  // After leaving, a later open visit reloads instead.
  function removed(generation: number, removeRow: () => void) {
    notifyArchivedChatsChanged();
    if (generation !== focusGeneration.current) {
      if (focused.current) void loadChats();
      return;
    }
    removeRow();
    void loadChats();
  }

  async function mutate(request: () => Promise<unknown>, removeRow: () => void, failure: string) {
    if (pending) return;
    setPending(true);
    const generation = focusGeneration.current;
    try {
      await request();
      removed(generation, removeRow);
    } catch (cause) {
      if (generation === focusGeneration.current) {
        Alert.alert(failure, errorText(cause, t("Try again.")));
      }
    } finally {
      if (generation === focusGeneration.current) setPending(false);
    }
  }

  async function requestOptions(spaceId: string | undefined) {
    const context = await captureApiRequestContext();
    return {
      skipSpaceAuthRecovery: true,
      requestContext: {
        ...context,
        headers: { ...context.headers, ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}) },
      },
    };
  }

  async function inSpace(spaceId: string | undefined) {
    if (spaceId && !(await selectSpace(spaceId))) throw new Error(t("Could not switch spaces"));
  }

  function restoreGroup(group: MobileGroup) {
    void mutate(
      async () => {
        return rpc("groups/restore", { groupId: group.id }, await requestOptions(group.spaceId));
      },
      () => setGroups((current) => current.filter((item) => item.id !== group.id)),
      t("Could not update chat"),
    );
  }

  function withoutBot(botId: string) {
    return () => setBots((current) => current?.filter((item) => item.id !== botId) ?? null);
  }

  function restore(bot: MobileBot) {
    void mutate(
      async () => {
        await rpc("bots/restore", { botId: bot.id }, await requestOptions(bot.spaceId));
      },
      withoutBot(bot.id),
      t("Could not restore bot"),
    );
  }

  async function remove(bot: MobileBot) {
    if (pending) return;
    const generation = focusGeneration.current;
    let options: Awaited<ReturnType<typeof requestOptions>>;
    try {
      options = await requestOptions(bot.spaceId);
    } catch (cause) {
      Alert.alert(t("Could not delete bot"), errorText(cause, t("Try again.")));
      return;
    }
    if (generation !== focusGeneration.current) return;
    confirmDeleteBot(
      bot,
      () => removed(generation, withoutBot(bot.id)),
      () => generation === focusGeneration.current,
      options.requestContext,
    );
  }

  async function open(bot: MobileBot) {
    if (pending) return;
    setPending(true);
    const generation = focusGeneration.current;
    const askedIn = searchInboxSession();
    try {
      await inSpace(bot.spaceId);
      await rpc("threads/get", { botId: bot.id });
      // Left or dismissed while loading, even if back since: a later sheet must not close for it.
      if (generation !== focusGeneration.current) return;
      addToSearchInbox({ kind: "bot", bot }, askedIn);
      // The thread is not a settings page, so it opens on the root stack once the sheet closes.
      openFromSettingsSheet(router, {
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
      <NativeActionButton label={t("Try again.")} onPress={() => void loadChats()} fill={false} />
    </>
  ) : null;
  if (!bots?.length && !groups.length)
    return (
      <ScrollView
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 24, gap: 12 }}
      >
        {failure ??
          (bots ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("No archived chats")}</Text>
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
        bots={bots ?? []}
        groups={groups}
        pending={pending}
        onOpen={(bot) => void open(bot)}
        onRestore={restore}
        onDelete={remove}
        onRestoreGroup={restoreGroup}
      />
    </>
  );
}
