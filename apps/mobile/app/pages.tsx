import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { PageIcon } from "@rakazo/chat-ui/native";
import type { PageSummary } from "@rakazo/contracts";
import { PAGE_TITLE_MAX_LENGTH } from "@rakazo/contracts";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { LongPressMenu } from "../components/long-press-menu";
import { PageLoadFailure } from "../components/pages/page-load-failure";
import { useTextEditDialog } from "../components/profile-edit-dialog";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { formatActivityRelativeTime } from "../lib/activity";
import { rpc } from "../lib/api";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { getLatestPage, removePage, renamePage } from "../lib/pages";
import { usePagedPages } from "../lib/use-paged-pages";

/** The bot's pages, pinned first and then most recently updated. */
export default function PagesScreen() {
  const { botId, groupId } = useLocalSearchParams<{ botId?: string; groupId?: string }>();
  const router = useRouter();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { listed, showMore, refresh } = usePagedPages({ botId, groupId });
  const [problem, setProblem] = useState<string | null>(null);
  const rename = useTextEditDialog(t`Rename`, PAGE_TITLE_MAX_LENGTH);

  if (listed.status !== "ready") {
    return (
      <View style={styles.center}>
        {listed.status === "loading" ? (
          <ActivityIndicator color={tokens.mutedForeground} />
        ) : (
          <PageLoadFailure
            error={listed.error}
            fallback={t`Could not load pages.`}
            onRetry={refresh}
          />
        )}
      </View>
    );
  }
  if (listed.items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={[styles.message, { color: tokens.mutedForeground }]}>
          {groupId
            ? t`Pages this group builds for you appear here.`
            : t`Pages this bot builds for you appear here.`}
        </Text>
      </View>
    );
  }
  const open = (page: PageSummary) =>
    router.push({ pathname: "/page", params: { pageId: page.id } });
  // A failed change may still have been made with only its answer lost: the list is read again.
  const failed = (message: string) => () => {
    setProblem(message);
    refresh();
  };
  const act = (page: PageSummary, action: string) => {
    setProblem(null);
    if (action === "open") open(page);
    else if (action === "rename") {
      rename.ask(page.title, (title) => {
        if (!title || title === page.title) return;
        void renamePage(page.id, title).then(refresh, failed(t`Could not rename the page.`));
      });
    } else if (action === "share")
      router.push({ pathname: "/page-share", params: { pageId: page.id } });
    else if (action === "copy") {
      void getLatestPage(page.id, { refresh: true, link: true })
        .then(async (detail) => {
          // Turned off elsewhere since the list was read: the list catches up instead.
          if (detail.shareUrl) await Clipboard.setStringAsync(detail.shareUrl);
          else refresh();
        })
        .catch(() => setProblem(t`Could not copy the link.`));
    } else if (action === "pin") {
      void rpc("pages/pin", { pageId: page.id, pinned: !page.pinned }).then(
        refresh,
        failed(t`Could not pin the page.`),
      );
    } else if (action === "delete") {
      Alert.alert(
        t`Delete ${ph({ name: page.title })}?`,
        t`Its link stops working. This cannot be undone.`,
        [
          { text: t`Cancel`, style: "cancel" },
          {
            text: t`Delete`,
            style: "destructive",
            onPress: () =>
              void removePage(page.id).then(refresh, failed(t`Could not delete the page.`)),
          },
        ],
      );
    }
  };
  const row = (page: PageSummary) => (
    <LongPressMenu
      key={page.id}
      colorScheme={colorScheme}
      title={page.title}
      actions={[
        { id: "open", title: t`Open` },
        { id: "rename", title: t`Rename` },
        { id: "share", title: t`Share` },
        ...(page.visibility === "link" ? [{ id: "copy", title: t`Copy link` }] : []),
        { id: "pin", title: page.pinned ? t`Unpin` : t`Pin` },
        { id: "delete", title: t`Delete`, attributes: { destructive: true } },
      ]}
      onPressAction={(event) => act(page, event.nativeEvent.event)}
    >
      {(onLongPress) => (
        <SettingsRow
          accessibilityRole="button"
          chevron="right"
          title={page.title}
          detail={`${page.visibility === "link" ? `${t`Shared`} · ` : ""}${formatActivityRelativeTime(page.updatedAt)}`}
          leading={<PageIcon colors={tokens} width={26} />}
          onPress={() => open(page)}
          onLongPress={onLongPress}
        />
      )}
    </LongPressMenu>
  );
  const pinned = listed.items.filter((page) => page.pinned);
  const rest = listed.items.filter((page) => !page.pinned);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      {problem ? (
        <Text accessibilityRole="alert" style={[styles.problem, { color: tokens.destructive }]}>
          {problem}
        </Text>
      ) : null}
      {pinned.length ? <SettingsGroup label={t`Pinned`}>{pinned.map(row)}</SettingsGroup> : null}
      {rest.length ? <SettingsGroup>{rest.map(row)}</SettingsGroup> : null}
      {rename.dialog}
      {listed.nextCursor ? (
        <SettingsGroup>
          <SettingsRow
            key="more"
            accessibilityRole="button"
            title={t`Show more`}
            onPress={() => void showMore().catch(() => setProblem(t`Could not load pages.`))}
          />
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  message: { fontSize: 15, textAlign: "center" },
  problem: { paddingHorizontal: 20, paddingTop: 12, fontSize: 13 },
});
