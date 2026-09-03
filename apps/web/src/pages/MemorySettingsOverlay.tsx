import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceMemoryConfig } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  Toggle,
} from "@rakazo/ui-web";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
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
    <div className="text-[13.5px] text-muted-foreground">
      <Trans>Default scope</Trans>
      <div className="mt-2 flex gap-2">
        {(["isolated", "shared"] as const).map((option) => (
          <Toggle
            key={option}
            variant="outline"
            pressed={value === option}
            disabled={disabled}
            onPressedChange={() => onChange(option)}
            className="flex-1 font-normal text-muted-foreground aria-pressed:text-foreground"
          >
            {option === "isolated" ? <Trans>Isolated</Trans> : <Trans>Shared</Trans>}
          </Toggle>
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
  config: SpaceMemoryConfig | null | undefined;
  onConfigChange: (config: SpaceMemoryConfig | null) => void;
}) {
  const { t } = useLingui();
  const providerSelectId = useId();
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
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (busy) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(760px,calc(100%-2rem))] w-[560px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-h-[min(760px,calc(100%-5rem))] sm:max-w-[calc(100%-5rem)]"
      >
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-2xl font-medium text-foreground">
              <Trans>Memory</Trans>
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13.5px] text-muted-foreground/70">
              {registration?.description ?? (
                <Trans>Manage the Space semantic memory provider.</Trans>
              )}
            </DialogDescription>
          </div>
          <DialogClose
            aria-label={t`Close memory settings`}
            disabled={busy}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>

        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

          {config === undefined ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Loading memory settings…</Trans>
            </p>
          ) : config ? (
            <div className="rounded-xl border border-border px-4 py-3">
              <div className="text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground/80">
                <Trans>Connected</Trans>
              </div>
              <div className="mt-1 text-[15px] text-foreground">
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
                <Field className="mb-4">
                  <FieldLabel htmlFor={providerSelectId}>
                    <Trans>Provider</Trans>
                  </FieldLabel>
                  <NativeSelect
                    id={providerSelectId}
                    className="w-full"
                    value={selectedProvider}
                    disabled={busy}
                    onChange={(event) => setSelectedProvider(event.target.value)}
                  >
                    {MEMORY_PROVIDER_SETTINGS.map((entry) => (
                      <NativeSelectOption key={entry.id} value={entry.id}>
                        {entry.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              ) : null}

              <div className="mb-4">
                <ScopePicker value={defaultScope} disabled={busy} onChange={setDefaultScope} />
              </div>

              <registration.SettingsForm busy={busy} onConnect={connect} />
            </>
          ) : (
            <p className="text-sm text-destructive">
              <Trans>The selected memory provider is not available in this build.</Trans>
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
