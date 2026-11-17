import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Disclosure, Input } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import {
  ModelPreflightFeedback,
  modelPreflightTestingLabel,
} from "../../components/ModelConnectionPreflightNotice";
import { ModelSignInProgress } from "../../components/ModelSignInProgress";
import { CompatibleKeyField } from "./compatible-key-field";
import type { ModelSettingsState } from "./use-model-settings";

export function ConnectionControls({
  acceptsKey,
  accountId,
  apiKey,
  beginSelectedSubscriptionSignIn,
  busy,
  cancelOAuthAttempt,
  routingReady,
  codeCopied,
  connectKey,
  copyOAuthCode,
  credential,
  gatewayId,
  projectId,
  region,
  needsRouting,
  needsGateway,
  needsProject,
  isOpenAiCompatible,
  oauth,
  oauthPending,
  pasteCode,
  pending,
  popupBlocked,
  preflightFailure,
  preflightSuccess,
  preflightTarget,
  preflightTesting,
  selected,
  setAccountId,
  setGatewayId,
  setProjectId,
  setRegion,
  setPasteCode,
  submitOAuthCode,
  subscriptionSignIn,
  testApiKeyConnection,
  updateApiKey,
}: Pick<
  ModelSettingsState,
  | "acceptsKey"
  | "accountId"
  | "apiKey"
  | "beginSelectedSubscriptionSignIn"
  | "busy"
  | "cancelOAuthAttempt"
  | "routingReady"
  | "codeCopied"
  | "connectKey"
  | "copyOAuthCode"
  | "credential"
  | "gatewayId"
  | "projectId"
  | "region"
  | "needsRouting"
  | "needsGateway"
  | "needsProject"
  | "isOpenAiCompatible"
  | "oauth"
  | "oauthPending"
  | "pasteCode"
  | "pending"
  | "popupBlocked"
  | "preflightFailure"
  | "preflightSuccess"
  | "preflightTarget"
  | "preflightTesting"
  | "selected"
  | "setAccountId"
  | "setGatewayId"
  | "setProjectId"
  | "setRegion"
  | "setPasteCode"
  | "submitOAuthCode"
  | "subscriptionSignIn"
  | "testApiKeyConnection"
  | "updateApiKey"
>) {
  const { t } = useLingui();
  // Signed in with a subscription, a key is an alternative, so it stays folded until asked for.
  const [keyShownFor, setKeyShownFor] = useState<string | null>(null);
  const keyFolded =
    subscriptionSignIn &&
    credential?.authKind === "oauth" &&
    keyShownFor !== (selected?.provider ?? null);
  // Opening the fold swaps the summary for the form, so focus moves to the key field.
  useEffect(() => {
    if (keyShownFor) document.getElementById("model-api-key")?.focus();
  }, [keyShownFor]);
  return !isOpenAiCompatible ? (
    <>
      {subscriptionSignIn && (credential?.authKind !== "oauth" || credential.reconnectRequired) ? (
        <div className="mt-5 flex flex-wrap items-center gap-2 first:mt-0">
          {oauth ? (
            <ModelSignInProgress
              oauth={oauth}
              pasteCode={pasteCode}
              setPasteCode={setPasteCode}
              submitOAuthCode={submitOAuthCode}
              popupBlocked={popupBlocked}
              codeCopied={codeCopied}
              copyOAuthCode={copyOAuthCode}
              cancelOAuthAttempt={cancelOAuthAttempt}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => beginSelectedSubscriptionSignIn()}
            >
              {oauthPending ? (
                <Trans>Starting…</Trans>
              ) : credential?.authKind === "oauth" ? (
                <Trans>Sign in again</Trans>
              ) : (
                (selected?.oauthLabel ?? t`Sign in`)
              )}
            </Button>
          )}
        </div>
      ) : null}

      {acceptsKey && keyFolded ? (
        // Only the summary shows here; opening it swaps in the key form below.
        <Disclosure
          className="mt-5 text-body-sm leading-[1.5] text-muted-foreground"
          open={false}
          onOpenChange={() => setKeyShownFor(selected?.provider ?? null)}
          summary={<Trans>Or paste an API key</Trans>}
        >
          {null}
        </Disclosure>
      ) : acceptsKey ? (
        <div className="mt-5 first:mt-0">
          {needsRouting ? (
            <>
              <label className="block text-body text-muted-foreground" htmlFor="model-account-id">
                {needsProject ? <Trans>Project ID</Trans> : <Trans>Account ID</Trans>}
                <Input
                  id="model-account-id"
                  value={needsProject ? projectId : accountId}
                  onChange={(event) =>
                    (needsProject ? setProjectId : setAccountId)(event.target.value)
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 h-10 text-foreground"
                />
              </label>
              {needsGateway || needsProject ? (
                <label
                  className="mt-4 block text-body text-muted-foreground"
                  htmlFor="model-gateway-id"
                >
                  {needsProject ? <Trans>Region</Trans> : <Trans>Gateway ID</Trans>}
                  <Input
                    id="model-gateway-id"
                    value={needsProject ? region : gatewayId}
                    onChange={(event) =>
                      (needsProject ? setRegion : setGatewayId)(event.target.value)
                    }
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2 h-10 text-foreground"
                  />
                </label>
              ) : null}
            </>
          ) : null}
          {acceptsKey ? (
            <label
              className={`block text-body text-muted-foreground ${needsRouting ? "mt-4" : ""}`}
              htmlFor="model-api-key"
            >
              {credential?.hasKey ? (
                <Trans>Replace API key</Trans>
              ) : subscriptionSignIn ? (
                <Trans>Or paste an API key</Trans>
              ) : (
                <Trans>API key</Trans>
              )}
              <Input
                id="model-api-key"
                value={apiKey}
                onChange={(event) => updateApiKey(event.target.value)}
                placeholder={credential?.hasKey ? t`Paste a replacement key` : "sk-…"}
                type="password"
                autoComplete="new-password"
                className="mt-2 h-10 text-foreground"
              />
            </label>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {acceptsKey && selected?.catalogProbe ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || preflightTesting || apiKey.trim().length < 8}
                onClick={() => void testApiKeyConnection()}
              >
                {modelPreflightTestingLabel(preflightTesting && preflightTarget === "api-key")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !routingReady || apiKey.trim().length < 8}
              onClick={() => void connectKey()}
            >
              {pending === "connect" ? (
                <Trans>Saving…</Trans>
              ) : credential?.hasKey ? (
                <Trans>Replace API key</Trans>
              ) : (
                <Trans>Connect API key</Trans>
              )}
            </Button>
          </div>
          {preflightTarget === "api-key" ? (
            <ModelPreflightFeedback success={preflightSuccess} failure={preflightFailure} />
          ) : null}
        </div>
      ) : null}

      {selected?.auth === "oauth" && !subscriptionSignIn ? (
        <p className="mt-5 text-body-sm leading-[1.5] text-muted-foreground first:mt-0">
          <Trans>
            This subscription sign-in is not available in Rakazo yet. Use a deployment credential or
            choose another provider.
          </Trans>
        </p>
      ) : null}
    </>
  ) : null;
}

export function CompatibleKeyControls({
  apiKey,
  busy,
  connectKey,
  credential,
  endpointPreset,
  isOpenAiCompatible,
  openAiCompatibleReady,
  pending,
  updateApiKey,
}: Pick<
  ModelSettingsState,
  | "apiKey"
  | "busy"
  | "connectKey"
  | "credential"
  | "endpointPreset"
  | "isOpenAiCompatible"
  | "openAiCompatibleReady"
  | "pending"
  | "updateApiKey"
>) {
  const { t } = useLingui();
  return isOpenAiCompatible ? (
    <div className="mt-5">
      <CompatibleKeyField
        keyRequired={Boolean(endpointPreset)}
        className="block text-body text-muted-foreground"
      >
        <Input
          aria-label={t`API key`}
          value={apiKey}
          onChange={(event) => updateApiKey(event.target.value)}
          required={Boolean(endpointPreset)}
          placeholder={
            credential?.hasKey
              ? t`Paste a replacement key`
              : endpointPreset
                ? undefined
                : t`Optional`
          }
          type="password"
          autoComplete="new-password"
          className="mt-2 h-10 text-foreground"
        />
      </CompatibleKeyField>
      <Button
        type="button"
        variant="secondary"
        className="mt-3"
        size="sm"
        disabled={busy || !openAiCompatibleReady}
        onClick={() => void connectKey()}
      >
        {pending === "connect" ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
      </Button>
    </div>
  ) : null;
}
