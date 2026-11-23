import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelCredential, ModelSettings } from "@rakazo/contracts";
import { MAX_MODEL_CONTEXT_WINDOW, MAX_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import type { ModelSettingsFields as Fields } from "@rakazo/core";
import {
  credentialModelSettings,
  modelCapabilitiesConfigurable,
  modelHasOwnSettings,
  modelSettingsDefaults,
  modelSettingsFields,
  modelSettingsRequest,
} from "@rakazo/core";
import { writeSaved } from "@rakazo/core/query";
import { Button, ModelSettingsFields } from "@rakazo/ui-web";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ModelCatalogEntry } from "../../lib/models/model-auth";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

/** One model's own settings on the connection that runs it. */
export function ModelSettingsPanel({
  credential,
  modelId,
  entry,
}: {
  credential: ModelCredential;
  modelId: string;
  entry: ModelCatalogEntry | undefined;
}) {
  const { t } = useLingui();
  const provider = credential.provider;
  const saved = modelSettingsFields(credentialModelSettings(credential, modelId), entry);
  // Unedited fields follow what is saved, including after a save or reset.
  const [edited, setEdited] = useState<Fields | null>(null);
  const fields = edited ?? saved;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const persist = useSave({
    save: async (settings: ModelSettings, rpc) => {
      await rpc.models.saveModelSettings({ credentialId: credential.id, modelId, settings });
      // Shown as saved even if reading the connections again fails.
      await writeSaved(queryClient, queries.models.credentials.queryKey(), (current = []) =>
        current.map((entry) =>
          entry.id === credential.id
            ? { ...entry, modelSettings: { ...entry.modelSettings, [modelId]: settings } }
            : entry,
        ),
      );
    },
    stale: [queries.models.credentials.key(), queries.models.list.key()],
    onSaved: () => {
      setEdited(null);
      setNotice(t`Saved.`);
    },
  });
  const pending = persist.pending;
  const defaults = modelSettingsDefaults(provider, entry);
  const capabilities = modelCapabilitiesConfigurable(provider, entry);
  const dirty = (Object.keys(fields) as (keyof Fields)[]).some((key) => fields[key] !== saved[key]);

  const customized = modelHasOwnSettings(credential, modelId);

  const update = (patch: Partial<Fields>) => {
    setEdited({ ...fields, ...patch });
    setError(null);
    setNotice(null);
    persist.reset();
  };

  function run(settings: ModelSettings) {
    if (pending) return;
    setError(null);
    setNotice(null);
    persist.run(settings);
  }

  function save() {
    const request = modelSettingsRequest({ fields, provider, entry });
    if (request.status === "invalid") {
      persist.reset();
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
    run(request.settings);
  }

  return (
    <>
      {persist.error || error ? (
        <p className="mb-4 text-body text-destructive" role="alert">
          {persist.error ? errorText(persist.error, t`Could not save model settings`) : error}
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
      {dirty || customized ? (
        <div className="mt-4 flex items-center gap-2">
          {dirty ? (
            <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={save}>
              {pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
          ) : null}
          {customized ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={pending}
              onClick={() => run({})}
            >
              <Trans>Reset to defaults</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
