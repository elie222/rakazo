import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { SettingsGroup, SettingsRow } from "../components/settings/settings-group";
import { errorText } from "../lib/api/user-error";
import { useMobileTokens } from "../lib/native/native";
import { useScreenHeader } from "../lib/navigation/screen-header";
import { PageLoadFailure } from "../lib/pages/page-load-failure";
import { usePageReviewSignals } from "../lib/pages/page-review-reads";
import { targetRpcQuery } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";
import { ACCOUNT_SETTINGS } from "../lib/query/settings-target";

export default function SharedPagesScreen() {
  const router = useRouter();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [cursor, setCursor] = useState<string>();
  const list = useScreenQuery(targetRpcQuery(ACCOUNT_SETTINGS, "pageReviews/list", { cursor }));
  usePageReviewSignals();
  useScreenHeader({ title: t`Pages shared with you` });
  const items = list.isError ? [] : (list.data?.items ?? []);
  const next = list.isError ? null : list.data?.nextCursor;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {list.isPending ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
      {list.error ? (
        <PageLoadFailure
          error={list.error}
          fallback={errorText(list.error)}
          retrying={list.isFetching}
          onRetry={() => void list.refetch()}
        />
      ) : null}
      {list.isSuccess && !items.length ? (
        <Text
          style={[styles.message, { color: tokens.mutedForeground }]}
        >{t`No pages shared with you yet.`}</Text>
      ) : null}
      <SettingsGroup>
        {items.map(({ id, title }) => (
          <SettingsRow
            key={id}
            title={title}
            chevron="right"
            onPress={() => router.push({ pathname: "/page-review", params: { pageId: id } })}
          />
        ))}
      </SettingsGroup>
      {cursor || next ? (
        <SettingsGroup>
          {cursor ? (
            <SettingsRow
              key="first"
              title={t`Back to first page`}
              onPress={() => setCursor(undefined)}
            />
          ) : null}
          {next ? (
            <SettingsRow key="more" title={t`Show more`} onPress={() => setCursor(next)} />
          ) : null}
        </SettingsGroup>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingVertical: 16, gap: 12 },
  message: { paddingHorizontal: 20 },
});
