import { Trans, useLingui } from "@lingui/react/macro";
import type { SettingsScope } from "@rakazo/contracts";
import {
  compatibleConnectionName,
  connectionDisplayName,
  isOllamaCloudBaseUrl,
  OLLAMA_CLOUD_BASE_URL,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  savedCompatibleEndpointMatches,
} from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ModelThinkingOptions,
  Spinner,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelCredential } from "../lib/model-auth";
import type { ModelRoleConnectIntent } from "./ModelRoleSettings";
import { ModelRoleSettings } from "./ModelRoleSettings";
import { CompatibleModelFields } from "./model-settings/compatible-model-fields";
import { CompatibleKeyControls, ConnectionControls } from "./model-settings/connection-controls";
import { ConnectionNameField, ProvidersSection } from "./model-settings/providers-section";
import type { ConnectableProvider } from "./model-settings/role-model-picker";
import { SpaceBotsModelNotice } from "./model-settings/space-bots-model";
import { useModelSettings } from "./model-settings/use-model-settings";

export function ModelSettingsOverlay({
  onClose,
  embedded = false,
  scope,
}: {
  onClose: () => void;
  /** Render the content only, inside the shared Settings shell's scroller. */
  embedded?: boolean;
  /**
   * The account's models, or the bound Space's own when it overrides them. Connections are
   * account-wide, so a Space shows only its role lists.
   */
  scope: SettingsScope;
}) {
  const { t } = useLingui();
  const model = useModelSettings(onClose, scope);
  const {
    baseUrl,
    busy,
    catalog,
    cancelOAuthAttempt,
    confirmDisconnect,
    connectKey,
    credential,
    credentialByProvider,
    credentials,
    disconnectCredential,
    disconnectName,
    error,
    groups,
    handleClose,
    hostCredentialSource,
    intentRef,
    isOpenAiCompatible,
    loading,
    maxTokens,
    me,
    notice,
    pending,
    provider,
    refresh,
    selected,
    selectedConnectionName,
    selectedProviderName,
    setConfirmDisconnect,
    setMaxTokens,
    setNotice,
    settingsDirty,
  } = model;
  // Where the connection form opens: under a role's list, under a provider row, or at the
  // end of Providers when adding one. The rest of the page stays where it was.
  const [connectionAt, setConnectionAt] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [connectionAt]);

  const providers: ConnectableProvider[] = groups
    .filter((group) => !credentialByProvider.has(group.id))
    .map((group) => ({ id: group.id, name: group.name }));
  if (
    groups.some((group) => group.id === OPENAI_COMPATIBLE_PROVIDER_ID) &&
    !isOllamaCloudBaseUrl(credentialByProvider.get(OPENAI_COMPATIBLE_PROVIDER_ID)?.baseUrl)
  )
    providers.push({
      id: OPENAI_COMPATIBLE_PROVIDER_ID,
      name: t`Ollama Cloud`,
      baseUrl: OLLAMA_CLOUD_BASE_URL,
    });
  // Adding another account is open to every provider, connected or not.
  const allProviders: ConnectableProvider[] = [
    ...groups.map((group) => ({ id: group.id, name: group.name })),
    ...(groups.some((group) => group.id === OPENAI_COMPATIBLE_PROVIDER_ID)
      ? [
          {
            id: OPENAI_COMPATIBLE_PROVIDER_ID,
            name: t`Ollama Cloud`,
            baseUrl: OLLAMA_CLOUD_BASE_URL,
          },
        ]
      : []),
  ];
  const connectionName = (entry: ModelCredential) => {
    const group = groups.find((item) => item.id === entry.provider);
    return connectionDisplayName(
      entry,
      group?.name ?? entry.provider,
      group?.entries[0]?.providerName ? [group.entries[0].providerName] : [],
    );
  };
  const providerLabel = (id: string) =>
    compatibleConnectionName(
      credentialByProvider.get(id)?.baseUrl,
      groups.find((group) => group.id === id)?.name ?? id,
    );
  // The Ollama Cloud preset shares the compatible provider id with a saved local server.
  const connected = Boolean(
    credential &&
      (!isOpenAiCompatible || savedCompatibleEndpointMatches(baseUrl, credential.baseUrl)),
  );

  /** Opens a connection by id, or connects a new one for the provider. */
  function openConnection(
    next: ConnectableProvider,
    intent: ModelRoleConnectIntent | null,
    credentialId: string | null,
    at: string,
  ) {
    model.chooseProvider(next.id, next.baseUrl, credentialId);
    intentRef.current = {
      makeDefault: intent?.makeDefault ?? false,
      onConnected: async (choice) => {
        setConnectionAt(null);
        intentRef.current = null;
        await intent?.onConnected(choice);
      },
    };
    setConnectionAt(at);
  }

  function closeConnection() {
    cancelOAuthAttempt();
    intentRef.current = null;
    setConnectionAt(null);
  }

  const disconnectButton = connected ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="mt-6 -ml-2.5 text-muted-foreground"
      disabled={busy}
      onClick={() => setConfirmDisconnect(true)}
    >
      {pending === "disconnect" ? <Trans>Disconnecting…</Trans> : <Trans>Disconnect</Trans>}
    </Button>
  ) : null;

  const connection = selected ? (
    isOpenAiCompatible ? (
      <>
        <CompatibleModelFields {...model} />
        <CompatibleKeyControls {...model} />
        {disconnectButton}
      </>
    ) : credential ? (
      <>
        <ConnectionControls {...model} />
        <ModelThinkingOptions
          showThinking={false}
          disabled={busy}
          advancedLabel={t`Advanced`}
          maxTokens={maxTokens}
          onMaxTokensChange={(value) => {
            setMaxTokens(value);
            setNotice(null);
          }}
          maxTokensLabel={t`Maximum output tokens`}
        />
        {settingsDirty ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-4"
            disabled={busy}
            onClick={() => void connectKey({ settingsOnly: true })}
          >
            {pending === "settings" ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        ) : null}
        {disconnectButton}
      </>
    ) : (
      <>
        {provider === me?.hostCredentialProvider ? (
          <p className="mb-5 text-[13px] leading-[1.5] text-muted-foreground">
            <Trans>
              Uses this server's own {hostCredentialSource} credentials to access{" "}
              {selectedProviderName}.
            </Trans>
          </p>
        ) : null}
        <ConnectionControls {...model} />
      </>
    )
  ) : null;

  // Under its own Providers row the row is the heading, so the form sits there unframed.
  const panelFor = (framed: boolean) => (
    <div
      ref={panelRef}
      className={framed ? "mt-3 rounded-xl border border-border px-4 py-4" : "pt-1"}
      data-testid="model-connection"
    >
      <div className={framed ? "mb-3 flex items-center justify-between gap-3" : "sr-only"}>
        <h4
          data-testid="model-connection-title"
          className="min-w-0 truncate text-[15px] font-medium text-foreground"
        >
          {connected ? selectedConnectionName : <Trans>Connect {selectedProviderName}</Trans>}
        </h4>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-me-1.5 shrink-0 text-muted-foreground"
          aria-label={t`Close`}
          tabIndex={framed ? undefined : -1}
          onClick={closeConnection}
        >
          <X />
        </Button>
      </div>
      {error ? (
        <p className="mb-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mb-4 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {/* Edits made while a save is in flight would be replaced by what it saved. */}
      <fieldset className="contents" disabled={pending === "connect" || pending === "settings"}>
        {connected && credential ? (
          <ConnectionNameField
            key={credential.id}
            credential={credential}
            onRenamed={() => void refresh()}
          />
        ) : null}
        {connection}
      </fieldset>
    </div>
  );

  const content = (
    <>
      {error && !connectionAt ? (
        <p className="mb-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {notice && !connectionAt ? (
        <p className="mb-4 text-sm text-success" role="status">
          {notice}
        </p>
      ) : null}
      {me ? (
        <>
          <ModelRoleSettings
            userId={me.userId}
            spaceId={me.spaceId}
            scope={scope}
            credentials={credentials}
            title={t`Main model`}
            defaultLabel={t`Choose a model`}
            providers={providers}
            providerLabel={providerLabel}
            onConnect={(next, intent) => openConnection(next, intent, null, "main")}
            onManage={(id, credentialId) =>
              openConnection({ id, name: id }, null, credentialId, "main")
            }
            panel={connectionAt === "main" ? panelFor(true) : null}
            thinking
            onChanged={() => void refresh()}
          />
          {me.needsModel ? null : (
            <SpaceBotsModelNotice
              refreshKey={`${me.spaceId}:${me.defaultProvider ?? ""}:${me.defaultModel ?? ""}`}
            />
          )}
          <ModelRoleSettings
            userId={me.userId}
            spaceId={me.spaceId}
            scope={scope}
            credentials={credentials}
            modelRole="approval"
            title={t`Approval model`}
            defaultLabel={t`Choose a model`}
            providers={providers}
            providerLabel={providerLabel}
            onConnect={(next, intent) => openConnection(next, intent, null, "approval")}
            onManage={(id, credentialId) =>
              openConnection({ id, name: id }, null, credentialId, "approval")
            }
            panel={connectionAt === "approval" ? panelFor(true) : null}
          />
          {scope === "space" ? null : (
            <ProvidersSection
              credentials={credentials}
              providers={allProviders}
              name={connectionName}
              disabled={busy}
              onAdd={(next) => openConnection(next, null, null, "providers:add")}
              onOpen={(entry) =>
                connectionAt === `providers:${entry.id}`
                  ? closeConnection()
                  : openConnection(
                      { id: entry.provider, name: entry.provider },
                      null,
                      entry.id,
                      `providers:${entry.id}`,
                    )
              }
              panel={
                connectionAt?.startsWith("providers:")
                  ? panelFor(connectionAt === "providers:add")
                  : null
              }
              panelAt={connectionAt?.slice("providers:".length) ?? null}
            />
          )}
        </>
      ) : loading ? (
        <div className="grid place-items-center py-10">
          <Spinner
            className="size-5 text-muted-foreground"
            aria-label={t`Loading model catalog…`}
          />
        </div>
      ) : catalog.length ? null : (
        <p className="text-[13px] leading-[1.5] text-muted-foreground">
          <Trans>No model catalog is available.</Trans>
        </p>
      )}
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Disconnect {disconnectName}?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>This removes the connection from every space.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending === "disconnect"}
              onClick={() => {
                setConfirmDisconnect(false);
                setConnectionAt(null);
                intentRef.current = null;
                void disconnectCredential();
              }}
            >
              <Trans>Disconnect</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  if (embedded) {
    return <div data-testid="model-settings">{content}</div>;
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[1080px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[1080px]"
      >
        <DialogHeader className="flex-row items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <DialogTitle className="text-heading2 font-medium text-foreground">
            <Trans>Models</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close model settings`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          <div className="max-w-[600px]">{content}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
