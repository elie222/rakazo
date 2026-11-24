import { Trans, useLingui } from "@lingui/react/macro";
import type { DeploymentModelSettings as Settings } from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  OptionSelect,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SuccessPop } from "../../components/ai/primitives";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

type Draft = { provider: string; modelId: string; apiKey: string };

function draftFrom(settings: Settings): Draft {
  return { provider: settings.provider ?? "", modelId: settings.modelId ?? "", apiKey: "" };
}

/**
 * An admin's choice of the model members without their own run on, and the key that pays for
 * it. "Default" goes back to the server's own. The key never comes back from the server.
 */
export function DeploymentModelSettings() {
  const { t } = useLingui();
  const providerId = useId();
  const keyId = useId();
  const modelId = useId();
  const queries = useSpaceQueries();
  const read = useQuery(queries.models.deployment.get.queryOptions());
  const settings = read.data;
  // Null until edited, so what the server holds shows until then.
  const [edited, setEdited] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useSave({
    save: (next: Draft, client) =>
      client.models.deployment.update(
        next.provider
          ? {
              provider: next.provider,
              modelId: next.modelId,
              ...(next.apiKey.trim() ? { apiKey: next.apiKey.trim() } : {}),
            }
          : { provider: null },
      ),
    // What members run without their own model is part of every model read and of the account.
    stale: [queries.models.key(), queries.me.key()],
    onSaved: () => {
      setEdited(null);
      setSaved(true);
    },
  });

  if (!settings) {
    return read.error ? (
      <p role="alert" className="mb-8 text-body-sm text-destructive">
        {errorText(read.error, t`Could not load model settings`)}
      </p>
    ) : null;
  }
  // A key saved before the block stopped applying stays removable.
  if (settings.providers.length === 0 && !settings.keySaved) return null;
  const draft = edited ?? draftFrom(settings);
  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setEdited({ ...draft, ...patch });
  };
  const provider = settings.providers.find((entry) => entry.id === draft.provider);
  const keySaved = settings.keySaved && draft.provider === settings.provider;
  // A key whose model no longer runs shows as Default, and saving that removes the key.
  const setAside = settings.keySaved && !settings.provider;
  return (
    <section className="mb-8" data-testid="deployment-model-settings">
      <SectionHeading className="mb-2.5">
        <Trans>Default for everyone</Trans>
      </SectionHeading>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.run(draft);
        }}
      >
        {/* Edits made while a save is in flight would be replaced by what it saved. */}
        <fieldset className="contents" disabled={save.pending}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={providerId}>
                <Trans>Provider</Trans>
              </FieldLabel>
              <OptionSelect
                id={providerId}
                value={draft.provider}
                onValueChange={(next) =>
                  set({
                    provider: next,
                    modelId:
                      next === settings.provider
                        ? (settings.modelId ?? "")
                        : (settings.providers.find((entry) => entry.id === next)?.models[0]?.id ??
                          ""),
                    apiKey: "",
                  })
                }
                options={[
                  { value: "", label: t`Default` },
                  ...settings.providers.map((entry) => ({ value: entry.id, label: entry.name })),
                ]}
              />
            </Field>
            {provider ? (
              <>
                <Field>
                  <FieldLabel htmlFor={keyId}>
                    <Trans>API key</Trans>
                  </FieldLabel>
                  <Input
                    id={keyId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.apiKey}
                    placeholder={keySaved ? t`Saved` : undefined}
                    required={!keySaved}
                    onChange={(event) => set({ apiKey: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={modelId}>
                    <Trans>Model</Trans>
                  </FieldLabel>
                  <OptionSelect
                    id={modelId}
                    value={draft.modelId || null}
                    required
                    onValueChange={(next) => set({ modelId: next })}
                    options={provider.models.map((model) => ({
                      value: model.id,
                      label: model.label,
                    }))}
                  />
                </Field>
              </>
            ) : null}
          </FieldGroup>
        </fieldset>
        {save.error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {errorText(save.error, t`Could not save model settings`)}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={save.pending || (!edited && !setAside)}>
            <Trans>Save</Trans>
          </Button>
          {saved ? <SuccessPop label={t`Saved`} /> : null}
        </div>
      </form>
    </section>
  );
}
