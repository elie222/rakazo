import { Trans, useLingui } from "@lingui/react/macro";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Disclosure,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { ModelBackupsSettings } from "./ModelBackupsSettings";

import { CatalogModelFields } from "./model-settings/catalog-model-fields";
import { CompatibleModelFields } from "./model-settings/compatible-model-fields";
import {
  CompatibleKeyControls,
  ConnectionControls,
  SaveModelButton,
} from "./model-settings/connection-controls";
import { ProviderList } from "./model-settings/provider-list";
import { useModelSettings } from "./model-settings/use-model-settings";

export function ModelSettingsOverlay({
  onClose,
  embedded = false,
  localOwner = false,
}: {
  onClose: () => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
  localOwner?: boolean;
}) {
  const { t } = useLingui();
  const model = useModelSettings(onClose);
  const {
    activeThinkingLabel,
    busy,
    catalog,
    confirmDisconnect,
    credential,
    credentials,
    currentEntry,
    detailScrollRef,
    disconnectCredential,
    disconnectName,
    error,
    handleClose,
    isOpenAiCompatible,
    loading,
    me,
    notice,
    ownKeyProvider,
    pending,
    provider,
    selected,
    setConfirmDisconnect,
    setOwnKeyProvider,
    hostCredentialSource,
    selectedProviderName,
  } = model;
  const serverCredentialsNote = (
    <p className="text-[13px] leading-[1.5] text-muted-foreground">
      <Trans>
        Uses this server's own {hostCredentialSource} credentials to access {selectedProviderName}.
      </Trans>
    </p>
  );
  const description = localOwner ? (
    <Trans>Models for the server owner’s default space.</Trans>
  ) : null;

  const body = (
    <>
      {!embedded ? (
        <DialogHeader className="flex-row items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-2xl font-medium text-foreground">
              <Trans>Models</Trans>
            </DialogTitle>
            {description ? (
              <DialogDescription className="mt-1 text-[13px] leading-[1.5] text-muted-foreground">
                {description}
              </DialogDescription>
            ) : null}
          </div>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close model settings`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
      ) : description ? (
        <p className="px-6 pt-1 text-[13px] leading-[1.5] text-muted-foreground sm:px-8">
          {description}
        </p>
      ) : null}

      {me?.needsModel ? null : (
        <div className={`mx-6 sm:mx-8 ${embedded ? "mt-4" : "mt-5"}`}>
          <div className="flex flex-col gap-1 md:flex-row md:items-baseline md:gap-6">
            <span className="shrink-0 text-[13.5px] text-muted-foreground md:w-[310px]">
              <Trans>Active model</Trans>
            </span>
            <div className="flex min-w-0 items-baseline gap-3">
              <span className="truncate text-[15px] text-foreground">
                {currentEntry?.label ?? me?.defaultModel ?? t`Deployment default`}
              </span>
              <span className="truncate text-[13px] leading-[1.5] text-muted-foreground">
                {currentEntry?.providerName ?? me?.defaultProvider ?? (
                  <Trans>Configured by deployment</Trans>
                )}
                {activeThinkingLabel ? (
                  <>
                    {" · "}
                    <span>
                      <Trans>Thinking: {activeThinkingLabel}</Trans>
                    </span>
                  </>
                ) : null}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-6 sm:px-8 md:flex-row">
        <ProviderList {...model} />

        <div
          ref={detailScrollRef}
          className="rk-scroll -m-1 min-h-0 min-w-0 flex-1 overflow-y-auto p-1"
        >
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
          {selected ? (
            <>
              {isOpenAiCompatible ? <CompatibleModelFields {...model} /> : null}
              {isOpenAiCompatible ? (
                <>
                  <CompatibleKeyControls {...model} />
                  <SaveModelButton {...model} />
                </>
              ) : credential ? (
                <>
                  {/* The key may be the default in another space while this one runs on server
                      credentials; saving here switches this space to the key. */}
                  {provider === me?.hostCredentialProvider ? (
                    <div className="mb-5">{serverCredentialsNote}</div>
                  ) : null}
                  <CatalogModelFields {...model} />
                  <SaveModelButton {...model} />
                  <div className="mt-6 border-t border-border pt-5">
                    <ConnectionControls {...model} />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-3 -ml-2.5 text-muted-foreground"
                      disabled={busy}
                      onClick={() => setConfirmDisconnect(true)}
                    >
                      {pending === "disconnect" ? (
                        <Trans>Disconnecting…</Trans>
                      ) : (
                        <Trans>Disconnect</Trans>
                      )}
                    </Button>
                  </div>
                </>
              ) : provider === me?.hostCredentialProvider ? (
                <>
                  {serverCredentialsNote}
                  <Disclosure
                    className="mt-5 text-[13px] leading-[1.5] text-muted-foreground"
                    open={ownKeyProvider === provider}
                    onOpenChange={(open) => setOwnKeyProvider(open ? provider : null)}
                    summary={<Trans>Use your own key</Trans>}
                  >
                    <div className="mt-5">
                      <ConnectionControls {...model} />
                    </div>
                    <div className="mt-6">
                      <CatalogModelFields {...model} />
                    </div>
                  </Disclosure>
                </>
              ) : (
                <>
                  <ConnectionControls {...model} />
                  <div className="mt-6">
                    <CatalogModelFields {...model} />
                  </div>
                </>
              )}
            </>
          ) : loading ? (
            <p className="text-[13px] leading-[1.5] text-muted-foreground">
              <Trans>Loading model catalog…</Trans>
            </p>
          ) : (
            <p className="text-[13px] leading-[1.5] text-muted-foreground">
              <Trans>No model catalog is available.</Trans>
            </p>
          )}
          {me ? (
            <ModelBackupsSettings
              userId={me.userId}
              spaceId={me.spaceId}
              catalog={catalog}
              credentials={credentials}
            />
          ) : null}
        </div>
      </div>
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
