import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { botVoiceChoices, botVoiceProviderChoices } from "@rakazo/core";
import { Button, Field, FieldGroup, FieldLabel, OptionSelect } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Play, Square } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useCallSession } from "../../lib/call-session";
import { useSave, useSpaceQueries } from "../../lib/query";
import { speaker } from "../../lib/tts";
import { errorText } from "../../lib/user-error";

type VoiceChoice = { voiceProvider: string | null; voiceId: string | null };

/** Voice choices save independently, so an unrelated profile draft cannot overwrite them. */
export function BotVoiceSettings({ bot }: { bot: Bot }) {
  const { t } = useLingui();
  const ids = useId();
  const queries = useSpaceQueries();
  const botQuery = useQuery({
    ...queries.bots.get.queryOptions({ input: { botId: bot.id } }),
    initialData: bot,
  });
  const credentials = useQuery(queries.voice.credentials.queryOptions());
  const catalog = useQuery(queries.voice.catalog.queryOptions());
  const current = botQuery.data ?? bot;
  const selectedProvider = current.voiceProvider ?? "";
  const providers = botVoiceProviderChoices({
    provider: current.voiceProvider,
    credentials: credentials.data,
    catalog: catalog.data,
  });
  const connection = providers.connection;
  const voices = useQuery({
    ...queries.voice.voices.queryOptions({
      input: connection ? { provider: connection.provider } : {},
    }),
    enabled: Boolean(connection),
  });
  const save = useSave<VoiceChoice, Bot>({
    save: (choice, rpc) => rpc.bots.update({ botId: bot.id, ...choice }),
    stale: [
      queries.bots.get.queryKey({ input: { botId: bot.id } }),
      queries.bots.list.queryKey(),
      queries.bootstrap.queryKey({ input: {} }),
      queries.voice.status.queryKey(),
    ],
  });
  const previewId = `${ids}-voice-preview`;
  const subscribe = useCallback((notify: () => void) => speaker.subscribe(notify), []);
  const playback = useSyncExternalStore(subscribe, () => speaker.state);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRevision = useRef(0);
  useEffect(
    () => () => {
      previewRevision.current += 1;
      if (speaker.state.messageId === previewId) speaker.stop();
    },
    [previewId],
  );
  const call = useCallSession();
  const playing = playback.messageId === previewId && playback.status !== "idle";
  const defaultProviderLabel = providers.defaultLabel
    ? t`Default (${providers.defaultLabel})`
    : t`Default`;
  const voiceChoices = botVoiceChoices({
    voices: voices.data,
    voiceId: current.voiceId,
    defaultVoiceId: connection?.voiceId,
  });
  const defaultVoiceLabel = voiceChoices.defaultLabel
    ? t`Default (${voiceChoices.defaultLabel})`
    : t`Default`;
  const failure =
    save.error ?? credentials.error ?? catalog.error ?? voices.error ?? botQuery.error;
  const canPreview = Boolean(connection && (current.voiceId || connection.voiceId));

  function stopPreview() {
    previewRevision.current += 1;
    setPreviewError(null);
    if (speaker.state.messageId === previewId) speaker.stop();
  }

  return (
    <FieldGroup className="gap-0" data-testid="bot-voice-settings">
      <Field orientation="horizontal" className="min-h-12 justify-between">
        <FieldLabel htmlFor={`${ids}-provider`}>
          <Trans>Voice provider</Trans>
        </FieldLabel>
        <OptionSelect
          id={`${ids}-provider`}
          className="w-fit max-w-2/3"
          value={selectedProvider}
          disabled={save.pending || credentials.isPending}
          options={[{ value: "", label: defaultProviderLabel }, ...providers.options]}
          onValueChange={(provider) => {
            stopPreview();
            save.run({ voiceProvider: provider || null, voiceId: null });
          }}
        />
      </Field>
      <Field orientation="horizontal" className="min-h-12 justify-between">
        <FieldLabel htmlFor={`${ids}-voice`}>
          <Trans>Voice</Trans>
        </FieldLabel>
        <div className="flex min-w-0 max-w-2/3 items-center gap-1">
          <OptionSelect
            id={`${ids}-voice`}
            className="min-w-0 flex-1"
            value={current.voiceId ?? ""}
            disabled={save.pending || !connection || voices.isPending}
            options={[{ value: "", label: defaultVoiceLabel }, ...voiceChoices.options]}
            onValueChange={(voiceId) => {
              stopPreview();
              save.run({
                voiceProvider: selectedProvider || (voiceId ? connection?.provider : null) || null,
                voiceId: voiceId || null,
              });
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={playing ? t`Stop` : t`Hear a sample`}
            title={playing ? t`Stop` : t`Hear a sample`}
            disabled={save.pending || !canPreview || call !== null}
            onClick={() => {
              if (playing) stopPreview();
              else {
                stopPreview();
                speaker.unlock();
                const revision = previewRevision.current;
                void speaker
                  .speak(t`Hi, this is how I'll sound when I read replies out loud.`, {
                    botId: bot.id,
                    spaceId: bot.spaceId,
                    messageId: previewId,
                  })
                  .then((failure) => {
                    if (previewRevision.current === revision) setPreviewError(failure ?? null);
                  });
              }
            }}
          >
            {playing ? <Square data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          </Button>
        </div>
      </Field>
      {failure || previewError ? (
        <p role="alert" className="pb-3 text-body text-destructive">
          {failure ? errorText(failure) : previewError}
        </p>
      ) : credentials.data?.length === 0 ? (
        <p className="pb-3 text-body text-muted-foreground">
          <Trans>Connect a provider in Settings → Voice.</Trans>
        </p>
      ) : selectedProvider && !connection ? (
        <p role="alert" className="pb-3 text-body text-destructive">
          <Trans>Reconnect this provider in Settings → Voice.</Trans>
        </p>
      ) : null}
    </FieldGroup>
  );
}
