import { useLingui } from "@lingui/react/macro";
import { useRouter } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SettingsGroup, SettingsRow } from "../../components/settings/settings-group";
import { LoadFailure } from "../../components/ui/load-failure";
import { errorText } from "../../lib/api/user-error";
import { useSideInsets } from "../../lib/layout/side-insets";
import { native, useThemedStyles } from "../../lib/native/native";
import { rpcQuery } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { openFromSettingsSheet } from "../../lib/settings/settings-sheet";

/**
 * One Space shows its members, and its own settings only when some were customized while there
 * were others; several each open their own settings.
 */
export default function SpacesSettings() {
  const { t } = useLingui();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const query = useScreenQuery(rpcQuery("spaces/list"));
  const spaces = query.data?.spaces;
  const only = spaces?.length === 1 ? spaces[0] : undefined;
  const overrides = useScreenQuery(rpcQuery("spaceSettings/overrides", undefined, only?.id), {
    enabled: Boolean(only),
  });
  // A failed read keeps the row, whose screen shows the failure and a retry.
  const customized = (overrides.data?.length ?? 0) > 0 || overrides.isError;

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {!spaces ? (
          query.error ? (
            <LoadFailure message={errorText(query.error)} onRetry={() => void query.refetch()} />
          ) : (
            <ActivityIndicator color={native.secondaryLabel} />
          )
        ) : (
          <SettingsGroup
            footer={t`Spaces keep work apart. Bots, chats, memory and computers never cross between them.`}
          >
            {only ? (
              <SettingsRow
                key="members"
                accessibilityRole="button"
                chevron="right"
                title={t`Members`}
                // Members lives on the root stack, so it closes the sheet first.
                onPress={() =>
                  openFromSettingsSheet(router, {
                    pathname: "/space-members",
                    params: { spaceId: only.id },
                  })
                }
              />
            ) : null}
            {only && customized ? (
              <SettingsRow
                key="space-settings"
                accessibilityRole="button"
                chevron="right"
                title={t`Settings for this Space`}
                onPress={() =>
                  router.push({
                    pathname: "/space",
                    params: { spaceId: only.id, name: only.name },
                  })
                }
              />
            ) : null}
            {only
              ? null
              : spaces.map((space) => (
                  <SettingsRow
                    key={space.id}
                    accessibilityRole="button"
                    chevron="right"
                    title={space.name}
                    onPress={() =>
                      router.push({
                        pathname: "/space",
                        params: { spaceId: space.id, name: space.name },
                      })
                    }
                  />
                ))}
            <SettingsRow
              key="new-space"
              accessibilityRole="button"
              tinted
              title={t`New private space`}
              onPress={() => openFromSettingsSheet(router, "/new-space")}
            />
          </SettingsGroup>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
  });
}
