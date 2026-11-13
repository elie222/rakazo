import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelCredential } from "@rakazo/contracts";
import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import type { ModelSettingsFields as Fields } from "@rakazo/core";
import {
  credentialModelSettings,
  modelCapabilitiesConfigurable,
  modelSettingsDefaults,
  modelSettingsFields,
  modelSettingsRequest,
} from "@rakazo/core";
import { Button, ModelSettingsFields } from "@rakazo/ui-web";
import { useState } from "react";
import type { ModelCatalogEntry } from "../../lib/model-auth";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

/** One model's own settings on the connection that runs it. */
export function ModelSettingsPanel({
  credential,
  modelId,
  entry,
  onSaved,
}: {
  credential: ModelCredential;
  modelId: string;
  entry: ModelCatalogEntry | undefined;
  onSaved: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const provider = credential.provider;
  const saved = modelSettingsFields(credentialModelSettings(credential, modelId), entry);
  const [fields, setFields] = useState(saved);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const defaults = modelSettingsDefaults(provider, entry);
  const capabilities = modelCapabilitiesConfigurable(provider, entry);
  const dirty = (Object.keys(fields) as (keyof Fields)[]).some((key) => fields[key] !== saved[key]);

  const update = (patch: Partial<Fields>) => {
    setFields((current) => ({ ...current, ...patch }));
    setError(null);
    setNotice(null);
  };

  async function save() {
    const request = modelSettingsRequest({ fields, provider, entry });
    if (request.status === "invalid") {
      setError(
        request.field === "contextWindow"
          ? t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`
          : request.field === "maxTokens"
            ? t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`
            : request.field === "outputRoom"
              ? t`Maximum output tokens must be below the context limit.`
              : t`Enter a whole number from 1 to 1000 for the image limit.`,
      );
      return;
    }
    setPending(true);
    try {
      await rpc.models.saveModelSettings({
        credentialId: credential.id,
        modelId,
        settings: request.settings,
      });
      await onSaved();
      setNotice(t`Saved.`);
    } catch (err) {
      setError(errorText(err, t`Could not save model settings`));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {error ? (
        <p className="mb-4 text-body text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mb-4 text-body text-success" role="status">
          {notice}
        </p>
      ) : null}
      <ModelSettingsFields
        disabled={pending}
        contextWindow={fields.contextWindow}
        onContextWindowChange={(contextWindow) => update({ contextWindow })}
        contextWindowLabel={t`Context limit`}
        contextWindowPlaceholder={defaults.contextWindow?.toString()}
        maxTokens={fields.maxTokens}
        onMaxTokensChange={(maxTokens) => update({ maxTokens })}
        maxTokensLabel={t`Maximum output tokens`}
        maxTokensPlaceholder={defaults.maxTokens?.toString()}
        capabilities={capabilities}
        images={fields.images}
        onImagesChange={(images) => update({ images })}
        imagesLabel={t`Supports images`}
        maxImagesPerPrompt={fields.maxImagesPerPrompt}
        onMaxImagesPerPromptChange={(maxImagesPerPrompt) => update({ maxImagesPerPrompt })}
        maxImagesLabel={t`Maximum images per request`}
        reasoning={fields.reasoning}
        onReasoningChange={(reasoning) => update({ reasoning })}
        reasoningLabel={t`Supports thinking`}
      />
      {dirty ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-4"
          disabled={pending}
          onClick={() => void save()}
        >
          {pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
      ) : null}
    </>
  );
}
