import { Trans, useLingui } from "@lingui/react/macro";
import {
  compatibleConnectionName,
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
import { useState } from "react";
import type { ModelRoleConnectIntent } from "./ModelRoleSettings";
import { ModelRoleSettings } from "./ModelRoleSettings";
import { CompatibleModelFields } from "./model-settings/compatible-model-fields";
import { CompatibleKeyControls, ConnectionControls } from "./model-settings/connection-controls";
import type { ConnectableProvider } from "./model-settings/role-model-picker";
import { SpaceBotsModelNotice } from "./model-settings/space-bots-model";
import { useModelSettings } from "./model-settings/use-model-settings";

export function ModelSettingsOverlay({
  onClose,
  embedded = false,
}: {
  onClose: () => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
}) {
  const { t } = useLingui();
  const model = useModelSettings(onClose);
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
    currentEntry,
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
    selectedProviderName,
    setConfirmDisconnect,
    setMaxTokens,
    setNotice,
    settingsDirty,
  } = model;
  const [dialogOpen, setDialogOpen] = useState(false);

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

  function openConnection(next: ConnectableProvider, intent: ModelRoleConnectIntent | null) {
    model.chooseProvider(next.id, next.baseUrl);
    intentRef.current = {
      makeDefault: intent?.makeDefault ?? false,
      onConnected: async (choice) => {
        setDialogOpen(false);
        intentRef.current = null;
        await intent?.onConnected(choice);
      },
    };
    setDialogOpen(true);
  }

  function closeConnection() {
    cancelOAuthAttempt();
    intentRef.current = null;
    setDialogOpen(false);
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
            className="mt-4 rounded-full"
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

  const body = (
    <>
      {!embedded ? (
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
      ) : null}

      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
        <div className="mx-auto max-w-[600px]">
          {error && !dialogOpen ? (
            <p className="mb-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {notice && !dialogOpen ? (
            <p className="mb-4 text-sm text-success" role="status">
              {notice}
            </p>
          ) : null}
          {me ? (
            <>
              <ModelRoleSettings
                userId={me.userId}
                spaceId={me.spaceId}
                credentials={credentials}
                title={t`Main model`}
                defaultLabel={
                  me.needsModel
                    ? t`Choose a model`
                    : (currentEntry?.label ?? me.defaultModel ?? t`Deployment default`)
                }
                providers={providers}
                providerLabel={providerLabel}
                onConnect={openConnection}
                onManage={(id) => openConnection({ id, name: id }, null)}
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
                credentials={credentials}
                modelRole="approval"
                title={t`Approval model`}
                defaultLabel={t`Deployment default`}
                providers={providers}
                providerLabel={providerLabel}
                onConnect={openConnection}
                onManage={(id) => openConnection({ id, name: id }, null)}
              />
            </>
          ) : loading ? (
            <Spinner aria-label={t`Loading model catalog…`} />
          ) : catalog.length ? null : (
            <p className="text-[13px] leading-[1.5] text-muted-foreground">
              <Trans>No model catalog is available.</Trans>
            </p>
          )}
        </div>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeConnection();
        }}
      >
        <DialogContent className="max-h-[calc(100%-2rem)] w-[480px] max-w-[calc(100%-2rem)] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-lg">
              {connected ? selectedProviderName : <Trans>Connect {selectedProviderName}</Trans>}
            </DialogTitle>
          </DialogHeader>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="text-sm text-success" role="status">
              {notice}
            </p>
          ) : null}
          <div>{connection}</div>
        </DialogContent>
      </Dialog>

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
                setDialogOpen(false);
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
    return (
      <div data-testid="model-settings" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {body}
      </div>
    );
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
        {body}
      </DialogContent>
    </Dialog>
  );
}
