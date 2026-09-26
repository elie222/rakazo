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
import { sandboxCheckFailureMessage } from "../lib/computer-sandbox";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";

export function HostComputerPrompt({
  initialMe,
  onMeUpdated,
  onOpenComputerSettings,
}: {
  initialMe?: Me;
  onMeUpdated?: (me: Me) => void;
  onOpenComputerSettings?: () => void;
}) {
  const { t } = useLingui();
  const desktop = desktopBridge();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mac = desktop?.platform === "darwin";
  const hostLabel = mac ? t`this Mac` : t`this computer`;

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

  if (!open) return null;

  async function refreshChoiceState() {
    setChecking(true);
    setError(null);
    try {
      const me = await rpc.me();
      onMeUpdated?.(me);
      if (!me.canChooseHostComputer || me.computerHost != null) {
        setOpen(false);
      }
    } catch (err) {
      setError(sandboxCheckFailureMessage(err));
    } finally {
      setChecking(false);
    }
  }

  async function choose(computerHost: "docker" | "this-mac") {
    setPending(true);
    setError(null);
    try {
      await rpc.deployment.update({ computerHost });
      const me = await rpc.me();
      onMeUpdated?.(me);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save that choice`);
    } finally {
      setPending(false);
    }
  }

  const busy = pending || checking;

  // The choice is required, so the dialog stays open until one is saved.
  return (
    <Dialog open>
      <DialogContent showCloseButton={false} className="rounded-2xl p-6 sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-[22px]">
            <Trans>Where should bots run?</Trans>
          </DialogTitle>
          <DialogDescription className="space-y-2 leading-relaxed">
            <span className="block">
              <Trans>
                Docker limits access to your computer for added security. Using {hostLabel} lets
                bots work with your local files and tools.
              </Trans>
            </span>
            <span className="block text-xs text-muted-foreground/80">
              <Trans>
                Local access lets bots run commands without asking. Avoid it on shared or public
                servers.
              </Trans>
            </span>
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button variant="outline" size="lg" disabled={busy} onClick={() => void choose("docker")}>
            <Trans>Docker</Trans>
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={busy}
            onClick={() => void choose("this-mac")}
          >
            <Trans>Use {hostLabel}</Trans>
          </Button>
        </div>
        {error ? (
          <div className="mt-1 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-full"
              disabled={busy}
              onClick={() => void refreshChoiceState()}
            >
              {checking ? <Trans>Checking…</Trans> : <Trans>Check again</Trans>}
            </Button>
            {onOpenComputerSettings ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-full"
                disabled={busy}
                onClick={onOpenComputerSettings}
              >
                <Trans>Computer setup</Trans>
              </Button>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
