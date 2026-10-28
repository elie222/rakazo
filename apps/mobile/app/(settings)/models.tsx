import {
  canonicalPiProviderId,
  isOllamaCloudBaseUrl,
  OLLAMA_CLOUD_BASE_URL,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { popularModelProvidersFirst } from "@rakazo/core";
import { fetchFresh } from "@rakazo/core/query";
import { isCancelledError, useQuery } from "@tanstack/react-query";
import type { Href } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { ModelProviders } from "../../components/model-providers";
import type { ConnectableProvider, ModelConnectIntent } from "../../components/model-role-settings";
import { ModelRoleSettings } from "../../components/model-role-settings";
import type { MobileModel, MobileModelCredential } from "../../lib/api";
// Connections belong to the account, so renaming and removing them go to the selected Space.
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { ModelConnectionRequest } from "../../lib/model-connection-request";
import { closeModelConnection, openModelConnection } from "../../lib/model-connection-request";
import type { ModelPickerRequest } from "../../lib/model-picker-selection";
import { closeModelPicker, openModelPicker } from "../../lib/model-picker-selection";
import { native, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery } from "../../lib/query";
import { settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

const noModels: MobileModel[] = [];
const noCredentials: MobileModelCredential[] = [];

/**
 * The main and approval model lists; connecting a provider opens its own screen. Opened with a
 * Space, it edits that Space's override instead of the account's.
 */
export default function Models() {
  const params = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(params.spaceId), [params.spaceId]);
  // A Space's override is read from that Space even when another one is selected.
  const spaceId = target.scope === "space" ? target.spaceId : undefined;
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createModelsStyles);
  const router = useRouter();
  const { t } = useI18n();
  const me =
    useQuery({ ...rpcQuery("me", undefined, spaceId), enabled: false }, queryClient).data ?? null;
  const catalog =
    useQuery({ ...rpcQuery("models/list", undefined, spaceId), enabled: false }, queryClient)
      .data ?? noModels;
  const credentials =
    useQuery(
      {
        ...rpcQuery("models/credentials", undefined, spaceId),
        enabled: false,
      },
      queryClient,
    ).data ?? noCredentials;
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const openedRef = useRef(false);
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

  /** Opening shares a read already in flight; after a change, the answer must come from a new one. */
  const load = useCallback(
    async (reuse = false) => {
      try {
        await Promise.all([
          fetchFresh(queryClient, rpcQuery("me", undefined, spaceId), { reuse }),
          fetchFresh(queryClient, rpcQuery("models/list", undefined, spaceId), {
            reuse,
          }),
          fetchFresh(queryClient, rpcQuery("models/credentials", undefined, spaceId), {
            reuse,
          }),
        ]);
        setLoadError(null);
      } catch (err) {
        // A newer read replaced this one and reports for both.
        if (!isCancelledError(err))
          setLoadError(errorText(err, t("Could not load model settings")));
      }
    },
    [spaceId, t],
  );

  useFocusEffect(
    useCallback(() => {
      // A picker pick saves through the list itself; only connections change what loads here.
      if (returningFromPickerRef.current) returningFromPickerRef.current = false;
      else {
        void load(!openedRef.current);
        openedRef.current = true;
      }
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

  // Connecting from a picker always adds a connection.
  const connectRoute = (provider: ConnectableProvider, intent: ModelConnectIntent) =>
    connectionRoute({
      provider: provider.id,
      baseUrl: provider.baseUrl,
      credentialId: null,
      target,
      ...intent,
    });
  const manage = (credential: MobileModelCredential) =>
    router.push(
      connectionRoute({
        provider: credential.provider,
        credentialId: credential.id,
        makeDefault: false,
        target,
      }),
    );

  /** Every provider, popular first, plus the Ollama Cloud preset of the compatible one. */
  const allProviders = useMemo(() => {
    const grouped = new Map<string, ConnectableProvider>();
    for (const entry of catalog) {
      if (grouped.has(entry.provider)) continue;
      grouped.set(entry.provider, {
        id: entry.provider,
        name: entry.providerName ?? entry.provider,
      });
    }
    const all = popularModelProvidersFirst([...grouped.values()], (group) => group.id);
    if (catalog.some((entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID))
      all.push({
        id: OPENAI_COMPATIBLE_PROVIDER_ID,
        name: t("Ollama Cloud"),
        baseUrl: OLLAMA_CLOUD_BASE_URL,
      });
    return all;
  }, [catalog, t]);

  // Deployment-funded providers stay listed so people can still add their own key.
  const providers = useMemo(() => {
    const connected = new Set(credentials.map((entry) => canonicalPiProviderId(entry.provider)));
    const ollama = credentials.some(
      (entry) =>
        entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID && isOllamaCloudBaseUrl(entry.baseUrl),
    );
    return allProviders.filter((provider) =>
      provider.baseUrl ? !ollama : !connected.has(canonicalPiProviderId(provider.id)),
    );
  }, [allProviders, credentials]);

  const providerKey = (provider: ConnectableProvider) =>
    `connect:${provider.id}:${provider.baseUrl ?? ""}`;
  /** Adds a connection, even for a provider that has one, without touching any list. */
  function addProvider() {
    pushModelPicker({
      title: t("Add provider"),
      selectedKey: "",
      choices: allProviders.map((provider) => ({
        key: providerKey(provider),
        label: provider.name,
        modelLabel: provider.name,
      })),
      onSelect: () => undefined,
      continueTo: (choice) => {
        const provider = allProviders.find((entry) => providerKey(entry) === choice.key);
        return provider
          ? connectionRoute({
              provider: provider.id,
              baseUrl: provider.baseUrl,
              credentialId: null,
              makeDefault: false,
              target,
            })
          : undefined;
      },
    });
  }

  async function changeConnection(action: () => Promise<unknown>, failure: string) {
    try {
      await action();
      setError(null);
    } catch (err) {
      setError(errorText(err, failure));
    }
    await load();
  }

  // Only the first visit waits; a revisit paints what it saw last and refreshes behind it.
  if (!me && !loadError) {
    return (
      <SafeAreaView edges={["bottom"]} style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </SafeAreaView>
    );
  }

  const failure = error ?? loadError;
  const shownError = error ?? (me ? loadError : null);
  const shared = {
    credentials,
    providers,
    openPicker: pushModelPicker,
    pickerRoute,
    connectRoute,
    onManage: manage,
    userId: me?.userId ?? "",
    spaceId: target.scope === "space" ? target.spaceId : (me?.spaceId ?? ""),
    scope: target.scope,
  };
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {failure && !me ? (
          <LoadFailure
            message={failure}
            onRetry={() => {
              setError(null);
              setLoadError(null);
              void load();
            }}
          />
        ) : shownError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {shownError}
          </Text>
        ) : null}
        {me ? (
          <>
            <ModelRoleSettings
              {...shared}
              modelRole="main"
              title={t("Main model")}
              defaultLabel={t("Choose a model")}
              onChanged={() => void load()}
            />
            <ModelRoleSettings
              {...shared}
              modelRole="approval"
              title={t("Approval model")}
              defaultLabel={t("Choose a model")}
            />
            {/* Connections are the account's in every Space, so a Space's override lists only its models. */}
            {target.scope === "account" ? (
              <ModelProviders
                catalog={catalog}
                credentials={credentials}
                onManage={manage}
                onAdd={addProvider}
                onRename={(credential, label) =>
                  void changeConnection(
                    () => rpc("models/rename", { credentialId: credential.id, label }),
                    t("Could not update name"),
                  )
                }
                onDisconnect={(credential) =>
                  void changeConnection(
                    () =>
                      rpc("models/disconnect", {
                        provider: credential.provider,
                        credentialId: credential.id,
                      }),
                    t("Could not disconnect this provider"),
                  )
                }
              />
            ) : null}
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
