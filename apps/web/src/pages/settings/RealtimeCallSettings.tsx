import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RealtimeCallCapability,
  RealtimeCallSettings,
  RealtimeCallState,
} from "@rakazo/contracts";
import { chosenRealtimeModel } from "@rakazo/contracts";
import {
  Disclosure,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  OptionSelect,
} from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { loadRealtimeCallState } from "../../lib/calls/realtime-call";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

/** Languages offered for the caller; any ISO 639-1 code is accepted by the server. */
const LANGUAGES = ["de", "en", "fr", "es", "it", "nl", "pl", "pt", "tr", "uk"] as const;
/** "" is Standard: nothing is sent and the provider keeps its normal pace. */
const SPEEDS = ["0.8", "0.9", "1", "1.1", "1.25", "1.5"] as const;
/** Each language under its own name, the way a speaker looks for it. */
const ownName = (code: string) =>
  new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;

/**
 * A blank field clears the setting. A value outside the range, or a fraction where a whole
 * number is required, is not saved; the field returns to what is stored.
 */
function saveNumber(
  input: HTMLInputElement,
  range: { min: number; max: number; integer?: boolean },
  stored: number | undefined,
  apply: (value: number | undefined) => void,
) {
  if (!input.value.trim()) {
    if (stored !== undefined) apply(undefined);
    return;
  }
  const parsed = Number(input.value);
  const valid =
    Number.isFinite(parsed) &&
    parsed >= range.min &&
    parsed <= range.max &&
    (!range.integer || Number.isInteger(parsed));
  if (!valid) {
    input.value = stored === undefined ? "" : String(stored);
    return;
  }
  if (parsed !== stored) apply(parsed);
}

