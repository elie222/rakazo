import { useQuery } from "@tanstack/react-query";
import type { Href } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ActivityIndicator, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ModelRoleSettings } from "../../components/account-model-role-settings";
import { ModelAccount } from "../../components/model-account";
import { SpaceBotsModel } from "../../components/settings/space-bots-model";
import { LoadFailure } from "../../components/ui/load-failure";
import { errorText } from "../../lib/api/user-error";
import { useSideInsets } from "../../lib/layout/side-insets";
import { modelAccountStatusQuery } from "../../lib/model-account-client";
import { useI18n } from "../../lib/model-account-i18n";
import type { ModelPickerRequest } from "../../lib/models/model-picker-selection";
import { closeModelPicker, openModelPicker } from "../../lib/models/model-picker-selection";
import { native } from "../../lib/native/native";
import { queryClient, rpcQuery } from "../../lib/query/query";
import { settingsTarget } from "../../lib/query/settings-target";
import { useAccountAuthorizationReturn } from "../../lib/use-account-authorization-return";

export default function ModelAccountPage() {
  const params = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(params.spaceId), [params.spaceId]);
  const spaceId = target.scope === "space" ? target.spaceId : undefined;
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSideInsets();
  const me = useQuery(rpcQuery("me", undefined, spaceId), queryClient);
  const credentials = useQuery(rpcQuery("models/credentials", undefined, spaceId), queryClient);
  const bots = useQuery(rpcQuery("bots/list", undefined, spaceId), queryClient);
  const picker = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (picker.current) closeModelPicker(picker.current);
    },
    [],
  );
  const refresh = useCallback(async () => {
    await Promise.all([
      me.refetch(),
      credentials.refetch(),
      bots.refetch(),
      queryClient.invalidateQueries({ queryKey: ["model-account-status"] }),
    ]);
  }, [me.refetch, credentials.refetch, bots.refetch]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const pickerRoute = (request: ModelPickerRequest): Href => {
    if (picker.current) closeModelPicker(picker.current);
    picker.current = openModelPicker(request);
    return { pathname: "/model-picker", params: { requestId: picker.current } };
  };
  const status = useQuery(modelAccountStatusQuery(), queryClient);
  useAccountAuthorizationReturn(status.data);
  const failure = me.error ?? credentials.error ?? bots.error ?? status.error;
  const managedCredentials = useMemo(
    () =>
      credentials.data?.filter((credential) => credential.id === status.data?.credentialId) ?? [],
    [credentials.data, status.data?.credentialId],
  );
  const shared = {
    userId: me.data?.userId ?? "",
    spaceId: spaceId ?? me.data?.spaceId ?? "",
    scope: target.scope,
    credentials: managedCredentials,
    defaultLabel: t("Choose a model"),
    openPicker: (request: ModelPickerRequest) => router.push(pickerRoute(request)),
    onChanged: () => void refresh(),
  };
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={insets}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        {failure ? (
          <LoadFailure
            message={errorText(failure, t("Could not load model settings"))}
            onRetry={() => void refresh()}
          />
        ) : null}
        {target.scope === "account" || !status.data?.connected || status.data.recovery ? (
          <ModelAccount required onChanged={refresh} />
        ) : null}
        {!me.data && !failure ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        {status.data?.connected && me.data && credentials.data ? (
          <>
            <ModelRoleSettings {...shared} modelRole="main" title={t("Main model")} />
            {me.data.needsModel ? null : (
              <SpaceBotsModel bots={bots.data ?? []} spaceId={spaceId} onSwitched={refresh} />
            )}
            <ModelRoleSettings {...shared} modelRole="approval" title={t("Approval model")} />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: native.page },
  content: { padding: 16 },
});
