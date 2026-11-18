import { Trans, useLingui } from "@lingui/react/macro";
import type { SpaceMemoryConfig } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Field,
  FieldLabel,
  OptionSelect,
  SectionHeading,
  Spinner,
  Toggle,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ProviderSettingsDraft } from "../../components/models/ProviderSettingsForm";
import { ProviderSettingsForm } from "../../components/models/ProviderSettingsForm";
import { SETTINGS_CONTENT_WIDTH } from "../../components/settings/SettingsRows";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorCode, errorText } from "../../lib/query/user-error";
import { SpaceMemorySection } from "../space/KnowledgeSection";

type MemoryScope = "isolated" | "shared";

type Change =
  | { kind: "connect"; provider: string; draft: ProviderSettingsDraft; scope: MemoryScope }
  | { kind: "update"; draft: ProviderSettingsDraft }
  | { kind: "scope"; scope: MemoryScope }
  | { kind: "disconnect" };

function ScopePicker({
  value,
  disabled,
  onChange,
}: {
  value: MemoryScope;
  disabled: boolean;
  onChange: (scope: MemoryScope) => void;
}) {
  const labelId = useId();
  return (
    <Field aria-labelledby={labelId}>
      <FieldLabel id={labelId}>
        <Trans>Default scope</Trans>
      </FieldLabel>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {(["isolated", "shared"] as const).map((option) => (
          <Toggle
            key={option}
            pressed={value === option}
            disabled={disabled}
            onPressedChange={() => onChange(option)}
            className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            {option === "isolated" ? <Trans>Isolated</Trans> : <Trans>Shared</Trans>}
          </Toggle>
        ))}
      </div>
    </Field>
  );
}

