import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button, Disclosure, Input, Label, OptionSelect, Switch } from "@rakazo/ui-web";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
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
  reportSignInStep,
  credential,
  gatewayId,
  projectId,
  region,
  needsRouting,
  needsGateway,
  needsProject,
  modelId,
  modelsForProvider,
  setModelId,
  setThinkingLevel,
  isOpenAiCompatible,
  oauth,
  oauthPending,
  pasteCode,
  pending,
  popupBlocked,
  selected,
  selectionRevisionRef,
  setAccountId,
  setGatewayId,
  setProjectId,
  setRegion,
  setPasteCode,
  setZeroDataRetention,
  submitOAuthCode,
  subscriptionSignIn,
  updateApiKey,
  zeroDataRetention,
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
  | "reportSignInStep"
  | "credential"
  | "gatewayId"
  | "projectId"
  | "region"
  | "needsRouting"
  | "needsGateway"
  | "needsProject"
  | "modelId"
  | "modelsForProvider"
  | "setModelId"
  | "setThinkingLevel"
  | "isOpenAiCompatible"
  | "oauth"
  | "oauthPending"
  | "pasteCode"
  | "pending"
  | "popupBlocked"
  | "selected"
  | "selectionRevisionRef"
  | "setAccountId"
  | "setGatewayId"
  | "setProjectId"
  | "setRegion"
  | "setPasteCode"
  | "setZeroDataRetention"
  | "submitOAuthCode"
  | "subscriptionSignIn"
  | "updateApiKey"
  | "zeroDataRetention"
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
            <div className="w-full rounded-xl border border-border px-4 py-3">
              {oauth.mode === "auth-url" ? (
                <>
                  <p className="text-body-sm leading-[1.5] text-muted-foreground">
                    <Trans>
                      Sign in at{" "}
                      <a
                        href={oauth.verificationUri}
                        onClick={() => reportSignInStep("page_opened")}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground underline"
                      >
                        {new URL(oauth.verificationUri).hostname}
                      </a>
                      , then paste the code here.
                    </Trans>
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Input
                      value={pasteCode}
                      onChange={(e) => setPasteCode(e.target.value)}
                      aria-label={t`Authorization code`}
                      autoComplete="off"
                      spellCheck={false}
                      className="text-foreground md:text-body-sm"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!pasteCode.trim()}
                      onClick={() => void submitOAuthCode()}
                    >
                      <Trans>Submit</Trans>
                    </Button>
                  </div>
                  <p className="mt-2 text-body-sm leading-[1.5] text-muted-foreground">
                    <Plural
                      value={Math.ceil(oauth.expiresInSeconds / 60)}
                      one="Waiting for sign-in — the link expires in about # minute."
                      other="Waiting for sign-in — the link expires in about # minutes."
                    />
                  </p>
                </>
              ) : (
                <>
                  <p className="text-body-sm leading-[1.5] text-muted-foreground">
                    {popupBlocked ? (
                      <Trans>
                        Open{" "}
                        <a
                          href={oauth.verificationUri}
                          onClick={() => reportSignInStep("page_opened")}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground underline"
                        >
                          {oauth.verificationUri.replace(/^https:\/\//, "")}
                        </a>{" "}
                        and enter this code:
                      </Trans>
                    ) : (
                      <Trans>
                        A sign-in tab opened at{" "}
                        <a
                          href={oauth.verificationUri}
                          onClick={() => reportSignInStep("page_opened")}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground underline"
                        >
                          {oauth.verificationUri.replace(/^https:\/\//, "")}
                        </a>
                        . Enter this code there — this window keeps waiting:
                      </Trans>
                    )}
                  </p>
                  <div className="mt-2 flex items-center gap-3">
                    <p className="font-mono text-heading2 tracking-[0.2em] text-foreground">
                      {oauth.userCode}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copyOAuthCode(oauth.userCode)}
                    >
                      {codeCopied ? (
                        <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                      ) : (
                        <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
                      )}
                      {codeCopied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                    </Button>
                  </div>
                  <p className="mt-2 text-body-sm leading-[1.5] text-muted-foreground">
                    <Plural
                      value={Math.ceil(oauth.expiresInSeconds / 60)}
                      one="Waiting for sign-in — the code expires in about # minute."
                      other="Waiting for sign-in — the code expires in about # minutes."
                    />
                  </p>
                </>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 -ml-2 text-muted-foreground"
                onClick={() => cancelOAuthAttempt()}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
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
                  size="lg"
                  className="mt-2 text-foreground"
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
                    size="lg"
                    className="mt-2 text-foreground"
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
                size="lg"
                className="mt-2 text-foreground"
              />
            </label>
          ) : null}
          {!credential && acceptsKey && modelsForProvider.length ? (
            <label
              className="mt-4 block text-body text-muted-foreground"
              htmlFor="connection-model"
            >
              <Trans>Model</Trans>
              <OptionSelect
                id="connection-model"
                aria-label={t`Model`}
                options={modelsForProvider.map((entry) => ({
                  value: entry.id,
                  label: entry.label,
                }))}
                value={modelId}
                onValueChange={(value) => {
                  selectionRevisionRef.current += 1;
                  setModelId(value);
                  setThinkingLevel(null);
                }}
                disabled={busy}
                size="lg"
                className="mt-2 text-foreground"
              />
            </label>
          ) : null}
          {selected?.dataRetentionControl ? (
            <div className="mt-4 flex items-center justify-between gap-3">
              <Label htmlFor="model-zero-data-retention" className="text-body font-normal">
                <Trans>Zero data retention</Trans>
              </Label>
              <Switch
                id="model-zero-data-retention"
                checked={zeroDataRetention}
                disabled={busy}
                onCheckedChange={setZeroDataRetention}
              />
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
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

export function CompatibleKeyInput({
  apiKey,
  credential,
  compatibleKeyRequired,
  updateApiKey,
}: Pick<ModelSettingsState, "apiKey" | "credential" | "compatibleKeyRequired" | "updateApiKey">) {
  const { t } = useLingui();
  return (
    <div className="mt-5">
      <CompatibleKeyField
        keyRequired={compatibleKeyRequired}
        className="block text-body text-muted-foreground"
      >
        <Input
          aria-label={t`API key`}
          value={apiKey}
          onChange={(event) => updateApiKey(event.target.value)}
          required={compatibleKeyRequired}
          placeholder={
            credential?.hasKey
              ? t`Paste a replacement key`
              : compatibleKeyRequired
                ? undefined
                : t`Optional`
          }
          type="password"
          autoComplete="new-password"
          size="lg"
          className="mt-2 text-foreground"
        />
      </CompatibleKeyField>
    </div>
  );
}
