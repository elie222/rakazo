import { useLingui } from "@lingui/react/macro";
import { useCompatibleModelDiscovery } from "@rakazo/chat-ui/model-discovery";
import type {
  ModelApiProtocol,
  ModelCredential,
  ModelHeaderRow,
  ThinkingLevel,
} from "@rakazo/contracts";
import {
  compatibleEndpointPresets,
  matchCompatibleEndpointPreset,
  modelRoutingForm,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import type { ConnectionFormFields } from "@rakazo/core";
import {
  modelConnectionFormSecrets,
  sameCompatibleModelEndpoint,
  sanitizeModelConnectionError,
  savedCompatibleModelIds,
} from "@rakazo/core";
import { useMemo, useRef, useState } from "react";
import type { ModelCatalogEntry } from "../../lib/models/model-auth";
import type { RpcClient } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";

/**
 * The fields and model discovery shared by the web connection forms.
 * `credential` is the saved connection being edited, if any; the caller owns saving.
 */
export function useModelConnectionForm({
  rpc,
  catalog,
  credential,
  onModelsFound,
}: {
  rpc: RpcClient;
  catalog: readonly ModelCatalogEntry[];
  credential?: ModelCredential;
  /** Runs after a current probe lists the endpoint's models, with the id typed before it. */
  onModelsFound?: (models: string[], typedModelId: string) => void;
}) {
  const { t } = useLingui();
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [region, setRegion] = useState("global");
  const [zeroDataRetention, setZeroDataRetention] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [presetBaseUrl, setPresetBaseUrl] = useState<string>();
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>("chat-completions");
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[] | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  // The catalog names the IDs a provider needs besides its key.
  const { needsRouting, needsGateway, needsProject, routingReady } = modelRoutingForm(
    selected?.routingFields,
    {
      accountId,
      gatewayId,
      projectId,
      region,
    },
    credential,
  );

  function applyFields(fields: ConnectionFormFields) {
    setEnabledModelIds(fields.enabledModelIds);
    setBaseUrl(fields.baseUrl);
    setApiProtocol(fields.apiProtocol);
    setThinkingLevel(fields.thinkingLevel);
    setAccountId(fields.accountId);
    setGatewayId(fields.gatewayId);
    setProjectId(fields.projectId ?? "");
    setRegion(fields.region ?? "global");
    setZeroDataRetention(fields.zeroDataRetention ?? false);
  }

  /** Points the form at another provider's connection, clearing the key and any results. */
  function openConnection(
    nextProvider: string,
    nextModelId: string,
    fields: ConnectionFormFields,
    nextPresetBaseUrl?: string,
  ) {
    setProvider(nextProvider);
    setPresetBaseUrl(nextPresetBaseUrl);
    setModelId(nextModelId);
    applyFields(fields);
    setApiKey("");
    setHeaderRows(null);
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    if (sameCompatibleModelEndpoint(baseUrl, nextBaseUrl)) return;
    // A typed key belongs to the endpoint it was entered for.
    if (baseUrl.trim()) setApiKey("");
    setHeaderRows(null);
    // A new endpoint starts with no ticks; the saved endpoint gets its saved list back.
    setEnabledModelIds(savedCompatibleModelIds(credential, nextBaseUrl));
    resetOpenAiCompatibleProbe();
    setError(null);
    setNotice(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    if (!matchedEndpoint?.publicModels && nextApiKey.trim() !== apiKey.trim()) {
      resetOpenAiCompatibleProbe();
    }
  }

  function updateApiProtocol(nextProtocol: ModelApiProtocol) {
    setApiProtocol(nextProtocol);
    resetOpenAiCompatibleProbe();
  }

  /** A failed connection's message, without the credentials this form holds. */
  function connectionErrorText(err: unknown, fallback: string): string {
    return sanitizeModelConnectionError(
      errorText(err, fallback),
      modelConnectionFormSecrets({ apiKey, headerRows }),
    );
  }

  const endpointPresets = useMemo(() => compatibleEndpointPresets(catalog), [catalog]);
  const endpointPreset = isOpenAiCompatible
    ? matchCompatibleEndpointPreset(endpointPresets, presetBaseUrl ?? credential?.baseUrl)
    : undefined;
  const matchedEndpoint = isOpenAiCompatible
    ? matchCompatibleEndpointPreset(endpointPresets, baseUrl)
    : undefined;
  const compatibleKeyRequired = Boolean(matchedEndpoint);
  const discovery = useCompatibleModelDiscovery(
    isOpenAiCompatible
      ? { baseUrl, apiKey, apiProtocol, headerRows, preset: matchedEndpoint, credential }
      : null,
    {
      request: (input) => rpc.models.probeOpenAiCompatible(input),
      onModels: (models) => {
        const current = modelIdRef.current.trim();
        setModelId(current || models[0] || "");
        onModelsFound?.(models, current);
      },
      errorMessage: (err) => connectionErrorText(err, t`Could not reach this model server`),
    },
  );
  const { resetOpenAiCompatibleProbe } = discovery;

  return {
    accountId,
    apiKey,
    apiProtocol,
    applyFields,
    baseUrl,
    compatibleKeyRequired,
    connectionErrorText,
    ...discovery,
    routingReady,
    enabledModelIds,
    endpointPreset,
    endpointPresets,
    error,
    gatewayId,
    projectId,
    region,
    headerRows,
    needsRouting,
    needsGateway,
    needsProject,
    isOpenAiCompatible,
    modelId,
    modelsForProvider,
    notice,
    openConnection,
    provider,
    selected,
    setAccountId,
    setApiKey,
    setEnabledModelIds,
    setError,
    setGatewayId,
    setProjectId,
    setRegion,
    setZeroDataRetention,
    setHeaderRows,
    setModelId,
    setNotice,
    setProvider,
    setThinkingLevel,
    thinkingLevel,
    updateApiKey,
    updateApiProtocol,
    updateBaseUrl,
    zeroDataRetention,
  };
}
