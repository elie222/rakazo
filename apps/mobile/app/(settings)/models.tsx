import {
  canonicalPiProviderId,
  isOllamaCloudBaseUrl,
  OLLAMA_CLOUD_BASE_URL,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { popularModelProvidersFirst } from "@rakazo/core";
import type { Href } from "expo-router";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ConnectableProvider, ModelConnectIntent } from "../../components/model-role-settings";
import { ModelRoleSettings } from "../../components/model-role-settings";
import type { MobileMe, MobileModel, MobileModelCredential } from "../../lib/api";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { ModelConnectionRequest } from "../../lib/model-connection-request";
import { closeModelConnection, openModelConnection } from "../../lib/model-connection-request";
import type { ModelPickerRequest } from "../../lib/model-picker-selection";
import { closeModelPicker, openModelPicker } from "../../lib/model-picker-selection";
import { native, useThemedStyles } from "../../lib/native";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

/** The main and approval model lists; connecting a provider opens its own screen. */
export default function Models() {
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createModelsStyles);
  const router = useRouter();
  const { t } = useI18n();
  const [me, setMe] = useState<MobileMe | null>(null);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pickerRequestRef = useRef<string | null>(null);
  const connectionRequestRef = useRef<string | null>(null);
  const returningFromPickerRef = useRef(false);

  useEffect(
    () => () => {
      if (pickerRequestRef.current) closeModelPicker(pickerRequestRef.current);
      if (connectionRequestRef.current) closeModelConnection(connectionRequestRef.current);
    },
    [],
  );

  const load = useCallback(async () => {
    try {
      const [nextMe, nextCatalog, nextCredentials] = await Promise.all([
        rpc<MobileMe>("me"),
        rpc<MobileModel[]>("models/list"),
        rpc<MobileModelCredential[]>("models/credentials"),
      ]);
      setMe(nextMe);
      setCatalog(nextCatalog);
      setCredentials(nextCredentials);
      setError(null);
    } catch (err) {
      setError(errorText(err, t("Could not load model settings")));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useFocusEffect(
    useCallback(() => {
      // A picker pick saves through the list itself; only connections change what loads here.
      if (returningFromPickerRef.current) returningFromPickerRef.current = false;
      else void load();
    }, [load]),
  );

  /** A picker reopened after connecting returns to a list that must reload its connections. */
  function pickerRoute(request: ModelPickerRequest): Href {
    if (pickerRequestRef.current) closeModelPicker(pickerRequestRef.current);
    const requestId = openModelPicker(request);
    pickerRequestRef.current = requestId;
    returningFromPickerRef.current = false;
    return { pathname: "/model-picker", params: { requestId } };
  }

  function pushModelPicker(request: ModelPickerRequest) {
    router.push(pickerRoute(request));
    returningFromPickerRef.current = true;
  }

  function connectionRoute(request: ModelConnectionRequest): Href {
    if (connectionRequestRef.current) closeModelConnection(connectionRequestRef.current);
    const requestId = openModelConnection(request);
    connectionRequestRef.current = requestId;
    returningFromPickerRef.current = false;
    return { pathname: "/model-connection", params: { requestId } };
  }

  const connectRoute = (provider: ConnectableProvider, intent: ModelConnectIntent) =>
    connectionRoute({ provider: provider.id, baseUrl: provider.baseUrl, ...intent });
  const manage = (provider: string) =>
    router.push(connectionRoute({ provider, makeDefault: false }));

  const providers = useMemo(() => {
    const connected = new Set(credentials.map((entry) => canonicalPiProviderId(entry.provider)));
    // Deployment-funded providers stay listed so people can still add their own key.
    const grouped = new Map<string, ConnectableProvider>();
    for (const entry of catalog) {
      if (connected.has(canonicalPiProviderId(entry.provider)) || grouped.has(entry.provider))
        continue;
      grouped.set(entry.provider, {
        id: entry.provider,
        name: entry.providerName ?? entry.provider,
      });
    }
    const unconnected = popularModelProvidersFirst([...grouped.values()], (group) => group.id);
    const compatible = credentials.find(
      (entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    if (
      catalog.some((entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID) &&
      !isOllamaCloudBaseUrl(compatible?.baseUrl)
    )
      unconnected.push({
        id: OPENAI_COMPATIBLE_PROVIDER_ID,
        name: t("Ollama Cloud"),
        baseUrl: OLLAMA_CLOUD_BASE_URL,
      });
    return unconnected;
  }, [catalog, credentials, t]);

  if (loading && !me) {
    return (
      <SafeAreaView edges={["bottom"]} style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </SafeAreaView>
    );
  }

  const shared = {
    credentials,
    providers,
    openPicker: pushModelPicker,
    pickerRoute,
    connectRoute,
    onManage: manage,
  };
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {me ? (
          <>
            <ModelRoleSettings
              {...shared}
              userId={me.userId}
              spaceId={me.spaceId}
              modelRole="main"
              title={t("Main model")}
              defaultLabel={
                me.hostCredentialProvider ? t("Deployment default") : t("Choose a model")
              }
              onChanged={() => void load()}
            />
            <ModelRoleSettings
              {...shared}
              userId={me.userId}
              spaceId={me.spaceId}
              modelRole="approval"
              title={t("Approval model")}
              defaultLabel={t("Deployment default")}
            />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createModelsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    centered: {
      alignItems: "center",
      justifyContent: "center",
    },
    content: {
      width: "100%",
      padding: 20,
      gap: 24,
      paddingBottom: 40,
    },
    error: {
      color: tokens.destructive,
      fontSize: 14,
    },
  });
}
