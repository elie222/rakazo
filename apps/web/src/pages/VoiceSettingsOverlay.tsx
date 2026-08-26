import { Trans, useLingui } from "@lingui/react/macro";
import type { VoiceCatalogEntry, VoiceCredential, VoiceInfo, VoiceStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";

export function VoiceSettingsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
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
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-4 sm:p-10">
      <div
        data-testid="voice-settings"
        className="flex h-[min(680px,100%)] w-[920px] max-w-full flex-col overflow-hidden rounded-[26px] border border-[#232326] bg-[#141416] shadow-[0_40px_90px_rgba(0,0,0,.55)]"
      >
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="text-2xl font-medium text-[#F1F1F2]">
              <Trans>Voice</Trans>
            </div>
            <p className="mt-1 text-[13.5px] text-[#7A7A80]">
              {loading ? (
                <Trans>Loading voice providers…</Trans>
              ) : (
                <Trans>
                  Bring your own key. The provider is swappable; your bots keep the same speak and
                  call buttons.
                </Trans>
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label={t`Close voice settings`}
            onClick={onClose}
            className="text-[#85858A]"
          >
            ✕
          </button>
        </div>

        <div className="mx-6 mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-3 sm:mx-8">
          <div className="text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
            <Trans>Active voice</Trans>
          </div>
          <div className="mt-1 text-[16px] text-[#F1F1F2]">
            {status?.ready
              ? voiceOptions.find((voice) => voice.id === status.voiceId)?.label || status.voiceId
              : status?.configured
                ? t`Pick a voice`
                : t`Not configured`}
          </div>
          <div className="mt-1 text-[13px] text-[#85858A]">
            {selected?.name ?? status?.provider ?? (
              <Trans>Connect ElevenLabs, OpenAI, or Cartesia</Trans>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-6 sm:px-8 md:flex-row">
          <div className="flex min-h-0 shrink-0 flex-col md:w-[280px]">
            <div className="mb-3 text-[13.5px] text-[#85858A]">
              <Trans>Providers</Trans>
            </div>
            <div className="rk-scroll overflow-y-auto rounded-[13px] border border-[#26262A]">
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
                    className={`flex w-full items-center gap-3 border-b border-[#202023] px-3.5 py-3 text-start last:border-0 ${
                      entry.id === provider ? "bg-[#1A1A1D]" : "hover:bg-[#161618]"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-[#ECECEE]">
                        {entry.name}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-[#6C6C70]">
                        {entry.transcribe ? (
                          <Trans>Speak + transcribe</Trans>
                        ) : (
                          <Trans>Speak only</Trans>
                        )}
                      </span>
                    </span>
                    {connected ? (
                      <span className="text-[12px] text-[#4ECB71]">
                        <Trans>Connected</Trans>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rk-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
            {error ? <p className="mb-4 text-sm text-[#C94244]">{error}</p> : null}
            {notice ? <p className="mb-4 text-sm text-[#4ECB71]">{notice}</p> : null}
            {selected ? (
              <>
                <p className="text-[13.5px] leading-[1.5] text-[#85858A]">{selected.description}</p>
                <div className="mt-5 rounded-[13px] border border-[#26262A] px-4 py-3">
                  <div className="text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
                    <Trans>Personal credential</Trans>
                  </div>
                  <div className="mt-1 text-[15px] text-[#ECECEE]">
                    {credential ? (
                      <Trans>Connected · {selected.name}</Trans>
                    ) : (
                      <Trans>Not connected</Trans>
                    )}
                  </div>
                  <div className="mt-1 text-[13px] text-[#85858A]">
                    <Trans>
                      Keys stay on the server. The app only learns whether a provider is configured.
                    </Trans>
                  </div>
                </div>

                <label className="mt-5 block text-[13.5px] text-[#85858A]">
                  <Trans>API key</Trans>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={credential ? t`Paste a replacement key` : t`Paste your API key`}
                    className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-2.5 text-[14px] text-[#ECECEE] outline-none"
                  />
                </label>
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
                    <label className="mt-6 block text-[13.5px] text-[#85858A]">
                      <Trans>Voice</Trans>
                      <select
                        value={voiceId}
                        onChange={(event) => void chooseVoice(event.target.value)}
                        className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-2.5 text-[14px] text-[#ECECEE] outline-none"
                      >
                        {voiceOptions.map((voice) => (
                          <option key={voice.id} value={voice.id}>
                            {voice.label}
                            {voice.description ? ` · ${voice.description}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={busy || !status?.ready}
                      onClick={() => void testVoice()}
                      className="mt-4 text-[14px] text-[#C9C9CE] disabled:opacity-40"
                    >
                      {pending === "test" ? <Trans>Playing…</Trans> : <Trans>Hear a sample</Trans>}
                    </button>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
