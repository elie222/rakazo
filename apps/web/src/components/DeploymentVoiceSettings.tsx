import { Trans, useLingui } from "@lingui/react/macro";
import type { DeploymentVoiceSettings as Settings, VoiceInfo } from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
} from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";

type Draft = { provider: string; apiKey: string; voiceId: string };

function draftFrom(settings: Settings): Draft {
  return { provider: settings.provider ?? "", apiKey: "", voiceId: settings.voiceId };
}

/** Admins choose the voice everyone without their own connection uses. The key never returns. */
export function DeploymentVoiceSettings() {
  const { t } = useLingui();
  const providerId = useId();
  const apiKeyId = useId();
  const voiceSelectId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  function show(next: Settings) {
    setSettings(next);
    setDraft(draftFrom(next));
    setVoices([]);
    if (!next.keySaved) return;
    // The RPC client hands out a new object on every property read, so never hold it.
    rpc.voice.deployment.voices().then(
      (listed) => {
        if (alive.current) setVoices(listed);
      },
      (caught: unknown) => {
        if (alive.current) setError(errorText(caught, t`Could not load voice settings`));
      },
    );
  }

  useEffect(() => {
    alive.current = true;
    rpc.voice.deployment.get().then(show, (caught: unknown) => {
      if (alive.current) setError(errorText(caught, t`Could not load voice settings`));
    });
    return () => {
      alive.current = false;
    };
  }, []);

  if (!settings || !draft) {
    return error ? (
      <p role="alert" className="mt-8 text-body-sm text-destructive">
        {error}
      </p>
    ) : null;
  }

  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch });
  };
  async function save() {
    if (!draft || pending) return;
    setPending(true);
    setError(null);
    try {
      const next = await rpc.voice.deployment.update({
        provider: draft.provider || null,
        // Blank keeps the saved key.
        apiKey: draft.apiKey.trim(),
        ...(draft.voiceId ? { voiceId: draft.voiceId } : {}),
      });
      if (!alive.current) return;
      show(next);
      setSaved(true);
    } catch (caught) {
      if (alive.current) setError(errorText(caught, t`Could not connect this voice provider`));
    } finally {
      if (alive.current) setPending(false);
    }
  }

  const savedProvider = settings.provider ?? "";
  const keySaved = settings.keySaved && draft.provider === savedProvider;
  const environment = settings.providers.find((entry) => entry.id === settings.environmentProvider);
  const voiceOptions: VoiceInfo[] =
    draft.voiceId && !voices.some((voice) => voice.id === draft.voiceId)
      ? [{ id: draft.voiceId, label: draft.voiceId }, ...voices]
      : voices;
  return (
    <form
      className="mt-8 grid gap-3"
      data-testid="deployment-voice-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SectionHeading variant="heading">
        <Trans>Default for everyone</Trans>
      </SectionHeading>
      {/* Edits made while a save is in flight would be replaced by what it saved. */}
      <fieldset className="contents" disabled={pending}>
        <Field>
          <FieldLabel htmlFor={providerId}>
            <Trans>Provider</Trans>
          </FieldLabel>
          <NativeSelect
            id={providerId}
            className="w-full"
            value={draft.provider}
            onChange={(event) =>
              set({
                provider: event.target.value,
                apiKey: "",
                voiceId: event.target.value === savedProvider ? settings.voiceId : "",
              })
            }
          >
            <NativeSelectOption value="">
              {t`Default`}
              {environment ? ` (${environment.name})` : ""}
            </NativeSelectOption>
            {settings.providers.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>
                {entry.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        {draft.provider ? (
          <Field>
            <FieldLabel htmlFor={apiKeyId}>
              <Trans>API key</Trans>
            </FieldLabel>
            <Input
              id={apiKeyId}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={draft.apiKey}
              required={!keySaved}
              placeholder={keySaved ? t`Saved` : t`Paste your API key`}
              onChange={(event) => set({ apiKey: event.target.value })}
            />
          </Field>
        ) : null}
        {keySaved && voiceOptions.length ? (
          <Field>
            <FieldLabel htmlFor={voiceSelectId}>
              <Trans>Voice</Trans>
            </FieldLabel>
            <NativeSelect
              id={voiceSelectId}
              className="w-full"
              value={draft.voiceId}
              onChange={(event) => set({ voiceId: event.target.value })}
            >
              {voiceOptions.map((voice) => (
                <NativeSelectOption key={voice.id} value={voice.id}>
                  {voice.label}
                  {voice.description ? ` (${voice.description})` : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
      </fieldset>
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          <Trans>Save</Trans>
        </Button>
        {saved ? <SuccessPop label={t`Saved`} /> : null}
      </div>
    </form>
  );
}