/** Realtime call settings for the account; hidden until a connected provider can hold a call. */
export function RealtimeCallSettingsSection() {
  const { t, i18n } = useLingui();
  const ids = {
    provider: useId(),
    model: useId(),
    voice: useId(),
    speed: useId(),
    patience: useId(),
    noise: useId(),
    language: useId(),
    thinking: useId(),
    threshold: useId(),
    silence: useId(),
    tokens: useId(),
  };
  const [state, setState] = useState<RealtimeCallState | null>(null);
  const settingsSave = useSave({
    save: (next: RealtimeCallSettings, client) => client.voice.realtime.set(next),
    onSaved: (saved) => setState(saved),
  });
  const busy = settingsSave.pending;
  const error = settingsSave.error
    ? errorText(settingsSave.error, t`Could not save the call settings`)
    : "";

  useEffect(() => {
    let cancelled = false;
    void loadRealtimeCallState()
      .then((loaded) => {
        if (!cancelled) setState(loaded);
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state?.available) return null;
  const { settings } = state;
  const chosen = chosenRealtimeModel(state);
  const provider =
    state.providers.find((entry) => entry.provider === settings.provider) ?? state.providers[0];
  const can = (capability: RealtimeCallCapability) =>
    chosen?.model.capabilities.includes(capability) ?? false;

  function save(patch: Partial<RealtimeCallSettings>) {
    settingsSave.run({ ...settings, ...patch });
  }

  return (
    <section className="mt-8 border-t pt-6" aria-labelledby={ids.model}>
      <h3 className="text-sm font-medium">
        <Trans>Realtime calls</Trans>
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        <Trans>
          Realtime calls share audio, recent chat messages and your bot's memory with the voice
          provider. The bot can look up older messages during the call.
        </Trans>
      </p>
      {state.providers.length > 1 ? (
        <Field className="mt-6">
          <FieldLabel htmlFor={ids.provider}>
            <Trans>Call provider</Trans>
          </FieldLabel>
          <OptionSelect
            id={ids.provider}
            value={provider?.provider ?? null}
            disabled={busy}
            options={state.providers.map((entry) => ({
              value: entry.provider,
              label: entry.provider,
            }))}
            onValueChange={(next) => save({ provider: next, model: "", voiceId: undefined })}
          />
        </Field>
      ) : null}
      <Field className="mt-6">
        <FieldLabel htmlFor={ids.model}>
          <Trans>Realtime call model</Trans>
        </FieldLabel>
        <OptionSelect
          id={ids.model}
          value={chosen?.model.id ?? ""}
          disabled={busy}
          options={[
            { value: "", label: t`Standard call` },
            ...(provider?.models ?? []).map((model) => ({ value: model.id, label: model.label })),
          ]}
          onValueChange={(next) => save({ provider: provider?.provider ?? "", model: next })}
        />
      </Field>
      {chosen ? (
        <>
          {can("voice") ? (
            <Field className="mt-6">
              <FieldLabel htmlFor={ids.voice}>
                <Trans>Call voice</Trans>
              </FieldLabel>
              <OptionSelect
                id={ids.voice}
                value={settings.voiceId ?? ""}
                disabled={busy}
                options={[
                  { value: "", label: t`Provider default` },
                  ...chosen.voices.map((voice) => ({ value: voice, label: voice })),
                ]}
                onValueChange={(next) => save({ voiceId: next || undefined })}
              />
              <FieldDescription>
                <Trans>A bot's own voice wins when the call provider offers it.</Trans>
              </FieldDescription>
            </Field>
          ) : null}
          {can("speed") ? (
            <Field className="mt-6">
              <FieldLabel htmlFor={ids.speed}>
                <Trans>Speaking speed</Trans>
              </FieldLabel>
              <OptionSelect
                id={ids.speed}
                value={settings.speed === undefined ? "" : String(settings.speed)}
                disabled={busy}
                options={[
                  { value: "", label: t`Standard` },
                  ...SPEEDS.map((speed) => ({
                    value: speed,
                    label: `${i18n.number(Number(speed))}×`,
                  })),
                ]}
                onValueChange={(next) => save({ speed: next ? Number(next) : undefined })}
              />
            </Field>
          ) : null}
          {can("patience") ? (
            <Field className="mt-6">
              <FieldLabel htmlFor={ids.patience}>
                <Trans>Turn taking</Trans>
              </FieldLabel>
              <OptionSelect
                id={ids.patience}
                value={settings.patience ?? ""}
                disabled={busy}
                options={[
                  { value: "", label: t`Standard` },
                  { value: "patient", label: t`Patient: lets you think out loud` },
                  { value: "balanced", label: t`Balanced` },
                  { value: "quick", label: t`Quick: answers after short pauses` },
                ]}
                onValueChange={(next) =>
                  save({
                    patience: next ? (next as RealtimeCallSettings["patience"]) : undefined,
                  })
                }
              />
            </Field>
          ) : null}
          {can("noiseReduction") ? (
            <Field className="mt-6">
              <FieldLabel htmlFor={ids.noise}>
                <Trans>Microphone</Trans>
              </FieldLabel>
              <OptionSelect
                id={ids.noise}
                value={settings.noiseReduction ?? ""}
                disabled={busy}
                options={[
                  { value: "", label: t`Standard` },
                  { value: "headset", label: t`Headset` },
                  { value: "room", label: t`Laptop or room` },
                  { value: "off", label: t`Off: no noise reduction` },
                ]}
                onValueChange={(next) =>
                  save({
                    noiseReduction: next
                      ? (next as RealtimeCallSettings["noiseReduction"])
                      : undefined,
                  })
                }
              />
            </Field>
          ) : null}
          {can("language") ? (
            <Field className="mt-6">
              <FieldLabel htmlFor={ids.language}>
                <Trans>Transcript language</Trans>
              </FieldLabel>
              <OptionSelect
                id={ids.language}
                value={settings.language ?? ""}
                disabled={busy}
                options={[
                  { value: "", label: t`Automatic` },
                  ...LANGUAGES.map((code) => ({ value: code, label: ownName(code) })),
                ]}
                onValueChange={(next) => save({ language: next || undefined })}
              />
            </Field>
          ) : null}
          {can("thinking") ? (
            <Field className="mt-6">
              <FieldLabel htmlFor={ids.thinking}>
                <Trans>Thinking before answering</Trans>
              </FieldLabel>
              <OptionSelect
                id={ids.thinking}
                value={settings.thinking ?? ""}
                disabled={busy}
                options={[
                  { value: "", label: t`Standard` },
                  { value: "fast", label: t`Fast: shortest delay` },
                  { value: "balanced", label: t`Balanced` },
                  { value: "thorough", label: t`Thorough: better answers, longer pauses` },
                ]}
                onValueChange={(next) =>
                  save({
                    thinking: next ? (next as RealtimeCallSettings["thinking"]) : undefined,
                  })
                }
              />
            </Field>
          ) : null}
          {can("vadThreshold") || can("silenceMs") || can("maxOutputTokens") ? (
            <Disclosure
              className="mt-6"
              summary={<span className="text-sm font-medium">{t`Advanced`}</span>}
              contentClassName="mt-4"
            >
              {!settings.patience && can("vadThreshold") ? (
                <Field>
                  <FieldLabel htmlFor={ids.threshold}>
                    <Trans>Speech threshold (0 to 1)</Trans>
                  </FieldLabel>
                  <Input
                    id={ids.threshold}
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    disabled={busy}
                    defaultValue={settings.vadThreshold ?? ""}
                    onBlur={(event) =>
                      saveNumber(event.target, { min: 0, max: 1 }, settings.vadThreshold, (value) =>
                        save({ vadThreshold: value }),
                      )
                    }
                  />
                </Field>
              ) : null}
              {!settings.patience && can("silenceMs") ? (
                <Field className="mt-4">
                  <FieldLabel htmlFor={ids.silence}>
                    <Trans>Quiet gap in milliseconds</Trans>
                  </FieldLabel>
                  <Input
                    id={ids.silence}
                    type="number"
                    min={200}
                    max={3000}
                    step={50}
                    disabled={busy}
                    defaultValue={settings.silenceMs ?? ""}
                    onBlur={(event) =>
                      saveNumber(
                        event.target,
                        { min: 200, max: 3000, integer: true },
                        settings.silenceMs,
                        (value) => save({ silenceMs: value }),
                      )
                    }
                  />
                </Field>
              ) : null}
              {can("maxOutputTokens") ? (
                <Field className="mt-4">
                  <FieldLabel htmlFor={ids.tokens}>
                    <Trans>Longest spoken answer (tokens)</Trans>
                  </FieldLabel>
                  <Input
                    id={ids.tokens}
                    type="number"
                    min={1}
                    max={4096}
                    step={1}
                    disabled={busy}
                    defaultValue={settings.maxOutputTokens ?? ""}
                    onBlur={(event) =>
                      saveNumber(
                        event.target,
                        { min: 1, max: 4096, integer: true },
                        settings.maxOutputTokens,
                        (value) => save({ maxOutputTokens: value }),
                      )
                    }
                  />
                </Field>
              ) : null}
            </Disclosure>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
