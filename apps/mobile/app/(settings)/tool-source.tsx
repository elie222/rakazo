import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text } from "react-native";
import { sourceKindLabel } from "../../components/integrations/connected-apps";
import { NativeActionButton } from "../../components/native/native-action-button";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import {
  reachesOtherSpaces,
  SpaceAvailabilityPicker,
  useOwnSpaces,
} from "../../components/settings/space-availability";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { useScreenHeader } from "../../lib/navigation/screen-header";
import { rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";

/** A custom MCP, OpenAPI or GraphQL source: where it points, where it is available, removing it. */
export default function ToolSourceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const installsRead = rpcQuery("capabilities/list");
  const installs = useScreenQuery(installsRead);
  const source =
    installs.data?.find(
      (item) =>
        item.id === id && (item.kind === "mcp" || item.kind === "api" || item.kind === "graphql"),
    ) ?? null;
  const everywhere = reachesOtherSpaces(source?.availability, useOwnSpaces().length);
  const remove = useSave({
    save: (_, send) => send("capabilities/remove", { id }),
    stale: [installsRead.queryKey],
    onSaved: () => router.back(),
    closesScreen: true,
  });

  // A source removed, or moved out of this Space, leaves nothing to show once a fresh read says so.
  const gone = installs.isSuccess && !installs.isFetching && !source && !remove.pending;
  useEffect(() => {
    if (gone) router.back();
  }, [gone, router]);

  useScreenHeader({ title: source?.name ?? "" });

  const error = remove.error
    ? errorText(remove.error, t`Could not remove source`)
    : installs.error
      ? errorText(installs.error, t`Could not load integrations`)
      : null;

  function confirmRemove() {
    if (!source) return;
    Alert.alert(
      everywhere ? t`Remove from every space?` : t`Remove ${ph({ name: source.name })}?`,
      undefined,
      [
        { text: t`Cancel`, style: "cancel" },
        { text: t`Remove`, style: "destructive", onPress: () => remove.run() },
      ],
    );
  }

  return (
    <ScrollView
      style={[styles.screen, sideInsets]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      {!source && installs.isFetching ? (
        <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
      ) : null}
      {source ? (
        <>
          <SettingsGroup>
            <SettingsRow key="source" title={sourceKindLabel(source)} detail={source.source} />
          </SettingsGroup>
          <SpaceAvailabilityPicker
            kind="install"
            id={source.id}
            availability={source.availability}
            stale={[installsRead.queryKey]}
          />
          <NativeActionButton
            busy={remove.pending}
            fill={false}
            label={t`Remove`}
            onPress={confirmRemove}
            prominence="destructive"
          />
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 16, gap: 20 },
    error: { color: mobileTokens().destructive, fontSize: 13 },
  });
}
