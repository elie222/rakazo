import { Trans, useLingui } from "@lingui/react/macro";
import type { WorkspaceMemoryConfig } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import {
  defaultMemoryProviderSettings,
  MEMORY_PROVIDER_SETTINGS,
  type MemoryProviderConnectionDraft,
  memoryProviderSettings,
} from "./memory-providers/registry";

function ScopePicker({
  value,
  disabled,
  onChange,
}: {
  value: "isolated" | "shared";
  disabled: boolean;
  onChange: (scope: "isolated" | "shared") => void;
}) {
  return (
    <div className="text-[13.5px] text-[#85858A]">
      <Trans>Default scope</Trans>
      <div className="mt-2 flex gap-2">
        {(["isolated", "shared"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            disabled={disabled}
            onClick={() => onChange(option)}
            className={`flex-1 rounded-[11px] border px-3.5 py-2.5 text-[14px] disabled:opacity-40 ${
              value === option
                ? "border-[#4A4A50] bg-[#1A1A1D] text-[#ECECEE]"
                : "border-[#26262A] text-[#85858A]"
            }`}
          >
            {option === "isolated" ? <Trans>Isolated</Trans> : <Trans>Shared</Trans>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MemorySettingsOverlay({
  onClose,
  config,
  onConfigChange,
}: {
  onClose: () => void;
  config: WorkspaceMemoryConfig | null | undefined;
  onConfigChange: (config: WorkspaceMemoryConfig | null) => void;
}) {
  const { t } = useLingui();
  const defaultRegistration = defaultMemoryProviderSettings();
  const [selectedProvider, setSelectedProvider] = useState(
    config?.provider ?? defaultRegistration.id,
  );
  const [defaultScope, setDefaultScope] = useState<"isolated" | "shared">(
    config?.defaultMemoryScope ?? "isolated",
  );
  const [pending, setPending] = useState<"connect" | "disconnect" | "scope" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config) {
      setSelectedProvider(config.provider);
      setDefaultScope(config.defaultMemoryScope);
      return;
    }
    if (config === null && !memoryProviderSettings(selectedProvider)) {
      setSelectedProvider(defaultRegistration.id);
    }
  }, [config, defaultRegistration.id, selectedProvider]);

  const registration = memoryProviderSettings(config?.provider ?? selectedProvider);
  const busy = pending !== null;

  async function connect(draft: MemoryProviderConnectionDraft) {
    if (!registration) return false;
    setError(null);
    setPending("connect");
    try {
      const next = await rpc.memory.connectProvider({
        provider: registration.id,
        ...draft,
        defaultMemoryScope: defaultScope,
      });
      onConfigChange(next);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not connect ${registration.name}`);
      return false;
    } finally {
      setPending(null);
    }
  }

  async function disconnect() {
    setError(null);
    setPending("disconnect");
    try {
      await rpc.memory.disconnectProvider();
      onConfigChange(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not disconnect memory provider`);
    } finally {
      setPending(null);
    }
  }

  async function updateDefaultScope(scope: "isolated" | "shared") {
    if (scope === defaultScope) return;
    setError(null);
    setPending("scope");
    try {
      const next = await rpc.memory.setDefaultScope({ defaultMemoryScope: scope });
      onConfigChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not update the default memory scope`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-4 sm:p-10">
      <div className="flex max-h-[min(760px,100%)] w-[560px] max-w-full flex-col overflow-hidden rounded-[26px] border border-[#232326] bg-[#141416] shadow-[0_40px_90px_rgba(0,0,0,.55)]">
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="text-2xl font-medium text-[#F1F1F2]">
              <Trans>Memory</Trans>
            </div>
            <p className="mt-1 text-[13.5px] text-[#7A7A80]">
              {registration?.description ?? (
                <Trans>Manage the workspace semantic memory provider.</Trans>
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label={t`Close memory settings`}
            disabled={busy}
            onClick={onClose}
            className="text-[#85858A] disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          {error ? <p className="mb-4 text-sm text-[#C94244]">{error}</p> : null}

          {config === undefined ? (
            <p className="text-sm text-[#85858A]">
              <Trans>Loading memory settings…</Trans>
            </p>
          ) : config ? (
            <div className="rounded-[13px] border border-[#26262A] px-4 py-3">
              <div className="text-[12.5px] uppercase tracking-[0.08em] text-[#6C6C70]">
                <Trans>Connected</Trans>
              </div>
              <div className="mt-1 text-[15px] text-[#ECECEE]">
                {registration?.connectedLabel(config) ?? config.provider}
              </div>
              <div className="mt-3">
                <ScopePicker
                  value={defaultScope}
                  disabled={busy}
                  onChange={(scope) => void updateDefaultScope(scope)}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void disconnect()}
                className="mt-3"
              >
                {pending === "disconnect" ? (
                  <Trans>Disconnecting…</Trans>
                ) : (
                  <Trans>Disconnect</Trans>
                )}
              </Button>
            </div>
          ) : registration ? (
            <>
              {MEMORY_PROVIDER_SETTINGS.length > 1 ? (
                <label className="mb-4 block text-[13.5px] text-[#85858A]">
                  <Trans>Provider</Trans>
                  <select
                    value={selectedProvider}
                    disabled={busy}
                    onChange={(event) => setSelectedProvider(event.target.value)}
                    className="mt-2 w-full rounded-[11px] border border-[#26262A] bg-[#101012] px-3.5 py-3 text-[#ECECEE] outline-none disabled:opacity-40"
                  >
                    {MEMORY_PROVIDER_SETTINGS.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="mb-4">
                <ScopePicker value={defaultScope} disabled={busy} onChange={setDefaultScope} />
              </div>

              <registration.SettingsForm busy={busy} onConnect={connect} />
            </>
          ) : (
            <p className="text-sm text-[#C94244]">
              <Trans>The selected memory provider is not available in this build.</Trans>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
