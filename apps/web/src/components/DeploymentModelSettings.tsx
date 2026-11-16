import { Trans, useLingui } from "@lingui/react/macro";
import type { DeploymentModelSettings as Settings } from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  Label,
  OptionSelect,
  SectionHeading,
  Switch,
} from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { useSave } from "../lib/query";
import type { RpcClient } from "../lib/rpc";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

type Draft = {
  provider: string;
  apiKey: string;
  baseUrl: string;
  models: string;
  contextWindow: string;
  maxTokens: string;
};

const EMPTY_DRAFT: Draft = {
  provider: "",
  apiKey: "",
  baseUrl: "",
  models: "",
  contextWindow: "",
  maxTokens: "",
};

/** One change an admin makes, sent through the client the save receives. */
type Change = { send: (client: RpcClient) => Promise<Settings>; done?: () => void };

const choiceKey = (provider: string, modelId: string) => `${provider}\n${modelId}`;

const positive = (value: string) => {
  const number = Number(value.trim());
  return value.trim() && Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

/**
 * Admins choose the deployment's model connections, its default model and which models members
 * may use without their own. Keys never come back from the server.
 */
export function DeploymentModelSettings() {
  const { t } = useLingui();
  const defaultId = useId();
  const providerId = useId();
  const apiKeyId = useId();
  const baseUrlId = useId();
  const modelsId = useId();
  const contextId = useId();
  const maxTokensId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Counts saves, so a load still in flight never replaces what a save returned.
  const saves = useRef(0);
  const save = useSave({
    save: (change: Change, client) => change.send(client),
    onSaved: (next, change) => {
      saves.current += 1;
      setSettings(next);
      change.done?.();
    },
  });
  const probe = useSave({
    save: (input: { baseUrl: string; apiKey: string }, client) =>
      client.models.deployment.probe(input),
    onSaved: ({ models }) =>
      setDraft((current) => ({ ...EMPTY_DRAFT, ...current, models: models.join(", ") })),
  });
  const pending = save.pending || probe.pending;
  // Each failure holds until the next request, which forgets the other's.
  const error =
    loadError ??
    (save.error
      ? errorText(save.error, t`Could not save model settings`)
      : probe.error
        ? errorText(probe.error, t`Could not list models`)
        : null);
  function run(send: Change["send"], done?: () => void) {
    probe.reset();
    save.run({ send, done });
  }

  useEffect(() => {
    // Each load answers only its own run of the effect: one started before a locale switch is
    // dropped, as is one that a save overtook.
    let current = true;
    const savesAtStart = saves.current;
    // The RPC client hands out a new object on every property read, so never hold it.
    rpc.models.deployment.get().then(
      (next) => {
        if (current && saves.current === savesAtStart) setSettings(next);
      },
      (caught: unknown) => {
        if (current) setLoadError(errorText(caught, t`Could not load model settings`));
      },
    );
    return () => {
      current = false;
    };
  }, [t]);

  if (!settings) {
    return error ? (
      <p role="alert" className="mt-8 text-body-sm text-destructive">
        {error}
      </p>
    ) : null;
  }

  const effective = settings.effectiveDefault;
  const environmentLabel = settings.defaultModel
    ? null
    : settings.connections
        .find((connection) => connection.provider === effective?.provider)
        ?.models.find((model) => model.id === effective?.modelId)?.label;
  const adding = draft
    ? settings.providers.find((provider) => provider.id === draft.provider)
    : undefined;
  const replacing = settings.connections.find(
    (connection) => connection.saved && connection.provider === draft?.provider,
  );
  const set = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...EMPTY_DRAFT, ...current, ...patch }));

  function findModels() {
    if (!draft) return;
    save.reset();
    probe.run({ baseUrl: draft.baseUrl, apiKey: draft.apiKey });
  }

  return (
    <section className="mt-8 grid gap-4" data-testid="deployment-model-settings">
      <SectionHeading variant="heading">
        <Trans>Default for everyone</Trans>
      </SectionHeading>
      {/* Edits made while a save is in flight would be replaced by what it saved. */}
      <fieldset className="contents" disabled={pending}>
        {settings.connections.length ? (
          <Field>
            {/* The heading already says what this picks; the label is for screen readers. */}
            <FieldLabel htmlFor={defaultId} className="sr-only">
              <Trans>Model</Trans>
            </FieldLabel>
            <OptionSelect
              id={defaultId}
              value={
                settings.defaultModel
                  ? choiceKey(settings.defaultModel.provider, settings.defaultModel.modelId)
                  : ""
              }
              onValueChange={(choice) => {
                const [provider, modelId] = choice.split("\n");
                run((client) =>
                  client.models.deployment.update({
                    defaultModel: provider && modelId ? { provider, modelId } : null,
                  }),
                );
              }}
              options={[
                {
                  value: "",
                  label: environmentLabel ? `${t`Default`} (${environmentLabel})` : t`Default`,
                },
                // One list for every provider; with more than one, each model names its own.
                ...settings.connections.flatMap((connection) =>
                  connection.models.map((model) => ({
                    value: choiceKey(connection.provider, model.id),
                    label:
                      settings.connections.length > 1
                        ? `${model.label} (${connection.name})`
                        : model.label,
                  })),
                ),
              ]}
            />
          </Field>
        ) : null}
        {settings.connections.length ? (
          <SettingsGroup
            title={<Trans>Members can also choose</Trans>}
            action={
              // A list saved here replaces the server's own until it is reset.
              settings.allowedModels ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() =>
                    run((client) => client.models.deployment.update({ allowedModels: null }))
                  }
                >
                  <Trans>Reset</Trans>
                </Button>
              ) : undefined
            }
          >
            {settings.connections.map((connection) => (
              <SettingsRow
                key={connection.provider}
                label={
                  <Label
                    htmlFor={`${defaultId}-${connection.provider}`}
                    className="text-body font-normal text-foreground"
                  >
                    {connection.name}
                  </Label>
                }
                control={
                  <>
                    {connection.saved ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        aria-label={t`Remove ${connection.name}`}
                        onClick={() =>
                          run((client) =>
                            client.models.deployment.disconnect({ provider: connection.provider }),
                          )
                        }
                      >
                        <Trans>Remove</Trans>
                      </Button>
                    ) : null}
                    <Switch
                      id={`${defaultId}-${connection.provider}`}
                      checked={connection.open}
                      onCheckedChange={(open) =>
                        run((client) =>
                          client.models.deployment.update({
                            open: { provider: connection.provider, open },
                          }),
                        )
                      }
                    />
                  </>
                }
              />
            ))}
          </SettingsGroup>
        ) : null}
        {draft ? (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const models = draft.models
                .split(/[\s,]+/)
                .map((id) => id.trim())
                .filter(Boolean);
              run(
                (client) =>
                  client.models.deployment.connect({
                    provider: draft.provider,
                    apiKey: draft.apiKey.trim(),
                    ...(adding?.endpoint
                      ? {
                          baseUrl: draft.baseUrl.trim(),
                          enabledModelIds: models,
                          contextWindow: positive(draft.contextWindow),
                          maxTokens: positive(draft.maxTokens) ?? null,
                        }
                      : {}),
                  }),
                () => setDraft(null),
              );
            }}
          >
            <Field>
              <FieldLabel htmlFor={providerId}>
                <Trans>Provider</Trans>
              </FieldLabel>
              <OptionSelect
                id={providerId}
                value={draft.provider || null}
                required
                onValueChange={(provider) => {
                  // A saved endpoint opens with its URL, models and limits; never its key.
                  const saved = settings.connections.find(
                    (connection) => connection.saved && connection.provider === provider,
                  );
                  setDraft({
                    ...EMPTY_DRAFT,
                    provider,
                    baseUrl: saved?.baseUrl ?? "",
                    models: saved?.baseUrl ? saved.models.map((model) => model.id).join(", ") : "",
                    contextWindow: saved?.contextWindow ? String(saved.contextWindow) : "",
                    maxTokens: saved?.maxTokens ? String(saved.maxTokens) : "",
                  });
                }}
                options={settings.providers.map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                }))}
              />
            </Field>
            {adding?.endpoint ? (
              <Field>
                <FieldLabel htmlFor={baseUrlId}>
                  <Trans>Base URL</Trans>
                </FieldLabel>
                <Input
                  id={baseUrlId}
                  type="url"
                  required
                  spellCheck={false}
                  value={draft.baseUrl}
                  onChange={(event) => set({ baseUrl: event.target.value })}
                />
              </Field>
            ) : null}
            {draft.provider ? (
              <Field>
                <FieldLabel htmlFor={apiKeyId}>
                  <Trans>API key</Trans>
                </FieldLabel>
                <Input
                  id={apiKeyId}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  // A saved key stays unless a new one replaces it.
                  required={!replacing && !adding?.endpoint}
                  placeholder={replacing ? t`Saved` : undefined}
                  value={draft.apiKey}
                  onChange={(event) => set({ apiKey: event.target.value })}
                />
              </Field>
            ) : null}
            {adding?.endpoint ? (
              <>
                <Field>
                  <FieldLabel htmlFor={modelsId}>
                    <Trans>Models</Trans>
                  </FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      id={modelsId}
                      required
                      spellCheck={false}
                      value={draft.models}
                      onChange={(event) => set({ models: event.target.value })}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!draft.baseUrl.trim()}
                      onClick={findModels}
                    >
                      <Trans>Find models</Trans>
                    </Button>
                  </div>
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor={contextId}>
                      <Trans>Context limit</Trans>
                    </FieldLabel>
                    <Input
                      id={contextId}
                      inputMode="numeric"
                      value={draft.contextWindow}
                      onChange={(event) => set({ contextWindow: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={maxTokensId}>
                      <Trans>Maximum output tokens</Trans>
                    </FieldLabel>
                    <Input
                      id={maxTokensId}
                      inputMode="numeric"
                      value={draft.maxTokens}
                      onChange={(event) => set({ maxTokens: event.target.value })}
                    />
                  </Field>
                </div>
              </>
            ) : null}
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={!draft.provider}>
                <Trans>Save</Trans>
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="justify-self-start"
            onClick={() => setDraft(EMPTY_DRAFT)}
          >
            <Trans>Add provider</Trans>
          </Button>
        )}
      </fieldset>
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
