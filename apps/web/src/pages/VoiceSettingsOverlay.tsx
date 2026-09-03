import { Trans, useLingui } from "@lingui/react/macro";
import type { VoiceCatalogEntry, VoiceCredential, VoiceInfo, VoiceStatus } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { XIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";

export function VoiceSettingsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  const apiKeyId = useId();
  const voiceSelectId = useId();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<VoiceCredential[]>([]);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"connect" | "voice" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh(nextProvider?: string) {
    const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
      rpc.voice.catalog(),
      rpc.voice.credentials(),
      rpc.voice.status(),
    ]);
    const selected = nextProvider || provider || nextStatus.provider || nextCatalog[0]?.id || "";
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setStatus(nextStatus);
    setProvider(selected);
    const cred = nextCredentials.find((entry) => entry.provider === selected);
    const activeVoice = cred?.voiceId ?? "";
    setVoiceId(activeVoice);
    if (cred) {
      const listed = await rpc.voice.voices({ provider: selected });
      setVoices(listed);
      if (!activeVoice && listed[0]) setVoiceId(listed[0].id);
    } else {
      setVoices([]);
    }
  }

  useEffect(() => {
    void refresh()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t`Could not load voice settings`),
      )
      .finally(() => setLoading(false));
  }, []);

  const selected = catalog.find((entry) => entry.id === provider) ?? catalog[0];
  const credential = credentials.find((entry) => entry.provider === provider);
  const busy = pending !== null;
  const voiceOptions = useMemo(
    () => (voices.length ? voices : voiceId ? [{ id: voiceId, label: voiceId }] : []),
    [voices, voiceId],
  );

  async function connectKey() {
    if (!selected || !apiKey.trim()) return;
    setError(null);
    setNotice(null);
    setPending("connect");
    try {
      await rpc.voice.connect({
        provider: selected.id,
        apiKey: apiKey.trim(),
        voiceId: voiceId || undefined,
      });
      setApiKey("");
      await refresh(selected.id);
      setNotice(t`Connected ${selected.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not connect this voice provider`);
    } finally {
      setPending(null);
    }
  }

  async function chooseVoice(nextVoiceId: string) {
    setVoiceId(nextVoiceId);
    if (!credential) return;
    setPending("voice");
    setError(null);
    try {
      await rpc.voice.setVoice({ voiceId: nextVoiceId, provider: selected?.id });
      await refresh(selected?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save that voice`);
    } finally {
      setPending(null);
    }
  }

  async function testVoice() {
    setError(null);
    setNotice(null);
    setPending("test");
    try {
      const { speaker } = await import("../lib/tts.js");
      await speaker.speak(t`Hi, this is how I'll sound when I read replies out loud.`);
      if (speaker.state.error) {
        setError(speaker.state.error);
        return;
      }
      setNotice(t`If you heard that, voice is ready.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not play a test clip`);
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="voice-settings"
        showCloseButton={false}
        className="flex h-[min(680px,calc(100%-2rem))] w-[920px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:h-[min(680px,calc(100%-5rem))] sm:max-w-[calc(100%-5rem)]"
      >
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-2xl font-medium text-foreground">
              <Trans>Voice</Trans>
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13.5px] text-muted-foreground/70">
              {loading ? (
                <Trans>Loading voice providers…</Trans>
              ) : (
                <Trans>
                  Bring your own key. The provider is swappable; your bots keep the same speak and
                  call buttons.
                </Trans>
              )}
            </DialogDescription>
          </div>
          <DialogClose
            aria-label={t`Close voice settings`}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>

        <div className="mx-6 mt-5 rounded-xl border border-border px-4 py-3 sm:mx-8">
          <div className="text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground/80">
            <Trans>Active voice</Trans>
          </div>
          <div className="mt-1 text-[16px] text-foreground">
            {status?.ready
              ? voiceOptions.find((voice) => voice.id === status.voiceId)?.label || status.voiceId
              : status?.configured
                ? t`Pick a voice`
                : t`Not configured`}
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            {selected?.name ?? status?.provider ?? (
              <Trans>Connect ElevenLabs, OpenAI, or Cartesia</Trans>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-6 sm:px-8 md:flex-row">
          <div className="flex min-h-0 shrink-0 flex-col md:w-[280px]">
            <div className="mb-3 text-[13.5px] text-muted-foreground">
              <Trans>Providers</Trans>
            </div>
            <div className="rk-scroll overflow-y-auto rounded-xl border border-border">
              {catalog.map((entry) => {
                const connected = credentials.some((cred) => cred.provider === entry.id);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => {
                      setProvider(entry.id);
                      setApiKey("");
                      setError(null);
                      setNotice(null);
                      void refresh(entry.id);
                    }}
                    className={`flex w-full items-center gap-3 border-b border-border px-3.5 py-3 text-start transition-colors last:border-0 ${
                      entry.id === provider ? "bg-muted" : "hover:bg-accent"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-foreground">
                        {entry.name}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-muted-foreground/80">
                        {entry.transcribe ? (
                          <Trans>Speak + transcribe</Trans>
                        ) : (
                          <Trans>Speak only</Trans>
                        )}
                      </span>
                    </span>
                    {connected ? (
                      <span className="text-[12px] text-success">
                        <Trans>Connected</Trans>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rk-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
            {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
            {notice ? <p className="mb-4 text-sm text-success">{notice}</p> : null}
            {selected ? (
              <>
                <p className="text-[13.5px] leading-[1.5] text-muted-foreground">
                  {selected.description}
                </p>
                <div className="mt-5 rounded-xl border border-border px-4 py-3">
                  <div className="text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground/80">
                    <Trans>Personal credential</Trans>
                  </div>
                  <div className="mt-1 text-[15px] text-foreground">
                    {credential ? (
                      <Trans>Connected · {selected.name}</Trans>
                    ) : (
                      <Trans>Not connected</Trans>
                    )}
                  </div>
                  <div className="mt-1 text-[13px] text-muted-foreground">
                    <Trans>
                      Keys stay on the server. The app only learns whether a provider is configured.
                    </Trans>
                  </div>
                </div>

                <Field className="mt-5">
                  <FieldLabel htmlFor={apiKeyId}>
                    <Trans>API key</Trans>
                  </FieldLabel>
                  <Input
                    id={apiKeyId}
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={credential ? t`Paste a replacement key` : t`Paste your API key`}
                  />
                </Field>
                <Button
                  type="button"
                  className="mt-3"
                  disabled={busy || apiKey.trim().length < 8}
                  onClick={() => void connectKey()}
                >
                  {pending === "connect" ? (
                    <Trans>Connecting…</Trans>
                  ) : credential ? (
                    <Trans>Replace key</Trans>
                  ) : (
                    <Trans>Connect</Trans>
                  )}
                </Button>

                {credential ? (
                  <>
                    <Field className="mt-6">
                      <FieldLabel htmlFor={voiceSelectId}>
                        <Trans>Voice</Trans>
                      </FieldLabel>
                      <NativeSelect
                        id={voiceSelectId}
                        className="w-full"
                        value={voiceId}
                        onChange={(event) => void chooseVoice(event.target.value)}
                      >
                        {voiceOptions.map((voice) => (
                          <NativeSelectOption key={voice.id} value={voice.id}>
                            {voice.label}
                            {voice.description ? ` · ${voice.description}` : ""}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Button
                      type="button"
                      variant="secondary"
                      className="mt-4 rounded-full"
                      disabled={busy || !status?.ready}
                      onClick={() => void testVoice()}
                    >
                      {pending === "test" ? <Trans>Playing…</Trans> : <Trans>Hear a sample</Trans>}
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
