import { useLingui } from "@lingui/react/macro";
import {
  ModelHeaderRowsSchema,
  modelHeadersInput,
  modelRoutingInput,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
} from "@rakazo/contracts";
import { connectionFormFields, pickCatalogModelId, popularModelProvidersFirst } from "@rakazo/core";
import { useMemo, useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import { providerDisplayName } from "../../lib/models/localized-provider-hint";
import type { ModelCatalogEntry } from "../../lib/models/model-auth";
import { useModelOAuthSignIn } from "../../lib/models/use-model-oauth-signin";
import { analyticsSurface } from "../../lib/platform/desktop";
import { rpc } from "../../lib/query/rpc";
import { useModelConnectionForm } from "../model-settings/use-model-connection-form";

/** Rakazo credits sit among the providers as the one choice that needs no account of its own. */
const CREDITS_OPTION = "__rakazo_credits__";
/** Select value for a hosted compatible service; the rest of the value is its base URL. */
const ENDPOINT_PRESET_OPTION = "endpoint-preset:";
/** A provider whose catalog entry offers both sign-in and a key appears once per way to connect. */
type ProviderAuth = "sign-in" | "key";

const MAIN_PROVIDER_OPTIONS: ReadonlyArray<{ provider: string; auth?: ProviderAuth }> = [
  { provider: "openai-codex" },
  { provider: "anthropic", auth: "sign-in" },
  { provider: "openai" },
  { provider: "anthropic", auth: "key" },
  { provider: "openrouter" },
  { provider: "google" },
];

function providerOptionValue(provider: string, auth?: ProviderAuth): string {
  return auth ? `${provider}:${auth}` : provider;
}

export type OnboardingModel = ReturnType<typeof useOnboardingModel>;

/**
 * The model step's connection form, sign-in, and provider choices. The page holds it for its
 * whole life because the bot step and signing out share its error.
 */
export function useOnboardingModel({
  catalog,
  billingEnabled,
  onConnected,
}: {
  catalog: ModelCatalogEntry[];
  billingEnabled: boolean;
  onConnected: () => void;
}) {
  const { t } = useLingui();
  const [providerAuth, setProviderAuth] = useState<ProviderAuth | undefined>();
  const [credits, setCredits] = useState(false);
  const [manualModelId, setManualModelId] = useState(false);
  const form = useModelConnectionForm({
    rpc,
    catalog,
    // Stay in manual entry across re-probes so a typed id that matches a
    // discovered model cannot yank the freeform field back to the Select.
    onModelsFound: (models, typedModelId) =>
      setManualModelId(
        (wasManual) => wasManual || (Boolean(typedModelId) && !models.includes(typedModelId)),
      ),
  });
  const {
    accountId,
    apiKey,
    apiProtocol,
    baseUrl,
    connectionErrorText,
    compatibleKeyRequired,
    endpointPreset,
    routingReady,
    gatewayId,
    projectId,
    region,
    headerRows,
    isOpenAiCompatible,
    modelId,
    modelsForProvider,
    openConnection,
    provider,
    selected,
    setError,
    setProvider,
  } = form;
  const [codeCopied, copyText] = useCopyText();

  const signIn = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: setError,
    onFinished: async () => {
      onConnected();
    },
  });
  const { oauthPending, cancelOAuthAttempt, startSubscriptionSignIn } = signIn;
  const copyOAuthCode = (code: string) => {
    const loginId = signIn.oauth?.loginId;
    void copyText(code).then((copied) => {
      if (copied) signIn.reportSignInStep("code_copied", loginId);
    });
  };

  const providers = useMemo(() => {
    const seen = new Map<string, ModelCatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return popularModelProvidersFirst(
      [...seen.values()],
      (entry) => entry.provider,
      (entry) => entry.providerName ?? entry.provider,
    );
  }, [catalog]);

  const subscriptionSignIn = selected?.signIn !== undefined && providerAuth !== "key";
  const acceptsKey = selected?.auth !== "oauth" && providerAuth !== "sign-in";
  const signInLabel = selected?.oauthLabel ?? t`Sign in`;
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    apiKey,
    baseUrl,
    modelId:
      headerRows !== null && !ModelHeaderRowsSchema.safeParse(headerRows).success ? "" : modelId,
    keyRequired: compatibleKeyRequired,
  });
  const canSaveModel = Boolean(
    selected &&
      modelId.trim() &&
      !oauthPending &&
      routingReady &&
      (isOpenAiCompatible ? openAiCompatibleReady : acceptsKey && apiKey.trim()),
  );
  // Subscriptions and the common API providers first; every other provider follows by name.
  const providerOptions = useMemo(() => {
    const byId = new Map(providers.map((entry) => [entry.provider, entry]));
    // Beside the subscriptions, the key-based options say API.
    const optionLabel = (id: string, auth?: ProviderAuth) => {
      if (id === "anthropic" && auth === "key") return t`Anthropic API`;
      if (id === "openai") return t`OpenAI API`;
      return providerDisplayName(id, byId.get(id)?.providerName ?? id, auth);
    };
    const main = [
      ...(billingEnabled ? [{ value: CREDITS_OPTION, label: t`Rakazo credits` }] : []),
      ...MAIN_PROVIDER_OPTIONS.filter((option) => byId.has(option.provider)).map((option) => ({
        value: providerOptionValue(option.provider, option.auth),
        label: optionLabel(option.provider, option.auth),
      })),
    ];
    const rest = popularModelProvidersFirst(
      providers
        .filter(
          (entry) => !MAIN_PROVIDER_OPTIONS.some((option) => option.provider === entry.provider),
        )
        .flatMap((entry) => {
          const item = { value: entry.provider, label: entry.providerName ?? entry.provider };
          return [
            item,
            ...(entry.endpointPresets ?? []).map((preset) => ({
              value: `${ENDPOINT_PRESET_OPTION}${preset.baseUrl}`,
              label: preset.name,
            })),
          ];
        }),
      (option) => option.value,
      (option) => option.label,
    );
    return { main, rest };
  }, [billingEnabled, providers, t]);
  // Base UI Select.Value only resolves labels when Root gets `items`.
  const providerItems = useMemo(
    () => [...providerOptions.main, ...providerOptions.rest],
    [providerOptions],
  );
  const modelItems = useMemo(
    () => modelsForProvider.map((entry) => ({ value: entry.id, label: entry.label })),
    [modelsForProvider],
  );

  const providerValue = credits
    ? CREDITS_OPTION
    : endpointPreset
      ? `${ENDPOINT_PRESET_OPTION}${endpointPreset.baseUrl}`
      : provider
        ? providerOptionValue(provider, providerAuth)
        : null;

  function chooseProvider(value: string) {
    if (value === CREDITS_OPTION) {
      cancelOAuthAttempt();
      setProvider("");
      setProviderAuth(undefined);
      setCredits(true);
      setError(null);
      return;
    }
    setCredits(false);
    if (value.startsWith(ENDPOINT_PRESET_OPTION))
      selectProvider(OPENAI_COMPATIBLE_PROVIDER_ID, value.slice(ENDPOINT_PRESET_OPTION.length));
    else selectProvider(value);
  }

  function selectProvider(option: string, presetBaseUrl?: string) {
    if (option === providerOptionValue(provider, providerAuth) && !presetBaseUrl && !endpointPreset)
      return;
    const [nextProvider = option, auth] = option.split(":") as [string, ProviderAuth?];
    cancelOAuthAttempt();
    setProviderAuth(auth);
    setManualModelId(false);
    const nextModelId =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? ""
        : pickCatalogModelId(catalog, nextProvider);
    openConnection(
      nextProvider,
      nextModelId,
      connectionFormFields({
        catalog,
        provider: nextProvider,
        modelId: nextModelId,
        presetBaseUrl,
      }),
      presetBaseUrl,
    );
  }

  async function saveModel() {
    if (!canSaveModel) return;
    setError(null);
    try {
      if (isOpenAiCompatible) {
        await rpc.models.connect({
          provider,
          baseUrl: baseUrl.trim(),
          apiProtocol,
          headers: modelHeadersInput(headerRows),
          modelId: modelId.trim(),
          apiKey: apiKey.trim() || undefined,
          label: selected?.providerName ?? provider,
          surface: analyticsSurface(),
        });
      } else if (apiKey) {
        await rpc.models.connect({
          provider,
          apiKey,
          ...modelRoutingInput(selected?.routingFields, {
            accountId,
            gatewayId,
            projectId,
            region,
          }),
          modelId,
          label: selected?.providerName ?? provider,
          surface: analyticsSurface(),
        });
      }
      onConnected();
    } catch (err) {
      setError(connectionErrorText(err, t`Could not save model`));
    }
  }

  async function fundWithCredits() {
    setError(null);
    try {
      await rpc.billing.selectFunding({ funding: "credits", surface: analyticsSurface() });
      window.location.assign("/onboarding");
    } catch {
      setError(t`Could not open billing`);
    }
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected?.id) return;
    void startSubscriptionSignIn({
      provider: selected.provider,
      modelId: selected.id,
      label: selected.providerName ?? selected.provider,
    });
  }

  return {
    ...form,
    ...signIn,
    codeCopied,
    copyOAuthCode,
    credits,
    manualModelId,
    setManualModelId,
    subscriptionSignIn,
    acceptsKey,
    signInLabel,
    endpointPreset,
    canSaveModel,
    providerOptions,
    providerItems,
    modelItems,
    providerValue,
    chooseProvider,
    saveModel,
    fundWithCredits,
    beginSelectedSubscriptionSignIn,
  };
}
