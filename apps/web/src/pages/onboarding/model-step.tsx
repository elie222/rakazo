import { Trans, useLingui } from "@lingui/react/macro";
import { isUnlistedCompatibleModel } from "@rakazo/core";
import {
  Button,
  Disclosure,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@rakazo/ui-web";
import { FoundModelPicker } from "../../components/models/FoundModelPicker";
import { ModelHeadersEditor } from "../../components/models/ModelHeadersEditor";
import { SubscriptionSignInSteps } from "../../components/models/SubscriptionSignInSteps";
import { CompatibleKeyField } from "../model-settings/compatible-key-field";
import type { OnboardingModel } from "./use-onboarding-model";

const CUSTOM_MODEL_OPTION = "__rakazo_custom_model__";

export function ModelStep({ model, fieldId }: { model: OnboardingModel; fieldId: string }) {
  const { t } = useLingui();
  const {
    acceptsKey,
    accountId,
    apiKey,
    cancelOAuthAttempt,
    canSaveModel,
    compatibleKeyRequired,
    chooseProvider,
    credits,
    endpointPreset,
    error,
    fundWithCredits,
    gatewayId,
    projectId,
    region,
    isOpenAiCompatible,
    modelId,
    modelItems,
    modelsForProvider,
    needsGateway,
    needsProject,
    needsRouting,
    notice,
    provider,
    providerItems,
    providerOptions,
    providerValue,
    saveModel,
    selected,
    setAccountId,
    setGatewayId,
    setProjectId,
    setRegion,
    setModelId,
    setThinkingLevel,
    subscriptionSignIn,
    updateApiKey,
  } = model;

  return (
    <div>
      <h1 className="text-display font-medium text-foreground">
        <Trans>Connect a model</Trans>
      </h1>
      <div className="mt-8 block text-body font-medium text-foreground">
        <span>
          <Trans>Provider</Trans>
        </span>
        <Select
          value={providerValue}
          onValueChange={(value) => {
            if (typeof value !== "string" || !value) return;
            chooseProvider(value);
          }}
          items={providerItems}
        >
          <SelectTrigger aria-label={t`Provider`} className="mt-2 w-full">
            <SelectValue placeholder={t`Choose a provider`} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {providerOptions.main.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
            {providerOptions.main.length && providerOptions.rest.length ? (
              <SelectSeparator />
            ) : null}
            <SelectGroup>
              {providerOptions.rest.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {provider ? (
        <>
          {isOpenAiCompatible && !endpointPreset ? (
            <CompatibleServerUrl model={model} fieldId={fieldId} />
          ) : null}
          {subscriptionSignIn ? <SubscriptionSignIn model={model} /> : null}
          {needsRouting && acceptsKey ? (
            <div className="mt-4 grid gap-4">
              <label
                htmlFor={`${fieldId}-account-id`}
                className="block text-body font-medium text-foreground"
              >
                {needsProject ? <Trans>Project ID</Trans> : <Trans>Account ID</Trans>}
                <Input
                  id={`${fieldId}-account-id`}
                  value={needsProject ? projectId : accountId}
                  onChange={(event) =>
                    (needsProject ? setProjectId : setAccountId)(event.target.value)
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2"
                />
              </label>
              {needsGateway || needsProject ? (
                <label
                  htmlFor={`${fieldId}-gateway-id`}
                  className="block text-body font-medium text-foreground"
                >
                  {needsProject ? <Trans>Region</Trans> : <Trans>Gateway ID</Trans>}
                  <Input
                    id={`${fieldId}-gateway-id`}
                    value={needsProject ? region : gatewayId}
                    onChange={(event) =>
                      (needsProject ? setRegion : setGatewayId)(event.target.value)
                    }
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2"
                  />
                </label>
              ) : null}
            </div>
          ) : null}
          {acceptsKey ? (
            isOpenAiCompatible ? (
              <CompatibleKeyField
                className="mt-4 block text-body text-muted-foreground"
                keyRequired={compatibleKeyRequired}
              >
                <Input
                  aria-label={t`API key`}
                  value={apiKey}
                  onChange={(e) => updateApiKey(e.target.value)}
                  required={compatibleKeyRequired}
                  placeholder={compatibleKeyRequired ? undefined : t`Optional`}
                  type="password"
                  autoComplete="new-password"
                  className="mt-2"
                />
              </CompatibleKeyField>
            ) : (
              <label
                htmlFor={`${fieldId}-api-key`}
                className="mt-4 block text-body font-medium text-foreground"
              >
                {subscriptionSignIn ? <Trans>Or paste an API key</Trans> : <Trans>API key</Trans>}
                <Input
                  id={`${fieldId}-api-key`}
                  value={apiKey}
                  onChange={(e) => updateApiKey(e.target.value)}
                  placeholder="sk-…"
                  type="password"
                  autoComplete="new-password"
                  className="mt-2"
                />
              </label>
            )
          ) : null}
          {isOpenAiCompatible ? <CompatibleModelSelection model={model} /> : null}
          {!isOpenAiCompatible && acceptsKey && modelItems.length ? (
            <div className="mt-6 block text-body text-foreground">
              <span className="font-medium">
                <Trans>Model</Trans>
              </span>
              <Select
                value={selected?.id ?? modelId}
                onValueChange={(value) => {
                  if (typeof value !== "string" || !value) return;
                  if (value === modelId) return;
                  cancelOAuthAttempt("replaced");
                  setModelId(value);
                  setThinkingLevel(null);
                }}
                items={modelItems}
              >
                <SelectTrigger aria-label={t`Model`} className="mt-2 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {modelsForProvider.map((entry) => (
                      <SelectItem key={`${entry.provider}:${entry.id}`} value={entry.id}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </>
      ) : null}
      {notice ? (
        <p className="mt-3 text-body text-success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? <p className="mt-3 text-body text-destructive">{error}</p> : null}
      <Button
        className="mt-6"
        disabled={!credits && !canSaveModel}
        onClick={() => void (credits ? fundWithCredits() : saveModel())}
      >
        <Trans>Continue</Trans>
      </Button>
    </div>
  );
}

function CompatibleServerUrl({ model, fieldId }: { model: OnboardingModel; fieldId: string }) {
  const { t } = useLingui();
  return (
    <label
      htmlFor={`${fieldId}-base-url`}
      className="mt-4 block text-body font-medium text-foreground"
    >
      <Trans>Server URL</Trans>
      <Input
        id={`${fieldId}-base-url`}
        value={model.baseUrl}
        onChange={(e) => model.updateBaseUrl(e.target.value)}
        aria-label={t`OpenAI-compatible server URL`}
        placeholder="http://127.0.0.1:8000/v1"
        autoComplete="off"
        className="mt-2"
      />
    </label>
  );
}

function CompatibleModelSelection({ model }: { model: OnboardingModel }) {
  const { t } = useLingui();
  const {
    endpointPreset,
    headerRows,
    manualModelId,
    modelId,
    discoverModels,
    probeError,
    probeModels,
    probing,
    resetOpenAiCompatibleProbe,
    setHeaderRows,
    setManualModelId,
    setModelId,
  } = model;

  return (
    <div className="mt-4 block text-body text-foreground">
      <div className="mt-4 block">
        <span className="font-medium">
          <Trans>Model</Trans>
        </span>
        {probeModels.length && !manualModelId ? (
          <FoundModelPicker
            models={probeModels}
            value={modelId}
            onChange={(next) => {
              setManualModelId(next === CUSTOM_MODEL_OPTION);
              setModelId(next === CUSTOM_MODEL_OPTION ? "" : next);
            }}
            otherValue={CUSTOM_MODEL_OPTION}
          />
        ) : (
          <Input
            value={modelId}
            onChange={(e) => {
              setManualModelId(true);
              setModelId(e.target.value);
            }}
            aria-label={t`Model id`}
            placeholder="exact-model-id"
            className="mt-2"
          />
        )}
        {probeModels.length && manualModelId ? (
          <Button
            variant="link"
            size="xs"
            className="mt-2 px-0 text-muted-foreground"
            onClick={() => {
              setManualModelId(false);
              setModelId(probeModels[0] ?? "");
            }}
          >
            <Trans>Use a found model</Trans>
          </Button>
        ) : null}
      </div>
      {isUnlistedCompatibleModel(modelId, probeModels) ? (
        <p className="mt-2 text-muted-foreground" role="status">
          <Trans>The server didn’t list this model.</Trans>
        </p>
      ) : null}
      {probing ? (
        <p className="mt-2 text-muted-foreground" role="status">
          <Trans>Finding…</Trans>
        </p>
      ) : null}
      {probeError ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-destructive" role="status">
            {probeError}
          </p>
          <Button type="button" variant="outline" size="xs" onClick={discoverModels}>
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {endpointPreset ? null : (
        <Disclosure className="mt-4 text-body text-muted-foreground" summary={t`Advanced`}>
          <ModelHeadersEditor
            rows={headerRows}
            onChange={(rows) => {
              setHeaderRows(rows);
              resetOpenAiCompatibleProbe();
            }}
          />
        </Disclosure>
      )}
    </div>
  );
}

/** Signing in with a subscription: the start button, then the code or link to finish. */
function SubscriptionSignIn({ model }: { model: OnboardingModel }) {
  const {
    beginSelectedSubscriptionSignIn,
    cancelOAuthAttempt,
    codeCopied,
    copyOAuthCode,
    reportSignInStep,
    oauth,
    oauthPending,
    pasteCode,
    selected,
    setPasteCode,
    signInLabel,
    submitOAuthCode,
  } = model;

  return (
    <div className="mt-4">
      <SubscriptionSignInSteps
        oauth={oauth}
        setup={selected?.signInSetup}
        startLabel={signInLabel}
        starting={oauthPending}
        onStart={() => beginSelectedSubscriptionSignIn()}
        onRestart={() => {
          cancelOAuthAttempt("replaced");
          beginSelectedSubscriptionSignIn();
        }}
        codeCopied={codeCopied}
        onCopyCode={copyOAuthCode}
        pasteCode={pasteCode}
        onPasteCodeChange={setPasteCode}
        onSubmitCode={() => void submitOAuthCode()}
        onPageOpened={() => reportSignInStep("page_opened")}
      />
    </div>
  );
}
