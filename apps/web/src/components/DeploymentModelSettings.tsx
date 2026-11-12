import { Trans, useLingui } from "@lingui/react/macro";
import type { DeploymentModelSettings as Settings } from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  Label,
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
  SectionHeading,
  Switch,
} from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  // Counts saves, so a load still in flight never replaces what a save returned.
  const saves = useRef(0);

  useEffect(() => {
    alive.current = true;
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
        if (current) setError(errorText(caught, t`Could not load model settings`));
      },
    );
    return () => {
      current = false;
      alive.current = false;
    };
  }, [t]);

  if (!settings) {
    return error ? (
      <p role="alert" className="mt-8 text-body-sm text-destructive">
        {error}
      </p>
    ) : null;
  }

  async function run(action: () => Promise<Settings>, done?: () => void) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const next = await action();
      if (!alive.current) return;
      saves.current += 1;
      setSettings(next);
      done?.();
    } catch (caught) {
      if (alive.current) setError(errorText(caught, t`Could not save model settings`));
    } finally {
      if (alive.current) setPending(false);
    }
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

  async function findModels() {
    if (!draft || pending) return;
    setPending(true);
    setError(null);
    try {
      const { models } = await rpc.models.deployment.probe({
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
      });
      if (alive.current) set({ models: models.join(", ") });
    } catch (caught) {
      if (alive.current) setError(errorText(caught, t`Could not list models`));
    } finally {
      if (alive.current) setPending(false);
    }
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
            <NativeSelect
              id={defaultId}
              className="w-full"
              value={
                settings.defaultModel
                  ? choiceKey(settings.defaultModel.provider, settings.defaultModel.modelId)
                  : ""
              }
              onChange={(event) => {
                const [provider, modelId] = event.target.value.split("\n");
                void run(() =>
                  rpc.models.deployment.update({
                    defaultModel: provider && modelId ? { provider, modelId } : null,
                  }),
                );
              }}
            >
              <NativeSelectOption value="">
                {t`Default`}
                {environmentLabel ? ` (${environmentLabel})` : ""}
              </NativeSelectOption>
              {settings.connections.map((connection) => (
                <NativeSelectOptGroup key={connection.provider} label={connection.name}>
                  {connection.models.map((model) => (
                    <NativeSelectOption
                      key={model.id}
                      value={choiceKey(connection.provider, model.id)}
                    >
                      {model.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              ))}
            </NativeSelect>
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
                    void run(() => rpc.models.deployment.update({ allowedModels: null }))
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
                          void run(() =>
                            rpc.models.deployment.disconnect({ provider: connection.provider }),
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
                        void run(() =>
                          rpc.models.deployment.update({
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
              void run(
                () =>
                  rpc.models.deployment.connect({
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
              <NativeSelect
                id={providerId}
                className="w-full"
                value={draft.provider}
                required
                onChange={(event) => {
                  // A saved endpoint opens with its URL, models and limits; never its key.
                  const saved = settings.connections.find(
                    (connection) => connection.saved && connection.provider === event.target.value,
                  );
                  setDraft({
                    ...EMPTY_DRAFT,
                    provider: event.target.value,
                    baseUrl: saved?.baseUrl ?? "",
                    models: saved?.baseUrl ? saved.models.map((model) => model.id).join(", ") : "",
                    contextWindow: saved?.contextWindow ? String(saved.contextWindow) : "",
                    maxTokens: saved?.maxTokens ? String(saved.maxTokens) : "",
                  });
                }}
              >
                <NativeSelectOption value="" />
                {settings.providers.map((provider) => (
                  <NativeSelectOption key={provider.id} value={provider.id}>
                    {provider.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
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
                      onClick={() => void findModels()}
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
