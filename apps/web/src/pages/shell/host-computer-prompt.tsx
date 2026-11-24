import { Trans, useLingui } from "@lingui/react/macro";
import type { Me } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { sandboxCheckFailureMessage } from "../../lib/computers/computer-sandbox";
import { desktopBridge } from "../../lib/platform/desktop";
import { useSave } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";
import { errorText } from "../../lib/query/user-error";

export function HostComputerPrompt({
  initialMe,
  onMeUpdated,
}: {
  initialMe?: Me;
  onMeUpdated?: (me: Me) => void;
}) {
  const desktop = desktopBridge();
  const [configuring, setConfiguring] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(
    () =>
      desktop?.computer?.onConfigure(() => {
        void rpc
          .me()
          .then((me) => {
            if (me.canChooseHostComputer) {
              setConfiguring(me.computerHost != null);
              setOpen(true);
            }
          })
          .catch(() => undefined);
      }),
    [desktop],
  );

  useEffect(() => {
    if (!desktop) return;
    if (initialMe) {
      if (initialMe.canChooseHostComputer && initialMe.computerHost == null) setOpen(true);
      return;
    }
    void rpc
      .me()
      .then((me) => {
        if (me.canChooseHostComputer && me.computerHost == null) setOpen(true);
      })
      .catch(() => undefined);
  }, [desktop, initialMe]);

  // Each opening mounts a fresh dialog, so nothing from an earlier attempt shows in it.
  if (!open) return null;
  return (
    <HostComputerDialog
      configuring={configuring}
      onClose={() => setOpen(false)}
      onMeUpdated={onMeUpdated}
    />
  );
}

function HostComputerDialog({
  configuring,
  onClose,
  onMeUpdated,
}: {
  configuring: boolean;
  onClose: () => void;
  onMeUpdated?: (me: Me) => void;
}) {
  const { t } = useLingui();
  const desktop = desktopBridge();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choice = useSave({
    // Resolves false when the person declined access, which leaves the choice open.
    save: async (computerHost: "docker" | "this-mac", client) => {
      if (!desktop?.computer?.managesHostChoice)
        throw new Error(t`Local computer access requires the latest desktop app.`);
      if (computerHost === "this-mac") {
        if (!(await desktop.computer.requestAccess())) return false;
      } else {
        await desktop.computer.revokeAccess();
      }
      try {
        onMeUpdated?.(await client.me());
      } catch {
        // The choice is already saved. A failed refresh must not look like a failed save.
      }
      return true;
    },
    onSaved: (chosen) => {
      if (chosen) onClose();
    },
  });
  const pending = choice.pending;
  const mac = desktop?.platform === "darwin";
  const hostLabel = mac ? t`this Mac` : t`this computer`;

  async function refreshChoiceState() {
    setChecking(true);
    setError(null);
    choice.reset();
    try {
      const me = await rpc.me();
      onMeUpdated?.(me);
      if (!me.canChooseHostComputer || me.computerHost != null) {
        onClose();
      }
    } catch (err) {
      setError(sandboxCheckFailureMessage(err));
    } finally {
      setChecking(false);
    }
  }

  function choose(computerHost: "docker" | "this-mac") {
    setError(null);
    choice.run(computerHost);
  }

  const shownError = choice.error ? errorText(choice.error, t`Could not save that choice`) : error;

  const busy = pending || checking;

  // The choice is required, so the dialog stays open until one is saved.
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // A choice still saving would land after one made in the next opening, so it holds the dialog.
        if (configuring && !next && !busy) onClose();
      }}
    >
      <DialogContent showCloseButton={configuring} className="rounded-2xl sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-heading2">
            <Trans>Where should bots run?</Trans>
          </DialogTitle>
          <DialogDescription className="space-y-2 leading-relaxed">
            <span className="block">
              <Trans>
                A sandbox limits access to your computer for added security. Using {hostLabel} lets
                bots work with your local files and tools.
              </Trans>
            </span>
            <span className="block text-label text-muted-foreground/80">
              <Trans>
                Local access lets bots run commands without asking. Avoid it on shared or public
                servers.
              </Trans>
            </span>
          </DialogDescription>
        </DialogHeader>
        {shownError ? (
          <p role="alert" className="text-body text-destructive">
            {shownError}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button variant="outline" size="lg" disabled={busy} onClick={() => choose("docker")}>
            <Trans>Sandbox</Trans>
          </Button>
          <Button variant="outline" size="lg" disabled={busy} onClick={() => choose("this-mac")}>
            <Trans>Use {hostLabel}</Trans>
          </Button>
        </div>
        {shownError ? (
          <div className="mt-1 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void refreshChoiceState()}
            >
              {checking ? <Trans>Checking…</Trans> : <Trans>Check again</Trans>}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