export function MemorySettingsOverlay({
  onClose,
  config,
  onConfigChange,
  embedded = false,
  onBusyChange,
}: {
  onClose: () => void;
  config: SpaceMemoryConfig | null | undefined;
  onConfigChange: (config: SpaceMemoryConfig | null) => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const providerSelectId = useId();
  const providersQuery = useQuery(queries.memory.providers.queryOptions());
  // A server from before this call has no providers to describe: nothing can be connected or
  // edited. Any other failure is a load to retry, not an empty list.
  const olderServer = errorCode(providersQuery.error) === "NOT_FOUND";
  const providers = providersQuery.data ?? (olderServer ? [] : undefined);
  const [selectedProvider, setSelectedProvider] = useState(config?.provider);
  const [defaultScope, setDefaultScope] = useState<MemoryScope>(
    config?.defaultMemoryScope ?? "isolated",
  );
  const [addingProvider, setAddingProvider] = useState(false);
  const [editingProvider, setEditingProvider] = useState(false);
  const change = useSave({
    save: async (input: Change, rpc): Promise<SpaceMemoryConfig | null> => {
      if (input.kind === "connect") {
        return rpc.memory.connectProvider({
          provider: input.provider,
          ...input.draft,
          defaultMemoryScope: input.scope,
        });
      }
      if (input.kind === "update") return rpc.memory.updateProvider(input.draft);
      if (input.kind === "scope") {
        return rpc.memory.setDefaultScope({ defaultMemoryScope: input.scope });
      }
      await rpc.memory.disconnectProvider();
      return null;
    },
    // What is remembered and how much room it has are read through the connected provider.
    stale: [
      queries.memory.providerConfig.queryKey(),
      queries.memory.list.key(),
      queries.memory.budget.key(),
    ],
    onSaved: (next, input) => {
      if (input.kind === "disconnect") setAddingProvider(false);
      if (input.kind === "disconnect" || input.kind === "update") setEditingProvider(false);
      onConfigChange(next);
    },
  });
  const busy = change.pending;

  useEffect(() => {
    if (!config) return;
    setSelectedProvider(config.provider);
    setDefaultScope(config.defaultMemoryScope);
  }, [config]);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const descriptor =
    providers?.find((entry) => entry.id === (config?.provider ?? selectedProvider)) ??
    (config ? undefined : providers?.[0]);
  const nameOf = (id: string | undefined) =>
    providers?.find((entry) => entry.id === id)?.displayName ?? id;
  const failed = change.error ? change.input : undefined;
  const error = !failed
    ? null
    : failed.kind === "connect"
      ? errorText(change.error, t`Could not connect ${nameOf(failed.provider)}`)
      : failed.kind === "update"
        ? errorText(change.error, t`Could not save ${nameOf(config?.provider)}`)
        : failed.kind === "scope"
          ? errorText(change.error, t`Could not update the default memory scope`)
          : errorText(change.error, t`Could not disconnect memory provider`);

  const body = (
    <>
      {!embedded ? (
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-heading2 font-medium text-foreground">
              <Trans>Memory</Trans>
            </DialogTitle>
          </div>
          <DialogClose
            aria-label={t`Close memory settings`}
            disabled={busy}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>
      ) : null}

      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 pt-6 sm:px-8 sm:pb-8">
        <div className={`space-y-5 ${SETTINGS_CONTENT_WIDTH}`}>
          {error ? <p className="text-body-sm text-destructive">{error}</p> : null}

          <SpaceMemorySection />

          {providers === undefined && providersQuery.isError ? (
            <div role="alert" className="text-body-sm text-destructive">
              {errorText(providersQuery.error)}
              <Button variant="ghost" size="sm" onClick={() => void providersQuery.refetch()}>
                {t`Retry`}
              </Button>
            </div>
          ) : config === undefined || providers === undefined ? (
            <p className="text-body-sm text-muted-foreground">
              <Spinner aria-label={t`Loading memory settings…`} />
            </p>
          ) : config ? (
            <section className="rounded-xl border border-border px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <SectionHeading variant="heading">{nameOf(config.provider)}</SectionHeading>
                <span className="text-body-sm text-success">
                  <Trans>Connected</Trans>
                </span>
              </div>
              <p className="mt-1 text-body-sm text-muted-foreground">
                {config.connectionLabel ?? config.provider}
              </p>
              <div className="mt-4">
                <ScopePicker
                  value={defaultScope}
                  disabled={busy}
                  onChange={(scope) => {
                    if (scope !== defaultScope) change.run({ kind: "scope", scope });
                  }}
                />
              </div>
              {editingProvider && descriptor ? (
                <>
                  <ProviderSettingsForm
                    fields={descriptor.fields}
                    busy={busy}
                    saved={config.settings}
                    onSubmit={(draft) => change.run({ kind: "update", draft })}
                    advancedSettings={null}
                  />
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditingProvider(false);
                      change.reset();
                    }}
                    className="mt-5 ml-2"
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                </>
              ) : (
                <div className="mt-5 flex gap-2">
                  {descriptor ? (
                    <Button
                      variant="outline"
                      type="button"
                      disabled={busy}
                      onClick={() => setEditingProvider(true)}
                    >
                      <Trans>Edit</Trans>
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    type="button"
                    disabled={busy}
                    onClick={() => change.run({ kind: "disconnect" })}
                  >
                    {busy && change.input?.kind === "disconnect" ? (
                      <Trans>Disconnecting…</Trans>
                    ) : (
                      <Trans>Disconnect</Trans>
                    )}
                  </Button>
                </div>
              )}
            </section>
          ) : !addingProvider ? (
            <Button
              variant="outline"
              type="button"
              onClick={() => setAddingProvider(true)}
              className="rounded-full"
            >
              <Trans>Connect memory provider</Trans>
            </Button>
          ) : descriptor ? (
            <section className="rounded-xl border border-border px-4 py-4">
              <SectionHeading id={providerSelectId} variant="heading">
                <Trans>Provider</Trans>
              </SectionHeading>
              {providers.length > 1 ? (
                <div className="mt-3">
                  <OptionSelect
                    aria-labelledby={providerSelectId}
                    value={descriptor.id}
                    disabled={busy}
                    options={providers.map((entry) => ({
                      value: entry.id,
                      label: entry.displayName,
                    }))}
                    onValueChange={setSelectedProvider}
                  />
                </div>
              ) : (
                <p className="mt-3 text-body text-foreground">{descriptor.displayName}</p>
              )}

              <p className="mt-3 text-body-sm text-muted-foreground">
                <Trans>
                  An external memory service for storing and recalling context across chats.
                </Trans>
              </p>
              <ProviderSettingsForm
                key={descriptor.id}
                fields={descriptor.fields}
                busy={busy}
                onSubmit={(draft) =>
                  change.run({
                    kind: "connect",
                    provider: descriptor.id,
                    draft,
                    scope: defaultScope,
                  })
                }
                advancedSettings={
                  <div className="mt-4">
                    <ScopePicker value={defaultScope} disabled={busy} onChange={setDefaultScope} />
                  </div>
                }
              />
            </section>
          ) : (
            <p className="text-body-sm text-destructive">
              <Trans>The selected memory provider is not available in this build.</Trans>
            </p>
          )}
        </div>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div data-testid="memory-settings" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {body}
      </div>
    );
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
        {body}
      </DialogContent>
    </Dialog>
  );
}
